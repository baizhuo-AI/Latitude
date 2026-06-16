/**
 * crossEngineConsistency.test.ts — 跨引擎行为层一致性回归(Task 4.5a)
 *
 * 目标:证明三条引擎适配器(API / Claude Code / Codex)在「脚本化模型行为」下产出的
 *   统一格式完全一致 —— 同样的事件序列 / 响应内容,经不同适配器转出相同的 EngineResult
 *   结构(content / model 字段、流式回调序列、消息条数)。
 *
 * 策略(录制回放式,不依赖真实 CLI):
 *   - API 适配器:注入桩 LLMProvider,按脚本返回固定 ChatResult。
 *   - CC / Codex 适配器:桩 Tauri invoke/listen,按相同事件脚本驱动 CliEvent 流。
 *   - 三者都走 temperature=0、固定输入消息、固定脚本响应;断言产出一致。
 *
 * 一致性维度(4.5a 断言的八条):
 *   D1. generate:最终 content 相同(同脚本内容)
 *   D2. generate:model 字段非空(各自标识)
 *   D3. generate:不含 toolCalls(工具调用不污染 content 结构)
 *   D4. generateStream:onToken 回调序列与 content 一致
 *   D5. generateStream:onDone 回调的 content 与返回值 content 相同
 *   D6. generateStream:onError 路径都能 reject + 调 onError 回调
 *   D7. 多段 text 事件的累积结果一致(不分段)
 *   D8. 无状态:两次独立 generate 互不污染(上下文不跨轮累积)
 *
 * 不验证的范围(边界说明,防止误解):
 *   - model 字段的具体值:三引擎各自声明,不应强求相同。
 *   - prompt 具体格式:CC/Codex 经 buildCliPrompt 序列化,API 用 messages 数组,
 *     格式本就不同 —— 这是适配器的「契约」而非「不一致」。
 *   - 真实 CLI 的跨引擎腔调:属 4.5b 人工验收范畴,不进 CI 红绿。
 *
 * 约束:不引新依赖,不碰生产逻辑,桩与各自单测中已有的桩一致。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  EngineAdapter,
  EngineResult,
  EngineStreamHandlers,
  EngineMessage,
} from "./types";
import type { LLMProvider, ChatMessage, ChatOptions, ChatResult, LLMCapabilities, StreamHandlers } from "../llm/types";

// ─── Tauri 边界桩(共享给 CC 和 Codex 适配器) ───────────────────────────────
//
// CC 和 Codex 适配器都走 invoke("cli_agent_send") + listen("cli-agent-event")。
// 两者在同一测试文件里,共用同一套桩。

type CliEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call_start"; name: string }
  | { type: "tool_call_end"; name: string; ok: boolean }
  | { type: "done" }
  | { type: "error"; message: string };

// 模块级可变状态:beforeEach 重置,各用例按需写入。
let cliScriptedEvents: CliEvent[];
let cliListenCallback: ((e: { payload: CliEvent }) => void) | null;
let cliUnlistenSpy: ReturnType<typeof vi.fn>;
let mcpConnInfo: { port: number; token: string; command: string } | null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "mcp_connection_info") {
      if (mcpConnInfo === null) throw new Error("no mcp");
      return mcpConnInfo;
    }
    if (cmd === "cli_agent_send") {
      // 按脚本事件逐条喂给 listen 回调(与各自单测桩一致)
      if (cliListenCallback) {
        for (const ev of cliScriptedEvents) {
          cliListenCallback({ payload: ev });
        }
      }
      return null;
    }
    return null;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: CliEvent }) => void) => {
    cliListenCallback = cb;
    return cliUnlistenSpy;
  }),
}));

// ─── 被测模块(mock 之后 import) ─────────────────────────────────────────────
import { makeApiAdapter } from "./apiAdapter";
import { makeClaudeCodeAdapter } from "./claudeCodeAdapter";
import { makeCodexAdapter } from "./codexAdapter";

// ─── API 适配器的桩 LLMProvider ──────────────────────────────────────────────
//
// 不走 getProvider()/DeepSeekProvider 路径(避免 settings/db 副依赖),
// 直接注入桩 provider —— makeApiAdapter(provider) 的显式传参路径。

function makeStubProvider(
  script: ChatResult[],
  opts?: { streamContent?: string }
): LLMProvider {
  const streamContent = opts?.streamContent ?? "stream-done";
  return {
    name: "stub-api",
    model: "stub-model",
    async chat(_messages: ChatMessage[], chatOpts?: ChatOptions): Promise<ChatResult> {
      const next = script.shift();
      if (next) return next;
      return { content: "(脚本耗尽)", model: chatOpts?.model };
    },
    async chatStream(
      _messages: ChatMessage[],
      chatOpts: ChatOptions,
      handlers: StreamHandlers
    ): Promise<ChatResult> {
      const result: ChatResult = { content: streamContent, model: chatOpts?.model };
      handlers.onToken(streamContent);
      handlers.onDone?.(result);
      return result;
    },
    capabilities(): LLMCapabilities {
      return { supportsTools: true, supportsReasoning: false, supportsStreaming: true };
    },
  };
}

// ─── 固定测试夹具 ─────────────────────────────────────────────────────────────
/** 温度=0、固定输入 —— 三引擎共用的标准消息组 */
const FIXED_MESSAGES: EngineMessage[] = [
  { role: "system", content: "你是资深幕僚,辅助用户高效决策。" },
  { role: "user", content: "今天要做哪三件最重要的事?" },
];

