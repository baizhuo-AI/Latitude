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
// 心跳巡检读取:全部 todo + 全部 calendar_events(真相源直读 DB)
let _fakeTodos: unknown[] = [];
let _fakeEvents: unknown[] = [];

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
    dbListTodos: vi.fn(async () => _fakeTodos),
    dbListCalendarEvents: vi.fn(async (_opts?: unknown) => _fakeEvents),
  };
});

// ─── mock settings(lang + reminder.pausedUntil + proactive 真相源) ─────────────
let _pausedUntil: number | undefined = undefined;
// 主动姿态真相源:测试按需改写(默认温和、心跳 90min、渠道 chat、四类事件全开)
let _proactive: {
  mode: "off" | "gentle" | "active";
  heartbeatMin: number;
  morningHour: number;
  budgetPerHalfDay: number;
  channel: "chat" | "notification" | "float" | "all";
  events: { meetingSoon: boolean; deadlineNear: boolean; taskStuck: boolean; justCompleted: boolean };
} = {
  mode: "gentle",
  heartbeatMin: 90,
  morningHour: 7,
  budgetPerHalfDay: 3,
  channel: "chat",
  events: { meetingSoon: true, deadlineNear: true, taskStuck: true, justCompleted: true },
};
function settingsSnapshot() {
  return {
    lang: "zh" as const,
    reminder: {
      enabled: true,
      workStart: 9,
      workEnd: 22,
      intervalMin: 120,
      channel: "both",
      pausedUntil: _pausedUntil,
    },
    proactive: _proactive,
  };
}
vi.mock("../settings", () => ({
  // llm/index.ts 在模块加载时注册 onProviderConfigChange,需提供桩(返回取消订阅函数)
  onProviderConfigChange: () => () => undefined,
  // 主动逻辑/闸门走真相源 readSettingsSnapshot(直读 localStorage,跨窗口安全)
  readSettingsSnapshot: () => settingsSnapshot(),
  useSettingsStore: {
    getState: () => settingsSnapshot(),
  },
}));

// ─── mock startupBackfill(只断言编排:backfillOnStartup 收到什么) ─────────────
const backfillSpy = vi.fn(async (_ctx: unknown) => ({ didBackfill: false }));
vi.mock("./startupBackfill", () => ({
  backfillOnStartup: (ctx: unknown) => backfillSpy(ctx),
}));

// ─── mock deliverProactive(只断言编排:被放行的候选 + channel + tonePhrase 透传) ──
const deliverSpy = vi.fn(
  async (_candidate: unknown, _opts: unknown) => ({ convId: "pa-test" })
);
vi.mock("./deliverProactive", () => ({
  deliverProactive: (candidate: unknown, opts: unknown) => deliverSpy(candidate, opts),
}));

// ─── mock gateState(loadGateState 直读 DB 派生;测试注入预设 GateState) ──────────
let _gateState: {
  recentlySent: Array<{ type: string; content: string; sentAt: number }>;
  pausedUntil: number | undefined;
  lastProactiveSentMs: number | undefined;
} = { recentlySent: [], pausedUntil: undefined, lastProactiveSentMs: undefined };
vi.mock("./gateState", () => ({
  loadGateState: vi.fn(async (pausedUntil: number | undefined) => ({
    ..._gateState,
    pausedUntil,
  })),
}));

