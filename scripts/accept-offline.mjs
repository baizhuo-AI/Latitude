import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  allocateLoopbackPort,
  assertChildRunning,
  assertNode22,
  chromeArguments,
  createOwnedSandbox,
  createResourceRegistry,
  getJson,
  postJson,
  removeOwnedSandbox,
  resolveBrowserBinary,
  runTrackedCommand,
  startTrackedProcess,
  stopResources,
  waitForJson,
  waitForLatitudePreview,
  waitForPageTarget,
  withoutCredentials,
} from "./accept-browser.mjs";
import {
  BrowserCdp,
  installBrowserFailureTracker,
  installLoopbackNetworkGuard,
} from "./browser-cdp.mjs";

const HOST = "127.0.0.1";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const OS_SANDBOX_MARKER = "LATITUDE_OFFLINE_OS_SANDBOX";
const RESERVED_PORTS_ENV = "LATITUDE_OFFLINE_RESERVED_PORTS";
const BLOCKED_UNIX_SOCKET_ENV = "LATITUDE_OFFLINE_BLOCKED_UNIX_SOCKET";
const SESSION_STORAGE_KEY = "latitude.browser-agent.session.v1";
const UI_STORAGE_KEY = "latitude.browser-ui-composition.v2:latitude-browser-live";
const CREATE_TURN =
  "OFFLINE_ACCEPT_CREATE_CLAIM_ACTION：请把这条显式低敏事实写成带当前消息收据的 claim，并创建一个包含触发条件、观察窗口、预期结果和未来 reviewAt 的行动。";
const LINK_TURN =
  "OFFLINE_ACCEPT_LINK_EVENT：相关证据事件已经发生。请用当前消息收据，把这个 EvidenceEvent 以 about / explicit_statement 应用到刚才的 claim。";
const CANDIDATE_TURN =
  "OFFLINE_ACCEPT_CANDIDATE_PROPOSE：请基于当前消息收据提出一个可共创候选；它不是结论，后续由我在页面上显式触碰和搁置。";
const UI_CUSTOMIZE_TURN =
  "OFFLINE_ACCEPT_UI_CUSTOMIZE：请用当前 UiSurfaceV2 的精确 revision，一次性隐藏命令栏，并解绑维度导航的 clue 动作。";
const CREATED_TEXT = "OFFLINE_AGENT_CREATED_CLAIM_AND_ACTION";
const LINKED_TEXT = "OFFLINE_AGENT_LINKED_EVENT";
const CANDIDATE_CREATED_TEXT = "OFFLINE_AGENT_CANDIDATE_PROPOSED";
const UI_CUSTOMIZED_TEXT = "OFFLINE_AGENT_UI_CUSTOMIZED";
const PUSH_TEXT = "OFFLINE_SCHEDULER_OUTCOME_PUSH";
const ACTION_LABEL = "离线验收：回收可审计结果";
const CANDIDATE_LABEL = "离线验收：先共创再决定";
const OUTCOME_TEXT = "离线验收真实结果：完整产品闭环按预期完成。";
const REVISED_STATEMENT = "有状态离线验收在保留收据时能稳定闭合。";
const WEB_QUERY = "离线本地 Agent 可审计认知闭环";
const WEB_TITLE = "离线验收：可审计认知闭环证据";
const DEFAULT_TIMEOUT_MS = 180_000;
let activeCleanup;

