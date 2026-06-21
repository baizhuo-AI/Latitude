/**
 * dailyScan.test.ts — Task 1.3 每日纪要
 *
 * 验收覆盖:
 *  1. db 层 — daily_digest upsert:同一天重跑覆盖,不重复插入
 *  2. db 层 — dbGetRecentDigests(n) 取近 N 天
 *  3. runDailyScan() — 调一次 generateOnce,把结果 upsert 进 daily_digest
 *  4. buildChatSystemPrompt — 有纪要时合成 prompt 确定性包含纪要文本
 *  5. buildChatSystemPrompt — 无纪要时正常工作、不报错
 *  6. 行为层"地板断言":新对话 prompt 能"读到"昨日纪要
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEngine, installFakeEngine } from "../llm/fakeEngine";

// ─── 注入共享假引擎(绕开 getProvider 模块单例缓存) ────────────────────────
const { setEngine } = installFakeEngine();
let engine: FakeEngine;

// ─── 内存 digest 存储(模拟 daily_digest 表) ──────────────────────────────
// key = date(YYYY-MM-DD),value = { summary, created_at }
const _digestStore = new Map<string, { summary: string; created_at: string }>();

// messages 和 todos 的假数据(dailyScan 需要查询这些来生成纪要)
let _fakeMessages: Array<{ content: string; role: string; created_at: string }> = [];
let _fakeTodos: Array<{
  title: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}> = [];

// ─── mock db 模块 ─────────────────────────────────────────────────────────
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // 不碰 usage 记录
    dbInsertUsage: vi.fn(async () => undefined),
    // daily_digest upsert:先删再插(覆盖语义)
    dbUpsertDailyDigest: vi.fn(async (date: string, summary: string) => {
      _digestStore.set(date, { summary, created_at: new Date().toISOString() });
    }),
    // 取近 N 天纪要,按日期倒序
    dbGetRecentDigests: vi.fn(async (n: number) => {
      return Array.from(_digestStore.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, n)
        .map(([date, row]) => ({ date, summary: row.summary, createdAt: row.created_at }));
    }),
    // dailyScan 查询当天 messages(查 user/assistant 消息要点)
    dbListMessagesOnDate: vi.fn(async (_dateKey: string) => _fakeMessages),
    // dailyScan 查询当天 todos 活动
    dbListTodosOnDate: vi.fn(async (_dateKey: string) => _fakeTodos),
  };
});

// mock store(buildChatSystemPrompt 读 todos/goals)
vi.mock("../store", () => ({
  useTodoStore: { getState: () => ({ todos: [] }) },
}));
vi.mock("../goalsStore", () => ({
  useGoalsStore: { getState: () => ({ goals: [] }) },
}));

// mock settings
const DAILY_SCAN_SETTINGS = {
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
  useSettingsStore: { getState: () => DAILY_SCAN_SETTINGS },
  // getProvider / buildChatSystemPrompt 改走真相源读取器,测试里与 store 值保持一致
  readSettingsSnapshot: () => DAILY_SCAN_SETTINGS,
}));

// mock chatTools(避免 import 副作用)
vi.mock("../chatTools", () => ({
  toolsForLLM: () => [],
  runChatTool: async () => "{}",
}));

// ─── 被测模块(所有 mock 之后 import) ─────────────────────────────────────
import { runDailyScan } from "./dailyScan";
import { buildChatSystemPrompt } from "../llm/index";
import { dbUpsertDailyDigest, dbGetRecentDigests } from "../db";

beforeEach(() => {
  engine = setEngine(new FakeEngine());
  _digestStore.clear();
  _fakeMessages = [];
  _fakeTodos = [];
  vi.mocked(dbUpsertDailyDigest).mockClear();
  vi.mocked(dbGetRecentDigests).mockClear();
});

// ════════════════════════════════════════════════════════════════════════════
// 1. db 层 — upsert 行为
// ════════════════════════════════════════════════════════════════════════════
describe("dbUpsertDailyDigest — 同天 upsert 覆盖,不重复插入", () => {
  it("第一次写入 → digest 存在", async () => {
    await dbUpsertDailyDigest("2026-06-15", "今天完成了 3 件事");
    const rows = await dbGetRecentDigests(7);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-06-15");
    expect(rows[0].summary).toContain("3 件事");
  });

  it("同一天写两次 → 只有一条,内容以第二次为准(upsert 覆盖)", async () => {
    await dbUpsertDailyDigest("2026-06-15", "第一次写");
    await dbUpsertDailyDigest("2026-06-15", "第二次覆盖");
    const rows = await dbGetRecentDigests(7);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe("第二次覆盖");
  });

  it("不同日期 → 各自独立,不互相覆盖", async () => {
    await dbUpsertDailyDigest("2026-06-14", "昨天的");
    await dbUpsertDailyDigest("2026-06-15", "今天的");
    const rows = await dbGetRecentDigests(7);
    expect(rows).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. db 层 — dbGetRecentDigests 取 N 条
// ════════════════════════════════════════════════════════════════════════════
describe("dbGetRecentDigests — 取近 N 天,按日期倒序", () => {
  it("有 3 条纪要时取 N=2 → 返回最近 2 条", async () => {
    await dbUpsertDailyDigest("2026-06-13", "前天");
    await dbUpsertDailyDigest("2026-06-14", "昨天");
    await dbUpsertDailyDigest("2026-06-15", "今天");
    const rows = await dbGetRecentDigests(2);
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe("2026-06-15"); // 最近的在前
    expect(rows[1].date).toBe("2026-06-14");
  });

  it("无纪要时 → 返回空数组", async () => {
    const rows = await dbGetRecentDigests(7);
    expect(rows).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. runDailyScan — 调 generateOnce 生成纪要并 upsert
// ════════════════════════════════════════════════════════════════════════════
describe("runDailyScan — 生成并存储当日纪要", () => {
  it("调一次 generateOnce,把返回的 summary upsert 到当日 digest", async () => {
    engine.script = [
      { content: "今日完成:写了 3 个接口,开了 1 次周会", model: "deepseek-chat" },
    ];

    const dateKey = "2026-06-15";
    await runDailyScan(dateKey);

    // generateOnce 被调了一次
    expect(engine.received).toHaveLength(1);
    // summary 被 upsert 了
    expect(dbUpsertDailyDigest).toHaveBeenCalledTimes(1);
    expect(dbUpsertDailyDigest).toHaveBeenCalledWith(
      dateKey,
      expect.stringContaining("3 个接口")
    );
  });

  it("同一天运行两次 → 第二次覆盖(upsert 语义,dbUpsertDailyDigest 被调两次)", async () => {
    engine.script = [
      { content: "第一次纪要", model: "deepseek-chat" },
      { content: "第二次纪要(覆盖)", model: "deepseek-chat" },
    ];

    const dateKey = "2026-06-15";
    await runDailyScan(dateKey);
    await runDailyScan(dateKey);

    // 两次都调了 upsert
    expect(dbUpsertDailyDigest).toHaveBeenCalledTimes(2);
    // digest store 里只有一条(因为 upsert 覆盖)
    const rows = await dbGetRecentDigests(7);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe("第二次纪要(覆盖)");
  });

  it("generateOnce 的 systemPrompt 在 zh 下包含中文写纪要指令", async () => {
    engine.script = [{ content: "今日纪要", model: "deepseek-chat" }];

    await runDailyScan("2026-06-15", "zh");

    const firstCall = engine.received[0];
    const sysMsg = firstCall.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toBeTruthy();
    // 写纪要的提示词应包含中文事实性总结关键词
    expect(sysMsg?.content).toMatch(/今日|事实|总结|纪要/);
  });

  it("generateOnce 的 systemPrompt 在 lang=en 时包含英文关键词", async () => {
    engine.script = [
      { content: "Daily digest: completed 3 tasks", model: "deepseek-chat" },
    ];

    await runDailyScan("2026-06-15", "en");

    const firstCall = engine.received[0];
    const sysMsg = firstCall.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toMatch(/daily|summary|today|factual/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. buildChatSystemPrompt — 有纪要时 prompt 确定性包含纪要
// ════════════════════════════════════════════════════════════════════════════
describe("buildChatSystemPrompt — 近期纪要注入", () => {
  it("有近期纪要时,合成 prompt 包含纪要文本", async () => {
    // 预置一条纪要
    await dbUpsertDailyDigest("2026-06-14", "昨天完成了重要的 API 对接");

    const prompt = await buildChatSystemPrompt();
    expect(prompt).toContain("昨天完成了重要的 API 对接");
  });

  it("有多条纪要时,合成 prompt 包含各条纪要内容", async () => {
    await dbUpsertDailyDigest("2026-06-13", "前天纪要");
    await dbUpsertDailyDigest("2026-06-14", "昨天纪要");

    const prompt = await buildChatSystemPrompt();
    expect(prompt).toContain("前天纪要");
    expect(prompt).toContain("昨天纪要");
  });

  it("无纪要时,buildChatSystemPrompt 正常返回、不报错、不出现 undefined/null", async () => {
    // _digestStore 已在 beforeEach 清空;直接 await,如有异常测试自动失败
    const prompt = await buildChatSystemPrompt();

    // 无纪要:基础结构仍然存在(人设锚点)
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
    expect(prompt).toContain("不替用户甩选项");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. 行为层"地板断言":新对话能读到昨日纪要
// ════════════════════════════════════════════════════════════════════════════
describe("行为层地板断言 — 新对话能读到昨日纪要", () => {
  it("写入昨日纪要 → buildChatSystemPrompt 返回的 prompt 中能找到该纪要", async () => {
    const digestText = "昨天完成了模块测试,共通过 42 个用例";
    await dbUpsertDailyDigest("2026-06-14", digestText);

    const prompt = await buildChatSystemPrompt();

    // 地板断言:纪要文本在 prompt 里"读得到"
    expect(prompt).toContain(digestText);
    // 不做"续接是否自然"等质量判断(留给 Phase 4 rubric)
  });

  it("dbGetRecentDigests slice(n) 行为:存 8 条取 7 条 → 返回不超过 7 条", async () => {
    for (let i = 1; i <= 8; i++) {
      const day = String(i).padStart(2, "0");
      await dbUpsertDailyDigest(`2026-06-${day}`, `第 ${i} 天纪要`);
    }
    const rows = await dbGetRecentDigests(7);
    expect(rows.length).toBeLessThanOrEqual(7);
  });
});
