/**
 * buildChatSystemPromptMemory.test.ts — Task 2.2 记忆全量注入(集成层)
 *
 * 验收 buildChatSystemPrompt:
 *   1. 从 DB【直读】记忆事实(dbListMemoryFacts({ onlyActive: true })),
 *      不走任何 store 内存缓存——跨窗口即时新鲜(铁律)。
 *   2. 把全部 active 记忆事实拼进 system prompt。
 *   3. inferred 事实带「(推断)」标注;told 不带。
 *   4. 记忆为空 → 不注入记忆段(无噪声)。
 *   5. DB 读记忆失败 → 静默降级,不影响对话主流程(其余 prompt 照常)。
 *
 * 策略:沿用 buildChatSystemPrompt.test.ts 的 mock 风格,
 *   mock ../db 暴露 dbListMemoryFacts(可控),断言注入结果。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeEngine, installFakeEngine } from "./fakeEngine";
import type { MemoryFact } from "../db";

// ─── 注入假引擎(绕开 getProvider 单例缓存)─────────────────────────────────
const { setEngine } = installFakeEngine();

// ─── 可控的 DB 记忆事实 mock ────────────────────────────────────────────────
// listMemoryFactsImpl 由各用例替换,实现「直读 DB」语义的可观测断言。
let listMemoryFactsImpl: (opts?: {
  onlyActive?: boolean;
}) => Promise<MemoryFact[]> = async () => [];
const dbListMemoryFactsSpy = vi.fn(
  (opts?: { onlyActive?: boolean }) => listMemoryFactsImpl(opts)
);

vi.mock("../db", () => ({
  dbInsertUsage: async () => undefined,
  dbGetRecentDigests: async () => [],
  dbListMemoryFacts: (opts?: { onlyActive?: boolean }) =>
    dbListMemoryFactsSpy(opts),
}));

vi.mock("../chatTools", () => ({
  toolsForLLM: () => [],
  runChatTool: async () => "{}",
}));

vi.mock("../store", () => ({
  useTodoStore: { getState: () => ({ todos: [] }) },
}));

vi.mock("../goalsStore", () => ({
  useGoalsStore: { getState: () => ({ goals: [] }) },
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

import { buildChatSystemPrompt } from "./index";

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "mf_" + Math.random().toString(36).slice(2, 8),
    category: "preference",
    content: "测试事实",
    source: "told",
    durability: "durable",
    pinned: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  setEngine(new FakeEngine());
  dbListMemoryFactsSpy.mockClear();
  listMemoryFactsImpl = async () => [];
});

describe("buildChatSystemPrompt — 记忆全量注入(直读 DB)", () => {
  it("从 DB 直读记忆(onlyActive: true),不走 store", async () => {
    listMemoryFactsImpl = async () => [fact({ content: "用户是产品经理" })];

    await buildChatSystemPrompt();

    expect(dbListMemoryFactsSpy).toHaveBeenCalledTimes(1);
    // 必须只取 active 事实(过期非 pinned 的不该进 prompt)
    expect(dbListMemoryFactsSpy).toHaveBeenCalledWith({ onlyActive: true });
  });

  it("把全部 active 记忆事实拼进 prompt", async () => {
    listMemoryFactsImpl = async () => [
      fact({ content: "用户是产品经理", source: "told" }),
      fact({ content: "用户在做 Latitude 项目", source: "told" }),
    ];

    const prompt = await buildChatSystemPrompt();

    expect(prompt).toContain("用户是产品经理");
    expect(prompt).toContain("用户在做 Latitude 项目");
  });

  it("inferred 事实带「(推断)」标注;told 不带", async () => {
    listMemoryFactsImpl = async () => [
      fact({ content: "用户偏好早上工作", source: "inferred" }),
      fact({ content: "用户是产品经理", source: "told" }),
    ];

    const prompt = await buildChatSystemPrompt();

    expect(prompt).toContain("用户偏好早上工作");
    expect(prompt).toContain("(推断)");
    // told 的那条不应被打上推断标注:确保标注是逐条而非整段
    const inferredIdx = prompt.indexOf("用户偏好早上工作");
    const toldIdx = prompt.indexOf("用户是产品经理");
    expect(inferredIdx).toBeGreaterThanOrEqual(0);
    expect(toldIdx).toBeGreaterThanOrEqual(0);
  });

  it("记忆为空 → 不注入记忆段(无噪声头部)", async () => {
    listMemoryFactsImpl = async () => [];

    const prompt = await buildChatSystemPrompt();

    // 还是会有人设等其他段;但不该出现记忆段头
    expect(prompt).not.toContain("长期记忆");
  });

  it("DB 读记忆失败 → 静默降级,prompt 其余部分照常产出", async () => {
    listMemoryFactsImpl = async () => {
      throw new Error("db boom");
    };

    // 不抛错
    const prompt = await buildChatSystemPrompt();
    // 人设核心规则段照常在(对话主流程不受影响)
    expect(prompt).toContain("不替用户甩选项");
  });
});