export async function runOfflineAcceptance(options = {}) {
  assertNode22(options.nodeVersion ?? process.versions.node);
  const osSandbox = options.osSandbox ?? readOsSandboxConfiguration(process.env);
  assert(
    osSandbox,
    "accept:offline must run inside its macOS sandbox-exec worker; no telemetry-only fallback is allowed",
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? process.env.LATITUDE_OFFLINE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "LATITUDE_OFFLINE_TIMEOUT_MS",
  );
  const keep = options.keep ?? process.env.LATITUDE_OFFLINE_KEEP === "1";
  const ports = {
    web: osSandbox.webPort,
    agent: osSandbox.agentPort,
    domain: osSandbox.domainPort,
  };
  const endpoints = {
    webPort: ports.web,
    agentPort: ports.agent,
    domainPort: ports.domain,
    webOrigin: `http://${HOST}:${ports.web}`,
    agentOrigin: `http://${HOST}:${ports.agent}`,
    domainOrigin: `http://${HOST}:${ports.domain}`,
  };
  const browserBinary = await resolveBrowserBinary(options.browserBinary);
  const fetchGuard = installProcessLoopbackFetchGuard();
  const sandbox = await createOwnedSandbox();
  const longLived = createResourceRegistry();
  let domainResources = createResourceRegistry();
  let agentResources = createResourceRegistry();
  let chromeResources = createResourceRegistry();
  let cdp;
  let browserFailures;
  let browserNetwork;
  let succeeded = false;
  let firstTelemetryPath;
  let clearedTelemetryPath;
  let restoredTelemetryPath;
  let networkTelemetryPath;
  let clearedNetworkTelemetryPath;
  let restoredNetworkTelemetryPath;

  const closeBrowser = async () => {
    browserNetwork?.dispose();
    browserFailures?.dispose();
    if (cdp) {
      await cdp.send("Browser.close").catch(() => undefined);
      // Browser.close is the persistence boundary for the owned profile;
      // allow LevelDB to flush before the process registry escalates signals.
      await delay(500);
    }
    await cdp?.close().catch(() => undefined);
    cdp = undefined;
    browserNetwork = undefined;
    browserFailures = undefined;
    await stopResources(chromeResources);
    chromeResources = createResourceRegistry();
  };
  const closeAgent = async () => {
    await stopResources(agentResources);
    agentResources = createResourceRegistry();
  };
  const closeDomain = async () => {
    await stopResources(domainResources);
    domainResources = createResourceRegistry();
  };
  const cleanup = async () => {
    await closeBrowser();
    await closeAgent();
    await closeDomain();
    await stopResources(longLived);
  };
  activeCleanup = cleanup;

  try {
    const agentDir = path.join(sandbox.root, "latitude-agent-offline");
    const telemetryDir = path.join(sandbox.root, "acceptance-telemetry");
    const downloadDir = path.join(sandbox.root, "browser-downloads");
    firstTelemetryPath = path.join(telemetryDir, "agent-first.json");
    clearedTelemetryPath = path.join(telemetryDir, "agent-cleared-restart.json");
    restoredTelemetryPath = path.join(telemetryDir, "agent-restored-restart.json");
    networkTelemetryPath = path.join(telemetryDir, "os-network-proof.json");
    clearedNetworkTelemetryPath = path.join(
      telemetryDir,
      "os-network-proof-cleared-restart.json",
    );
    restoredNetworkTelemetryPath = path.join(
      telemetryDir,
      "os-network-proof-restored-restart.json",
    );
    await Promise.all([
      mkdir(agentDir, { recursive: true, mode: 0o700 }),
      mkdir(telemetryDir, { recursive: true, mode: 0o700 }),
      mkdir(downloadDir, { recursive: true, mode: 0o700 }),
    ]);

    phase("start isolated real Domain, injected real Agent Host, and production Browser");
    const domain = startOfflineDomain(domainResources, sandbox, endpoints);
    await waitForJson(`${endpoints.domainOrigin}/health`, {
      timeoutMs,
      label: "isolated Domain",
      accept: (body) => body?.ok === true && body?.status === "ready",
      guard: () => assertChildRunning(domain, "offline Domain"),
    });
    const firstAgent = startOfflineAgent(
      agentResources,
      agentDir,
      firstTelemetryPath,
      networkTelemetryPath,
      endpoints,
    );
    await waitForOfflineAgent(firstAgent, timeoutMs, endpoints.agentOrigin);

    await runTrackedCommand(
      longLived,
      "offline-browser-build",
      path.join(process.cwd(), "node_modules", ".bin", "vite"),
      ["build"],
      {
        env: browserBuildEnvironment(process.env, endpoints),
        timeoutMs,
      },
    );
    const web = startTrackedProcess(
      longLived,
      "offline-browser-preview",
      "npm",
      [
        "run",
        "preview",
        "--",
        "--host",
        HOST,
        "--port",
        String(endpoints.webPort),
        "--strictPort",
      ],
      { env: withoutCredentials(process.env) },
    );
    await waitForLatitudePreview(endpoints.webOrigin, timeoutMs, web);
    ({ cdp, browserFailures, browserNetwork } = await launchBrowser({
      resources: chromeResources,
      browserBinary,
      profileDir: sandbox.chromeDir,
      timeoutMs,
      debugPort: osSandbox.cdpPort,
    }));
    await cdp.navigate(endpoints.webOrigin);
    await waitForProductReady(cdp, timeoutMs);
    assertBrowserGates(browserFailures, browserNetwork);

    phase("use the rendered conversation to persist a claim and four-field action");
    await sendBrowserMessage(cdp, CREATE_TURN);
    await cdp.waitForExpression(bodyIncludes(CREATED_TEXT), {
      description: "model-created claim/action reply",
      timeoutMs,
    });
    await cdp.waitForExpression(buttonWithAria(`完成：${ACTION_LABEL}`), {
      description: "model-created action projected into Browser",
      timeoutMs,
    });
    const sessionId = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(SESSION_STORAGE_KEY)})`,
    );
    assertString(sessionId, "Browser session id");
    let context = await readContext(endpoints.domainOrigin);
    const action = context.nodes.find((node) =>
      node.kind === "action" && node.label === ACTION_LABEL
    );
    assert(action, "action_create did not persist the expected action");
    const testsEdge = context.edges?.find((edge) =>
      edge.relationType === "tests" && edge.fromNodeId === action.id
    );
    const claimId = stringValue(testsEdge?.toNodeId);
    assertString(claimId, "action claimId");
    assertFourFieldAction(action);

    phase("link a new EvidenceEvent and let the real durable scheduler push the outcome clock");
    await sendBrowserMessage(cdp, LINK_TURN);
    await cdp.waitForExpression(bodyIncludes(LINKED_TEXT), {
      description: "event-location Agent reply",
      timeoutMs,
    });
    const outcomeOutbox = await waitForSchedulerItem(
      (item) => item.kind === "outcome_collection" && item.domainId === action.id,
      timeoutMs,
      endpoints.agentOrigin,
    );
    assert(
      outcomeOutbox.text.includes(PUSH_TEXT),
      "scheduler outcome item did not come from the injected DSH model loop",
    );
    await nudgeBrowserVisibility(cdp);
    await cdp.waitForExpression(bodyIncludes(PUSH_TEXT), {
      description: "Browser-rendered scheduler outcome push",
      timeoutMs: 30_000,
    });
    await waitForSchedulerAcknowledgement(
      outcomeOutbox.receiptKey,
      30_000,
      endpoints.agentOrigin,
    );
    context = await readContext(endpoints.domainOrigin);
    const event = context.nodes.find((node) =>
      node.kind === "evidence_event" && node.statement === LINK_TURN
    );
    assert(event, "second Browser conversation was not persisted as EvidenceEvent");
    const due = await getJson(
      `${endpoints.domainOrigin}/v1/actions/due?at=${encodeURIComponent(new Date().toISOString())}` +
        "&limit=100&sensitivityCeiling=low",
    );
    const eventDue = due.items?.find((item) => item.id === action.id);
    assert(eventDue?.dueReason === "linked_event", "action did not become due from linked event");
    assert(
      eventDue?.triggerEventReceipt?.eventNodeId === event.id,
      "event-clock receipt did not preserve the triggering EvidenceEvent id",
    );

    phase("submit the real result and cognitive revision through the rendered DOM");
    const opened = await cdp.evaluate(clickButtonWithAria(`完成：${ACTION_LABEL}`), {
      userGesture: true,
    });
    assert(opened === true, "projected action completion button was not clickable");
    await cdp.waitForExpression(
      "Boolean(document.querySelector('[role=\"dialog\"][aria-label=\"回收行动结果\"]'))",
      { description: "outcome collection dialog", timeoutMs: 10_000 },
    );
    await populateOutcomeRevision(cdp);
    const submitted = await cdp.evaluate(clickButtonText("写入真实结果"), {
      userGesture: true,
    });
    assert(submitted === true, "outcome submit button was not clickable");
    await cdp.waitForExpression(bodyIncludes("真实结果已回收"), {
      description: "Browser outcome completion notice",
      timeoutMs: 30_000,
    });
    context = await waitForContext((value) => {
      const completedAction = value.nodes.find((node) => node.id === action.id);
      const outcome = value.nodes.find((node) =>
        node.kind === "outcome" && node.outcome === OUTCOME_TEXT
      );
      const revision = value.nodes.find((node) =>
        node.kind === "claim" && node.statement === REVISED_STATEMENT
      );
      return completedAction?.status === "concluded" && Boolean(outcome && revision);
    }, 30_000, endpoints.domainOrigin);
    const revisedClaim = context.nodes.find((node) =>
      node.kind === "claim" && node.statement === REVISED_STATEMENT
    );
    assert(revisedClaim, "revises outcome did not create the versioned claim");

    phase("create a real weekly review, then persist Web whyNow through the rendered controls");
    const reviewClicked = await cdp.evaluate(clickButtonText("真实周回顾"), {
      userGesture: true,
    });
    assert(reviewClicked === true, "real weekly review button was not clickable");
    await cdp.waitForExpression(bodyIncludes("真实周回顾已由行动和结果生成"), {
      description: "weekly review completion notice",
      timeoutMs: 30_000,
    });
    context = await waitForContext(
      (value) => value.nodes.some((node) => node.label === "真实周回顾"),
      30_000,
      endpoints.domainOrigin,
    );
    const review = context.nodes.find((node) => node.label === "真实周回顾");
    assert(review, "Domain did not persist the real weekly review node");
    assert(
      Array.isArray(review.payload?.outcomes) && review.payload.outcomes.some((node) =>
        node.outcome === OUTCOME_TEXT
      ),
      "weekly review did not fold the Browser-recorded outcome",
    );

    await setBrowserInput(cdp, "搜索真实讯息", WEB_QUERY);
    const searched = await cdp.evaluate(clickButtonText("Web Search"), { userGesture: true });
    assert(searched === true, "Web Search button was not clickable");
    await cdp.waitForExpression(bodyIncludes(WEB_TITLE), {
      description: "rendered persisted Web result",
      timeoutMs: 30_000,
    });
    context = await waitForContext(
      (value) => value.nodes.some((node) =>
        node.kind === "resource" && node.label === WEB_TITLE &&
        typeof node.payload?.whyNow === "string" && node.payload.whyNow.trim()
      ),
      30_000,
      endpoints.domainOrigin,
    );
    const webResource = context.nodes.find((node) =>
      node.kind === "resource" && node.label === WEB_TITLE
    );
    assert(webResource, "Web result was not persisted as a Domain resource");
    const persistedWhyNow = stringValue(webResource.payload?.whyNow);
    assertString(persistedWhyNow, "persisted Web whyNow");
    assert(
      webResource.payload?.promptAuthority === "none" &&
        webResource.payload?.untrustedContent === true,
      "Web resource crossed the untrusted/no-prompt-authority boundary",
    );
    await cdp.waitForExpression(bodyIncludes(persistedWhyNow), {
      description: "Browser-rendered persisted whyNow",
      timeoutMs: 20_000,
    });
    assertBrowserGates(browserFailures, browserNetwork);

    phase("propose one evidence-grounded candidate, then touch and park it in the Browser");
    await sendBrowserMessage(cdp, CANDIDATE_TURN);
    await cdp.waitForExpression(bodyIncludes(CANDIDATE_CREATED_TEXT), {
      description: "model-proposed candidate reply",
      timeoutMs,
    });
    await cdp.waitForExpression(buttonWithAria(`触碰它：${CANDIDATE_LABEL}`), {
      description: "Browser-projected proposed candidate",
      timeoutMs: 30_000,
    });
    context = await waitForContext(
      (value) => value.nodes.some((node) =>
        node.label === CANDIDATE_LABEL && node.payload?.candidateState === "proposed"
      ),
      30_000,
      endpoints.domainOrigin,
    );
    const candidate = context.nodes.find((node) => node.label === CANDIDATE_LABEL);
    assert(candidate, "candidate_propose did not persist the expected candidate");
    const touched = await cdp.evaluate(
      clickButtonWithAria(`触碰它：${CANDIDATE_LABEL}`),
      { userGesture: true },
    );
    assert(touched === true, "Browser candidate touch action was not clickable");
    await cdp.waitForExpression(bodyIncludes("候选已触碰；这不是结论"), {
      description: "Browser candidate touch receipt",
      timeoutMs: 20_000,
    });
    await cdp.waitForExpression(buttonWithAria(`先搁置：${CANDIDATE_LABEL}`), {
      description: "Browser candidate park action after touch",
      timeoutMs: 20_000,
    });
    const parked = await cdp.evaluate(
      clickButtonWithAria(`先搁置：${CANDIDATE_LABEL}`),
      { userGesture: true },
    );
    assert(parked === true, "Browser candidate park action was not clickable");
    await cdp.waitForExpression(bodyIncludes("候选已搁置；没有把安静误写成否定或结论"), {
      description: "Browser candidate park receipt",
      timeoutMs: 20_000,
    });
    context = await waitForContext(
      (value) => value.nodes.some((node) =>
        node.id === candidate.id && node.status === "parked" &&
        node.payload?.candidateState === "parked"
      ),
      30_000,
      endpoints.domainOrigin,
    );
    assertBrowserGates(browserFailures, browserNetwork);

    phase("let the real Browser dialogue apply one auditable 15-component UI ChangeSet");
    await sendBrowserMessage(cdp, UI_CUSTOMIZE_TURN);
    await cdp.waitForExpression(bodyIncludes(UI_CUSTOMIZED_TEXT), {
      description: "model-authored UI customization reply",
      timeoutMs,
    });
    await cdp.waitForExpression(
      "!document.querySelector('[aria-label=\"跟秘书说话\"]')",
      { description: "AI-hidden Browser command bar", timeoutMs: 20_000 },
    );
    context = await waitForContext(
      (value) => value.nodes.some((node) =>
        node.kind === "resource" && node.payload?.resourceType === "ui_change_set" &&
        Array.isArray(node.payload?.operations)
      ),
      30_000,
      endpoints.domainOrigin,
    );
    const uiResource = context.nodes.find((node) =>
      node.kind === "resource" && node.payload?.resourceType === "ui_change_set"
    );
    assert(uiResource, "ui_customize did not persist its Domain resource receipt");
    assertUiResourceReceipt(uiResource);
    const domainChanges = await getJson(`${endpoints.domainOrigin}/v1/changes?limit=100`);
    const uiDomainChange = domainChanges.items?.find((change) =>
      change.reversible === true && Array.isArray(change.operations) &&
      change.operations.some((operation) =>
        operation.targetId === uiResource.id || operation.after?.id === uiResource.id
      )
    );
    assert(uiDomainChange, "Domain ChangeSet history omitted the UI resource receipt");
    const uiCompositionRaw = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(UI_STORAGE_KEY)})`,
    );
    assertString(uiCompositionRaw, "persisted Browser UiSurfaceV2");
    const uiComposition = JSON.parse(uiCompositionRaw);
    assertUiComposition(uiComposition, uiResource);
    assertBrowserGates(browserFailures, browserNetwork);

    phase("use the deep data-safety UI to export Domain, Agent, UI, and session together");
    await enableBrowserDownloads(cdp, downloadDir);
    await openDataSafetyPanel(cdp);
    await waitForEnabledButton(cdp, "检查数据完整性", 10_000);
    const integrityClicked = await cdp.evaluate(clickButtonText("检查数据完整性"), {
      userGesture: true,
    });
    assert(integrityClicked === true, "deep data-safety integrity button was not clickable");
    await cdp.waitForExpression(bodyIncludes("完整性检查通过。"), {
      description: "composite profile integrity notice",
      timeoutMs: 30_000,
    });
    await waitForEnabledButton(cdp, "下载完整导出", 10_000);
    const exportClicked = await cdp.evaluate(clickButtonText("下载完整导出"), {
      userGesture: true,
    });
    assert(exportClicked === true, "deep data-safety export button was not clickable");
    await cdp.waitForExpression(bodyIncludes("完整导出已生成并下载"), {
      description: "complete profile export notice",
      timeoutMs: 30_000,
    });
    const profileDownload = await waitForDownloadedJson(
      downloadDir,
      "latitude-full-export-",
      30_000,
    );
    const fullProfile = JSON.parse(await readFile(profileDownload, "utf8"));
    assertFullBrowserProfile(fullProfile, {
      sessionId,
      uiResource,
      uiComposition,
      claimId,
      actionId: action.id,
      candidateId: candidate.id,
      webResourceId: webResource.id,
      persistedWhyNow,
    });
    assertBrowserGates(browserFailures, browserNetwork);

    phase("clear all three owners through the production IndexedDB recovery gate");
    await completeDataSafetyOperation(cdp, {
      prepareLabel: "第一步：准备可恢复清空",
      preparedText: "完整可恢复备份已写入并读回",
      completedText: "可恢复清空已完成",
    });
    await waitForContext(
      (value) => !value.nodes.some((node) =>
        [claimId, action.id, candidate.id, revisedClaim.id, review.id, webResource.id, uiResource.id]
          .includes(node.id)
      ),
      30_000,
      endpoints.domainOrigin,
    );
    const clearedSessionBeforeRestart = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(SESSION_STORAGE_KEY)})`,
    );
    const clearedUiBeforeRestart = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(UI_STORAGE_KEY)})`,
    );
    assert(clearedSessionBeforeRestart === null, "recoverable clear retained Browser session id");
    assert(
      clearedUiBeforeRestart === null || clearedUiBeforeRestart !== uiCompositionRaw,
      "recoverable clear retained the customized Browser UI composition",
    );
    assertBrowserGates(browserFailures, browserNetwork);

    phase("restart Domain, Agent Host, and Browser in the cleared state");
    await closeBrowser();
    await closeAgent();
    await closeDomain();
    const clearedDomain = startOfflineDomain(domainResources, sandbox, endpoints);
    await waitForJson(`${endpoints.domainOrigin}/health`, {
      timeoutMs,
      label: "cleared restarted Domain",
      accept: (body) => body?.ok === true && body?.status === "ready",
      guard: () => assertChildRunning(clearedDomain, "cleared restarted Domain"),
    });
    const clearedAgent = startOfflineAgent(
      agentResources,
      agentDir,
      clearedTelemetryPath,
      clearedNetworkTelemetryPath,
      endpoints,
    );
    await waitForOfflineAgent(clearedAgent, timeoutMs, endpoints.agentOrigin);
    ({ cdp, browserFailures, browserNetwork } = await launchBrowser({
      resources: chromeResources,
      browserBinary,
      profileDir: sandbox.chromeDir,
      timeoutMs,
      debugPort: osSandbox.cdpPort,
    }));
    await cdp.navigate(endpoints.webOrigin);
    await waitForProductReady(cdp, timeoutMs, { requireCommandBar: false });
    const clearedSessionId = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(SESSION_STORAGE_KEY)})`,
    );
    assertString(clearedSessionId, "new Browser session after recoverable clear");
    assert(clearedSessionId !== sessionId, "cleared Browser reused the deleted session identity");
    const clearedUiAfterRestart = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(UI_STORAGE_KEY)})`,
    );
    assert(
      clearedUiAfterRestart === null || clearedUiAfterRestart !== uiCompositionRaw,
      "cleared Browser restart recovered the pre-clear customized UiSurfaceV2",
    );
    const clearedContext = await readContext(endpoints.domainOrigin);
    assert(
      !clearedContext.nodes.some((node) =>
        [claimId, action.id, candidate.id, revisedClaim.id, review.id, webResource.id, uiResource.id]
          .includes(node.id)
      ),
      "cleared Domain restart still exposed pre-clear product artifacts",
    );
    const clearedAgentExport = await getJson(
      `${endpoints.agentOrigin}/v1/agent/admin/export`,
    );
    assert(
      !JSON.stringify(clearedAgentExport).includes(CREATED_TEXT),
      "cleared Agent restart still exposed the original conversation",
    );
    assertBrowserGates(browserFailures, browserNetwork);

    phase("restore the IndexedDB recovery copy through the restarted production UI");
    await openDataSafetyPanel(cdp);
    await completeDataSafetyOperation(cdp, {
      prepareLabel: "第一步：恢复最近可恢复备份",
      preparedText: "已读回最近一次可恢复清空前的完整备份",
      completedText: "完整 profile 已恢复",
    });
    const restoredSessionBeforeRestart = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(SESSION_STORAGE_KEY)})`,
    );
    const restoredUiBeforeRestart = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(UI_STORAGE_KEY)})`,
    );
    assert(
      restoredSessionBeforeRestart === sessionId,
      "Browser restore did not reinstate the original session before restart",
    );
    assert(
      restoredUiBeforeRestart === uiCompositionRaw,
      "Browser restore did not reinstate the exact UiSurfaceV2 backup",
    );
    assertBrowserGates(browserFailures, browserNetwork);

    phase("restart all local owners again, then read every restored projection back");
    await closeBrowser();
    await closeAgent();
    await closeDomain();
    const restoredDomain = startOfflineDomain(domainResources, sandbox, endpoints);
    await waitForJson(`${endpoints.domainOrigin}/health`, {
      timeoutMs,
      label: "restored restarted Domain",
      accept: (body) => body?.ok === true && body?.status === "ready",
      guard: () => assertChildRunning(restoredDomain, "restored restarted Domain"),
    });
    const restoredAgent = startOfflineAgent(
      agentResources,
      agentDir,
      restoredTelemetryPath,
      restoredNetworkTelemetryPath,
      endpoints,
    );
    await waitForOfflineAgent(restoredAgent, timeoutMs, endpoints.agentOrigin);
    ({ cdp, browserFailures, browserNetwork } = await launchBrowser({
      resources: chromeResources,
      browserBinary,
      profileDir: sandbox.chromeDir,
      timeoutMs,
      debugPort: osSandbox.cdpPort,
    }));
    await cdp.navigate(endpoints.webOrigin);
    await waitForProductReady(cdp, timeoutMs, { requireCommandBar: false });
    await cdp.waitForExpression(bodyIncludes(REVISED_STATEMENT), {
      description: "restart-restored cognitive revision",
      timeoutMs,
    });
    await cdp.waitForExpression(bodyIncludes(WEB_TITLE), {
      description: "restart-restored Web resource",
      timeoutMs,
    });
    await cdp.waitForExpression(bodyIncludes(persistedWhyNow), {
      description: "restart-restored immutable whyNow",
      timeoutMs,
    });
    await cdp.waitForExpression(
      "!document.querySelector('[aria-label=\"跟秘书说话\"]')",
      { description: "restart-restored hidden command bar", timeoutMs: 20_000 },
    );
    const restoredUiCompositionRaw = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(UI_STORAGE_KEY)})`,
    );
    assert(
      restoredUiCompositionRaw === uiCompositionRaw,
      "Browser restart rewrote or lost the persisted UiSurfaceV2 CAS receipt",
    );
    const restoredSessionId = await cdp.evaluate(
      `window.localStorage.getItem(${JSON.stringify(SESSION_STORAGE_KEY)})`,
    );
    assert(restoredSessionId === sessionId, "Browser restart did not preserve session identity");
    await openSecretaryThread(cdp);
    await cdp.waitForExpression(
      `document.querySelector('[aria-label="与秘书的对话"]')?.innerText.includes(${JSON.stringify(CREATED_TEXT)}) && ` +
        `document.querySelector('[aria-label="与秘书的对话"]')?.innerText.includes(${JSON.stringify(LINKED_TEXT)}) && ` +
        `document.querySelector('[aria-label="与秘书的对话"]')?.innerText.includes(${JSON.stringify(CANDIDATE_CREATED_TEXT)}) && ` +
        `document.querySelector('[aria-label="与秘书的对话"]')?.innerText.includes(${JSON.stringify(UI_CUSTOMIZED_TEXT)})`,
      { description: "restart-restored Host conversation", timeoutMs: 30_000 },
    );
    const restoredContext = await readContext(endpoints.domainOrigin);
    const restoredWeb = restoredContext.nodes.find((node) => node.id === webResource.id);
    assert(
      restoredWeb?.payload?.whyNow === persistedWhyNow,
      "restart rewrote the historical Web whyNow",
    );
    assert(
      restoredContext.nodes.some((node) => node.id === review.id) &&
        restoredContext.nodes.some((node) => node.id === revisedClaim.id) &&
        restoredContext.nodes.some((node) =>
          node.id === candidate.id && node.payload?.candidateState === "parked"
        ) &&
        restoredContext.nodes.some((node) => node.id === uiResource.id),
      "restart lost weekly review, cognitive revision, parked candidate, or UI ChangeSet receipt",
    );

    phase("export both stores, verify integrity, and prove the no-network ledger");
    const [domainExport, domainIntegrity] = await Promise.all([
      getJson(`${endpoints.domainOrigin}/v1/admin/export`),
      getJson(`${endpoints.domainOrigin}/v1/admin/integrity`),
    ]);
    // Agent Host intentionally serializes quiescent snapshots. Export and
    // integrity must therefore be distinct read transactions, not Promise.all.
    const agentExport = await getJson(`${endpoints.agentOrigin}/v1/agent/admin/export`);
    const agentIntegrity = await getJson(`${endpoints.agentOrigin}/v1/agent/admin/integrity`);
    assert(domainIntegrity.ok === true, "Domain integrity gate failed");
    assert(agentIntegrity.ok === true, "Agent integrity gate failed");
    assertString(domainExport.checksum, "Domain export checksum");
    assertString(agentExport.checksum, "Agent export checksum");
    assert(
      JSON.stringify(domainExport).includes(webResource.id) &&
        JSON.stringify(domainExport).includes(persistedWhyNow) &&
        JSON.stringify(domainExport).includes(OUTCOME_TEXT),
      "Domain export omitted a required closure artifact",
    );
    assert(
      JSON.stringify(agentExport).includes(CREATED_TEXT) &&
        JSON.stringify(agentExport).includes(LINKED_TEXT) &&
        JSON.stringify(agentExport).includes(CANDIDATE_CREATED_TEXT) &&
        JSON.stringify(agentExport).includes(UI_CUSTOMIZED_TEXT),
      "Agent export omitted durable Browser conversation history",
    );
    const firstTelemetry = await readTelemetry(firstTelemetryPath);
    const clearedTelemetry = await readTelemetry(clearedTelemetryPath);
    const restoredTelemetry = await readTelemetry(restoredTelemetryPath);
    const networkTelemetry = await readTelemetry(networkTelemetryPath);
    const clearedNetworkTelemetry = await readTelemetry(clearedNetworkTelemetryPath);
    const restoredNetworkTelemetry = await readTelemetry(restoredNetworkTelemetryPath);
    assertOfflineTelemetry(firstTelemetry, { minimumWebSearchCalls: 1 });
    assertOfflineTelemetry(clearedTelemetry, {
      minimumWebSearchCalls: 0,
      minimumLlmCalls: 0,
    });
    assertOfflineTelemetry(restoredTelemetry, {
      minimumWebSearchCalls: 0,
      minimumLlmCalls: 0,
    });
    assertOsNetworkTelemetry(networkTelemetry, endpoints.domainOrigin);
    assertOsNetworkTelemetry(clearedNetworkTelemetry, endpoints.domainOrigin);
    assertOsNetworkTelemetry(restoredNetworkTelemetry, endpoints.domainOrigin);
    assert(
      firstTelemetry.requestedTools?.includes("ui_customize"),
      "real DSH loop did not execute ui_customize",
    );
    assert(
      firstTelemetry.requestedTools?.includes("candidate_propose"),
      "real DSH loop did not execute candidate_propose",
    );
    assert(fetchGuard.externalRequests.length === 0, "acceptance process attempted external fetch");
    assertBrowserGates(browserFailures, browserNetwork);
    await writeFile(
      path.join(sandbox.root, "acceptance-summary.json"),
      `${JSON.stringify({
        externalNetwork: false,
        osNetworkSandbox: true,
        networkBypassProbes:
          networkTelemetry.probes.length +
          clearedNetworkTelemetry.probes.length +
          restoredNetworkTelemetry.probes.length,
        rendered: true,
        productionBrowser: true,
        realDomain: true,
        realAgentHttp: true,
        realDshLoop: true,
        realScheduler: true,
        restarted: true,
        recoverableClear: true,
        restartSafeRestore: true,
        claimId,
        actionId: action.id,
        candidateId: candidate.id,
        eventNodeId: event.id,
        outcomeNodeId: context.nodes.find((node) => node.kind === "outcome")?.id,
        revisedClaimId: revisedClaim.id,
        reviewNodeId: review.id,
        webResourceId: webResource.id,
        uiResourceId: uiResource.id,
        uiDomainChangeSetId: uiDomainChange.id,
        uiRevision: uiComposition.document.revision,
        fullProfileChecksum: fullProfile.checksum,
        whyNow: persistedWhyNow,
        domainChecksum: domainExport.checksum,
        agentChecksum: agentExport.checksum,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    succeeded = true;
    logCheck("offline-product-acceptance", {
      externalNetwork: false,
      osNetworkSandbox: true,
      networkBypassProbes:
        networkTelemetry.probes.length +
        clearedNetworkTelemetry.probes.length +
        restoredNetworkTelemetry.probes.length,
      consoleExceptions: 0,
      fullClosure: true,
      restartReadback: true,
      exportIntegrity: true,
      uiCustomization: true,
      candidateLifecycle: true,
      completeProfileExport: true,
      recoverableClear: true,
      restartSafeRestore: true,
      realKey: false,
    });
  } catch (error) {
    if (cdp) {
      try {
        await writeFile(
          path.join(sandbox.root, "offline-acceptance-failure.png"),
          await cdp.captureScreenshot(),
          { mode: 0o600 },
        );
      } catch {
        // The screenshot is diagnostic and cannot replace the actual failure.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[accept-offline] FAILED: ${message}\n`);
    if (error && typeof error === "object") error.acceptOfflineReported = true;
    throw error;
  } finally {
    await cleanup();
    fetchGuard.restore();
    if (activeCleanup === cleanup) activeCleanup = undefined;
    if (succeeded && !keep) {
      await removeOwnedSandbox(sandbox);
      await assertPathAbsent(sandbox.root);
      process.stdout.write("[accept-offline] owned temporary sandbox cleaned\n");
    } else {
      process.stderr.write(`[accept-offline] diagnostic sandbox retained: ${sandbox.root}\n`);
    }
  }
}

function startOfflineDomain(resources, sandbox, endpoints) {
  return startTrackedProcess(
    resources,
    "offline-domain",
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "--offline",
      "--manifest-path",
      "src-tauri/domain-service/Cargo.toml",
      "--bin",
      "latitude-domain",
    ],
    {
      env: {
        ...withoutCredentials(process.env),
        LATITUDE_DB_PATH: sandbox.dbPath,
        LATITUDE_BACKUP_DIR: sandbox.backupDir,
        LATITUDE_DOMAIN_ADDR: `${HOST}:${endpoints.domainPort}`,
        LATITUDE_WEB_PORT: String(endpoints.webPort),
        CARGO_TARGET_DIR:
          process.env.LATITUDE_OFFLINE_CARGO_TARGET_DIR?.trim() ||
          path.join(os.tmpdir(), "latitude-domain-target"),
      },
    },
  );
}

function startOfflineAgent(
  resources,
  stateDir,
  telemetryPath,
  networkTelemetryPath,
  endpoints,
) {
  return startTrackedProcess(
    resources,
    "offline-agent",
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/accept-offline-agent.ts",
      `--telemetry-file=${telemetryPath}`,
      `--network-telemetry-file=${networkTelemetryPath}`,
    ],
    {
      env: {
        ...withoutCredentials(process.env),
        LATITUDE_STATE_DIR: stateDir,
        LATITUDE_AGENT_PORT: String(endpoints.agentPort),
        LATITUDE_DOMAIN_URL: endpoints.domainOrigin,
        LATITUDE_WEB_PORT: String(endpoints.webPort),
        LATITUDE_SCHEDULER_POLL_MS: "300000",
        LATITUDE_COMPACTION_EVENT_THRESHOLD: "20000",
      },
    },
  );
}

async function waitForOfflineAgent(agent, timeoutMs, agentOrigin) {
  const health = await waitForJson(`${agentOrigin}/health`, {
    timeoutMs,
    label: "offline Agent Host",
    guard: () => assertChildRunning(agent, "offline Agent Host"),
    accept: (body) =>
      body?.status === "ready" &&
      body?.domain?.healthy === true &&
      body?.model?.provider === "latitude-offline-acceptance" &&
      body?.model?.configured === true,
  });
  assert(
    health.model?.authentication === "unverified" ||
      health.model?.authentication === "accepted",
    "fresh offline Host reported a provider authentication failure",
  );
}

async function launchBrowser({
  resources,
  browserBinary,
  profileDir,
  timeoutMs,
  debugPort,
}) {
  const chrome = startTrackedProcess(
    resources,
    "offline-chrome",
    browserBinary,
    [
      ...chromeArguments(profileDir, debugPort),
      // Chrome's renderer Seatbelt cannot nest inside sandbox-exec on macOS.
      // The whole acceptance process tree is already constrained by the
      // fail-closed exact-port OS profile before Chrome is spawned.
      "--no-sandbox",
      "--disable-gpu",
      "--disable-crash-reporter",
    ],
    { env: withoutCredentials(process.env), printOutput: false },
  );
  const target = await waitForPageTarget(debugPort, timeoutMs, chrome);
  const cdp = await BrowserCdp.connect(target.webSocketDebuggerUrl, {
    connectTimeoutMs: 10_000,
    commandTimeoutMs: 15_000,
  });
  await cdp.enablePageRuntime();
  const browserFailures = installBrowserFailureTracker(cdp);
  const browserNetwork = await installLoopbackNetworkGuard(cdp);
  await Promise.all([
    cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1_440,
      height: 1_100,
      deviceScaleFactor: 1,
      mobile: false,
    }),
    cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    }),
  ]);
  return { cdp, browserFailures, browserNetwork };
}

