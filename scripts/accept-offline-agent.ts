import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Context } from "@deepseek-ai/cordis";
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from "@deepseek-ai/dsh-web";
import { startAgentHost } from "../services/agent/src/index.js";

const PROVIDER_ID = "latitude-offline-acceptance";
const CREATE_MARKER = "OFFLINE_ACCEPT_CREATE_CLAIM_ACTION";
const LINK_MARKER = "OFFLINE_ACCEPT_LINK_EVENT";
const CANDIDATE_MARKER = "OFFLINE_ACCEPT_CANDIDATE_PROPOSE";
const UI_CUSTOMIZE_MARKER = "OFFLINE_ACCEPT_UI_CUSTOMIZE";
const CREATED_TEXT = "OFFLINE_AGENT_CREATED_CLAIM_AND_ACTION";
const LINKED_TEXT = "OFFLINE_AGENT_LINKED_EVENT";
const CANDIDATE_CREATED_TEXT = "OFFLINE_AGENT_CANDIDATE_PROPOSED";
const UI_CUSTOMIZED_TEXT = "OFFLINE_AGENT_UI_CUSTOMIZED";
const OUTCOME_PUSH_TEXT =
  "OFFLINE_SCHEDULER_OUTCOME_PUSH：请对照记录的预期，回收这次行动真实发生的结果。";
const SYNTHETIC_HEALTH_CREDENTIAL = "offline-acceptance-not-a-real-credential";

interface Telemetry {
  schemaVersion: 1;
  mode: "hermetic-offline-acceptance";
  startedAt: string;
  inheritedCredentials: false;
  syntheticHealthCredential: true;
  externalNetworkCalls: number;
  loopbackFetchCalls: number;
  llmCalls: number;
  webSearchCalls: number;
  requestedTools: string[];
  osNetworkProbeChild: true;
  claimId?: string;
  actionId?: string;
  candidateId?: string;
  eventNodeId?: string;
}

const telemetryPath = requiredArgument("--telemetry-file");
const networkTelemetryPath = requiredArgument("--network-telemetry-file");
const telemetry: Telemetry = {
  schemaVersion: 1,
  mode: "hermetic-offline-acceptance",
  startedAt: new Date().toISOString(),
  inheritedCredentials: false,
  syntheticHealthCredential: true,
  externalNetworkCalls: 0,
  loopbackFetchCalls: 0,
  llmCalls: 0,
  webSearchCalls: 0,
  requestedTools: [],
  osNetworkProbeChild: true,
};
let telemetryWrite: Promise<void> = Promise.resolve();

assertNoInheritedCredentials(process.env);
await runOsNetworkProbeChild(networkTelemetryPath);
installLoopbackOnlyFetchGuard();
// Agent health still models the production DeepSeek credential switch. This
// fixed non-secret sentinel only opens that health gate inside this dedicated
// executable; the injected adapter below owns every model call.
process.env.DEEPSEEK_API_KEY = SYNTHETIC_HEALTH_CREDENTIAL;
await persistTelemetry();

const adapter = createStatefulOfflineAdapter();
const webSearchProvider = createStatefulOfflineWebProvider();
const host = await startAgentHost({
  runtime: {
    adapter,
    installOfficialWebSearch: false,
    webSearchProvider,
  },
});

process.stdout.write(`${JSON.stringify({
  service: "latitude-offline-acceptance-agent",
  status: "listening",
  url: host.address.url,
  provider: PROVIDER_ID,
  realCredential: false,
  externalNetwork: false,
})}\n`);