/** 脚本化回复内容(measures against content equality across engines) */
const SCRIPTED_CONTENT = "优先处理高价值任务";

beforeEach(() => {
  cliScriptedEvents = [];
  cliListenCallback = null;
  cliUnlistenSpy = vi.fn();
  mcpConnInfo = { port: 42800, token: "tok-test", command: "cli ..." };
});

// ─── 工具函数:构造三条适配器 ──────────────────────────────────────────────────

/** 给 CLI 设置单段响应(每次调用前设置) */
function setCliScript(content: string): void {
  cliScriptedEvents = [{ type: "text", text: content }, { type: "done" }];
}

/** 给 CLI 设置多段文本响应 */
function setCliMultiSegmentScript(segments: string[]): void {
  cliScriptedEvents = [
    ...segments.map((t) => ({ type: "text" as const, text: t })),
    { type: "done" },
  ];
}

/** 给 CLI 设置含 thinking + text 的响应 */
function setCliThinkingScript(thinking: string, content: string): void {
  cliScriptedEvents = [
    { type: "thinking", text: thinking },
    { type: "text", text: content },
    { type: "done" },
  ];
}

/** 给 CLI 设置含 tool_call_start 的响应 */
function setCliToolCallScript(toolName: string, textAfter: string): void {
  cliScriptedEvents = [
    { type: "tool_call_start", name: toolName },
    { type: "text", text: textAfter },
    { type: "done" },
  ];
}

/** 给 CLI 设置 error 响应 */
function setCliErrorScript(message: string): void {
  cliScriptedEvents = [{ type: "error", message }];
}

/**
 * 注意:CC 和 Codex 适配器共用同一个 `cliListenCallback` 槽,
 * 因此不能并发调用两个 CLI 适配器(listen 第二次会覆盖第一次的 callback)。
 * 凡是需要对比 CC 和 Codex 输出的用例,必须串行执行:先 CC、再重置脚本、再 Codex。
 * API 适配器(走 LLMProvider 桩,不用 listen)可以和任何适配器并发,无限制。
 */

// ─── D1 / D2 / D3: generate 基础一致性 ─────────────────────────────────────

