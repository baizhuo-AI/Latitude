import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  BrowserCdp,
  installBrowserFailureTracker,
  installLoopbackNetworkGuard,
} from "./browser-cdp.mjs";
import { scanCredentialArtifacts } from "./scan-credential-artifacts.mjs";

const WORKSPACE = process.cwd();
const HOST = "127.0.0.1";
const SANDBOX_PREFIX = "latitude-browser-accept-";
const OWNER_FILE = ".latitude-browser-acceptance-owner.json";
const ACTION_LABEL = "Browser smoke：回收一条真实结果";
const OUTCOME_TEXT = "Browser smoke 已通过真实页面写回结果。";
const DEFAULT_TIMEOUT_MS = 90_000;
let activeSignalCleanup;

export async function runBrowserSmoke(options = {}) {
  assertNode22(options.nodeVersion ?? process.versions.node);
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? process.env.LATITUDE_BROWSER_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "LATITUDE_BROWSER_TIMEOUT_MS",
  );
  const keep = options.keep ?? process.env.LATITUDE_BROWSER_KEEP === "1";
  const browserBinary = await resolveBrowserBinary(options.browserBinary);
  const sandbox = await createOwnedSandbox();
  const resources = createResourceRegistry();
  let cdp;
  let failureTracker;
  let networkGuard;
  let succeeded = false;
  const cleanupOwnedResources = async () => {
    networkGuard?.dispose();
    failureTracker?.dispose();
    await cdp?.close().catch(() => undefined);
    await stopResources(resources);
  };
  activeSignalCleanup = cleanupOwnedResources;

  try {
    resources.portReservations = await reserveSmokePorts();
    const endpoints = smokeEndpoints(resources.portReservations.ports);
    phase(
      `use owned random loopback ports (Browser ${endpoints.webPort}, ` +
        `Agent ${endpoints.agentPort}, Domain ${endpoints.domainPort})`,
    );

    phase("start isolated Domain and explicit Agent test double");
    await resources.portReservations.release("domain");
    const domain = startTrackedProcess(
      resources,
      "domain",
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
            process.env.LATITUDE_BROWSER_CARGO_TARGET_DIR?.trim() ||
            path.join(os.tmpdir(), "latitude-domain-target"),
        },
      },
    );
    await resources.portReservations.release("agent");
    resources.agentStub = await startAgentStub({
      host: HOST,
      port: endpoints.agentPort,
      webOrigin: endpoints.webOrigin,
      domainOrigin: endpoints.domainOrigin,
    });
    await waitForJson(`${endpoints.domainOrigin}/health`, {
      timeoutMs,
      label: "isolated Domain",
      accept: (body) => body?.ok === true && body?.status === "ready",
      guard: () => assertChildRunning(domain, "Domain"),
    });
    await waitForJson(`${endpoints.agentOrigin}/health`, {
      timeoutMs,
      label: "Agent test double",
      accept: (body) => body?.status === "ready" && body?.testDouble === true,
    });
    assertChildRunning(domain, "Domain");

    phase("seed one due action through the production Domain API");
    const fixture = await seedDueAction(endpoints.domainOrigin, sandbox.nonce);

    phase("build and serve the production Browser bundle with isolated service URLs");
    await runTrackedCommand(
      resources,
      "browser-build",
      "npm",
      [
        "run",
        "build",
        "--",
        "--outDir",
        sandbox.browserDist,
        "--emptyOutDir",
      ],
      { env: browserBuildEnvironment(process.env, endpoints), timeoutMs },
    );
    const artifactScan = await scanCredentialArtifacts({
      workspace: sandbox.root,
      roots: ["browser-dist"],
      requiredRoots: ["browser-dist"],
    });
    logCheck("temporary-browser-artifact-scan", artifactScan);
    await resources.portReservations.release("web");
    resources.web = startTrackedProcess(
      resources,
      "web",
      "npm",
      [
        "run",
        "preview",
        "--",
        "--outDir",
        sandbox.browserDist,
        "--host",
        HOST,
        "--port",
        String(endpoints.webPort),
        "--strictPort",
      ],
      { env: withoutCredentials(process.env) },
    );
    await waitForLatitudePreview(endpoints.webOrigin, timeoutMs, resources.web);
    assertChildRunning(resources.web, "Browser preview");

    phase("launch system Chrome and verify the rendered Domain loop");
    const debugPort = await allocateLoopbackPort();
    resources.chrome = startTrackedProcess(
      resources,
      "chrome",
      browserBinary,
      chromeArguments(sandbox.chromeDir, debugPort),
      { env: withoutCredentials(process.env), printOutput: false },
    );
    const pageTarget = await waitForPageTarget(debugPort, timeoutMs, resources.chrome);
    cdp = await BrowserCdp.connect(pageTarget.webSocketDebuggerUrl, {
      connectTimeoutMs: 10_000,
      commandTimeoutMs: 15_000,
    });
    await cdp.enablePageRuntime();
    failureTracker = installBrowserFailureTracker(cdp);
    networkGuard = await installLoopbackNetworkGuard(cdp);
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
    await cdp.navigate(endpoints.webOrigin);
    await cdp.waitForExpression(
      browserReadyExpression(ACTION_LABEL),
      { description: "Latitude service state, due action, and companion", timeoutMs },
    );
    await delay(250);
    failureTracker.assertEmpty();
    networkGuard.assertExternalNetworkFalse();
    await writeFile(sandbox.beforeScreenshot, await cdp.captureScreenshot(), {
      mode: 0o600,
    });

    phase("submit one real outcome through the rendered Browser UI");
    const opened = await cdp.evaluate(openOutcomeDialogExpression(ACTION_LABEL), {
      userGesture: true,
    });
    assert(opened === true, "rendered due-action completion button was not clickable");
    await cdp.waitForExpression(
      "Boolean(document.querySelector('[role=\"dialog\"][aria-label=\"回收行动结果\"]'))",
      { description: "outcome dialog" },
    );
    const populated = await cdp.evaluate(populateOutcomeExpression(OUTCOME_TEXT), {
      userGesture: true,
    });
    assert(populated === true, "outcome form could not be populated through the rendered DOM");
    await cdp.waitForExpression(
      `(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="回收行动结果"]');
        const button = [...(dialog?.querySelectorAll('button') ?? [])]
          .find((item) => item.textContent?.includes('写入真实结果'));
        return Boolean(button && !button.disabled);
      })()`,
      { description: "enabled outcome submit button" },
    );
    const submitted = await cdp.evaluate(
      `(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="回收行动结果"]');
        const button = [...(dialog?.querySelectorAll('button') ?? [])]
          .find((item) => item.textContent?.includes('写入真实结果'));
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`,
      { userGesture: true },
    );
    assert(submitted === true, "outcome submit button was not clickable");
    const readback = await waitForOutcomeReadback(
      endpoints.domainOrigin,
      fixture.actionId,
      OUTCOME_TEXT,
      20_000,
    );
    await cdp.waitForExpression(
      `document.body.innerText.includes(${JSON.stringify("真实结果已回收")})`,
      { description: "Browser outcome completion notice", timeoutMs: 20_000 },
    );
    await delay(250);
    failureTracker.assertEmpty();
    networkGuard.assertExternalNetworkFalse();
    await writeFile(sandbox.afterScreenshot, await cdp.captureScreenshot(), {
      mode: 0o600,
    });
    assert(
      resources.agentStub.unknownRequests.length === 0,
      `Browser called unsupported Agent stub route(s): ${resources.agentStub.unknownRequests.join(", ")}`,
    );
    const integrity = await getJson(`${endpoints.domainOrigin}/v1/admin/integrity`);
    assert(integrity.ok === true, "Domain integrity failed after Browser outcome write");
    succeeded = true;
    logCheck("browser-smoke", {
      browser: path.basename(browserBinary),
      actionId: fixture.actionId,
      outcomeNodeId: readback.outcomeNode.id,
      agent: "explicit-local-test-double",
      externalNetwork: false,
      ports: "owned-random-loopback",
      rendered: true,
      screenshotGate: false,
    });
  } catch (error) {
    if (cdp) {
      try {
        await writeFile(sandbox.failureScreenshot, await cdp.captureScreenshot(), {
          mode: 0o600,
        });
      } catch {
        // Failure screenshot is diagnostic only and cannot hide the real error.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[accept-browser] FAILED: ${message}\n`);
    if (error && typeof error === "object") error.acceptBrowserReported = true;
    printRecentOutput(resources);
    throw error;
  } finally {
    await cleanupOwnedResources();
    if (activeSignalCleanup === cleanupOwnedResources) activeSignalCleanup = undefined;
    if (succeeded && !keep) {
      await removeOwnedSandbox(sandbox);
      process.stdout.write("[accept-browser] isolated sandbox cleaned\n");
    } else {
      process.stderr.write(
        `[accept-browser] diagnostic sandbox retained: ${sandbox.root}\n`,
      );
    }
  }
}

export function assertNode22(version) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "0", 10);
  if (major !== 22) throw new Error(`Browser smoke requires Node 22.x; current ${version}`);
}

