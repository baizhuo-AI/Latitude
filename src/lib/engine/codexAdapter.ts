/**
 * codexAdapter.ts — 把本地 OpenAI Codex(codex CLI)包成 EngineAdapter
 *
 * 这是 Phase 4「统一引擎适配器」三条引擎里的 Codex 条(Task 4.4)。它与 claudeCodeAdapter
 * 同构:不重写 spawn / JSONL 解析逻辑,而是复用 cli_agent 那条已验证的路径(Rust 侧
 * cli_agent_send + cli-agent-event 事件流,见 src-tauri/src/cli_agent/codex.rs),把 CLI 的
 * 事件流适配成 EngineAdapter 的统一格式:
 *
 *   EngineAdapter.generate        →  跑一轮 codex,累积 text 作为 content 返回
 *   EngineAdapter.generateStream  →  跑一轮 codex,text→onToken / reasoning→onReasoningToken,
 *                                    最终回 content
 *   EngineAdapter.capabilities    →  Codex 据实声明(支持工具/推理/流式)
 *
 * 为什么需要它(对齐 Task 4.4):
 *   收口层(callBrain / generateOnce)此前 codex-cli 兜底到 apiAdapter,主动引擎 / 简报
 *   在 codex 后端下其实走的是 API。把 Codex 也实现成 EngineAdapter 并在 selectEngine 加
 *   codex-cli→codexAdapter 分支后,generateOnce(主动引擎/简报)就能真正用 codex,收口层
 *   代码不动。
 *
 * 无状态(铁律①):适配器不持有任何会话状态,不用 codex 自身的 session / `codex exec resume`。
 *   每次 generate / generateStream 都接收「完整 messages」(含 system 人设、记忆、历史),
 *   用 serializeMessages(buildCliPrompt 同款)把它序列化成单段 prompt 注入 —— 与 chatStore
 *   CLI 分流、claudeCodeAdapter 走的是同一套序列化逻辑,保证 Codex 引擎拿到的上下文与 API
 *   引擎(messages 数组)等价。app 是唯一的会话状态持有者;CLI 当哑引擎,一轮算一轮。
 *
 * 工具能力(MCP):跑前现取本机 MCP server 的接入信息(mcp_connection_info),把 url/token
 *   透传给 cli_agent_send。Rust 端 codex.rs 据此用 `codex exec -c mcp_servers.daybreak.url=...
 *   -c mcp_servers.daybreak.http_headers={Authorization="Bearer <token>"}` 在调用时程序化注入
 *   daybreak MCP(不写文件、不改用户 ~/.codex/config.toml),让 codex 能调 app 已有的工具。
 *   拿不到 MCP 时降级为纯聊天(不传 url/token),不报错。注入细节见 codex.rs。
 *
 * 边界 / 已知限制(与 claudeCodeAdapter 一致):
 *   - 工具调用在 Codex 路径由 CLI 自己执行(连 MCP),不像 API 引擎那样把 toolCalls 回吐
 *     给上层做 agent loop。因此本适配器的 EngineResult 不带 toolCalls;工具步骤只通过流
 *     事件可观测(tool_call_start),不计入最终 content。这对 generateOnce(裸调,本就不
 *     期待结构化 toolCalls)是匹配的。
 *   - opts(temperature / maxTokens / responseFormat / model / tools)对 CLI 不透传:codex
 *     CLI 走用户订阅,这些参数无对应入口。保留签名以满足 EngineAdapter 接口,但不据此改变
 *     行为(JSON mode 等结构化需求应钉死走 API 引擎,见 index.ts 的分发 forceApi)。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildCliPrompt } from "../cliPrompt";
import { mcpUrlFrom, type McpConnInfo } from "../mcpConn";
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineMessage,
  EngineOptions,
  EngineResult,
  EngineStreamHandlers,
} from "./types";

/** 引擎标识(usage 记录的 provider 字段、日志、Settings 显示)。 */
const ENGINE_NAME = "codex";
/**
 * model 标识。codex CLI 走用户订阅,具体模型由 CLI 侧(~/.codex/config.toml)决定,这里给
 * 一个稳定标识用于 usage 记录与能力位兜底(不影响实际跑哪个模型)。
 */
const ENGINE_MODEL = "codex";

/** cli-agent-event 事件载荷(与 Rust 端 ChatEvent 对齐:tag=type,snake_case)。 */
type CliEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call_start"; name: string }
  | { type: "tool_call_end"; name: string; ok: boolean }
  | { type: "done" }
  | { type: "error"; message: string };

/** 跑一轮 codex 的内部回调(generate 用 no-op token,generateStream 用真回调)。 */
interface RunHandlers {
  onText: (t: string) => void;
  onThinking: (t: string) => void;
  onToolCall: (name: string) => void;
}

