/**
 * dispatch.test.ts — 引擎分发经过 EngineAdapter(Task 4.3 目标 2)
 *
 * 验证「孤岛接进生产链」:callBrain / generateOnce 不再直连 getProvider().chat,
 * 而是按 chatBackend 选适配器(deepseek-api→apiAdapter,claude-cli→claudeCodeAdapter)。
 *
 * 策略:
 *   - mock ./claudeCodeAdapter:换成可观测的桩 EngineAdapter,断言「被选中并调用」,
 *     绝不真起 claude(headless 跑不了)。
 *   - 沿用 installFakeEngine() 拦 API 路径(deepseek),断言 deepseek-api 行为不变。
 *   - mock ../settings:chatBackend 可变,逐用例切换,验证分发选对适配器。
 *
 * 重点边界(防回归):
 *   ① chatBackend=claude-cli → generateOnce 走 CC 适配器(主动引擎/简报因此能用 CC)。
 *   ② chatBackend=deepseek-api → generateOnce / chatAgentCall 仍走 API(行为不变)。
 *   ③ parseTask / generateTodayPlan 是结构化 JSON 任务(工作台触发,非对话),
 *      无论 chatBackend 是什么都钉死走 API 引擎,绝不被切到 CC(否则 JSON mode 丢失)。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEngine, installFakeEngine } from "./fakeEngine";
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineMessage,
  EngineOptions,
  EngineResult,
  EngineStreamHandlers,
} from "../engine/types";

// ─── 拦 API 路径(deepseek) ──────────────────────────────────────────────────
const { setEngine } = installFakeEngine();
let engine: FakeEngine;

// ─── mock CC 适配器:可观测桩,断言被选中,绝不真 spawn ────────────────────────
// 记录每次 generate / generateStream 的入参,供断言分发命中。
interface CcCall {
  method: "generate" | "generateStream";
  messages: EngineMessage[];
  opts?: EngineOptions;
}
let ccCalls: CcCall[];
let ccNextResult: EngineResult;

vi.mock("../engine/claudeCodeAdapter", () => ({
  makeClaudeCodeAdapter: (): EngineAdapter => ({
    name: "claude-code",
    model: "claude-code",
    async generate(messages: EngineMessage[], opts?: EngineOptions): Promise<EngineResult> {
      ccCalls.push({ method: "generate", messages, opts });
      return ccNextResult;
    },
    async generateStream(
      messages: EngineMessage[],
      opts: EngineOptions,
      handlers: EngineStreamHandlers
    ): Promise<EngineResult> {
      ccCalls.push({ method: "generateStream", messages, opts });
      handlers.onToken(ccNextResult.content);
      handlers.onDone?.(ccNextResult);
      return ccNextResult;
    },
    capabilities(): EngineCapabilities {
      return { supportsTools: true, supportsReasoning: true, supportsStreaming: true };
    },
  }),
}));

// ─── db / chatTools / stores 桩(同 index.test.ts) ──────────────────────────
const dbInsertUsageSpy = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../db", () => ({
  dbInsertUsage: (...args: unknown[]) => dbInsertUsageSpy(...args),
  dbGetRecentDigests: async () => [],
  dbListMemoryFacts: async () => [],
}));
vi.mock("../chatTools", () => ({
  toolsForLLM: () => [
    { type: "function", function: { name: "fake_tool", description: "", parameters: {} } },
  ],
  runChatTool: async (name: string) => JSON.stringify({ ok: true, tool: name }),
}));
vi.mock("../store", () => ({
  useTodoStore: { getState: () => ({ todos: [], applySchedules: async () => undefined }) },
}));
vi.mock("../goalsStore", () => ({
  useGoalsStore: { getState: () => ({ goals: [] }) },
}));

// ─── settings:chatBackend 可变(逐用例切换) ─────────────────────────────────
let chatBackend: "deepseek-api" | "claude-cli" | "codex-cli" | "kiro-cli";
const makeSettings = () => ({
  lang: "zh" as const,
  persona: { presetKey: "seniorAdvisor" as const },
  llmProvider: "deepseek" as const,
  chatBackend,
  providers: {
    deepseek: { apiKey: "test-key", baseUrl: "https://example.test", model: "deepseek-chat" },
  },
});
vi.mock("../settings", () => ({
  onProviderConfigChange: () => () => undefined,
  useSettingsStore: { getState: () => makeSettings() },
  readSettingsSnapshot: () => makeSettings(),
}));

// 被测模块在 mock 之后 import
import {
  generateOnce,
  parseTask,
  generateTodayPlan,
  chatAgentCall,
} from "./index";

beforeEach(() => {
  engine = setEngine(new FakeEngine());
  ccCalls = [];
  ccNextResult = { content: "CC-回复", model: "claude-code" };
  dbInsertUsageSpy.mockClear();
  chatBackend = "deepseek-api"; // 默认 API;需要 CC 的用例自行覆盖
});

describe("分发:chatBackend=deepseek-api → 走 API 引擎(行为不变)", () => {
  it("generateOnce 走 API(假 deepseek),不碰 CC 适配器", async () => {
    engine.script = [{ content: "API-回复", model: "deepseek-chat" }];
    const text = await generateOnce("sys", [{ role: "user", content: "hi" }]);
    expect(text).toBe("API-回复");
    expect(engine.received).toHaveLength(1); // API 被调
    expect(ccCalls).toHaveLength(0); // CC 没被调
  });

  it("chatAgentCall 走 API(假 deepseek),不碰 CC 适配器", async () => {
    engine.script = [{ content: "agent 最终答复", model: "deepseek-chat" }];
    const result = await chatAgentCall([{ role: "user", content: "在吗" }]);
    expect(result.content).toBe("agent 最终答复");
    expect(engine.received).toHaveLength(1);
    expect(ccCalls).toHaveLength(0);
  });
});

describe("分发:chatBackend=claude-cli → generateOnce 切到 CC 适配器", () => {
  beforeEach(() => {
    chatBackend = "claude-cli";
  });

  it("generateOnce 走 CC 适配器(主动引擎/简报因此能用 CC)", async () => {
    const text = await generateOnce("你是助手", [{ role: "user", content: "今天咋样" }]);
    expect(text).toBe("CC-回复");
    expect(ccCalls).toHaveLength(1);
    expect(ccCalls[0].method).toBe("generate");
    // generateOnce 把 systemPrompt 拼成首条 system,messages 原样跟随(无状态注入)
    expect(ccCalls[0].messages[0]).toEqual({ role: "system", content: "你是助手" });
    expect(ccCalls[0].messages[1]).toEqual({ role: "user", content: "今天咋样" });
    // API 路径完全没被调
    expect(engine.received).toHaveLength(0);
  });

  it("generateOnce 经 CC 不记 usage(裸调语义不变)", async () => {
    ccNextResult = {
      content: "x",
      model: "claude-code",
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    };
    await generateOnce("sys", [{ role: "user", content: "hi" }]);
    expect(dbInsertUsageSpy).not.toHaveBeenCalled();
  });
});

describe("分发:结构化任务钉死 API(不被 chatBackend 切到 CC)", () => {
  // parseTask / generateTodayPlan 是工作台触发的 JSON 任务,需 HTTP provider 的
  // JSON mode + 结构化输出,CC CLI 给不了。无论 chatBackend 选了什么,都必须走 API。
  beforeEach(() => {
    chatBackend = "claude-cli"; // 即便对话后端切到 CC
  });

  it("parseTask 仍走 API 引擎,不碰 CC", async () => {
    engine.script = [
      {
        content: JSON.stringify({ title: "买菜", priority: "low", tags: [] }),
        model: "deepseek-chat",
      },
    ];
    const parsed = await parseTask("顺便买个菜");
    expect(parsed.title).toBe("买菜");
    expect(parsed.parsed).toBe(true);
    expect(engine.received).toHaveLength(1); // API 被调
    expect(ccCalls).toHaveLength(0); // CC 没被调
    // 仍带 JSON mode(责任在 API provider;这里断言 opts 透传)
    expect(engine.received[0].opts.responseFormat).toBe("json");
  });

  it("generateTodayPlan 仍走 API 引擎,不碰 CC", async () => {
    engine.script = [
      {
        content: JSON.stringify({ plan: [{ id: "t1", scheduledTime: "09:00-10:00" }] }),
        model: "deepseek-chat",
      },
    ];
    await generateTodayPlan([
      {
        id: "t1",
        title: "写方案",
        priority: "high",
        tags: [],
        status: "todo",
        createdAt: Date.now(),
      } as never,
    ]);
    expect(engine.received).toHaveLength(1);
    expect(ccCalls).toHaveLength(0);
    expect(engine.received[0].opts.responseFormat).toBe("json");
  });
});
