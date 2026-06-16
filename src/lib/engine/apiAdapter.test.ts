/**
 * apiAdapter.test.ts — API 引擎适配器回归测试
 *
 * 目的(Task 4.1 验收):证明 makeApiAdapter() 包出来的 EngineAdapter 与底层
 * LLMProvider 路径行为完全一致——即「把单引擎缝包成统一接口后,现有聊天行为不变」。
 *
 * 策略:沿用 llm/index.test.ts 的假引擎夹具(installFakeEngine):它把 DeepSeekProvider
 * 换成「每次方法调用转发到当前 FakeEngine」的代理。makeApiAdapter() 内部走 getProvider(),
 * 因此适配器会透明路由到假引擎,绝不打真 API。我们断言:
 *   - generate        透传 messages/opts 到底层 chat,并原样返回结果(含 toolCalls/usage)
 *   - generateStream  透传到底层 chatStream,流式回调与最终结果不变
 *   - capabilities    据 model 透传底层能力位
 *   - name/model      反映当前生效 provider
 *   - 钉死 provider(显式传入)时,不再走 getProvider(),用传入实例
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEngine, installFakeEngine } from "../llm/fakeEngine";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMCapabilities,
  LLMProvider,
  StreamHandlers,
} from "../llm/types";

// 注入共享假引擎(模块顶层,内部 vi.mock("../llm/deepseek"))。
// 注意:fakeEngine.installFakeEngine 内部 mock 的是相对它自身的 "./deepseek",
// 即 src/lib/llm/deepseek —— 与 getProvider() new 的是同一个模块,故能拦截到。
const { setEngine } = installFakeEngine();

let engine: FakeEngine;

// db / settings 的 mock:让 getProvider() 走真 provider 分支(deepseek + 有 key),
// 且 usage 记录相关依赖不碰真实 SQLite。makeApiAdapter 本身不记 usage,但 getProvider
// 所在的 llm/index 模块会 import ../db / ../settings,需提供桩。
vi.mock("../db", () => ({
  dbInsertUsage: async () => undefined,
  dbGetRecentDigests: async () => [],
  dbListMemoryFacts: async () => [],
}));

const FIXED_SETTINGS = {
  lang: "zh" as const,
  persona: { presetKey: "seniorAdvisor" as const },
  llmProvider: "deepseek" as const,
  providers: {
    deepseek: {
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: "deepseek-chat",
    },
  },
};

vi.mock("../settings", () => ({
  onProviderConfigChange: () => () => undefined,
  useSettingsStore: { getState: () => FIXED_SETTINGS },
  readSettingsSnapshot: () => FIXED_SETTINGS,
}));

// 被测模块在 mock 之后 import
import { makeApiAdapter } from "./apiAdapter";

beforeEach(() => {
  engine = setEngine(new FakeEngine());
});

describe("makeApiAdapter — 透明包装当前 provider(行为不变)", () => {
  it("name / model 反映当前生效 provider", () => {
    engine.model = "deepseek-chat";
    const adapter = makeApiAdapter();
    expect(adapter.name).toBe("deepseek"); // FakeEngine 冒充 deepseek
    expect(adapter.model).toBe("deepseek-chat");
  });

  it("generate 透传 messages/opts 到底层 chat,并原样返回结果", async () => {
    engine.script = [
      { content: "最终答复", model: "deepseek-chat", usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 } },
    ];
    const adapter = makeApiAdapter();

    const messages: ChatMessage[] = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "在吗" },
    ];
    const opts: ChatOptions = { temperature: 0.7, maxTokens: 123, model: "deepseek-chat" };

    const result = await adapter.generate(messages, opts);

    // 结果原样回传
    expect(result.content).toBe("最终答复");
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 5, totalTokens: 8 });

    // 入参原样透传到底层 chat(假引擎记录了快照)
    expect(engine.received).toHaveLength(1);
    expect(engine.received[0].messages).toEqual(messages);
    expect(engine.received[0].opts).toEqual(opts);
  });

  it("generate 透传 toolCalls(function calling 结构不丢)", async () => {
    engine.script = [
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "fake_tool", arguments: '{"x":1}' }],
        model: "deepseek-chat",
      },
    ];
    const adapter = makeApiAdapter();

    const result = await adapter.generate([{ role: "user", content: "建任务" }], {
      tools: [{ type: "function", function: { name: "fake_tool" } }],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toEqual({
      id: "call_1",
      name: "fake_tool",
      arguments: '{"x":1}',
    });
    // tools 选项被透传给底层
    expect(engine.received[0].opts.tools).toEqual([
      { type: "function", function: { name: "fake_tool" } },
    ]);
  });

  it("generateStream 透传到底层 chatStream,流式回调与最终结果一致", async () => {
    const adapter = makeApiAdapter();
    const tokens: string[] = [];
    let doneResult: ChatResult | undefined;

    const handlers: StreamHandlers = {
      onToken: (t) => tokens.push(t),
      onDone: (r) => {
        doneResult = r;
      },
    };

    const final = await adapter.generateStream(
      [{ role: "user", content: "讲个笑话" }],
      { model: "deepseek-reasoner" },
      handlers
    );

    // FakeEngine.chatStream 默认行为:onToken("stream-done") + onDone
    expect(tokens).toEqual(["stream-done"]);
    expect(final.content).toBe("stream-done");
    expect(final.model).toBe("deepseek-reasoner");
    expect(doneResult).toEqual(final);
  });

  it("capabilities 据 model 透传底层能力位(reasoner 无工具 / chat 有工具)", () => {
    const adapter = makeApiAdapter();
    const reasoner = adapter.capabilities("deepseek-reasoner");
    expect(reasoner.supportsTools).toBe(false);
    expect(reasoner.supportsReasoning).toBe(true);

    const chat = adapter.capabilities("deepseek-chat");
    expect(chat.supportsTools).toBe(true);
    expect(chat.supportsReasoning).toBe(false);
  });

  it("显式钉死 provider 时:用传入实例,不走 getProvider()", async () => {
    // 一个独立的桩 provider,断言 generate 落到它身上而非假引擎(getProvider 路径)
    const calls: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];
    const pinned: LLMProvider = {
      name: "pinned-engine",
      model: "pinned-model",
      async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
        calls.push({ messages, opts });
        return { content: "from-pinned", model: "pinned-model" };
      },
      async chatStream(
        _messages: ChatMessage[],
        _opts: ChatOptions,
        handlers: StreamHandlers
      ): Promise<ChatResult> {
        const r: ChatResult = { content: "pinned-stream", model: "pinned-model" };
        handlers.onToken("pinned-stream");
        handlers.onDone?.(r);
        return r;
      },
      capabilities(): LLMCapabilities {
        return { supportsTools: true, supportsReasoning: false, supportsStreaming: true };
      },
    };

    const adapter = makeApiAdapter(pinned);
    expect(adapter.name).toBe("pinned-engine");
    expect(adapter.model).toBe("pinned-model");

    const result = await adapter.generate([{ role: "user", content: "hi" }]);
    expect(result.content).toBe("from-pinned");
    expect(calls).toHaveLength(1);
    // 假引擎(getProvider 路径)完全没被调用
    expect(engine.received).toHaveLength(0);
  });
});