async function waitForProductReady(cdp, timeoutMs, options = {}) {
  const requireCommandBar = options.requireCommandBar ?? true;
  await cdp.waitForExpression(
    `(() => {
      const service = document.querySelector('[aria-label="本地服务状态"]')?.textContent ?? '';
      const commandBar = Boolean(document.querySelector('[aria-label="跟秘书说话"]'));
      return service.includes('图谱 已连接') && service.includes('Agent 已连接') &&
        Boolean(document.querySelector('[aria-label="秘书栏"]')) &&
        commandBar === ${JSON.stringify(requireCommandBar)};
    })()`,
    { description: "production Browser with both real services", timeoutMs },
  );
}

async function sendBrowserMessage(cdp, value) {
  await setBrowserInput(cdp, "跟秘书说话", value);
  await cdp.waitForExpression(
    `(() => {
      const button = document.querySelector('button[aria-label="发送"]');
      return Boolean(button && !button.disabled);
    })()`,
    { description: "enabled Browser conversation send button", timeoutMs: 5_000 },
  );
  const clicked = await cdp.evaluate(clickButtonWithAria("发送"), { userGesture: true });
  assert(clicked === true, "Browser conversation send button was not clickable");
}

async function setBrowserInput(cdp, ariaLabel, value) {
  const changed = await cdp.evaluate(
    `(() => {
      const input = document.querySelector('[aria-label=${JSON.stringify(ariaLabel)}]');
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
      const prototype = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    { userGesture: true },
  );
  assert(changed === true, `Browser input ${ariaLabel} was not writable`);
}

async function populateOutcomeRevision(cdp) {
  const initial = await cdp.evaluate(
    `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="回收行动结果"]');
      const input = dialog?.querySelector('[aria-label="实际结果"]');
      const select = dialog?.querySelector('[aria-label="对认知的影响"]');
      if (!(input instanceof HTMLTextAreaElement) || !(select instanceof HTMLSelectElement)) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
        input,
        ${JSON.stringify(OUTCOME_TEXT)},
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'revises');
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    { userGesture: true },
  );
  assert(initial === true, "outcome/effect controls were not writable");
  await cdp.waitForExpression(
    "Boolean(document.querySelector('[role=\"dialog\"] [aria-label=\"认知修订\"]'))",
    { description: "cognitive revision textarea", timeoutMs: 5_000 },
  );
  await setBrowserInput(cdp, "认知修订", REVISED_STATEMENT);
  await cdp.waitForExpression(
    `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="回收行动结果"]');
      const button = [...(dialog?.querySelectorAll('button') ?? [])]
        .find((candidate) => candidate.textContent?.trim() === '写入真实结果');
      return Boolean(button && !button.disabled);
    })()`,
    { description: "enabled outcome revision submit", timeoutMs: 5_000 },
  );
}

