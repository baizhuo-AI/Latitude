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
 *   - 共享夹具 installFakeEngine():把 DeepSeekProvider 换成可编排的假引擎(fakeEngine.ts),
 *     绕开 getProvider 模块单例缓存,绝不打真 API。
 *   - mock `../db`:dbInsertUsage 变 no-op,避免碰 SQLite。
 *   - mock `../chatTools`:toolsForLLM / runChatTool 变可控 fake,断言回灌行为。
 *   - mock 两个 store:让 buildChatSystemPrompt 输出稳定、不依赖真实数据。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatMessage } from "./types";
import { FakeEngine, installFakeEngine } from "./fakeEngine";

// ─── 注入共享假引擎(绕开 getProvider 模块单例缓存) ────────────────────────
// installFakeEngine() 在模块顶层调用:内部执行 vi.mock("./deepseek"),
// 把 DeepSeekProvider 换成「每次方法调用转发到当前 engine 实例」的代理。
// 代理方式确保 beforeEach 换 engine 后,代理自动跟到新实例,无需清模块缓存。
const { getEngine, setEngine } = installFakeEngine();

// 当前测试持有的假引擎实例;beforeEach 里重置
let engine: FakeEngine;

// ─── mock 模块依赖 ───────────────────────────────────────────────────────────

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
// lang + persona 也带上,确保 buildChatSystemPrompt 的人设路径有稳定输入
vi.mock("../settings", () => ({
  onProviderConfigChange: () => () => undefined,
  useSettingsStore: {
    getState: () => ({
      lang: "zh",
      persona: { presetKey: "seniorAdvisor" },
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
  engine = setEngine(new FakeEngine());
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
    expect(engine.received).toHaveLength(1);
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
    expect(engine.received).toHaveLength(2);
    // 工具被执行了一次,且参数被解析并传入
    expect(runChatToolSpy).toHaveBeenCalledTimes(1);
    expect(runChatToolSpy).toHaveBeenCalledWith("fake_tool", { x: 1 });

    // 关键:第二轮请求的 messages 里必须「回灌」了 assistant 的工具调用 + tool 结果
    const secondRoundMsgs = engine.received[1].messages;
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
    expect(engine.received).toHaveLength(6);
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

    expect(engine.received).toHaveLength(3);
    for (const call of engine.received) {
      // 每一轮第一条都是 system,且带上了 buildChatSystemPrompt 的内容
      // (原来检测 "Daybreak" 字符串;Task 1.1 后人设注入替换了写死的 header,
      //  改为断言锁死核心规则段里必然存在的锚字符串)
      expect(call.messages[0].role).toBe("system");
      expect(call.messages[0].content).toContain("不替用户甩选项");
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
    expect(engine.received).toHaveLength(1);
    const msgs = engine.received[0].messages;
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
    expect(engine.received[0].opts.tools).toBeUndefined();
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

    const opts = engine.received[0].opts;
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
