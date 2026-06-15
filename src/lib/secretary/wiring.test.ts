/**
 * wiring.test.ts — Task 1.8 整合 wiring
 *
 * 验收覆盖(都是可单测的逻辑,不碰 Tauri GUI):
 *  1. todayDateKeys — 今日/昨日日期键(本地时区,跨自然日边界)
 *  2. computeUserActiveToday — dbListMessagesOnDate 今天 length>0 判活跃 + 异常保守为 true
 *  3. buildGateStateProvider — 从 reminder.pausedUntil 同步取,其余留空
 *  4. registerSecretaryJobs — 注册集合恰为 { daily-scan, morning-briefing(带 gate) }
 *  5. runStartupBackfill — 编排:把算出的 userActiveToday + lastSentAt 传给 backfillOnStartup
 *
 * startSecretaryScheduler 本体(解析真实 Tauri label + start/stop 副作用)依赖 Tauri runtime,
 * 端到端留给用户跑 app 验证;这里只测它依赖的纯/半纯零件与编排函数。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── 假数据(被 db mock 读取) ────────────────────────────────────────────────
let _fakeMessagesOnDate: Array<{ role: string; content: string; created_at: string }> = [];
let _lastProactiveSentAt: number | undefined = undefined;
let _throwOnListMessages = false;

// ─── mock db ─────────────────────────────────────────────────────────────────
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dbListMessagesOnDate: vi.fn(async (_dateKey: string) => {
      if (_throwOnListMessages) throw new Error("boom");
      return _fakeMessagesOnDate;
    }),
    dbGetLastProactiveSentAt: vi.fn(async (_prefix: string) => _lastProactiveSentAt),
  };
});

// ─── mock settings(lang + reminder.pausedUntil) ──────────────────────────────
let _pausedUntil: number | undefined = undefined;
vi.mock("../settings", () => ({
  // llm/index.ts 在模块加载时注册 onProviderConfigChange,需提供桩(返回取消订阅函数)
  onProviderConfigChange: () => () => undefined,
  useSettingsStore: {
    getState: () => ({
      lang: "zh",
      reminder: {
        enabled: true,
        workStart: 9,
        workEnd: 22,
        intervalMin: 120,
        channel: "both",
        pausedUntil: _pausedUntil,
      },
    }),
  },
}));

// ─── mock startupBackfill(只断言编排:backfillOnStartup 收到什么) ─────────────
const backfillSpy = vi.fn(async (_ctx: unknown) => ({ didBackfill: false }));
vi.mock("./startupBackfill", () => ({
  backfillOnStartup: (ctx: unknown) => backfillSpy(ctx),
}));

// ─── 被测模块(所有 mock 之后 import) ─────────────────────────────────────────
import {
  todayDateKeys,
  computeUserActiveToday,
  buildGateStateProvider,
  registerSecretaryJobs,
  runStartupBackfill,
} from "./wiring";
import { createScheduler, type ScheduledJob } from "./scheduler";

// ─── 辅助 ─────────────────────────────────────────────────────────────────────
function tsAt(hour: number, minute = 0, dateStr = "2026-06-15"): number {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

beforeEach(() => {
  _fakeMessagesOnDate = [];
  _lastProactiveSentAt = undefined;
  _throwOnListMessages = false;
  _pausedUntil = undefined;
  backfillSpy.mockClear();
});

// ════════════════════════════════════════════════════════════════════════════
// 1. todayDateKeys
// ════════════════════════════════════════════════════════════════════════════
describe("todayDateKeys", () => {
  it("从 now 算出今日 + 昨日日期键(本地时区)", () => {
    const now = tsAt(9, 0, "2026-06-15");
    expect(todayDateKeys(now)).toEqual({
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
    });
  });

  it("跨月边界:6/1 的昨日应为 5/31", () => {
    const now = tsAt(9, 0, "2026-06-01");
    expect(todayDateKeys(now)).toEqual({
      dateKey: "2026-06-01",
      yesterdayKey: "2026-05-31",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. computeUserActiveToday
// ════════════════════════════════════════════════════════════════════════════
describe("computeUserActiveToday", () => {
  it("今天有消息 → true", async () => {
    _fakeMessagesOnDate = [{ role: "user", content: "hi", created_at: "2026-06-15T08:00:00" }];
    await expect(computeUserActiveToday("2026-06-15")).resolves.toBe(true);
  });

  it("今天无消息 → false", async () => {
    _fakeMessagesOnDate = [];
    await expect(computeUserActiveToday("2026-06-15")).resolves.toBe(false);
  });

  it("查询抛错 → 保守视为已活跃(true,宁可不补发也不误打扰)", async () => {
    _throwOnListMessages = true;
    await expect(computeUserActiveToday("2026-06-15")).resolves.toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. buildGateStateProvider
// ════════════════════════════════════════════════════════════════════════════
describe("buildGateStateProvider", () => {
  it("无 pausedUntil → 返回空状态(不限制)", () => {
    _pausedUntil = undefined;
    const state = buildGateStateProvider()();
    expect(state).toEqual({
      recentlySent: [],
      pausedUntil: undefined,
      lastProactiveSentMs: undefined,
    });
  });

  it("有 pausedUntil → 透传给 gate 状态(让'别烦我'生效)", () => {
    _pausedUntil = tsAt(23, 0);
    const state = buildGateStateProvider()();
    expect(state.pausedUntil).toBe(tsAt(23, 0));
    expect(state.recentlySent).toEqual([]);
    expect(state.lastProactiveSentMs).toBeUndefined();
  });

  it("每次调用都重新读 settings(动态反映 pausedUntil 变化)", () => {
    const provider = buildGateStateProvider();
    _pausedUntil = undefined;
    expect(provider().pausedUntil).toBeUndefined();
    _pausedUntil = tsAt(20, 0);
    expect(provider().pausedUntil).toBe(tsAt(20, 0));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. registerSecretaryJobs — 注册集合
// ════════════════════════════════════════════════════════════════════════════
describe("registerSecretaryJobs", () => {
  it("恰好注册 daily-scan + morning-briefing 两个任务", () => {
    const registered: string[] = [];
    const scheduler = createScheduler({ windowId: "test-main" });
    const origRegister = scheduler.registerJob;
    scheduler.registerJob = (job: ScheduledJob) => {
      registered.push(job.id);
      origRegister(job);
    };

    registerSecretaryJobs(scheduler, "zh");

    expect(registered).toContain("daily-scan");
    expect(registered).toContain("morning-briefing");
    expect(registered).toHaveLength(2);
  });

  it("注册的 morning-briefing 是带 gate 的版本(其 shouldRun 跨自然日判断)", () => {
    const jobs: ScheduledJob[] = [];
    const scheduler = createScheduler({ windowId: "test-main" });
    const origRegister = scheduler.registerJob;
    scheduler.registerJob = (job: ScheduledJob) => {
      jobs.push(job);
      origRegister(job);
    };

    registerSecretaryJobs(scheduler, "zh");

    const briefing = jobs.find((j) => j.id === "morning-briefing");
    expect(briefing).toBeTruthy();
    // 默认 morningHour=7:06:59 不触发,07:00 触发(当天未跑过时)
    expect(briefing!.shouldRun(tsAt(6, 59), { lastRan: undefined })).toBe(false);
    expect(briefing!.shouldRun(tsAt(7, 0), { lastRan: undefined })).toBe(true);
    // 今天已跑过(lastRan 在今天 0 点后)→ 不重复
    expect(briefing!.shouldRun(tsAt(9, 0), { lastRan: tsAt(7, 5) })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. runStartupBackfill — 编排
// ════════════════════════════════════════════════════════════════════════════
describe("runStartupBackfill", () => {
  it("把算出的 dateKey/yesterdayKey/userActiveToday/lastSentAt 传给 backfillOnStartup", async () => {
    _fakeMessagesOnDate = []; // 今天没消息 → userActiveToday=false
    _lastProactiveSentAt = undefined; // 今天没发过简报
    const now = tsAt(9, 0, "2026-06-15");

    await runStartupBackfill(now);

    expect(backfillSpy).toHaveBeenCalledTimes(1);
    const ctx = backfillSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(ctx.now).toBe(now);
    expect(ctx.dateKey).toBe("2026-06-15");
    expect(ctx.yesterdayKey).toBe("2026-06-14");
    expect(ctx.userActiveToday).toBe(false);
    expect(ctx.lastSentAt).toBeUndefined();
    expect(ctx.lang).toBe("zh");
    expect(ctx.morningHour).toBe(7);
  });

  it("今天有消息 → userActiveToday=true 透传(backfillOnStartup 会据此跳过)", async () => {
    _fakeMessagesOnDate = [{ role: "user", content: "hi", created_at: "2026-06-15T08:00:00" }];
    const now = tsAt(9, 0);

    await runStartupBackfill(now);

    const ctx = backfillSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(ctx.userActiveToday).toBe(true);
  });

  it("已有上次简报发送时间 → 作为 lastSentAt 透传", async () => {
    _lastProactiveSentAt = tsAt(7, 5);
    const now = tsAt(9, 0);

    await runStartupBackfill(now);

    const ctx = backfillSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(ctx.lastSentAt).toBe(tsAt(7, 5));
  });

  it("内部异常时不抛、返回 didBackfill=false(不影响 app 启动)", async () => {
    _throwOnListMessages = true; // computeUserActiveToday 内部已吞,但用 backfill 抛验证外层兜底
    backfillSpy.mockRejectedValueOnce(new Error("compose failed"));

    const result = await runStartupBackfill(tsAt(9, 0));
    expect(result).toEqual({ didBackfill: false });
  });
});