async function nudgeBrowserVisibility(cdp) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await cdp.evaluate(
      "document.dispatchEvent(new Event('visibilitychange')); true",
      { userGesture: true },
    );
    await delay(200);
  }
}

async function openSecretaryThread(cdp) {
  const result = await cdp.evaluate(
    `(() => {
      const chat = [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === '聊聊' && !button.disabled);
      if (chat) { chat.click(); return 'chat'; }
      const restore = document.querySelector('button[aria-label="唤回秘书"]');
      if (restore && !restore.disabled) { restore.click(); return 'restore'; }
      const expand = document.querySelector('button[aria-label="展开秘书栏"]');
      if (expand && !expand.disabled) { expand.click(); return 'expand'; }
      const portrait = document.querySelector('button[aria-label="跟她说句话"]');
      if (portrait && !portrait.disabled) { portrait.click(); return 'portrait'; }
      return false;
    })()`,
    { userGesture: true },
  );
  assert(result, "secretary chat affordance was unavailable after restart");
  if (result !== "chat") {
    if (result === "restore" || result === "expand") {
      await cdp.waitForExpression(
        "Boolean(document.querySelector('button[aria-label=\"跟她说句话\"]'))",
        { description: "visible secretary rail portrait", timeoutMs: 5_000 },
      );
      const opened = await cdp.evaluate(clickButtonWithAria("跟她说句话"), {
        userGesture: true,
      });
      assert(opened === true, "secretary rail portrait was not clickable");
    }
    await cdp.waitForExpression(
      `(() => [...document.querySelectorAll('button')]
        .some((button) => button.textContent?.trim() === '聊聊' && !button.disabled))()`,
      { description: "secretary chat action", timeoutMs: 5_000 },
    );
    const chatted = await cdp.evaluate(clickButtonText("聊聊"), { userGesture: true });
    assert(chatted === true, "secretary chat action was not clickable");
  }
}