describe("D1-D3: generate — content / model / toolCalls 跨引擎结构一致", () => {
  it("D1: 三引擎 generate 产出相同 content(脚本化内容)", async () => {
    // CC 和 Codex 共用 cliListenCallback 槽,必须串行调用(先 CC 再 Codex)。
    // API 适配器不走 listen,可以任意时序。

    // API
    const apiProvider = makeStubProvider([
      { content: SCRIPTED_CONTENT, model: "stub-model" },
    ]);
    const apiAdapter = makeApiAdapter(apiProvider);
    const apiResult = await apiAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // CC(串行)
    setCliScript(SCRIPTED_CONTENT);
    const ccAdapter = makeClaudeCodeAdapter();
    const ccResult = await ccAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // Codex(串行,重置脚本)
    setCliScript(SCRIPTED_CONTENT);
    const codexAdapter = makeCodexAdapter();
    const codexResult = await codexAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // D1: 三引擎 content 等同脚本内容
    expect(apiResult.content).toBe(SCRIPTED_CONTENT);
    expect(ccResult.content).toBe(SCRIPTED_CONTENT);
    expect(codexResult.content).toBe(SCRIPTED_CONTENT);
  });

  it("D2: 三引擎 generate 的 model 字段均非空(各自标识)", async () => {
    // API
    const apiProvider = makeStubProvider([
      { content: SCRIPTED_CONTENT, model: "stub-model" },
    ]);
    const apiAdapter = makeApiAdapter(apiProvider);
    const apiResult = await apiAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // CC(串行)
    setCliScript(SCRIPTED_CONTENT);
    const ccAdapter = makeClaudeCodeAdapter();
    const ccResult = await ccAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // Codex(串行)
    setCliScript(SCRIPTED_CONTENT);
    const codexAdapter = makeCodexAdapter();
    const codexResult = await codexAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // D2: model 字段各自声明,但都必须存在且非空
    expect(typeof apiResult.model).toBe("string");
    expect(typeof ccResult.model).toBe("string");
    expect(typeof codexResult.model).toBe("string");
  });

  it("D3: tool_call_start 事件不污染最终 content(工具步骤不计入结果)", async () => {
    // API:工具调用由上层 agent loop 处理,content 是纯文字
    const apiProvider = makeStubProvider([
      { content: "你今天有 5 个待办", model: "stub-model" },
    ]);
    const apiAdapter = makeApiAdapter(apiProvider);
    const apiResult = await apiAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // CC(串行)
    setCliToolCallScript("list_todos", "你今天有 5 个待办");
    const ccAdapter = makeClaudeCodeAdapter();
    const ccResult = await ccAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // Codex(串行,重置脚本)
    setCliToolCallScript("list_todos", "你今天有 5 个待办");
    const codexAdapter = makeCodexAdapter();
    const codexResult = await codexAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // D3: 工具调用不计入 content 文本
    expect(apiResult.content).not.toContain("list_todos");
    expect(ccResult.content).not.toContain("list_todos");
    expect(codexResult.content).not.toContain("list_todos");

    // CLI 适配器 content 只含 text 事件的文字
    expect(ccResult.content).toBe("你今天有 5 个待办");
    expect(codexResult.content).toBe("你今天有 5 个待办");

    // CLI 适配器不产出 toolCalls(CLI 自己执行,不回吐 agent loop)
    expect(ccResult.toolCalls).toBeUndefined();
    expect(codexResult.toolCalls).toBeUndefined();
  });
});

// ─── D4 / D5: generateStream 流式回调一致性 ──────────────────────────────────