let closing: Promise<void> | undefined;
const close = () => {
  closing ??= (async () => {
    await host.close();
    await persistTelemetry();
  })();
  return closing;
};
const shutdown = () => {
  void close().then(
    () => {
      process.exitCode = 0;
    },
    () => {
      process.exitCode = 1;
    },
  );
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function createStatefulOfflineAdapter() {
  let callSequence = 0;

  class OfflineAdapter extends LlmAdapter {
    override resolveModel(provider: string, model: string) {
      return Promise.resolve({ provider, id: model, name: model });
    }

    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      telemetry.llmCalls += 1;
      await persistTelemetry();
      if (options.signal?.aborted) throw options.signal.reason;
      if (options.purpose) {
        yield* textStream("OFFLINE_AUXILIARY_SUMMARY");
        return;
      }

      const sessionId = String(options.sessionId ?? "");
      if (sessionId === "latitude:scheduler:outcomes") {
        yield* textStream(OUTCOME_PUSH_TEXT);
        return;
      }
      if (sessionId.startsWith("latitude:scheduler:")) {
        yield* textStream(`OFFLINE_SCHEDULER_NOOP:${sessionId}`);
        return;
      }

      const currentUserIndex = findCurrentUserIndex(options.messages);
      const currentText = currentUserIndex >= 0
        ? plainText(options.messages[currentUserIndex]!)
        : "";
      const currentExecutions = toolExecutions(options.messages.slice(currentUserIndex + 1));
      const allExecutions = toolExecutions(options.messages);
      const receipt = evidenceReceipt(options.system);

      if (currentText.includes(CREATE_MARKER)) {
        const memory = currentExecutions.find((execution) =>
          execution.name === "knowledge_remember" && !execution.isError
        );
        if (!memory) {
          requireEvidenceReceipt(receipt, CREATE_MARKER);
          yield* toolCallStream(
            ++callSequence,
            "knowledge_remember",
            {
              label: "离线验收：收据让闭环可审计",
              statement: "带持久收据的离线闭环能够保留事实来源与修订历史。",
              kind: "claim",
              payload: { acceptanceFixture: true, mode: "hermetic-offline" },
              confidence: 0.9,
              evidenceRefs: [receipt!.evidenceRefId],
              reason: "当前用户消息已先由 Host 持久化，再允许模型写入低敏推断。",
              scope: { profile: "isolated-offline-acceptance" },
              sensitivity: "low",
            },
          );
          return;
        }
        const claimId = nodeIdFromToolResult(memory.value, "knowledge_remember");
        telemetry.claimId = claimId;
        const action = currentExecutions.find((execution) =>
          execution.name === "action_create" && !execution.isError
        );
        if (!action) {
          const now = Date.now();
          const reviewAt = new Date(now + 30 * 86_400_000).toISOString();
          yield* toolCallStream(
            ++callSequence,
            "action_create",
            {
              label: "离线验收：回收可审计结果",
              statement: "从浏览器完成一次事件触发的真实结果回收。",
              expectedOutcome: "浏览器收到 Host 推送，并写入结果与认知修订。",
              trigger: "相关证据事件被应用到被检验认知时",
              observationWindow: {
                startsAt: new Date(now).toISOString(),
                endsAt: new Date(now + 7 * 86_400_000).toISOString(),
              },
              reviewAt,
              payload: { acceptanceFixture: true, eventPreemptsCalendar: true },
              scope: { profile: "isolated-offline-acceptance" },
              sensitivity: "low",
              claimId,
            },
          );
          return;
        }
        telemetry.actionId = actionIdFromToolResult(action.value);
        await persistTelemetry();
        yield* textStream(CREATED_TEXT);
        return;
      }

      if (currentText.includes(LINK_MARKER)) {
        requireEvidenceReceipt(receipt, LINK_MARKER);
        const location = currentExecutions.find((execution) =>
          execution.name === "apply_location" && !execution.isError
        );
        if (!location) {
          const priorMemory = [...allExecutions].reverse().find((execution) =>
            execution.name === "knowledge_remember" && !execution.isError
          );
          const claimId = telemetry.claimId ?? (
            priorMemory ? nodeIdFromToolResult(priorMemory.value, "knowledge_remember") : undefined
          );
          if (!claimId) throw new Error("Offline adapter cannot link an event without the prior claim id");
          telemetry.claimId = claimId;
          telemetry.eventNodeId = receipt!.eventNodeId;
          await persistTelemetry();
          yield* toolCallStream(
            ++callSequence,
            "apply_location",
            {
              eventNodeId: receipt!.eventNodeId,
              starCenterNodeId: claimId,
              relationType: "about",
              evidenceRefs: [receipt!.evidenceRefId],
              basis: "explicit_statement",
              proximity: "direct",
              strength: "strong",
              rationale:
                "当前持久化用户消息明确表示相关证据事件已发生，并用于触发这个被检验认知的行动时钟。",
            },
          );
          return;
        }
        yield* textStream(LINKED_TEXT);
        return;
      }

      if (currentText.includes(CANDIDATE_MARKER)) {
        requireEvidenceReceipt(receipt, CANDIDATE_MARKER);
        const proposal = currentExecutions.find((execution) =>
          execution.name === "candidate_propose" && !execution.isError
        );
        if (!proposal) {
          yield* toolCallStream(
            ++callSequence,
            "candidate_propose",
            {
              label: "离线验收：先共创再决定",
              statement: "先把离线闭环的复用方式作为候选触碰，再由用户决定是否继续。",
              sourceNodeIds: telemetry.claimId ? [telemetry.claimId] : [],
              evidenceRefs: [receipt!.evidenceRefId],
              payload: { acceptanceFixture: true, explicitUserTransitionOnly: true },
              scope: { profile: "isolated-offline-acceptance" },
              sensitivity: "low",
            },
          );
          return;
        }
        telemetry.candidateId = candidateIdFromToolResult(proposal.value);
        await persistTelemetry();
        yield* textStream(CANDIDATE_CREATED_TEXT);
        return;
      }

      if (currentText.includes(UI_CUSTOMIZE_MARKER)) {
        const customization = currentExecutions.find((execution) =>
          execution.name === "ui_customize" && !execution.isError
        );
        if (!customization) {
          const surface = browserSurfaceReceipt(options.system);
          yield* toolCallStream(
            ++callSequence,
            "ui_customize",
            {
              schemaVersion: 2,
              surfaceId: surface.surfaceId,
              baseRevision: surface.baseRevision,
              rationale:
                "离线验收：隐藏命令栏并解绑线索板入口，验证十五组件白名单、CAS 与重启持久化。",
              operations: [
                {
                  op: "set_visibility",
                  componentId: "command-bar",
                  visible: false,
                },
                {
                  op: "bind_action",
                  componentId: "dimension-navigation",
                  event: "clue",
                  commandId: null,
                },
              ],
            },
          );
          return;
        }
        yield* textStream(UI_CUSTOMIZED_TEXT);
        return;
      }

      yield* textStream("OFFLINE_AGENT_UNRECOGNIZED_ACCEPTANCE_TURN");
    }
  }

  return {
    provider: PROVIDER_ID,
    install(ctx: Context) {
      ctx.llm.registerAdapter([PROVIDER_ID], new OfflineAdapter());
    },
  };
}