async function openDataSafetyPanel(cdp) {
  const alreadyOpen = await cdp.evaluate(
    "Boolean(document.querySelector('[role=\"dialog\"][aria-label=\"数据与安全\"]'))",
  );
  if (alreadyOpen) return;
  const openedSecretary = await cdp.evaluate(
    `(() => {
      if ([...document.querySelectorAll('button')]
        .some((button) => button.textContent?.trim() === '设置' && !button.disabled)) return true;
      const restore = document.querySelector('button[aria-label="唤回秘书"]');
      if (restore && !restore.disabled) { restore.click(); return true; }
      const expand = document.querySelector('button[aria-label="展开秘书栏"]');
      if (expand && !expand.disabled) { expand.click(); return true; }
      return true;
    })()`,
    { userGesture: true },
  );
  assert(openedSecretary === true, "secretary settings entry was unavailable");
  await cdp.waitForExpression(
    `(() => [...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === '设置' && !button.disabled))()`,
    { description: "secretary settings action", timeoutMs: 5_000 },
  );
  const settingsClicked = await cdp.evaluate(clickButtonText("设置"), { userGesture: true });
  assert(settingsClicked === true, "secretary settings action was not clickable");
  await cdp.waitForExpression(
    "Boolean(document.querySelector('[role=\"dialog\"][aria-label=\"本地服务诊断\"]'))",
    { description: "deep local-service diagnostics", timeoutMs: 5_000 },
  );
  const dataSafetyClicked = await cdp.evaluate(clickButtonText("数据与安全…"), {
    userGesture: true,
  });
  assert(dataSafetyClicked === true, "data-safety deep entry was not clickable");
  await cdp.waitForExpression(
    "Boolean(document.querySelector('[role=\"dialog\"][aria-label=\"数据与安全\"]'))",
    { description: "deep data-safety dialog", timeoutMs: 5_000 },
  );
}

