/**
 * claudeCodeAdapter.test.ts — Claude Code 引擎适配器契约测试(Task 4.3)
 *
 * 被测:makeClaudeCodeAdapter() 把本地 claude(cli_agent 那条 spawn/MCP 路径)包成
 * 统一的 EngineAdapter。CC 在 headless 下没法真跑,这里用桩拦截 Tauri 边界:
 *   - invoke("mcp_connection_info") → 返回假 MCP url/token(让适配器把它透传给 CLI)
 *   - invoke("cli_agent_send", {...}) → 记录入参快照,然后按预设脚本把 cli-agent-event
 *     事件喂给已注册的 listen 回调,最后 resolve(模拟一轮跑完)
 *   - listen("cli-agent-event", cb) → 把 cb 存起来,供 cli_agent_send 触发
 *
 * 验收维度(对齐 Task 4.3 目标 1 + 铁律①):
 *   ① 无状态注入:每轮把〔system + 历史 + 当前消息〕序列化进单段 prompt(buildCliPrompt 同款),
 *      不带 sessionId/resume,两次 generate 互不影响。
 *   ② MCP 透传:把 mcp_connection_info 的 url/token 传给 cli_agent_send,让 CLI 连本机 MCP。
 *   ③ 流格式转换:CLI 的 text→onToken、thinking→onReasoningToken、tool_call_start→(可观测),
 *      done→onDone;最终 EngineResult.content 为所有 text 累积。
 *   ④ generate(非流式)也累积 content 返回(内部复用同一条事件流,只是不对外吐 token)。
 *   ⑤ capabilities 据实声明(CC 支持工具/推理/流式)。
 *   ⑥ name/model 标识正确。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  ChatMessage,
  EngineStreamHandlers,
} from "./types";

// ─── Tauri 边界桩 ────────────────────────────────────────────────────────────
//
// 适配器内部走 invoke / listen。这里用模块级可变状态记录调用、保存 listen 回调,
// 让 cli_agent_send 在被调用时按 scriptedEvents 逐条喂事件给回调,再 resolve。

type Ev =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call_start"; name: string }
  | { type: "tool_call_end"; name: string; ok: boolean }
  | { type: "done" }
  | { type: "error"; message: string };

interface SendCall {
  kind: string;
  prompt: string;
  mcpUrl?: string;
  mcpToken?: string;
}

// 每个用例前重置
let sendCalls: SendCall[];
let scriptedEvents: Ev[];
let listenCallback: ((e: { payload: Ev }) => void) | null;
let unlistenSpy: ReturnType<typeof vi.fn>;
// mcp_connection_info 的返回(null 表示拿不到,适配器应降级为不传 MCP)
let mcpConnInfo: { url: string; token: string } | null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "mcp_connection_info") {
      if (mcpConnInfo === null) throw new Error("no mcp");
      return mcpConnInfo;
    }
    if (cmd === "cli_agent_send") {
      const req = (args?.req ?? {}) as {
        prompt: string;
        mcpUrl?: string;
        mcpToken?: string;
      };
      sendCalls.push({
        kind: args?.kind as string,
        prompt: req.prompt,
        mcpUrl: req.mcpUrl,
        mcpToken: req.mcpToken,
      });
      // 模拟 Rust 端:把脚本事件逐条 emit 给已注册的 listen 回调,最后才 resolve
      // (真实 cli_agent_send 也是 Done 后才返回)
      if (listenCallback) {
        for (const ev of scriptedEvents) {
          listenCallback({ payload: ev });
        }
      }
      return null;
    }
    return null;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: Ev }) => void) => {
    listenCallback = cb;
    return unlistenSpy;
  }),
}));

// 被测模块在 mock 之后 import
import { makeClaudeCodeAdapter } from "./claudeCodeAdapter";

beforeEach(() => {
  sendCalls = [];
  scriptedEvents = [];
  listenCallback = null;
  unlistenSpy = vi.fn();
  mcpConnInfo = { url: "http://127.0.0.1:42800/mcp", token: "tok-abc" };
});

describe("makeClaudeCodeAdapter — 标识与能力位", () => {
  it("name=claude-code,model 据实声明", () => {
    const adapter = makeClaudeCodeAdapter();
    expect(adapter.name).toBe("claude-code");
    // model 是一个非空标识(用于 usage 记录/能力位兜底)
    expect(typeof adapter.model).toBe("string");
    expect(adapter.model.length).toBeGreaterThan(0);
  });

  it("capabilities 据实声明:CC 支持工具/推理/流式", () => {
    const adapter = makeClaudeCodeAdapter();
    const caps = adapter.capabilities();
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsStreaming).toBe(true);
  });
});

describe("makeClaudeCodeAdapter — 无状态注入 + MCP 透传", () => {
  it("generate:把 system+历史+当前消息序列化进单段 prompt 喂给 claude", async () => {
    scriptedEvents = [{ type: "text", text: "好的" }, { type: "done" }];
    const adapter = makeClaudeCodeAdapter();

    const messages: ChatMessage[] = [
      { role: "system", content: "你是资深幕僚" },
      { role: "user", content: "第一句" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二句" },
    ];

    await adapter.generate(messages);

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].kind).toBe("claude");
    const prompt = sendCalls[0].prompt;
    // 单段 prompt 必须把 system 放在最前(人设/记忆随每轮注入)
    expect(prompt.startsWith("你是资深幕僚")).toBe(true);
    // 历史 + 当前消息平铺进 prompt,顺序保持
    const iFirst = prompt.indexOf("第一句");
    const iAns = prompt.indexOf("第一答");
    const iSecond = prompt.indexOf("第二句");
    expect(iFirst).toBeGreaterThan(-1);
    expect(iAns).toBeGreaterThan(iFirst);
    expect(iSecond).toBeGreaterThan(iAns);
  });

  it("MCP 透传:把 mcp_connection_info 的 url/token 传给 cli_agent_send", async () => {
    scriptedEvents = [{ type: "text", text: "x" }, { type: "done" }];
    const adapter = makeClaudeCodeAdapter();
    await adapter.generate([{ role: "user", content: "hi" }]);
    expect(sendCalls[0].mcpUrl).toBe("http://127.0.0.1:42800/mcp");
    expect(sendCalls[0].mcpToken).toBe("tok-abc");
  });

  it("MCP 拿不到时降级:不传 url/token,仍能跑(纯聊天)", async () => {
    mcpConnInfo = null; // mcp_connection_info 抛错
    scriptedEvents = [{ type: "text", text: "纯聊天" }, { type: "done" }];
    const adapter = makeClaudeCodeAdapter();
    const result = await adapter.generate([{ role: "user", content: "hi" }]);
    expect(sendCalls[0].mcpUrl).toBeUndefined();
    expect(sendCalls[0].mcpToken).toBeUndefined();
    expect(result.content).toBe("纯聊天");
  });

  it("无状态:两次 generate 互不影响,prompt 各自独立(不累积会话)", async () => {
    const adapter = makeClaudeCodeAdapter();

    scriptedEvents = [{ type: "text", text: "答一" }, { type: "done" }];
    await adapter.generate([
      { role: "system", content: "SYS" },
      { role: "user", content: "问一" },
    ]);

    scriptedEvents = [{ type: "text", text: "答二" }, { type: "done" }];
    await adapter.generate([
      { role: "system", content: "SYS" },
      { role: "user", content: "问二" },
    ]);

    expect(sendCalls).toHaveLength(2);
    // 第二轮的 prompt 不应残留第一轮的「问一」(无状态:每轮只含调用方传入的 messages)
    expect(sendCalls[1].prompt).toContain("问二");
    expect(sendCalls[1].prompt).not.toContain("问一");
  });
});

describe("makeClaudeCodeAdapter — 流格式转换", () => {
  it("generateStream:text→onToken,thinking→onReasoningToken,done→onDone,content 累积", async () => {
    scriptedEvents = [
      { type: "thinking", text: "想一下…" },
      { type: "text", text: "你" },
      { type: "text", text: "好" },
      { type: "done" },
    ];
    const adapter = makeClaudeCodeAdapter();

    const tokens: string[] = [];
    const reasoningTokens: string[] = [];
    let doneContent: string | undefined;
    const handlers: EngineStreamHandlers = {
      onToken: (t) => tokens.push(t),
      onReasoningToken: (t) => reasoningTokens.push(t),
      onDone: (r) => {
        doneContent = r.content;
      },
    };

    const result = await adapter.generateStream(
      [{ role: "user", content: "在吗" }],
      {},
      handlers
    );

    expect(tokens).toEqual(["你", "好"]);
    expect(reasoningTokens).toEqual(["想一下…"]);
    expect(result.content).toBe("你好");
    expect(doneContent).toBe("你好");
  });

  it("generate(非流式):不对外吐 token,但 content 仍为所有 text 累积", async () => {
    scriptedEvents = [
      { type: "text", text: "结" },
      { type: "text", text: "果" },
      { type: "done" },
    ];
    const adapter = makeClaudeCodeAdapter();
    const result = await adapter.generate([{ role: "user", content: "hi" }]);
    expect(result.content).toBe("结果");
  });

  it("tool_call_start 事件不会污染最终文本(工具步骤不计入 content)", async () => {
    scriptedEvents = [
      { type: "tool_call_start", name: "list_todos" },
      { type: "text", text: "你有 3 个任务" },
      { type: "done" },
    ];
    const adapter = makeClaudeCodeAdapter();
    const result = await adapter.generate([{ role: "user", content: "几个任务" }]);
    expect(result.content).toBe("你有 3 个任务");
  });

  it("error 事件 → 流式 onError 收到,且 promise reject", async () => {
    scriptedEvents = [{ type: "error", message: "claude 登录失效" }];
    const adapter = makeClaudeCodeAdapter();
    const errors: Error[] = [];
    await expect(
      adapter.generateStream([{ role: "user", content: "hi" }], {}, {
        onToken: () => undefined,
        onError: (e) => errors.push(e),
      })
    ).rejects.toThrow(/claude 登录失效/);
    expect(errors).toHaveLength(1);
  });

  it("跑完后注销监听(unlisten 被调用,不泄漏)", async () => {
    scriptedEvents = [{ type: "text", text: "x" }, { type: "done" }];
    const adapter = makeClaudeCodeAdapter();
    await adapter.generate([{ role: "user", content: "hi" }]);
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });
});