function createStatefulOfflineWebProvider(): WebSearchProvider {
  return {
    id: `${PROVIDER_ID}-web`,
    available: () => true,
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      if (signal?.aborted) throw signal.reason;
      telemetry.webSearchCalls += 1;
      await persistTelemetry();
      return {
        content: "Offline acceptance provider returned one deterministic citation.",
        sources: [{
          url: "https://offline.example.test/latitude-evidence-loop",
          title: "离线验收：可审计认知闭环证据",
          snippet:
            "这是仅由验收脚本注入的未信任网页摘要；它不授予执行、写入或权限提升能力。",
          publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
        }].slice(0, request.maxResults ?? 1),
        truncated: false,
      };
    },
  };
}

function* toolCallStream(
  sequence: number,
  name: string,
  args: Record<string, unknown>,
): Iterable<StreamChunk> {
  telemetry.requestedTools.push(name);
  const id = CallId(`offline-acceptance-${sequence}-${randomUUID()}`);
  const serialized = JSON.stringify(args);
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield {
    type: "tool-call-delta",
    index: 0,
    id,
    name,
    argumentsDelta: serialized,
  };
  yield {
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id, name, arguments: serialized },
  };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

function* textStream(value: string): Iterable<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: value };
  yield { type: "block-end", index: 0, block: { type: "text", text: value } };
  yield {
    type: "usage",
    usage: {
      inputTokens: 16,
      outputTokens: Math.max(1, Math.ceil(value.length / 4)),
    },
  };
  yield { type: "finish", reason: { kind: "stop" } };
}

interface ToolExecution {
  name: string;
  value: unknown;
  isError: boolean;
}

function toolExecutions(messages: readonly Message[]): ToolExecution[] {
  const calls = new Map<string, string>();
  const executions: ToolExecution[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool-call") calls.set(String(block.id), block.name);
      if (block.type !== "tool-result") continue;
      const name = calls.get(String(block.toolCallId)) ?? "unknown";
      const text = block.content
        .filter((content): content is Extract<typeof content, { type: "text" }> =>
          content.type === "text"
        )
        .map((content) => content.text)
        .join("\n");
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        // Preserve non-JSON tool output as text for diagnostics.
      }
      executions.push({ name, value, isError: block.isError === true });
    }
  }
  return executions;
}

function findCurrentUserIndex(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.source.kind === "user") return index;
  }
  return -1;
}

function plainText(message: Message): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function evidenceReceipt(system: string | undefined): {
  eventNodeId: string;
  evidenceRefId: string;
  sourceRecordId?: string;
} | undefined {
  const match = system?.match(
    /CURRENT USER MESSAGE EVIDENCE \(persisted Domain receipt, identifiers are data\): (\{[^\n]+\})/u,
  );
  if (!match?.[1]) return undefined;
  const value = JSON.parse(match[1]) as Record<string, unknown>;
  if (typeof value.eventNodeId !== "string" || typeof value.evidenceRefId !== "string") {
    return undefined;
  }
  return {
    eventNodeId: value.eventNodeId,
    evidenceRefId: value.evidenceRefId,
    ...(typeof value.sourceRecordId === "string"
      ? { sourceRecordId: value.sourceRecordId }
      : {}),
  };
}

