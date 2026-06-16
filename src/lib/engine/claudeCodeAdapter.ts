/**
 * claudeCodeAdapter.ts — 把本地 Claude Code(claude CLI)包成 EngineAdapter
 *
 * 这是 Phase 4「统一引擎适配器」三条引擎里的 CC 条。它不重写 spawn / NDJSON 解析逻辑,
 * 而是复用 cli_agent 那条已验证的路径(Rust 侧 cli_agent_send + cli-agent-event 事件流,
 * 见 src-tauri/src/cli_agent/claude.rs),把 CLI 的事件流适配成 EngineAdapter 的统一格式:
 *
 *   EngineAdapter.generate        →  跑一轮 claude,累积 text 作为 content 返回
 *   EngineAdapter.generateStream  →  跑一轮 claude,text→onToken / thinking→onReasoningToken,
 *                                    最终回 content
 *   EngineAdapter.capabilities    →  CC 据实声明(支持工具/推理/流式)
 *
 * 为什么需要它(对齐 Task 4.3):
 *   收口层(callBrain / generateOnce)原本直连 HTTP provider,主动引擎 / 简报只能用 API。
 *   把 CC 也实现成 EngineAdapter 后,收口层按 chatBackend 选适配器即可让主动引擎也用 CC,
 *   收口层代码不动。
 *
 * 无状态(铁律①):适配器不持有任何会话状态,不用 claude 自身的 session / --resume。
 *   每次 generate / generateStream 都接收「完整 messages」(含 system 人设、记忆、历史),
 *   用 buildCliPrompt 把它序列化成单段 prompt 注入 —— 与 chatStore CLI 分流走的是同一套
 *   序列化逻辑,保证 CC 引擎拿到的上下文与 API 引擎(messages 数组)等价。app 是唯一的
 *   会话状态持有者;CLI 当哑引擎,一轮算一轮。
 *
 * 工具能力(MCP):跑前现取本机 MCP server 的接入信息(mcp_connection_info),传给
 *   cli_agent_send,让 claude 启动时连进来、能调 app 已有的工具(与 sendViaCli 一致)。
 *   拿不到 MCP 时降级为纯聊天(不传 url/token),不报错。
 *
 * 边界 / 已知限制:
 *   - 工具调用(tool_call_start)在 CC 路径由 CLI 自己执行(连 MCP),不像 API 引擎那样
 *     把 toolCalls 回吐给上层做 agent loop。因此本适配器的 EngineResult 不带 toolCalls;
 *     工具步骤只通过流事件可观测(tool_call_start),不计入最终 content。这对 generateOnce
 *     (裸调,本就不期待结构化 toolCalls)是匹配的。
 *   - opts(temperature / maxTokens / responseFormat / model / tools)对 CLI 不透传:
 *     claude CLI 走用户订阅,这些参数无对应入口。保留签名以满足 EngineAdapter 接口,
 *     但不据此改变行为(JSON mode 等结构化需求应钉死走 API 引擎,见 index.ts 的分发)。
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
const ENGINE_NAME = "claude-code";
/**
 * model 标识。claude CLI 走用户订阅,具体模型由 CLI 侧决定,这里给一个稳定标识用于
 * usage 记录与能力位兜底(不影响实际跑哪个模型)。
 */
const ENGINE_MODEL = "claude-code";

/** cli-agent-event 事件载荷(与 Rust 端 ChatEvent 对齐:tag=type,snake_case)。 */
type CliEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call_start"; name: string }
  | { type: "tool_call_end"; name: string; ok: boolean }
  | { type: "done" }
  | { type: "error"; message: string };

/** 跑一轮 claude 的内部回调(generate 用 no-op token,generateStream 用真回调)。 */
interface RunHandlers {
  onText: (t: string) => void;
  onThinking: (t: string) => void;
  onToolCall: (name: string) => void;
}

/**
 * 把完整 messages 序列化成喂给无状态 CLI 的单段 prompt。
 *
 * 复用 buildCliPrompt(与 chatStore CLI 分流同款):
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
 * 驱动一轮 claude:spawn(经 cli_agent_send)→ 监听 cli-agent-event → 累积/转发 → 返回完整文本。
 *
 * 无状态:prompt 已是本轮完整上下文;不传/不收 session。
 * MCP:现取 mcp_connection_info 透传(拿不到则降级纯聊天)。
 *
 * @returns 本轮 assistant 的完整文本(所有 text 事件累积)
 * @throws  收到 error 事件时 reject(上层 generateStream 会先回调 onError)
 */
async function runClaude(prompt: string, handlers: RunHandlers): Promise<string> {
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
        // 工具结束:MVP 不单独处理(与 sendViaCli 一致)
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
      kind: "claude",
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
 * 构造 Claude Code 引擎适配器。
 *
 * 无构造参数:无状态,每次 generate / generateStream 现取 MCP、现拼 prompt、现跑一轮。
 */
export function makeClaudeCodeAdapter(): EngineAdapter {
  return {
    name: ENGINE_NAME,
    model: ENGINE_MODEL,

    async generate(
      messages: EngineMessage[],
      _opts?: EngineOptions
    ): Promise<EngineResult> {
      // 非流式:跑一轮但不对外吐 token,只累积 content 返回。
      const prompt = serializeMessages(messages);
      const content = await runClaude(prompt, {
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
        const content = await runClaude(prompt, {
          onText: (t) => handlers.onToken(t),
          onThinking: (t) => handlers.onReasoningToken?.(t),
          // 工具步骤:CC 由 CLI 自己执行,这里仅作为流事件可观测(不入 content)。
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
      // CC 据实声明:支持工具(经 MCP)、推理(thinking)、流式(NDJSON 增量)。
      return { supportsTools: true, supportsReasoning: true, supportsStreaming: true };
    },
  };
}
