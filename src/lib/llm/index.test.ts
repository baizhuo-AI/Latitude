/**
 * index.test.ts — 大脑调用层(LLM 高层 API)单测
 *
 * 分两部分:
 *  1. 【特征化测试】先用假引擎锁住 chatAgentCall 现有的 agent loop 控制流——
 *     这是用户正在用的聊天主路径,重构前必须先把当前行为钉死:
 *       - 工具调用最多 MAX_ROUNDS 轮(死循环保护)
 *       - 收到 tool 结果后回灌再请求(多轮 function calling)
 *       - 模型不再调工具时给出最终答复
 *       - 系统提示词 + 完整历史「每一轮」都注入(无状态 C1),不依赖引擎侧 session
 *  2. 【新行为】generateOnce 裸调 + 能力位 + 解 reasoner/工具互斥(可配置 model)。
 *
 * 测试策略(沿用本仓 scheduler.test / dbTx.test 的依赖注入 + fake 风格):
 *   - mock `./deepseek`:把 DeepSeekProvider 换成「可编排脚本」的假引擎,绝不打真 API。
 *     这样测的是真实的 chatAgentCall + getProvider 接线,只把网络那一层换掉。
 *   - mock `../db`:dbInsertUsage 变 no-op,避免碰 SQLite。
 *   - mock `../chatTools`:toolsForLLM / runChatTool 变可控 fake,断言回灌行为。
 *   - mock 两个 store:让 buildChatSystemPrompt 输出稳定、不依赖真实数据。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  StreamHandlers,
  LLMCapabilities,
} from "./types";
// 真实的 DeepSeek 能力位推断:测试里复用它,让假引擎的能力位与生产逻辑一致
// (而不是在测试里另抄一份,否则测的是测试自己)。
import { deepseekCapabilities } from "./deepseek";

// ─── 可编排的假引擎 ──────────────────────────────────────────────────────────
/**
 * 每次 chat() 调用按预设脚本依次返回一个 ChatResult,并把「本次收到的完整 messages
 * 快照」与「opts」记录下来,供断言「每轮都注入了 system+history」「model 透传」等。
 */
interface ChatCallRecord {
  messages: ChatMessage[];
  opts: ChatOptions;
}

class ScriptedEngine {
  readonly name = "deepseek"; // 冒充 deepseek,让 chatAgentCall 走「真 provider」分支
  model = "deepseek-chat";

  /** 预设的逐轮返回值;用尽后默认返回一个「无工具调用的最终答复」 */
  script: ChatResult[] = [];
  /** 记录每次 chat() 的入参,断言控制流用 */
  calls: ChatCallRecord[] = [];

  // 能力位据「当前 engine.model」推断,复用生产逻辑(测试切 engine.model 即可验证降级)
  capabilities(model?: string): LLMCapabilities {
    return deepseekCapabilities(model ?? this.model);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    // 深拷贝 messages 快照,防止后续 loop 往同一数组 push 污染历史断言
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)), opts });
    const next = this.script.shift();
    if (next) return next;
    return { content: "(脚本耗尽,最终答复)", model: opts.model };
  }

  async chatStream(
    _messages: ChatMessage[],
    _opts: ChatOptions,
    handlers: StreamHandlers
  ): Promise<ChatResult> {
    const result: ChatResult = { content: "stream-done", model: _opts.model };
    handlers.onToken("stream-done");
    handlers.onDone?.(result);
    return result;
  }
}

// 当前测试持有的假引擎实例;mock 工厂闭包引用它,各用例 beforeEach 重置。
let engine: ScriptedEngine;