export async function startAgentStub(options = {}) {
  const host = options.host ?? HOST;
  const port = options.port ?? 0;
  const webOrigin = options.webOrigin;
  const domainOrigin = options.domainOrigin;
  assertLoopbackOrigin(webOrigin, "Agent stub Browser origin");
  assertLoopbackOrigin(domainOrigin, "Agent stub Domain origin");
  const unknownRequests = [];
  const requests = [];
  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin && origin !== webOrigin) {
      writeStubJson(response, 403, {
        error: { code: "origin_forbidden", message: "Browser smoke origin is not allowed" },
      });
      return;
    }
    response.setHeader("vary", "Origin");
    if (origin) response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type,idempotency-key");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url || "/", `http://${host}`);
    const key = `${request.method} ${url.pathname}`;
    requests.push(key);
    if (request.method === "GET" && url.pathname === "/health") {
      writeStubJson(response, 200, {
        status: "ready",
        service: "latitude-agent-browser-smoke-test-double",
        apiVersion: "v1",
        testDouble: true,
        outboundNetwork: false,
        model: { provider: "none", id: "none", configured: false },
        domain: { url: domainOrigin, healthy: true },
      });
      return;
    }
    const messagesMatch = url.pathname.match(/^\/v1\/agent\/sessions\/([^/]+)\/messages$/u);
    if (request.method === "GET" && messagesMatch) {
      writeStubJson(response, 200, {
        sessionId: decodeURIComponent(messagesMatch[1]),
        messages: [],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/scheduler/outbox") {
      writeStubJson(response, 200, { items: [] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/scheduler/wake") {
      writeStubJson(response, 202, { ok: true, accepted: true, testDouble: true });
      return;
    }
    unknownRequests.push(key);
    writeStubJson(response, 404, {
      error: {
        code: "test_double_route_not_implemented",
        message: "This explicit Agent test double implements only Browser bootstrap routes",
      },
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, resolve);
  });
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  return {
    host,
    port: resolvedPort,
    origin: `http://${host}:${resolvedPort}`,
    requests,
    unknownRequests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

export async function createOwnedSandbox() {
  const nonce = randomUUID();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX)));
  const marker = {
    owner: "latitude-browser-acceptance",
    nonce,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(root, OWNER_FILE), `${JSON.stringify(marker)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const domainDir = path.join(root, "domain");
  const backupDir = path.join(domainDir, "backups");
  const chromeDir = path.join(root, "chrome-profile");
  const browserDist = path.join(root, "browser-dist");
  await Promise.all([
    mkdir(backupDir, { recursive: true, mode: 0o700 }),
    mkdir(chromeDir, { recursive: true, mode: 0o700 }),
    mkdir(browserDist, { recursive: true, mode: 0o700 }),
  ]);
  const sandbox = {
    root,
    nonce,
    domainDir,
    backupDir,
    chromeDir,
    browserDist,
    dbPath: path.join(domainDir, "latitude-domain.db"),
    beforeScreenshot: path.join(root, "browser-before.png"),
    afterScreenshot: path.join(root, "browser-after.png"),
    failureScreenshot: path.join(root, "browser-failure.png"),
  };
  await assertOwnedSandbox(sandbox);
  return sandbox;
}

export async function assertOwnedSandbox(sandbox) {
  const root = path.resolve(sandbox.root);
  const tempRoot = `${await realpath(os.tmpdir())}${path.sep}`;
  assert(root.startsWith(tempRoot), "Browser acceptance sandbox is outside the system temp root");
  assert(
    path.basename(root).startsWith(SANDBOX_PREFIX),
    "Browser acceptance sandbox prefix mismatch",
  );
  const rootMetadata = await lstat(root);
  assert(
    rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(),
    "Browser acceptance sandbox is not a real directory",
  );
  assert((await realpath(root)) === root, "Browser acceptance sandbox resolves through a symlink");
  const marker = JSON.parse(await readFile(path.join(root, OWNER_FILE), "utf8"));
  assert(marker.owner === "latitude-browser-acceptance", "Browser sandbox owner mismatch");
  assert(marker.nonce === sandbox.nonce, "Browser sandbox nonce mismatch");
  for (const target of [
    sandbox.domainDir,
    sandbox.backupDir,
    sandbox.chromeDir,
    sandbox.browserDist,
    sandbox.dbPath,
    sandbox.beforeScreenshot,
    sandbox.afterScreenshot,
    sandbox.failureScreenshot,
  ]) {
    const relative = path.relative(root, path.resolve(target));
    assert(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      `Browser sandbox target escaped owned root: ${target}`,
    );
  }
}

export async function removeOwnedSandbox(sandbox) {
  await assertOwnedSandbox(sandbox);
  await rm(sandbox.root, { recursive: true, force: false, maxRetries: 2 });
}

export function createResourceRegistry() {
  return {
    children: [],
    agentStub: undefined,
    portReservations: undefined,
    web: undefined,
    chrome: undefined,
    stopPromise: undefined,
  };
}

async function seedDueAction(domainOrigin, nonce) {
  const now = Date.now();
  const requestId = `browser-smoke-action-${nonce}`;
  const response = await postJson(
    `${domainOrigin}/v1/actions`,
    {
      clientRequestId: requestId,
      label: ACTION_LABEL,
      statement: "Use the rendered Browser to record one deterministic acceptance outcome.",
      expectedOutcome: OUTCOME_TEXT,
      trigger: "When the isolated Browser smoke page is ready",
      observationWindow: {
        startsAt: new Date(now - 2 * 60 * 60_000).toISOString(),
        endsAt: new Date(now - 60 * 60_000).toISOString(),
      },
      reviewAt: new Date(now - 30 * 60_000).toISOString(),
      payload: { acceptanceFixture: true, fixtureNonce: nonce },
      scope: { profile: "isolated-browser-smoke" },
      sensitivity: "medium",
      audit: {
        actor: "user",
        sessionId: `browser-smoke-${nonce}`,
        turnId: "seed-action",
        authorizationMode: "automatic",
      },
    },
    { idempotencyKey: requestId },
  );
  const actionId = response?.value?.action?.id;
  assert(typeof actionId === "string" && actionId, "Domain seed did not return an action id");
  return { actionId };
}

async function waitForOutcomeReadback(domainOrigin, actionId, outcomeText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "not queried";
  while (Date.now() < deadline) {
    try {
      const context = await postJson(`${domainOrigin}/v1/context`, {
        kinds: ["action", "outcome"],
        includeRetracted: true,
        limit: 50,
      });
      const actionNode = context.nodes?.find((node) => node.id === actionId);
      const outcomeNode = context.nodes?.find(
        (node) =>
          node.kind === "outcome" &&
          (node.statement === outcomeText || node.outcome === outcomeText),
      );
      if (
        actionNode?.status === "concluded" &&
        actionNode?.outcome === outcomeText &&
        outcomeNode
      ) {
        return { actionNode, outcomeNode };
      }
      last = JSON.stringify({
        actionStatus: actionNode?.status,
        actionOutcome: actionNode?.outcome,
        outcomeFound: Boolean(outcomeNode),
      });
    } catch (error) {
      last = errorMessage(error);
    }
    await delay(150);
  }
  throw new Error(`Domain outcome readback timed out: ${last}`);
}

function browserReadyExpression(actionLabel) {
  return `(() => {
    const service = document.querySelector('[aria-label="本地服务状态"]')?.textContent ?? '';
    const action = [...document.querySelectorAll('button')]
      .some((item) => item.getAttribute('aria-label') === ${JSON.stringify(`完成：${actionLabel}`)});
    const secretaryRail = document.querySelector('[aria-label="秘书栏"]');
    return service.includes('图谱 已连接') && service.includes('Agent 已连接') && action && Boolean(secretaryRail);
  })()`;
}

function openOutcomeDialogExpression(actionLabel) {
  return `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.getAttribute('aria-label') === ${JSON.stringify(`完成：${actionLabel}`)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

function populateOutcomeExpression(outcomeText) {
  return `(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="回收行动结果"]');
    const input = dialog?.querySelector('[aria-label="实际结果"]');
    const select = dialog?.querySelector('[aria-label="对认知的影响"]');
    if (!input || !select) return false;
    const inputPrototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(inputPrototype, 'value').set.call(
      input,
      ${JSON.stringify(outcomeText)},
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'unknown');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

export function chromeArguments(profileDir, debugPort) {
  return [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--remote-allow-origins=*",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    "--window-size=1440,1100",
    "about:blank",
  ];
}

export async function resolveBrowserBinary(explicit) {
  const configured = explicit ?? process.env.LATITUDE_BROWSER_BIN?.trim();
  const candidates = configured
    ? [configured]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      if (configured) throw new Error("LATITUDE_BROWSER_BIN must be an absolute executable path");
      continue;
    }
    try {
      await access(candidate, fsConstants.X_OK);
      const metadata = await stat(candidate);
      if (metadata.isFile()) return candidate;
    } catch {
      // Try the next known system-browser location.
    }
  }
  throw new Error(
    "No supported system Chrome/Edge binary found. Set LATITUDE_BROWSER_BIN to an absolute executable path.",
  );
}

export async function waitForPageTarget(debugPort, timeoutMs, chrome) {
  const deadline = Date.now() + timeoutMs;
  let last = "DevTools endpoint not ready";
  while (Date.now() < deadline) {
    assertChildRunning(chrome, "Chrome");
    try {
      const response = await fetch(`http://${HOST}:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string",
      );
      if (page) return page;
      last = "Chrome has no page target";
    } catch (error) {
      last = errorMessage(error);
    }
    await delay(100);
  }
  throw new Error(`Chrome DevTools target timed out: ${last}`);
}

export async function waitForLatitudePreview(origin, timeoutMs, web) {
  const deadline = Date.now() + timeoutMs;
  let last = "not started";
  while (Date.now() < deadline) {
    assertChildRunning(web, "Browser preview");
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
      const html = await response.text();
      if (
        response.ok &&
        /<title>维度 Latitude<\/title>/u.test(html) &&
        /<div\s+id=["']root["']><\/div>/u.test(html)
      ) {
        return;
      }
      last = `HTTP ${response.status} without Latitude signatures`;
    } catch (error) {
      last = errorMessage(error);
    }
    await delay(150);
  }
  throw new Error(`Browser preview health timed out: ${last}`);
}

export async function waitForJson(url, options) {
  const deadline = Date.now() + options.timeoutMs;
  let last = "not started";
  while (Date.now() < deadline) {
    options.guard?.();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      const body = await response.json();
      if (response.ok && options.accept(body)) return body;
      last = `HTTP ${response.status}: ${JSON.stringify(body)}`;
    } catch (error) {
      last = errorMessage(error);
    }
    await delay(150);
  }
  throw new Error(`${options.label} health timed out: ${last}`);
}