describe("D4-D5: generateStream — onToken 序列 / onDone content 跨引擎一致", () => {
  it("D4: 三引擎 generateStream 的 onToken 累积内容与最终 content 一致", async () => {
    const expectedContent = SCRIPTED_CONTENT;

    async function collectStream(adapter: EngineAdapter): Promise<{
      tokens: string[];
      finalContent: string;
    }> {
      const tokens: string[] = [];
      const result = await adapter.generateStream(
        FIXED_MESSAGES,
        { temperature: 0 },
        {
          onToken: (t) => tokens.push(t),
        } as EngineStreamHandlers
      );
      return { tokens, finalContent: result.content };
    }

    // API 适配器
    const apiProvider = makeStubProvider([], { streamContent: expectedContent });
    const apiAdapter = makeApiAdapter(apiProvider);
    const apiOut = await collectStream(apiAdapter);

    // CC(串行)
    setCliScript(expectedContent);
    const ccAdapter = makeClaudeCodeAdapter();
    const ccOut = await collectStream(ccAdapter);

    // Codex(串行,重置脚本)
    setCliScript(expectedContent);
    const codexAdapter = makeCodexAdapter();
    const codexOut = await collectStream(codexAdapter);

    // D4: onToken 累积结果 === 最终 content
    expect(apiOut.tokens.join("")).toBe(apiOut.finalContent);
    expect(ccOut.tokens.join("")).toBe(ccOut.finalContent);
    expect(codexOut.tokens.join("")).toBe(codexOut.finalContent);

    // 三引擎最终 content 都等于脚本内容
    expect(apiOut.finalContent).toBe(expectedContent);
    expect(ccOut.finalContent).toBe(expectedContent);
    expect(codexOut.finalContent).toBe(expectedContent);
  });

  it("D5: onDone 回调的 content 与 generateStream 返回值 content 相同(三引擎)", async () => {
    const expectedContent = "分析完成";

    async function collectDone(adapter: EngineAdapter): Promise<{
      doneContent: string | undefined;
      returnedContent: string;
    }> {
      let doneContent: string | undefined;
      const result = await adapter.generateStream(
        FIXED_MESSAGES,
        { temperature: 0 },
        {
          onToken: () => undefined,
          onDone: (r: EngineResult) => {
            doneContent = r.content;
          },
        } as EngineStreamHandlers
      );
      return { doneContent, returnedContent: result.content };
    }

    // API 适配器
    const apiProvider = makeStubProvider([], { streamContent: expectedContent });
    const apiAdapter = makeApiAdapter(apiProvider);
    const apiOut = await collectDone(apiAdapter);

    // CC(串行)
    setCliScript(expectedContent);
    const ccAdapter = makeClaudeCodeAdapter();
    const ccOut = await collectDone(ccAdapter);

    // Codex(串行,重置脚本)
    setCliScript(expectedContent);
    const codexAdapter = makeCodexAdapter();
    const codexOut = await collectDone(codexAdapter);

    // D5: onDone.content === 返回值 content(三引擎都成立)
    expect(apiOut.doneContent).toBe(apiOut.returnedContent);
    expect(ccOut.doneContent).toBe(ccOut.returnedContent);
    expect(codexOut.doneContent).toBe(codexOut.returnedContent);
  });
});

// ─── D6: 错误路径跨引擎一致性 ────────────────────────────────────────────────

describe("D6: 错误路径 — 三引擎都 reject + 调 onError 回调", () => {
  it("D6: generateStream 遇错误 → onError 被调,promise reject", async () => {
    const errMsg = "引擎响应失败";

    // CLI 适配器的错误路径
    setCliErrorScript(errMsg);
    const ccAdapter = makeClaudeCodeAdapter();
    const codexAdapter = makeCodexAdapter();

    // 验证 CC 适配器
    const ccErrors: Error[] = [];
    await expect(
      ccAdapter.generateStream(FIXED_MESSAGES, { temperature: 0 }, {
        onToken: () => undefined,
        onError: (e: Error) => ccErrors.push(e),
      })
    ).rejects.toThrow(errMsg);
    expect(ccErrors).toHaveLength(1);
    expect(ccErrors[0].message).toContain(errMsg);

    // 重置 CLI 脚本给 Codex 用
    setCliErrorScript(errMsg);
    const codexErrors: Error[] = [];
    await expect(
      codexAdapter.generateStream(FIXED_MESSAGES, { temperature: 0 }, {
        onToken: () => undefined,
        onError: (e: Error) => codexErrors.push(e),
      })
    ).rejects.toThrow(errMsg);
    expect(codexErrors).toHaveLength(1);
    expect(codexErrors[0].message).toContain(errMsg);

    // API 适配器的错误路径:provider 的 chatStream 抛错
    const errorProvider: LLMProvider = {
      name: "error-stub",
      model: "error-model",
      async chat(): Promise<ChatResult> {
        throw new Error(errMsg);
      },
      async chatStream(
        _messages: ChatMessage[],
        _opts: ChatOptions,
        handlers: StreamHandlers
      ): Promise<ChatResult> {
        const e = new Error(errMsg);
        handlers.onError?.(e);
        throw e;
      },
      capabilities(): LLMCapabilities {
        return { supportsTools: false, supportsReasoning: false, supportsStreaming: true };
      },
    };
    const apiAdapter = makeApiAdapter(errorProvider);
    const apiErrors: Error[] = [];
    await expect(
      apiAdapter.generateStream(FIXED_MESSAGES, { temperature: 0 }, {
        onToken: () => undefined,
        onError: (e: Error) => apiErrors.push(e),
      })
    ).rejects.toThrow(errMsg);
    expect(apiErrors).toHaveLength(1);
    expect(apiErrors[0].message).toContain(errMsg);
  });
});