// ─── mock 模块依赖 ───────────────────────────────────────────────────────────
// DeepSeekProvider → 一个「转发到当前 engine」的代理。
// 注意:不能在 constructor 里返回 engine 实例,因为 getProvider() 会把 provider 缓存成
// 模块级单例(只 new 一次)。若直接返回实例,后续 beforeEach 换了 engine,缓存里仍是旧实例。
// 用代理每次方法调用都读「当前 engine 绑定」,即可让每个用例拿到自己的脚本/记录。
vi.mock("./deepseek", async () => {
  // 保留真实的 deepseekCapabilities(能力位推断),只把 DeepSeekProvider 换成代理
  const actual = await vi.importActual<typeof import("./deepseek")>("./deepseek");
  return {
    ...actual,
    DeepSeekProvider: class {
      get name() {
        return engine.name;
      }
      get model() {
        return engine.model;
      }
      capabilities(model?: string) {
        return engine.capabilities(model);
      }
      chat(messages: ChatMessage[], opts?: ChatOptions) {
        return engine.chat(messages, opts);
      }
      chatStream(messages: ChatMessage[], opts: ChatOptions, handlers: StreamHandlers) {
        return engine.chatStream(messages, opts, handlers);
      }
    },
  };
});

// db 写入 no-op(usage 记录不该碰真 DB,也不影响控制流)
const dbInsertUsageSpy = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../db", () => ({
  dbInsertUsage: (...args: unknown[]) => dbInsertUsageSpy(...args),
}));

// chatTools:可控的工具列表 + 工具执行 fake
const runChatToolSpy = vi.fn(async (name: string, _args: Record<string, unknown>) =>
  JSON.stringify({ ok: true, tool: name })
);
vi.mock("../chatTools", () => ({
  toolsForLLM: () => [
    {
      type: "function",
      function: { name: "fake_tool", description: "测试工具", parameters: {} },
    },
  ],
  runChatTool: (name: string, args: Record<string, unknown>) => runChatToolSpy(name, args),
}));

// 两个 store:让 buildChatSystemPrompt / telosContextSection 输出稳定
vi.mock("../store", () => ({
  useTodoStore: { getState: () => ({ todos: [] }) },
}));
vi.mock("../goalsStore", () => ({
  useGoalsStore: { getState: () => ({ goals: [] }) },
}));

// settings:固定成「deepseek + 有 key + deepseek-chat」,让 getProvider 走真 provider 分支
vi.mock("../settings", () => ({
  onProviderConfigChange: () => () => undefined,
  useSettingsStore: {
    getState: () => ({
      llmProvider: "deepseek",
      providers: {
        deepseek: {
          apiKey: "test-key",
          baseUrl: "https://example.test",
          model: "deepseek-chat",
        },
      },
    }),
  },
}));

// 被测模块在 mock 之后再 import(确保拿到 mock 版依赖)
import {
  chatAgentCall,
  generateOnce,
  getCapabilities,
} from "./index";

beforeEach(() => {
  engine = new ScriptedEngine();
  dbInsertUsageSpy.mockClear();
  runChatToolSpy.mockClear();
});