export async function postJson(url, body, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`POST ${new URL(url).pathname} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(
      `POST ${new URL(url).pathname} failed HTTP ${response.status}: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`GET ${new URL(url).pathname} failed HTTP ${response.status}`);
  return value;
}

export function startTrackedProcess(resources, name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: WORKSPACE,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: false,
  });
  const tracked = { name, child, recent: [] };
  child.on("error", (error) => {
    tracked.spawnError = error;
    tracked.recent.push(`spawn error: ${errorMessage(error)}`);
  });
  resources.children.push(tracked);
  captureOutput(tracked, child.stdout, process.stdout, options.printOutput !== false);
  captureOutput(tracked, child.stderr, process.stderr, options.printOutput !== false);
  return tracked;
}

export async function runTrackedCommand(resources, name, command, args, options = {}) {
  const tracked = startTrackedProcess(resources, name, command, args, options);
  const result = await waitForChild(tracked.child, options.timeoutMs);
  if (result.signal || result.code !== 0) {
    throw new Error(`${name} failed (${result.signal ?? result.code ?? "unknown"})`);
  }
  return tracked;
}

function captureOutput(tracked, stream, output, print) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      tracked.recent.push(line);
      if (tracked.recent.length > 60) tracked.recent.shift();
      if (print) output.write(`[accept-browser:${tracked.name}] ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (!pending) return;
    tracked.recent.push(pending);
    if (print) output.write(`[accept-browser:${tracked.name}] ${pending}\n`);
  });
}

function waitForChild(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = timeoutMs
      ? setTimeout(() => reject(new Error("Child process timed out")), timeoutMs)
      : undefined;
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

export function assertChildRunning(tracked, label) {
  if (tracked.spawnError) throw new Error(`${label} failed to start: ${errorMessage(tracked.spawnError)}`);
  if (tracked.child.exitCode !== null || tracked.child.signalCode !== null) {
    throw new Error(`${label} stopped before Browser acceptance`);
  }
}

export async function stopResources(resources) {
  if (resources.stopPromise) return resources.stopPromise;
  resources.stopPromise = (async () => {
    await resources.portReservations?.releaseAll().catch(() => undefined);
    const children = [...resources.children].reverse();
    for (const tracked of children) signalOwnedProcess(tracked.child, "SIGTERM");
    await Promise.allSettled(children.map((tracked) => waitForExitWithin(tracked.child, 3_000)));
    for (const tracked of children) signalOwnedProcess(tracked.child, "SIGKILL");
    await Promise.allSettled(children.map((tracked) => waitForExitWithin(tracked.child, 1_000)));
    await resources.agentStub?.close().catch(() => undefined);
  })();
  return resources.stopPromise;
}

function signalOwnedProcess(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function waitForExitWithin(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function printRecentOutput(resources) {
  for (const tracked of resources.children) {
    if (tracked.recent.length === 0) continue;
    process.stderr.write(`[accept-browser] ${tracked.name} recent output:\n`);
    for (const line of tracked.recent.slice(-15)) process.stderr.write(`  ${line}\n`);
  }
}

export function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port)) reject(new Error("OS did not allocate a debug port"));
        else resolve(port);
      });
    });
  });
}

export async function reserveSmokePorts(options = {}) {
  const host = options.host ?? HOST;
  const entries = new Map();
  try {
    for (const name of ["web", "agent", "domain"]) {
      const server = net.createServer();
      server.unref();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port: 0, exclusive: true }, resolve);
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      if (!Number.isInteger(port)) {
        await closeServer(server);
        throw new Error(`OS did not allocate a ${name} acceptance port`);
      }
      entries.set(name, { server, port });
    }
  } catch (error) {
    await Promise.allSettled([...entries.values()].map((entry) => closeServer(entry.server)));
    throw error;
  }

  const release = async (name) => {
    const entry = entries.get(name);
    if (!entry) return;
    entries.delete(name);
    await closeServer(entry.server);
  };
  return {
    ports: Object.fromEntries(
      [...entries.entries()].map(([name, entry]) => [name, entry.port]),
    ),
    release,
    async releaseAll() {
      await Promise.allSettled([...entries.keys()].map((name) => release(name)));
    },
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function smokeEndpoints(ports) {
  return {
    webPort: ports.web,
    agentPort: ports.agent,
    domainPort: ports.domain,
    webOrigin: `http://${HOST}:${ports.web}`,
    agentOrigin: `http://${HOST}:${ports.agent}`,
    domainOrigin: `http://${HOST}:${ports.domain}`,
  };
}