// ─── 被测模块(所有 mock 之后 import) ─────────────────────────────────────────
import {
  todayDateKeys,
  computeUserActiveToday,
  buildGateStateProvider,
  registerSecretaryJobs,
  runStartupBackfill,
  filterCandidatesByEvents,
  applyLoadToGateOptions,
  runProactiveHeartbeat,
  createProactiveHeartbeatJob,
} from "./wiring";
import { createScheduler, type ScheduledJob } from "./scheduler";
import { defaultGateOptions } from "./gateProactive";
import type { ProactiveCandidate } from "./triggers";
import type { LoadAssessment } from "./loadSignals";

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
  _fakeTodos = [];
  _fakeEvents = [];
  _gateState = { recentlySent: [], pausedUntil: undefined, lastProactiveSentMs: undefined };
  _proactive = {
    mode: "gentle",
    heartbeatMin: 90,
    morningHour: 7,
    budgetPerHalfDay: 3,
    channel: "chat",
    events: { meetingSoon: true, deadlineNear: true, taskStuck: true, justCompleted: true },
  };
  backfillSpy.mockClear();
  deliverSpy.mockClear();
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
  it("恰好注册 daily-scan + morning-briefing + proactive-heartbeat 三个任务", () => {
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
    expect(registered).toContain("proactive-heartbeat");
    expect(registered).toHaveLength(3);
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

// ════════════════════════════════════════════════════════════════════════════
// 6. filterCandidatesByEvents — 事件开关过滤(纯)
// ════════════════════════════════════════════════════════════════════════════
function cand(kind: ProactiveCandidate["kind"], priority = 80): ProactiveCandidate {
  return { kind, priority, refId: `ref-${kind}`, title: kind };
}

describe("filterCandidatesByEvents", () => {
  const allOn = { meetingSoon: true, deadlineNear: true, taskStuck: true, justCompleted: true };

  it("全开 → 原样保留", () => {
    const cs = [cand("meeting_soon"), cand("deadline_near"), cand("task_stuck"), cand("just_completed")];
    expect(filterCandidatesByEvents(cs, allOn)).toHaveLength(4);
  });

  it("关掉 taskStuck / justCompleted → 对应 kind 被滤掉,其余保留", () => {
    const cs = [cand("meeting_soon"), cand("deadline_near"), cand("task_stuck"), cand("just_completed")];
    const out = filterCandidatesByEvents(cs, { ...allOn, taskStuck: false, justCompleted: false });
    expect(out.map((c) => c.kind)).toEqual(["meeting_soon", "deadline_near"]);
  });

  it("纯函数:不改入参数组", () => {
    const cs = [cand("meeting_soon"), cand("task_stuck")];
    filterCandidatesByEvents(cs, { ...allOn, taskStuck: false });
    expect(cs).toHaveLength(2); // 入参不被原地修改
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. applyLoadToGateOptions — 负荷 delta 透传到闸门 opts(纯)
// ════════════════════════════════════════════════════════════════════════════
function assessment(over: Partial<LoadAssessment> = {}): LoadAssessment {
  return { level: "normal", priorityFloorDelta: 0, budgetDelta: 0, tonePhrase: undefined, ...over };
}

describe("applyLoadToGateOptions", () => {
  it("high 档:priorityFloor 抬高、budget 收紧(delta 透传)", () => {
    const base = defaultGateOptions();
    const out = applyLoadToGateOptions(base, assessment({ level: "high", priorityFloorDelta: 15, budgetDelta: -1 }));
    expect(out.priorityFloor).toBe(base.priorityFloor + 15);
    expect(out.budgetPerHalfDay).toBe(base.budgetPerHalfDay - 1);
  });

  it("low 档:priorityFloor 放低、budget 放宽", () => {
    const base = defaultGateOptions();
    const out = applyLoadToGateOptions(base, assessment({ level: "low", priorityFloorDelta: -10, budgetDelta: 1 }));
    expect(out.priorityFloor).toBe(base.priorityFloor - 10);
    expect(out.budgetPerHalfDay).toBe(base.budgetPerHalfDay + 1);
  });

  it("normal/unknown 档:delta=0 → opts 不变", () => {
    const base = defaultGateOptions();
    const out = applyLoadToGateOptions(base, assessment({ level: "unknown" }));
    expect(out.priorityFloor).toBe(base.priorityFloor);
    expect(out.budgetPerHalfDay).toBe(base.budgetPerHalfDay);
  });

  it("夹紧:budget 至少 1、priorityFloor 不为负", () => {
    const base = { ...defaultGateOptions(), budgetPerHalfDay: 1, priorityFloor: 5 };
    const out = applyLoadToGateOptions(base, assessment({ level: "high", priorityFloorDelta: -100, budgetDelta: -5 }));
    expect(out.budgetPerHalfDay).toBeGreaterThanOrEqual(1);
    expect(out.priorityFloor).toBeGreaterThanOrEqual(0);
  });

  it("不原地改入参 base", () => {
    const base = defaultGateOptions();
    const beforeFloor = base.priorityFloor;
    applyLoadToGateOptions(base, assessment({ priorityFloorDelta: 15 }));
    expect(base.priorityFloor).toBe(beforeFloor);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. createProactiveHeartbeatJob.shouldRun — 用 shouldHeartbeat(时间注入)
// ════════════════════════════════════════════════════════════════════════════
describe("createProactiveHeartbeatJob.shouldRun", () => {
  it("工作时段外不跑(09:00-22:00,08:59 → false)", () => {
    const job = createProactiveHeartbeatJob();
    expect(job.id).toBe("proactive-heartbeat");
    expect(job.shouldRun(tsAt(8, 59), { lastRan: undefined })).toBe(false);
  });

  it("工作时段内、从未跑过 → true", () => {
    const job = createProactiveHeartbeatJob();
    expect(job.shouldRun(tsAt(10, 0), { lastRan: undefined })).toBe(true);
  });

  it("距上次未到心跳间隔(90min)→ false;到点 → true", () => {
    const job = createProactiveHeartbeatJob();
    const last = tsAt(10, 0);
    // 89min 后:未到
    expect(job.shouldRun(tsAt(11, 29), { lastRan: last })).toBe(false);
    // 90min 后:到点(>=)
    expect(job.shouldRun(tsAt(11, 30), { lastRan: last })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. runProactiveHeartbeat — 编排(触发→负荷→闸门→投递)
// ════════════════════════════════════════════════════════════════════════════

/** 构造一个「会议将至」事件:今天、startTs 在 now 之后 N 分钟(Unix 秒) */
function eventStartingInMin(now: number, minutes: number, id = "ev1") {
  const startMs = now + minutes * 60 * 1000;
  return {
    id,
    region: "feishu",
    calendarId: "c1",
    remoteEventId: "r1",
    title: "周会",
    isAllDay: false,
    startTs: Math.floor(startMs / 1000),
    endTs: Math.floor((startMs + 60 * 60 * 1000) / 1000),
    status: "confirmed",
    isRecurringInstance: false,
    isWritable: true,
    localDraft: false,
    createdAt: "2026-06-15T00:00:00Z",
    updatedAt: "2026-06-15T00:00:00Z",
  };
}

describe("runProactiveHeartbeat", () => {
  it("总闸 off → 不读候选、不投递", async () => {
    _proactive = { ..._proactive, mode: "off" };
    _fakeEvents = [eventStartingInMin(tsAt(10, 0), 5)];
    await runProactiveHeartbeat(tsAt(10, 0));
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("有紧迫候选(会议 5min 后)、闸门放行 → deliver 被调,带 channel 透传", async () => {
    _proactive = { ..._proactive, mode: "gentle", channel: "notification" };
    _fakeEvents = [eventStartingInMin(tsAt(10, 0), 5)];
    await runProactiveHeartbeat(tsAt(10, 0));
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [candidate, opts] = deliverSpy.mock.calls[0] as [ProactiveCandidate, Record<string, unknown>];
    expect(candidate.kind).toBe("meeting_soon");
    expect(opts.channel).toBe("notification");
  });

  it("无候选 → 不投递", async () => {
    _fakeEvents = [];
    _fakeTodos = [];
    await runProactiveHeartbeat(tsAt(10, 0));
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("候选 kind 被事件开关关掉 → 不投递", async () => {
    _proactive = {
      ..._proactive,
      mode: "gentle",
      events: { ..._proactive.events, meetingSoon: false },
    };
    _fakeEvents = [eventStartingInMin(tsAt(10, 0), 5)];
    await runProactiveHeartbeat(tsAt(10, 0));
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("闸门因 pausedUntil 拒绝 → 不投递(别烦我生效)", async () => {
    _proactive = { ..._proactive, mode: "gentle" };
    _pausedUntil = tsAt(23, 0); // 静音到今晚
    _gateState = { recentlySent: [], pausedUntil: tsAt(23, 0), lastProactiveSentMs: undefined };
    _fakeEvents = [eventStartingInMin(tsAt(10, 0), 5)];
    await runProactiveHeartbeat(tsAt(10, 0));
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("负荷措辞透传给 deliver(high 档 tonePhrase 注入)", async () => {
    // 加班场景:now 21:00,workEnd 22 不算加班;改用日程稠密推 high
    _proactive = { ..._proactive, mode: "gentle" };
    const now = tsAt(10, 0);
    // 三个今天的会议(meetingCount>=3 → high),外加一个 5min 后将至的会议作候选
    _fakeEvents = [
      eventStartingInMin(now, 5, "soon"),
      { ...eventStartingInMin(now, 120, "m2"), scheduledDate: "2026-06-15" },
      { ...eventStartingInMin(now, 180, "m3"), scheduledDate: "2026-06-15" },
      { ...eventStartingInMin(now, 240, "m4"), scheduledDate: "2026-06-15" },
    ];
    await runProactiveHeartbeat(now);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [, opts] = deliverSpy.mock.calls[0] as [ProactiveCandidate, Record<string, unknown>];
    expect(typeof opts.tonePhrase).toBe("string");
    expect((opts.tonePhrase as string).length).toBeGreaterThan(0);
  });

  it("内部异常不抛(DB 读失败 → 整轮静默跳过)", async () => {
    _proactive = { ..._proactive, mode: "gentle" };
    _throwOnListMessages = false;
    // 让 dbListCalendarEvents 抛
    const db = await import("../db");
    (db.dbListCalendarEvents as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    await expect(runProactiveHeartbeat(tsAt(10, 0))).resolves.toBeUndefined();
    expect(deliverSpy).not.toHaveBeenCalled();
  });
});