// ════════════════════════════════════════════════════════════════════════════
// 第一部分:chatAgentCall 特征化测试(锁住现有控制流)
// ════════════════════════════════════════════════════════════════════════════
describe("chatAgentCall — agent loop 特征化(锁住现有行为)", () => {
  it("模型首轮不调工具 → 单轮就返回最终答复", async () => {
    engine.script = [{ content: "你好,有什么可以帮你?", model: "deepseek-chat" }];

    const result = await chatAgentCall([{ role: "user", content: "在吗" }]);

    expect(result.content).toBe("你好,有什么可以帮你?");
    // 只请求了一次大脑
    expect(engine.calls).toHaveLength(1);
    // 没有执行任何工具
    expect(runChatToolSpy).not.toHaveBeenCalled();
  });

  it("模型调一次工具 → 回灌结果后再请求 → 第二轮给最终答复", async () => {
    engine.script = [
      // 第一轮:请求调工具(content 可空)
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "fake_tool", arguments: '{"x":1}' }],
        model: "deepseek-chat",
      },
      // 第二轮:拿到工具结果后给最终答复
      { content: "已处理完成", model: "deepseek-chat" },
    ];

    const result = await chatAgentCall([{ role: "user", content: "帮我建个任务" }]);

    expect(result.content).toBe("已处理完成");
    // 一共两轮大脑请求
    expect(engine.calls).toHaveLength(2);
    // 工具被执行了一次,且参数被解析并传入
    expect(runChatToolSpy).toHaveBeenCalledTimes(1);
    expect(runChatToolSpy).toHaveBeenCalledWith("fake_tool", { x: 1 });

    // 关键:第二轮请求的 messages 里必须「回灌」了 assistant 的工具调用 + tool 结果
    const secondRoundMsgs = engine.calls[1].messages;
    const assistantToolMsg = secondRoundMsgs.find(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0
    );
    const toolResultMsg = secondRoundMsgs.find((m) => m.role === "tool");
    expect(assistantToolMsg).toBeTruthy();
    expect(assistantToolMsg?.toolCalls?.[0].id).toBe("call_1");
    expect(toolResultMsg).toBeTruthy();
    expect(toolResultMsg?.toolCallId).toBe("call_1");
    expect(toolResultMsg?.content).toContain("fake_tool");
  });

  it("工具参数 JSON 解析失败 → 传空对象给工具(不抛错、流程不中断)", async () => {
    engine.script = [
      {
        content: "",
        toolCalls: [{ id: "call_bad", name: "fake_tool", arguments: "{不是合法JSON" }],
        model: "deepseek-chat",
      },
      { content: "兜底完成", model: "deepseek-chat" },
    ];

    const result = await chatAgentCall([{ role: "user", content: "x" }]);

    expect(result.content).toBe("兜底完成");
    // 参数解析失败 → 传空对象
    expect(runChatToolSpy).toHaveBeenCalledWith("fake_tool", {});
  });

  it("模型每轮都调工具 → 在 MAX_ROUNDS(6) 处停下,不无限循环", async () => {
    // 脚本始终返回「再调一次工具」,逼出上限
    engine.script = Array.from({ length: 10 }, (_, i) => ({
      content: "",
      toolCalls: [{ id: `call_${i}`, name: "fake_tool", arguments: "{}" }],
      model: "deepseek-chat",
    }));

    const result = await chatAgentCall([{ role: "user", content: "无限循环试探" }]);

    // 大脑请求次数恰好等于 MAX_ROUNDS(锁死当前上限 = 6)
    expect(engine.calls).toHaveLength(6);
    // 达到上限时返回兜底文案(非空)
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("无状态 C1:系统提示词 + 完整历史「每一轮」都注入,不依赖引擎 session", async () => {
    engine.script = [
      {
        content: "",
        toolCalls: [{ id: "c1", name: "fake_tool", arguments: "{}" }],
        model: "deepseek-chat",
      },
      {
        content: "",
        toolCalls: [{ id: "c2", name: "fake_tool", arguments: "{}" }],
        model: "deepseek-chat",
      },
      { content: "终", model: "deepseek-chat" },
    ];

    const history: ChatMessage[] = [
      { role: "user", content: "第一句" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二句" },
    ];
    await chatAgentCall(history);

    expect(engine.calls).toHaveLength(3);
    for (const call of engine.calls) {
      // 每一轮第一条都是 system,且带上了 buildChatSystemPrompt 的内容
      expect(call.messages[0].role).toBe("system");
      expect(call.messages[0].content).toContain("Daybreak");
      // 每一轮都带着原始 user/assistant 历史(没有因为进入后续轮次而丢上下文)
      const contents = call.messages.map((m) => m.content).join("\n");
      expect(contents).toContain("第一句");
      expect(contents).toContain("第二句");
    }
  });

  it("usage 记录被调用(每轮一次),但失败也不影响主流程", async () => {
    engine.script = [
      {
        content: "",
        toolCalls: [{ id: "c1", name: "fake_tool", arguments: "{}" }],
        model: "deepseek-chat",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        content: "完",
        model: "deepseek-chat",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ];

    const result = await chatAgentCall([{ role: "user", content: "x" }]);
    expect(result.content).toBe("完");
    // 两轮各记一次 usage
    expect(dbInsertUsageSpy).toHaveBeenCalledTimes(2);
  });

  it("onStep 回调:每个工具调用前触发一次,带工具名", async () => {
    engine.script = [
      {
        content: "",
        toolCalls: [
          { id: "a", name: "fake_tool", arguments: "{}" },
          { id: "b", name: "fake_tool", arguments: "{}" },
        ],
        model: "deepseek-chat",
      },
      { content: "完", model: "deepseek-chat" },
    ];

    const steps: string[] = [];
    await chatAgentCall([{ role: "user", content: "x" }], {
      onStep: (info) => steps.push(info.name),
    });

    expect(steps).toEqual(["fake_tool", "fake_tool"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 第二部分:generateOnce 裸调(C3,新增)
// ════════════════════════════════════════════════════════════════════════════
describe("generateOnce — 裸调(不绑会话/不写 DB/不记 usage)", () => {
  it("传入 systemPrompt + messages → 原样组装并调一次大脑,返回文本", async () => {
    engine.script = [{ content: "一句话答复", model: "deepseek-chat" }];

    const text = await generateOnce("你是测试助手", [
      { role: "user", content: "说一句话" },
    ]);

    expect(text).toBe("一句话答复");
    // 只调一次
    expect(engine.calls).toHaveLength(1);
    const msgs = engine.calls[0].messages;
    expect(msgs[0]).toEqual({ role: "system", content: "你是测试助手" });
    expect(msgs[1]).toEqual({ role: "user", content: "说一句话" });
  });

  it("不写 DB / 不记 usage(即便 provider 返回了 usage)", async () => {
    engine.script = [
      {
        content: "答",
        model: "deepseek-chat",
        usage: { promptTokens: 9, completionTokens: 9, totalTokens: 18 },
      },
    ];

    await generateOnce("sys", [{ role: "user", content: "hi" }]);
    // 裸调绝不记 usage
    expect(dbInsertUsageSpy).not.toHaveBeenCalled();
  });

  it("不调工具(裸调即纯文本生成,不传 tools)", async () => {
    engine.script = [{ content: "纯文本", model: "deepseek-chat" }];

    await generateOnce("sys", [{ role: "user", content: "hi" }]);
    // 裸调不该带 tools
    expect(engine.calls[0].opts.tools).toBeUndefined();
    expect(runChatToolSpy).not.toHaveBeenCalled();
  });

  it("opts 透传:可覆盖 temperature / maxTokens / responseFormat / model", async () => {
    engine.script = [{ content: "{}", model: "custom-model" }];

    await generateOnce("sys", [{ role: "user", content: "hi" }], {
      temperature: 0.1,
      maxTokens: 50,
      responseFormat: "json",
      model: "custom-model",
    });

    const opts = engine.calls[0].opts;
    expect(opts.temperature).toBe(0.1);
    expect(opts.maxTokens).toBe(50);
    expect(opts.responseFormat).toBe("json");
    expect(opts.model).toBe("custom-model");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 第三部分:能力位 + 解 reasoner/工具互斥
// ════════════════════════════════════════════════════════════════════════════
describe("能力位 getCapabilities — 据实声明,供上层降级", () => {
  it("deepseek-chat:支持工具/流式,不支持推理", () => {
    engine.model = "deepseek-chat";
    const caps = getCapabilities();
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsReasoning).toBe(false);
  });

  it("deepseek-reasoner:支持推理/流式,不支持工具", () => {
    engine.model = "deepseek-reasoner";
    const caps = getCapabilities();
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsTools).toBe(false);
  });

  it("未知/未来模型(如 V4):不再写死 block,默认按「工具+推理合一」放开", () => {
    // V4 这类「可能工具+推理合一」的模型:不硬 block,能力位据实(默认全开)
    engine.model = "deepseek-v4";
    const caps = getCapabilities();
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsStreaming).toBe(true);
  });
});