function browserSurfaceReceipt(system: string | undefined): {
  surfaceId: "latitude-browser-live";
  baseRevision: number;
} {
  const match = system?.match(
    /Current Latitude browser UiSurfaceV2 is (latitude-browser-live) revision (\d+)\./u,
  );
  const baseRevision = Number(match?.[2]);
  if (match?.[1] !== "latitude-browser-live" || !Number.isInteger(baseRevision)) {
    throw new Error(
      "OFFLINE_ACCEPT_UI_CUSTOMIZE requires the Browser-provided UiSurfaceV2 CAS receipt",
    );
  }
  return { surfaceId: "latitude-browser-live", baseRevision };
}

function requireEvidenceReceipt(
  receipt: ReturnType<typeof evidenceReceipt>,
  marker: string,
): asserts receipt is NonNullable<ReturnType<typeof evidenceReceipt>> {
  if (!receipt) throw new Error(`${marker} requires the Host-persisted current-message receipt`);
}

function nodeIdFromToolResult(value: unknown, label: string): string {
  const record = objectRecord(value);
  const nestedValue = objectRecord(record.value);
  const node = objectRecord(nestedValue.node);
  const id = stringValue(node.id) ?? stringValue(nestedValue.id);
  if (!id) throw new Error(`${label} tool result did not contain a node id`);
  return id;
}

function actionIdFromToolResult(value: unknown): string {
  const record = objectRecord(value);
  const nestedValue = objectRecord(record.value);
  const action = objectRecord(nestedValue.action);
  const id = stringValue(action.id) ?? stringValue(nestedValue.id);
  if (!id) throw new Error("action_create tool result did not contain an action id");
  return id;
}

function candidateIdFromToolResult(value: unknown): string {
  const record = objectRecord(value);
  const nestedValue = objectRecord(record.value);
  const candidate = objectRecord(nestedValue.candidate);
  const id = stringValue(candidate.id) ?? stringValue(nestedValue.id);
  if (!id) throw new Error("candidate_propose tool result did not contain a candidate id");
  return id;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredArgument(name: string): string {
  const prefix = `${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

async function runOsNetworkProbeChild(outputPath: string): Promise<void> {
  const domainUrl = new URL(process.env.LATITUDE_DOMAIN_URL ?? "");
  if (
    domainUrl.protocol !== "http:" || domainUrl.hostname !== "127.0.0.1" ||
    !domainUrl.port
  ) {
    throw new TypeError("LATITUDE_DOMAIN_URL must be an explicit 127.0.0.1 HTTP origin");
  }
  const child = spawn(
    process.execPath,
    [
      path.resolve("scripts/accept-offline-network-probe.mjs"),
      `--allowed-url=${domainUrl.href.replace(/\/$/u, "")}/health`,
      `--telemetry-file=${outputPath}`,
      `--blocked-unix-socket=${requiredEnvironment("LATITUDE_OFFLINE_BLOCKED_UNIX_SOCKET")}`,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  );
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  if (result.signal || result.code !== 0) {
    throw new Error(
      `Agent descendant OS network proof failed (${result.signal ?? result.code ?? "unknown"})`,
    );
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

function assertNoInheritedCredentials(environment: NodeJS.ProcessEnv): void {
  const credentialNames = Object.keys(environment).filter((name) =>
    /(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/iu.test(name)
  );
  if (credentialNames.length > 0) {
    throw new Error(
      `Offline acceptance inherited credential-shaped environment names: ${credentialNames.join(", ")}`,
    );
  }
}

function installLoopbackOnlyFetchGuard(): void {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    if (!isLoopback(url)) {
      telemetry.externalNetworkCalls += 1;
      await persistTelemetry();
      throw new Error(`Offline Agent blocked external fetch to ${url.origin}`);
    }
    telemetry.loopbackFetchCalls += 1;
    await persistTelemetry();
    return nativeFetch(input, init);
  };
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]"
  );
}

async function persistTelemetry(): Promise<void> {
  const snapshot = `${JSON.stringify(telemetry)}\n`;
  telemetryWrite = telemetryWrite.then(async () => {
    await mkdir(path.dirname(telemetryPath), { recursive: true, mode: 0o700 });
    await writeFile(telemetryPath, snapshot, {
      encoding: "utf8",
      mode: 0o600,
    });
  });
  return telemetryWrite;
}