// ─── D7: 多段文本累积结果一致性 ─────────────────────────────────────────────

describe("D7: 多段 text 事件累积 — CLI 两引擎结果与 API 一致", () => {
  it("D7: 多段 text 事件累积 content(CC/Codex 与 API 脚本内容一致)", async () => {
    const segments = ["第一段: ", "高价值任务", ", 聚焦执行。"];
    const expectedContent = segments.join("");

    setCliMultiSegmentScript(segments);
    // CLI 事件:需要重新设置给 codexAdapter(第二次调用会复用 cliScriptedEvents 已消耗)
    // 注意:两个 CLI 适配器串行调用时,要分别设置 cliScriptedEvents
    const ccAdapter = makeClaudeCodeAdapter();
    const ccResult = await ccAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    setCliMultiSegmentScript(segments);
    const codexAdapter = makeCodexAdapter();
    const codexResult = await codexAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    const apiProvider = makeStubProvider([
      { content: expectedContent, model: "stub-model" },
    ]);
    const apiAdapter = makeApiAdapter(apiProvider);
    const apiResult = await apiAdapter.generate(FIXED_MESSAGES, { temperature: 0 });

    // D7: 三引擎最终 content 相同
    expect(apiResult.content).toBe(expectedContent);
    expect(ccResult.content).toBe(expectedContent);
    expect(codexResult.content).toBe(expectedContent);
  });

  it("D7b: thinking 事件不进入最终 content(CC/Codex 推理流不污染结果)", async () => {
    const thinkingText = "让我思考一下用户的目标…";
    const actualContent = "今日三件事:撰写提案、面试候选人、回顾 Q2 数据。";

    setCliThinkingScript(thinkingText, actualContent);
    const ccAdapter = makeClaudeCodeAdapter();

    const ccTokens: string[] = [];
    const ccReasoningTokens: string[] = [];
    const ccResult = await ccAdapter.generateStream(
      FIXED_MESSAGES,
      { temperature: 0 },
      {
        onToken: (t) => ccTokens.push(t),
        onReasoningToken: (t) => ccReasoningTokens.push(t),
      } as EngineStreamHandlers
    );

    setCliThinkingScript(thinkingText, actualContent);
    const codexAdapter = makeCodexAdapter();

    const codexTokens: string[] = [];
    const codexReasoningTokens: string[] = [];
    const codexResult = await codexAdapter.generateStream(
      FIXED_MESSAGES,
      { temperature: 0 },
      {
        onToken: (t) => codexTokens.push(t),
        onReasoningToken: (t) => codexReasoningTokens.push(t),
      } as EngineStreamHandlers
    );

    // thinking 进 onReasoningToken,不进 content
    expect(ccResult.content).toBe(actualContent);
    expect(codexResult.content).toBe(actualContent);
    expect(ccResult.content).not.toContain(thinkingText);
    expect(codexResult.content).not.toContain(thinkingText);

    // onReasoningToken 收到 thinking
    expect(ccReasoningTokens).toContain(thinkingText);
    expect(codexReasoningTokens).toContain(thinkingText);

    // onToken 不含 thinking
    expect(ccTokens.join("")).not.toContain(thinkingText);
    expect(codexTokens.join("")).not.toContain(thinkingText);
  });
});

// ─── D8: 无状态隔离一致性 ────────────────────────────────────────────────────

