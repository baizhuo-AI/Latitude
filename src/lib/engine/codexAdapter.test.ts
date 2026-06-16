/**
 * codexAdapter.test.ts — Codex 引擎适配器契约测试(Task 4.4)
 *
 * 被测:makeCodexAdapter() 把本地 codex(cli_agent 那条 spawn/MCP 路径)包成统一的
 * EngineAdapter。和 CC 一样,Codex 在 headless 下没法真跑,这里用桩拦截 Tauri 边界:
 *   - invoke("mcp_connection_info") → 返回假 MCP url/token(让适配器把它透传给 CLI;
 *     Rust 端 codex.rs 再据此用 `-c` 注入 codex 的 mcp_servers)
 *   - invoke("cli_agent_send", {...}) → 记录入参快照(尤其 kind 必须是 "codex"),然后
 *     按预设脚本把 cli-agent-event 事件喂给已注册的 listen 回调,最后 resolve
 *   - listen("cli-agent-event", cb) → 把 cb 存起来,供 cli_agent_send 触发
 *
 * 验收维度(对齐 Task 4.4 目标 1 + 铁律①):
 *   ① kind=codex:必须以 codex 分流(不能误用 claude)。
 *   ② 无状态注入:每轮把〔system + 历史 + 当前消息〕序列化进单段 prompt(buildCliPrompt 同款),
 *      不带 sessionId/resume,两次 generate 互不影响。
 *   ③ MCP 透传:把 mcp_connection_info 的 url/token 传给 cli_agent_send(Rust 端据此注入)。
 *      拿不到 MCP 时降级:不传 url/token,仍能跑(纯聊天)。
 *   ④ 流格式转换:CLI 的 text→onToken、thinking→onReasoningToken、tool_call_start→(可观测),
 *      done→onDone;最终 EngineResult.content 为所有 text 累积。
 *   ⑤ generate(非流式)也累积 content 返回(内部复用同一条事件流,只是不对外吐 token)。
 *   ⑥ capabilities 据实声明(Codex 支持工具/推理/流式)。
 *   ⑦ name/model 标识正确。
 *
 * 注:此测试与 claudeCodeAdapter.test.ts 高度同构(两条 CLI 适配器范式一致),刻意保留
 * 平行结构便于对照——差异只在 kind 期望值(codex)与标识(name=codex)。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatMessage, EngineStreamHandlers } from "./types";

// ─── Tauri 边界桩 ────────────────────────────────────────────────────────────

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

let sendCalls: SendCall[];
let scriptedEvents: Ev[];
let listenCallback: ((e: { payload: Ev }) => void) | null;
let unlistenSpy: ReturnType<typeof vi.fn>;
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
      // 模拟 Rust 端:把脚本事件逐条 emit 给已注册的 listen 回调,最后才 resolve。
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
import { makeCodexAdapter } from "./codexAdapter";

beforeEach(() => {
  sendCalls = [];
  scriptedEvents = [];
  listenCallback = null;
  unlistenSpy = vi.fn();
  mcpConnInfo = { url: "http://127.0.0.1:42800/mcp", token: "tok-abc" };
});

describe("makeCodexAdapter — 标识与能力位", () => {
  it("name=codex,model 据实声明", () => {
    const adapter = makeCodexAdapter();
    expect(adapter.name).toBe("codex");
    expect(typeof adapter.model).toBe("string");
    expect(adapter.model.length).toBeGreaterThan(0);
  });

  it("capabilities 据实声明:Codex 支持工具/推理/流式", () => {
    const adapter = makeCodexAdapter();
    const caps = adapter.capabilities();
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsStreaming).toBe(true);
  });
});

describe("makeCodexAdapter — kind 分流 + 无状态注入 + MCP 透传", () => {
  it("generate:以 kind=codex 分流(不误用 claude)", async () => {
    scriptedEvents = [{ type: "text", text: "好的" }, { type: "done" }];
    const adapter = makeCodexAdapter();
    await adapter.generate([{ role: "user", content: "hi" }]);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].kind).toBe("codex");
  });

  it("generate:把 system+历史+当前消息序列化进单段 prompt 喂给 codex", async () => {
    scriptedEvents = [{ type: "text", text: "好的" }, { type: "done" }];
    const adapter = makeCodexAdapter();

    const messages: ChatMessage[] = [
      { role: "system", content: "你是资深幕僚" },
      { role: "user", content: "第一句" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二句" },
    ];

    await adapter.generate(messages);

    const prompt = sendCalls[0].prompt;
    expect(prompt.startsWith("你是资深幕僚")).toBe(true);
    const iFirst = prompt.indexOf("第一句");
    const iAns = prompt.indexOf("第一答");
    const iSecond = prompt.indexOf("第二句");
    expect(iFirst).toBeGreaterThan(-1);
    expect(iAns).toBeGreaterThan(iFirst);
    expect(iSecond).toBeGreaterThan(iAns);
  });

  it("MCP 透传:把 mcp_connection_info 的 url/token 传给 cli_agent_send", async () => {
    scriptedEvents = [{ type: "text", text: "x" }, { type: "done" }];
    const adapter = makeCodexAdapter();
    await adapter.generate([{ role: "user", content: "hi" }]);
    expect(sendCalls[0].mcpUrl).toBe("http://127.0.0.1:42800/mcp");
    expect(sendCalls[0].mcpToken).toBe("tok-abc");
  });

  it("MCP 拿不到时降级:不传 url/token,仍能跑(纯聊天)", async () => {
    mcpConnInfo = null;
    scriptedEvents = [{ type: "text", text: "纯聊天" }, { type: "done" }];
    const adapter = makeCodexAdapter();
    const result = await adapter.generate([{ role: "user", content: "hi" }]);
    expect(sendCalls[0].mcpUrl).toBeUndefined();
    expect(sendCalls[0].mcpToken).toBeUndefined();
    expect(result.content).toBe("纯聊天");
  });

  it("无状态:两次 generate 互不影响,prompt 各自独立(不累积会话)", async () => {
    const adapter = makeCodexAdapter();

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
    expect(sendCalls[1].prompt).toContain("问二");
    expect(sendCalls[1].prompt).not.toContain("问一");
  });
});

describe("makeCodexAdapter — 流格式转换", () => {
  it("generateStream:text→onToken,thinking→onReasoningToken,done→onDone,content 累积", async () => {
    scriptedEvents = [
      { type: "thinking", text: "想一下…" },
      { type: "text", text: "你" },
      { type: "text", text: "好" },
      { type: "done" },
    ];
    const adapter = makeCodexAdapter();

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
    const adapter = makeCodexAdapter();
    const result = await adapter.generate([{ role: "user", content: "hi" }]);
    expect(result.content).toBe("结果");
  });

  it("tool_call_start 事件不会污染最终文本(工具步骤不计入 content)", async () => {
    scriptedEvents = [
      { type: "tool_call_start", name: "list_todos" },
      { type: "text", text: "你有 3 个任务" },
      { type: "done" },
    ];
    const adapter = makeCodexAdapter();
    const result = await adapter.generate([{ role: "user", content: "几个任务" }]);
    expect(result.content).toBe("你有 3 个任务");
  });

  it("error 事件 → 流式 onError 收到,且 promise reject", async () => {
    scriptedEvents = [{ type: "error", message: "codex 返回失败" }];
    const adapter = makeCodexAdapter();
    const errors: Error[] = [];
    await expect(
      adapter.generateStream([{ role: "user", content: "hi" }], {}, {
        onToken: () => undefined,
        onError: (e) => errors.push(e),
      })
    ).rejects.toThrow(/codex 返回失败/);
    expect(errors).toHaveLength(1);
  });

  it("跑完后注销监听(unlisten 被调用,不泄漏)", async () => {
    scriptedEvents = [{ type: "text", text: "x" }, { type: "done" }];
    const adapter = makeCodexAdapter();
    await adapter.generate([{ role: "user", content: "hi" }]);
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });
});