/**
 * 把完整 messages 序列化成喂给无状态 CLI 的单段 prompt。
 *
 * 复用 buildCliPrompt(与 chatStore CLI 分流、claudeCodeAdapter 同款):
 *   - 所有 system 消息拼成 systemPrompt(人设 + 记忆 + 上下文,随每轮注入);
 *   - 其余消息(user/assistant/tool)作为对话历史平铺;
 *   - 末条若是 user,作为「当前消息」交给 buildCliPrompt 做去重 + 末尾续写占位。
 */
function serializeMessages(messages: EngineMessage[]): string {
  const systemPrompt = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const history = messages.filter((m) => m.role !== "system");
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  // 末条 user 作为「当前消息」:buildCliPrompt 内部会去重(history 末条恰为它则不重复追加),
  // 并在末尾留「助手：」占位行。无 user 消息时传空串(罕见,仅 system 单独调用的兜底)。
  return buildCliPrompt(systemPrompt, history, lastUser?.content ?? "");
}

/**
 * 驱动一轮 codex:spawn(经 cli_agent_send,kind=codex)→ 监听 cli-agent-event →
 * 累积/转发 → 返回完整文本。
 *
 * 无状态:prompt 已是本轮完整上下文;不传/不收 session。
 * MCP:现取 mcp_connection_info 透传(拿不到则降级纯聊天)。
 *
 * @returns 本轮 assistant 的完整文本(所有 text 事件累积)
 * @throws  收到 error 事件时 reject(上层 generateStream 会先回调 onError)
 */
async function runCodex(prompt: string, handlers: RunHandlers): Promise<string> {
  // 现取 MCP 接入信息(跟随真相源);拿不到就退化为纯聊天。
  // 注意:mcp_connection_info 返回 {port, token, command},**没有 url** —— url 必须从 port 拼
  // (见 ../mcpConn 的 mcpUrlFrom)。早先直读 conn.url 会得 undefined,导致 MCP 从不注入(4.3/4.4 复审)。
  const conn = await invoke<McpConnInfo>("mcp_connection_info").catch(() => null);
  const mcpUrl = mcpUrlFrom(conn);

  let content = "";
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const donePromise = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  // 先注册监听,再 spawn —— 保证事件不漏(真实 cli_agent_send 在 Done 后才 resolve)。
  const unlisten = await listen<CliEvent>("cli-agent-event", (e) => {
    const ev = e.payload;
    switch (ev.type) {
      case "text":
        content += ev.text;
        handlers.onText(ev.text);
        break;
      case "thinking":
        handlers.onThinking(ev.text);
        break;
      case "tool_call_start":
        handlers.onToolCall(ev.name);
        break;
      case "tool_call_end":
        // 工具结束:MVP 不单独处理(与 sendViaCli / claudeCodeAdapter 一致)
        break;
      case "done":
        resolveDone();
        break;
      case "error":
        rejectDone(new Error(ev.message));
        break;
    }
  });

  try {
    await invoke("cli_agent_send", {
      kind: "codex",
      req: {
        prompt,
        mcpUrl,
        mcpToken: conn?.token,
      },
    });
    await donePromise;
  } finally {
    unlisten();
  }

  return content;
}

/**
 * 构造 Codex 引擎适配器。
 *
 * 无构造参数:无状态,每次 generate / generateStream 现取 MCP、现拼 prompt、现跑一轮。
 */
export function makeCodexAdapter(): EngineAdapter {
  return {
    name: ENGINE_NAME,
    model: ENGINE_MODEL,

    async generate(
      messages: EngineMessage[],
      _opts?: EngineOptions
    ): Promise<EngineResult> {
      // 非流式:跑一轮但不对外吐 token,只累积 content 返回。
      const prompt = serializeMessages(messages);
      const content = await runCodex(prompt, {
        onText: () => undefined,
        onThinking: () => undefined,
        onToolCall: () => undefined,
      });
      return { content, model: ENGINE_MODEL };
    },

    async generateStream(
      messages: EngineMessage[],
      _opts: EngineOptions,
      handlers: EngineStreamHandlers
    ): Promise<EngineResult> {
      const prompt = serializeMessages(messages);
      try {
        const content = await runCodex(prompt, {
          onText: (t) => handlers.onToken(t),
          onThinking: (t) => handlers.onReasoningToken?.(t),
          // 工具步骤:Codex 由 CLI 自己执行,这里仅作为流事件可观测(不入 content)。
          // EngineStreamHandlers 无 onStep,故不对外暴露;保留 hook 以便将来扩展。
          onToolCall: () => undefined,
        });
        const result: EngineResult = { content, model: ENGINE_MODEL };
        handlers.onDone?.(result);
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        handlers.onError?.(e);
        throw e;
      }
    },

    capabilities(_model?: string): EngineCapabilities {
      // Codex 据实声明:支持工具(经 MCP)、推理(reasoning)、流式(JSONL 增量)。
      return { supportsTools: true, supportsReasoning: true, supportsStreaming: true };
    },
  };
}