describe("D8: 无状态隔离 — 三引擎两轮独立 generate 不跨轮污染", () => {
  it("D8: 两轮 generate 的 content 各自独立(不累积上轮内容)", async () => {
    const round1Content = "第一轮答复";
    const round2Content = "第二轮答复";

    // CLI 适配器(CC)
    const ccAdapter = makeClaudeCodeAdapter();
    cliScriptedEvents = [{ type: "text", text: round1Content }, { type: "done" }];
    const cc1 = await ccAdapter.generate([
      { role: "system", content: "SYS" },
      { role: "user", content: "问题一" },
    ], { temperature: 0 });

    cliScriptedEvents = [{ type: "text", text: round2Content }, { type: "done" }];
    const cc2 = await ccAdapter.generate([
      { role: "system", content: "SYS" },
      { role: "user", content: "问题二" },
    ], { temperature: 0 });

    expect(cc1.content).toBe(round1Content);
    expect(cc2.content).toBe(round2Content);
    // 第二轮 content 不含第一轮内容(无状态)
    expect(cc2.content).not.toContain(round1Content);

    // CLI 适配器(Codex)
    const codexAdapter = makeCodexAdapter();
    cliScriptedEvents = [{ type: "text", text: round1Content }, { type: "done" }];
    const codex1 = await codexAdapter.generate([
      { role: "system", content: "SYS" },
      { role: "user", content: "问题一" },
    ], { temperature: 0 });

    cliScriptedEvents = [{ type: "text", text: round2Content }, { type: "done" }];
    const codex2 = await codexAdapter.generate([
      { role: "system", content: "SYS" },
      { role: "user", content: "问题二" },
    ], { temperature: 0 });

    expect(codex1.content).toBe(round1Content);
    expect(codex2.content).toBe(round2Content);
    expect(codex2.content).not.toContain(round1Content);

    // API 适配器
    const apiProvider1 = makeStubProvider([
      { content: round1Content, model: "stub-model" },
      { content: round2Content, model: "stub-model" },
    ]);
    const apiAdapter = makeApiAdapter(apiProvider1);
    const api1 = await apiAdapter.generate([
      { role: "system", content: "SYS" },
      { role: "user", content: "问题一" },
    ], { temperature: 0 });
    const api2 = await apiAdapter.generate([
      { role: "system", content: "SYS" },
      { role: "user", content: "问题二" },
    ], { temperature: 0 });

    expect(api1.content).toBe(round1Content);
    expect(api2.content).toBe(round2Content);
    expect(api2.content).not.toContain(round1Content);
  });
});

// ─── 能力位接口一致性(capabilities 契约) ───────────────────────────────────

describe("能力位契约: 三引擎都实现 capabilities(),返回三个布尔字段", () => {
  it("capabilities() 返回结构与 EngineCapabilities 类型一致(字段齐全,布尔值)", () => {
    // 注意:API 桩 provider 的能力位与真实生产 provider 不同;这里只验接口形状。
    const apiProvider = makeStubProvider([]);
    const apiAdapter = makeApiAdapter(apiProvider);
    const ccAdapter = makeClaudeCodeAdapter();
    const codexAdapter = makeCodexAdapter();

    for (const adapter of [apiAdapter, ccAdapter, codexAdapter]) {
      const caps = adapter.capabilities();
      expect(typeof caps.supportsTools).toBe("boolean");
      expect(typeof caps.supportsReasoning).toBe("boolean");
      expect(typeof caps.supportsStreaming).toBe("boolean");
    }
  });

  it("CLI 引擎(CC/Codex)声明支持工具/推理/流式(经 MCP 路径)", () => {
    const ccAdapter = makeClaudeCodeAdapter();
    const codexAdapter = makeCodexAdapter();

    const ccCaps = ccAdapter.capabilities();
    const codexCaps = codexAdapter.capabilities();

    // CC 和 Codex 能力位对称(两者都走 MCP 工具 + thinking + NDJSON 流)
    expect(ccCaps.supportsTools).toBe(true);
    expect(ccCaps.supportsReasoning).toBe(true);
    expect(ccCaps.supportsStreaming).toBe(true);

    expect(codexCaps.supportsTools).toBe(true);
    expect(codexCaps.supportsReasoning).toBe(true);
    expect(codexCaps.supportsStreaming).toBe(true);
  });
});