export function browserBuildEnvironment(environment, endpoints) {
  return {
    ...withoutCredentials(environment),
    VITE_LATITUDE_AGENT_URL: endpoints.agentOrigin,
    VITE_LATITUDE_DOMAIN_URL: endpoints.domainOrigin,
  };
}

function assertLoopbackOrigin(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an explicit loopback HTTP origin`);
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.port
  ) {
    throw new Error(`${label} must be an explicit loopback HTTP origin`);
  }
}

function writeStubJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
}

export function withoutCredentials(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/iu.test(name),
    ),
  );
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
  process.stdout.write(`\n[accept-browser] ${message}\n`);
}

function logCheck(label, value) {
  process.stdout.write(`[accept-browser] ${label}: ${JSON.stringify(value)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  let interrupted = false;
  const exitForSignal = async (signal, exitCode) => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write(`[accept-browser] received ${signal}; owned resources will be cleaned safely\n`);
    await activeSignalCleanup?.().catch(() => undefined);
    process.exit(exitCode);
  };
  const onSigint = () => void exitForSignal("SIGINT", 130);
  const onSigterm = () => void exitForSignal("SIGTERM", 143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await runBrowserSmoke();
  } catch (error) {
    if (!error?.acceptBrowserReported) {
      process.stderr.write(`[accept-browser] FAILED: ${errorMessage(error)}\n`);
    }
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