async function waitForEnabledButton(cdp, label, timeoutMs) {
  await cdp.waitForExpression(
    `(() => [...document.querySelectorAll('button')].some((button) =>
      button.textContent?.trim() === ${JSON.stringify(label)} && !button.disabled
    ))()`,
    { description: `enabled ${label} button`, timeoutMs },
  );
}

async function completeDataSafetyOperation(cdp, options) {
  await waitForEnabledButton(cdp, options.prepareLabel, 10_000);
  const prepared = await cdp.evaluate(clickButtonText(options.prepareLabel), {
    userGesture: true,
  });
  assert(prepared === true, `${options.prepareLabel} was not clickable`);
  await cdp.waitForExpression(
    `document.body.innerText.includes(${JSON.stringify(options.preparedText)}) && ` +
      "Boolean(document.querySelector('[aria-label=\"危险操作确认短语\"]'))",
    { description: `${options.prepareLabel} durable preparation`, timeoutMs: 30_000 },
  );
  const confirmation = await cdp.evaluate(
    `(() => {
      const input = document.querySelector('[aria-label="危险操作确认短语"]');
      const section = input?.closest('section');
      return section?.querySelector('strong')?.textContent?.trim() || null;
    })()`,
  );
  assertString(confirmation, `${options.prepareLabel} confirmation phrase`);
  await setBrowserInput(cdp, "危险操作确认短语", confirmation);
  await waitForEnabledButton(cdp, "第二步：确认执行", 5_000);
  const committed = await cdp.evaluate(clickButtonText("第二步：确认执行"), {
    userGesture: true,
  });
  assert(committed === true, `${options.prepareLabel} second stage was not clickable`);
  await cdp.waitForExpression(
    `document.body.innerText.includes(${JSON.stringify(options.completedText)})`,
    { description: `${options.prepareLabel} complete receipt`, timeoutMs: 45_000 },
  );
  return confirmation;
}

async function enableBrowserDownloads(cdp, downloadDir) {
  const request = {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true,
  };
  try {
    await cdp.send("Browser.setDownloadBehavior", request);
  } catch {
    await cdp.send("Page.setDownloadBehavior", request);
  }
}

async function waitForDownloadedJson(downloadDir, prefix, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "no files";
  while (Date.now() < deadline) {
    const names = await readdir(downloadDir);
    const candidates = names.filter((name) =>
      name.startsWith(prefix) && name.endsWith(".json") && !name.endsWith(".crdownload")
    );
    for (const name of candidates) {
      const file = path.join(downloadDir, name);
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size === 0) continue;
        JSON.parse(await readFile(file, "utf8"));
        return file;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    }
    if (candidates.length === 0) last = `files=${names.join(",") || "none"}`;
    await delay(100);
  }
  throw new Error(`complete profile download timed out: ${last}`);
}

async function readContext(domainOrigin) {
  return postJson(`${domainOrigin}/v1/context`, {
    limit: 500,
    includeRetracted: true,
  });
}

async function waitForContext(predicate, timeoutMs, domainOrigin) {
  const deadline = Date.now() + timeoutMs;
  let last = "not queried";
  while (Date.now() < deadline) {
    try {
      const context = await readContext(domainOrigin);
      if (predicate(context)) return context;
      last = `nodes=${context.nodes?.length ?? 0}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
  }
  throw new Error(`Domain context readback timed out: ${last}`);
}

async function waitForSchedulerItem(predicate, timeoutMs, agentOrigin) {
  const deadline = Date.now() + timeoutMs;
  let last = "not queried";
  while (Date.now() < deadline) {
    const outbox = await getJson(`${agentOrigin}/v1/scheduler/outbox`);
    const found = outbox.items?.find(predicate);
    if (found) return found;
    last = `items=${outbox.items?.length ?? 0}`;
    await delay(200);
  }
  throw new Error(`Scheduler outbox timed out: ${last}`);
}

async function waitForSchedulerAcknowledgement(receiptKey, timeoutMs, agentOrigin) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outbox = await getJson(`${agentOrigin}/v1/scheduler/outbox`);
    const found = outbox.items?.find((item) => item.receiptKey === receiptKey);
    if (found?.deliveryStatus === "acknowledged") return found;
    await delay(150);
  }
  throw new Error("Browser did not acknowledge the scheduler outcome push");
}

function assertFourFieldAction(action) {
  assertString(action.expectedOutcome, "action expectedOutcome");
  assertString(action.payload?.trigger, "action trigger");
  assert(
    action.payload?.observationWindow && typeof action.payload.observationWindow === "object",
    "action observationWindow is missing",
  );
  assertString(action.reviewAt, "action reviewAt");
  assert(
    Date.parse(action.reviewAt) > Date.now() + 7 * 86_400_000,
    "action reviewAt is not a future calendar fallback",
  );
}

function assertUiResourceReceipt(resource) {
  const payload = resource.payload;
  assert(payload?.schemaVersion === 2, "UI Domain receipt is not UiSurfaceV2");
  assert(
    payload?.surfaceId === "latitude-browser-live" &&
      payload?.baseLayoutId === "latitude-browser-live",
    "UI Domain receipt targets the wrong Browser surface",
  );
  assert(
    Number.isInteger(payload?.baseRevision) && payload.baseRevision >= 0,
    "UI Domain receipt omitted its exact CAS baseRevision",
  );
  assert(
    payload?.actor === "model" && payload?.authorization === "preauthorized",
    "UI Domain receipt lost model/preauthorized provenance",
  );
  assert(Array.isArray(payload?.operations) && payload.operations.length === 2,
    "UI Domain receipt did not preserve the atomic two-operation ChangeSet");
  assert(
    payload.operations.some((operation) =>
      operation?.op === "set_visibility" && operation.componentId === "command-bar" &&
      operation.visible === false
    ),
    "UI Domain receipt omitted command-bar visibility",
  );
  assert(
    payload.operations.some((operation) =>
      operation?.op === "bind_action" && operation.componentId === "dimension-navigation" &&
      operation.event === "clue" && operation.commandId === null
    ),
    "UI Domain receipt omitted the navigation binding change",
  );
}

function assertUiComposition(value, resource) {
  const document = value?.document;
  const changes = value?.changes;
  assert(document?.schemaVersion === 2 && document?.id === "latitude-browser-live",
    "Browser did not persist the expected UiSurfaceV2 document");
  assert(Array.isArray(document.components) && document.components.length === 15,
    "Browser UiSurfaceV2 does not contain the registered 15 components");
  assert(
    document.revision === resource.payload.baseRevision + 1,
    "Browser UiSurfaceV2 revision did not advance exactly once from Domain CAS",
  );
  const commandBar = document.components.find((component) => component.id === "command-bar");
  const navigation = document.components.find((component) =>
    component.id === "dimension-navigation"
  );
  assert(commandBar?.visible === false, "Browser did not apply command-bar visibility to the DOM");
  assert(
    navigation && !("clue" in (navigation.actions ?? {})),
    "Browser did not remove the registered navigation clue binding",
  );
  assert(Array.isArray(changes) && changes.length >= 1,
    "Browser UiSurfaceV2 omitted its local reversible change history");
  const applied = changes.at(-1);
  assert(
    applied?.sourceRunId === resource.id && applied?.actor === "model" &&
      applied?.authorization === "preauthorized",
    "Browser UI receipt lost the Domain node provenance or authorization",
  );
  assert(
    applied?.beforeRevision === resource.payload.baseRevision &&
      applied?.afterRevision === document.revision,
    "Browser UI receipt does not match the Domain/Browser CAS boundary",
  );
}

function assertFullBrowserProfile(profile, expected) {
  assert(
    profile?.format === "latitude.browser-profile@1" && profile?.schemaVersion === 1,
    "deep data-safety export is not a complete Latitude Browser profile",
  );
  assertString(profile.checksum, "complete profile checksum");
  assertString(profile.domain?.checksum, "complete profile Domain checksum");
  assertString(profile.agent?.checksum, "complete profile Agent checksum");
  assert(
    profile.browserState?.agentSessionId === expected.sessionId,
    "complete profile lost the active Browser/Agent session identity",
  );
  assert(
    profile.uiComposition?.format === "latitude.browser-ui-composition@0.2",
    "complete profile omitted the V2 UI composition backup",
  );
  const uiDocument = profile.uiComposition.documents?.["latitude-browser-live"];
  assert(uiDocument, "complete profile omitted latitude-browser-live");
  assertUiComposition(uiDocument, expected.uiResource);
  assert(
    uiDocument.document.revision === expected.uiComposition.document.revision,
    "complete profile UI revision differs from the rendered Browser revision",
  );
  const serialized = JSON.stringify(profile);
  for (const [label, value] of [
    ["claim", expected.claimId],
    ["action", expected.actionId],
    ["candidate", expected.candidateId],
    ["Web resource", expected.webResourceId],
    ["Web whyNow", expected.persistedWhyNow],
    ["UI resource", expected.uiResource.id],
    ["outcome", OUTCOME_TEXT],
    ["cognitive revision", REVISED_STATEMENT],
    ["Agent UI reply", UI_CUSTOMIZED_TEXT],
  ]) {
    assert(serialized.includes(value), `complete profile omitted ${label}`);
  }
}

export async function allocateDistinctLoopbackPorts(
  allocator = allocateLoopbackPort,
) {
  const selected = [];
  for (let attempt = 0; selected.length < 3 && attempt < 24; attempt += 1) {
    const candidate = await allocator();
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65_535) {
      throw new Error(`loopback port allocator returned an invalid port: ${candidate}`);
    }
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  if (selected.length !== 3) {
    throw new Error("could not allocate three distinct loopback acceptance ports");
  }
  return { web: selected[0], agent: selected[1], domain: selected[2] };
}

export function buildNetworkSandboxProfile(options = {}) {
  const inboundPorts = validatedPorts(options.inboundPorts ?? [], "inboundPorts");
  const outboundPorts = validatedPorts(options.outboundPorts ?? [], "outboundPorts");
  const lines = [
    "(version 1)",
    "(allow default)",
    // Chrome headless owns a per-profile ProcessSingleton Unix listener. Unix
    // outbound remains denied below; TCP/UDP listeners are port-allowlisted.
    "(deny network-inbound (local tcp \"*:*\"))",
    "(deny network-inbound (local udp \"*:*\"))",
    "(deny network-outbound)",
  ];
  for (const port of inboundPorts) {
    lines.push(`(allow network-inbound (local tcp "localhost:${port}"))`);
  }
  for (const port of outboundPorts) {
    lines.push(`(allow network-outbound (remote tcp "localhost:${port}"))`);
  }
  return `${lines.join("\n")}\n`;
}

function readOsSandboxConfiguration(environment) {
  if (environment[OS_SANDBOX_MARKER] !== "1") return undefined;
  const raw = environment[RESERVED_PORTS_ENV];
  if (typeof raw !== "string") {
    throw new Error("OS-sandboxed offline worker is missing its reserved ports");
  }
  const ports = raw.split(",").map(Number);
  if (ports.length !== 4) {
    throw new Error("OS-sandboxed offline worker requires web, Agent, Domain, and CDP ports");
  }
  const [webPort, agentPort, domainPort, cdpPort] = validatedPorts(
    ports,
    RESERVED_PORTS_ENV,
  );
  if (new Set(ports).size !== 4) {
    throw new Error("OS-sandboxed offline worker ports must be distinct");
  }
  return { webPort, agentPort, domainPort, cdpPort };
}

function validatedPorts(values, label) {
  const result = [...new Set(values)];
  for (const value of result) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error(`${label} contains an invalid TCP port: ${value}`);
    }
  }
  return result;
}

function browserBuildEnvironment(environment, endpoints) {
  const safe = withoutCredentials(environment);
  safe.VITE_LATITUDE_AGENT_URL = endpoints.agentOrigin;
  safe.VITE_LATITUDE_DOMAIN_URL = endpoints.domainOrigin;
  return safe;
}

export function installProcessLoopbackFetchGuard(nativeFetch = globalThis.fetch) {
  const original = globalThis.fetch;
  const externalRequests = [];
  let loopbackRequests = 0;
  const guarded = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    let url;
    try {
      url = new URL(raw);
    } catch {
      externalRequests.push(raw);
      throw new Error(`Offline acceptance blocked an invalid fetch target: ${raw}`);
    }
    if (!isLoopbackHttpUrl(url)) {
      externalRequests.push(url.href);
      throw new Error(`Offline acceptance blocked external fetch to ${url.origin}`);
    }
    loopbackRequests += 1;
    return nativeFetch(input, init);
  };
  globalThis.fetch = guarded;
  return {
    externalRequests,
    get loopbackRequests() {
      return loopbackRequests;
    },
    restore() {
      if (globalThis.fetch === guarded) globalThis.fetch = original;
    },
  };
}

export function isLoopbackHttpUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  return url.protocol === "http:" && (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]"
  );
}

export function assertOfflineTelemetry(value, options = {}) {
  assert(value?.mode === "hermetic-offline-acceptance", "telemetry mode mismatch");
  assert(value?.inheritedCredentials === false, "offline child inherited credentials");
  assert(value?.syntheticHealthCredential === true, "offline child health sentinel missing");
  assert(value?.osNetworkProbeChild === true, "offline Agent did not launch its OS network proof child");
  assert(value?.externalNetworkCalls === 0, "offline Agent attempted external network");
  assert(
    Number.isInteger(value?.llmCalls) &&
      value.llmCalls >= (options.minimumLlmCalls ?? 1),
    "real DSH loop did not call adapter",
  );
  assert(
    Number.isInteger(value?.webSearchCalls) &&
      value.webSearchCalls >= (options.minimumWebSearchCalls ?? 0),
    "offline Web provider call count is below acceptance minimum",
  );
  return true;
}

export function assertOsNetworkTelemetry(value, domainOrigin) {
  assert(
    value?.mode === "macos-sandbox-exec-network-proof" &&
      value?.osSandboxEnforced === true && value?.externalNetwork === false,
    "OS network proof did not report a fail-closed sandbox",
  );
  assert(
    value?.allowedLoopbackFetch === true && value?.allowedLoopbackOrigin === domainOrigin,
    "OS network proof could not reach the exact allowed Domain port",
  );
  const expected = new Set([
    "fetch",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "global:WebSocket",
    "undici:request",
    "undici:Client",
    "child_process:node-net",
    "loopback:unknown-port",
    "dns:udp53",
    "unix:outbound",
  ]);
  assert(Array.isArray(value?.probes) && value.probes.length === expected.size,
    "OS network proof did not execute every required bypass probe");
  for (const probe of value.probes) {
    assert(expected.delete(probe?.label), `unexpected or duplicate network probe: ${probe?.label}`);
    assert(
      probe?.blocked === true && ["EPERM", "EACCES"].includes(probe?.code),
      `network probe ${probe?.label} was not denied by the OS sandbox`,
    );
  }
  assert(expected.size === 0, "OS network proof omitted a bypass protocol");
  return true;
}

async function readTelemetry(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function assertBrowserGates(failures, network) {
  failures.assertEmpty();
  network.assertExternalNetworkFalse();
}

function bodyIncludes(value) {
  return `document.body.innerText.includes(${JSON.stringify(value)})`;
}

function buttonWithAria(value) {
  return `Boolean(document.querySelector('button[aria-label=${JSON.stringify(value)}]'))`;
}

function clickButtonWithAria(value) {
  return `(() => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(value)}]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

function clickButtonText(value) {
  return `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(value)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

async function assertPathAbsent(target) {
  try {
    await stat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`owned temporary sandbox still exists after cleanup: ${target}`);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function assertString(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} must be a non-empty string`);
}

function positiveInteger(raw, fallback, name) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function phase(message) {
  process.stdout.write(`\n[accept-offline] ${message}\n`);
}

function logCheck(label, value) {
  process.stdout.write(`[accept-offline] ${label}: ${JSON.stringify(value)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (process.env[OS_SANDBOX_MARKER] !== "1") {
    process.exitCode = await launchOsSandboxedWorker();
    return;
  }
  let interrupted = false;
  const exitForSignal = async (signal, code) => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write(`[accept-offline] received ${signal}; cleaning owned resources\n`);
    await activeCleanup?.().catch(() => undefined);
    process.exit(code);
  };
  const onSigint = () => void exitForSignal("SIGINT", 130);
  const onSigterm = () => void exitForSignal("SIGTERM", 143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await runOfflineAcceptance();
  } catch (error) {
    if (!error?.acceptOfflineReported) {
      process.stderr.write(
        `[accept-offline] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

async function launchOsSandboxedWorker() {
  if (process.platform !== "darwin") {
    throw new Error(
      "accept:offline requires macOS sandbox-exec for fail-closed network isolation; no weaker fallback is allowed",
    );
  }
  await stat(SANDBOX_EXEC);
  const ports = await allocateDistinctLoopbackPorts();
  let cdpPort;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const candidate = await allocateLoopbackPort();
    if (![ports.web, ports.agent, ports.domain].includes(candidate)) {
      cdpPort = candidate;
      break;
    }
  }
  assert(Number.isInteger(cdpPort), "could not allocate a distinct loopback CDP port");
  const allPorts = [ports.web, ports.agent, ports.domain, cdpPort];
  const deniedUnixProbe = await createDeniedUnixProbeServer();
  const profile = buildNetworkSandboxProfile({
    inboundPorts: allPorts,
    outboundPorts: allPorts,
  });
  const environment = withoutCredentials(process.env);
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  environment[OS_SANDBOX_MARKER] = "1";
  environment[RESERVED_PORTS_ENV] = allPorts.join(",");
  environment[BLOCKED_UNIX_SOCKET_ENV] = deniedUnixProbe.socketPath;
  const worker = spawn(
    SANDBOX_EXEC,
    ["-p", profile, process.execPath, ...process.argv.slice(1)],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    },
  );
  let forwardedSignal;
  const forward = (signal) => {
    forwardedSignal = signal;
    worker.kill(signal);
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (forwardedSignal || result.signal) {
      return forwardedSignal === "SIGINT" || result.signal === "SIGINT" ? 130 : 143;
    }
    return Number.isInteger(result.code) ? result.code : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await deniedUnixProbe.close();
  }
}

async function createDeniedUnixProbeServer() {
  const root = await mkdtemp(path.join(os.tmpdir(), "latitude-offline-denied-unix-"));
  const socketPath = path.join(root, "listener.sock");
  const server = net.createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  let closePromise;
  return {
    socketPath,
    close() {
      closePromise ??= new Promise((resolve) => {
        server.close(() => resolve());
      }).finally(() => rm(root, { recursive: true, force: true }));
      return closePromise;
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
