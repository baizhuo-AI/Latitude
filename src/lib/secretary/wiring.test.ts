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
// M-fix:activity_capture 配置(注入进 settingsSnapshot)
let _activityCaptureConfig: {
  enabled: boolean;
  intervalMin: number;
  activityCaptureMode: "gentle" | "scheduled";
} | undefined = undefined;

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
    proactive: {
      ..._proactive,
      // M-fix:activity_capture 配置(按需注入;undefined 表示未配置)
      activityCapture: _activityCaptureConfig,
    },
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
  // M5 新增:事件细粒度巡检
  EVENT_SCAN_INTERVAL_MIN,
  EVENT_SCAN_KINDS,
  runProactiveEventScan,
  createProactiveEventScanJob,
  // M-fix 新增:activity_capture 独立 job
  createProactiveActivityCaptureJob,
  runProactiveActivityCapture,
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
  _activityCaptureConfig = undefined; // M-fix:默认不配置 activityCapture
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
  it("注册 daily-scan + morning-briefing + proactive-heartbeat + proactive-event-scan + proactive-activity-capture 五个任务", () => {
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
    expect(registered).toContain("proactive-event-scan");
    expect(registered).toContain("proactive-activity-capture");
    expect(registered).toHaveLength(5);
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

  it("有候选(task_stuck)、闸门放行 → deliver 被调,带 channel 透传", async () => {
    // heartbeat 不再产 meeting_soon/deadline_near(由 event-scan 专管),改用 task_stuck 验证投递路径
    _proactive = { ..._proactive, mode: "active", channel: "notification" }; // active 档地板低,task_stuck(40) 能过线
    const now = tsAt(10, 0);
    const stuckCreatedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4 天前
    _fakeTodos = [
      { id: "stuck-1", title: "卡住的任务", priority: "medium", tags: [], status: "todo", createdAt: stuckCreatedAt },
    ];
    _fakeEvents = [];
    await runProactiveHeartbeat(now);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [candidate, opts] = deliverSpy.mock.calls[0] as [ProactiveCandidate, Record<string, unknown>];
    expect(candidate.kind).toBe("task_stuck");
    expect(opts.channel).toBe("notification");
  });

  it("无候选 → 不投递", async () => {
    _fakeEvents = [];
    _fakeTodos = [];
    await runProactiveHeartbeat(tsAt(10, 0));
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("候选 kind 被事件开关关掉 → 不投递(task_stuck + taskStuck=false)", async () => {
    // heartbeat 只处理 task_stuck/just_completed/activity_capture;用 taskStuck 开关来验证过滤
    _proactive = {
      ..._proactive,
      mode: "active",
      events: { ..._proactive.events, taskStuck: false },
    };
    const now = tsAt(10, 0);
    const stuckCreatedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
    _fakeTodos = [
      { id: "stuck-1", title: "卡住的任务", priority: "medium", tags: [], status: "todo", createdAt: stuckCreatedAt },
    ];
    _fakeEvents = [];
    await runProactiveHeartbeat(now);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("闸门因 pausedUntil 拒绝 → 不投递(别烦我生效)", async () => {
    _proactive = { ..._proactive, mode: "active" };
    _pausedUntil = tsAt(23, 0); // 静音到今晚
    _gateState = { recentlySent: [], pausedUntil: tsAt(23, 0), lastProactiveSentMs: undefined };
    const now = tsAt(10, 0);
    const stuckCreatedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
    _fakeTodos = [
      { id: "stuck-1", title: "卡住的任务", priority: "medium", tags: [], status: "todo", createdAt: stuckCreatedAt },
    ];
    _fakeEvents = [];
    await runProactiveHeartbeat(now);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("负荷措辞透传给 deliver(high 档 tonePhrase 注入)", async () => {
    // heartbeat 候选改用 task_stuck;三个今天的会议仍用于 buildLoadSignals(meetingCount>=3 → high)
    _proactive = { ..._proactive, mode: "active" }; // active 档地板低,task_stuck(40) 能过线
    const now = tsAt(10, 0);
    const stuckCreatedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
    _fakeTodos = [
      { id: "stuck-1", title: "卡住的任务", priority: "medium", tags: [], status: "todo", createdAt: stuckCreatedAt },
    ];
    // 三个今天的会议推 high 负荷(meetingCount>=3),外加一个会议只用于 buildLoadSignals(不做候选)
    _fakeEvents = [
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

// ════════════════════════════════════════════════════════════════════════════
// M5:事件细粒度巡检 — 证明"会议提醒漏报"修复
// ════════════════════════════════════════════════════════════════════════════

// ── 10. EVENT_SCAN_INTERVAL_MIN 常量:应远小于 MEETING_SOON_WINDOW_MS(30min) ──
describe("M5: EVENT_SCAN_INTERVAL_MIN 常量", () => {
  it("事件巡检间隔 <= 15min(保证落在 30min 会议窗口内有机会检查)", () => {
    // 关键约束:检查间隔 <= 会议窗口(30min)才能保证不漏报
    expect(EVENT_SCAN_INTERVAL_MIN).toBeLessThanOrEqual(15);
    expect(EVENT_SCAN_INTERVAL_MIN).toBeGreaterThan(0);
  });
});

// ── 11. EVENT_SCAN_KINDS:只包含时间敏感事件 kind ─────────────────────────────
describe("M5: EVENT_SCAN_KINDS 常量", () => {
  it("包含 meeting_soon + deadline_near", () => {
    expect(EVENT_SCAN_KINDS).toContain("meeting_soon");
    expect(EVENT_SCAN_KINDS).toContain("deadline_near");
  });

  it("不包含低优先级/慢节奏的 task_stuck / just_completed / activity_capture", () => {
    // 这三类有自己的 gate 冷却控制(12h / 2h / 120min),不需要快速巡检
    expect(EVENT_SCAN_KINDS).not.toContain("task_stuck");
    expect(EVENT_SCAN_KINDS).not.toContain("just_completed");
    expect(EVENT_SCAN_KINDS).not.toContain("activity_capture");
  });
});

// ── 12. createProactiveEventScanJob — shouldRun 使用事件巡检间隔 ─────────────
describe("M5: createProactiveEventScanJob.shouldRun", () => {
  it("job id 为 proactive-event-scan", () => {
    const job = createProactiveEventScanJob();
    expect(job.id).toBe("proactive-event-scan");
  });

  it("工作时段外不跑(08:59 → false)", () => {
    const job = createProactiveEventScanJob();
    expect(job.shouldRun(tsAt(8, 59), { lastRan: undefined })).toBe(false);
  });

  it("工作时段内、从未跑过 → true", () => {
    const job = createProactiveEventScanJob();
    expect(job.shouldRun(tsAt(10, 0), { lastRan: undefined })).toBe(true);
  });

  it("使用 EVENT_SCAN_INTERVAL_MIN 间隔,不受 heartbeatMin(90min)约束", () => {
    const job = createProactiveEventScanJob();
    const last = tsAt(10, 0);
    const scanMs = EVENT_SCAN_INTERVAL_MIN * 60 * 1000;

    // 间隔 -1ms 未到 → false
    expect(job.shouldRun(last + scanMs - 1, { lastRan: last })).toBe(false);
    // 恰好到间隔(>=)→ true
    expect(job.shouldRun(last + scanMs, { lastRan: last })).toBe(true);

    // 证明:如果用 90min 间隔则这个时刻不应该跑,但 event-scan 会跑
    // (即 scanMs << 90min = 5400000ms)
    expect(scanMs).toBeLessThan(90 * 60 * 1000);
  });
});

// ── 13. registerSecretaryJobs — 新增 proactive-event-scan + proactive-activity-capture 共 5 个 job ──
describe("M5: registerSecretaryJobs 新增 proactive-event-scan", () => {
  it("注册 5 个任务:含 daily-scan + morning-briefing + proactive-heartbeat + proactive-event-scan + proactive-activity-capture", () => {
    const registered: string[] = [];
    const scheduler = createScheduler({ windowId: "test-m5" });
    const origRegister = scheduler.registerJob;
    scheduler.registerJob = (job: ScheduledJob) => {
      registered.push(job.id);
      origRegister(job);
    };

    registerSecretaryJobs(scheduler, "zh");

    expect(registered).toContain("daily-scan");
    expect(registered).toContain("morning-briefing");
    expect(registered).toContain("proactive-heartbeat");
    expect(registered).toContain("proactive-event-scan");
    expect(registered).toContain("proactive-activity-capture");
    expect(registered).toHaveLength(5);
  });
});

// ── 14. runProactiveEventScan — 核心场景:会议在两次旧心跳之间的窗口 ─────────
// 这是修复的关键确定性用例:
// 场景:心跳间隔 90min,会议在 now+20min,上次心跳在 now-10min。
// 修复前:下次心跳在 now+80min,届时会议已开始 → 漏报。
// 修复后:event-scan 每 15min 跑,now+0min 时就能检测到会议 → 产候选 → 投递。
describe("M5: runProactiveEventScan — 确定性漏报修复用例", () => {
  it("会议在两次旧心跳之间的窗口:事件扫描能检查到,heartbeat 在相同时点不会跑", async () => {
    // 场景配置:
    //   - heartbeatMin = 90
    //   - 会议在 now+20min(在 MEETING_SOON_WINDOW_MS=30min 内)
    //   - 上次心跳在 now-10min(距本次 10min,远未到 90min 间隔)
    //   - now = 10:00

    const now = tsAt(10, 0);
    const heartbeatJob = createProactiveHeartbeatJob(); // heartbeatMin=90
    const eventScanJob = createProactiveEventScanJob();

    // 上次心跳 10min 前 → heartbeat 不该跑(90min 未到)
    const lastHeartbeat = tsAt(9, 50);
    expect(heartbeatJob.shouldRun(now, { lastRan: lastHeartbeat })).toBe(false);

    // 但 event-scan 上次也在 lastHeartbeat 时跑过(同一时点),现在 10min 后到点了
    // (EVENT_SCAN_INTERVAL_MIN <= 15min,10min 后还没到;但上次完全没跑过时就立即跑)
    // 测试:从未运行过 → event-scan 立即跑
    expect(eventScanJob.shouldRun(now, { lastRan: undefined })).toBe(true);

    // 设置:会议在 20min 后开始
    _fakeEvents = [eventStartingInMin(now, 20)];
    _proactive = { ..._proactive, mode: "gentle" };

    // runProactiveEventScan 应该能产候选并投递
    await runProactiveEventScan(now);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [candidate] = deliverSpy.mock.calls[0] as [ProactiveCandidate, Record<string, unknown>];
    expect(candidate.kind).toBe("meeting_soon");
  });

  it("事件扫描只产 meeting_soon / deadline_near 候选(不产 task_stuck / just_completed)", async () => {
    const now = tsAt(10, 0);
    const stuckCreatedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4 天前创建
    _fakeTodos = [
      {
        id: "stuck-1",
        title: "卡住的任务",
        priority: "medium",
        tags: [],
        status: "todo",
        createdAt: stuckCreatedAt,
      },
    ];
    _fakeEvents = []; // 无会议

    // task_stuck 候选应该存在(4天前创建,>STUCK_TASK_AGE_MS=3天),但 event-scan 不产它
    await runProactiveEventScan(now);
    // event-scan 不投递 task_stuck(它只处理 EVENT_SCAN_KINDS)
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("总闸 off → event-scan 不投递", async () => {
    _proactive = { ..._proactive, mode: "off" };
    _fakeEvents = [eventStartingInMin(tsAt(10, 0), 5)];
    await runProactiveEventScan(tsAt(10, 0));
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("meetingSoon 开关关掉 → event-scan 不投递", async () => {
    _proactive = {
      ..._proactive,
      mode: "gentle",
      events: { ..._proactive.events, meetingSoon: false },
    };
    _fakeEvents = [eventStartingInMin(tsAt(10, 0), 5)];
    await runProactiveEventScan(tsAt(10, 0));
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("gate pausedUntil 拦截 → event-scan 不投递", async () => {
    _proactive = { ..._proactive, mode: "gentle" };
    _pausedUntil = tsAt(23, 0);
    _gateState = { recentlySent: [], pausedUntil: tsAt(23, 0), lastProactiveSentMs: undefined };
    _fakeEvents = [eventStartingInMin(tsAt(10, 0), 5)];
    await runProactiveEventScan(tsAt(10, 0));
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("内部异常不抛(DB 失败 → 整轮静默跳过)", async () => {
    _proactive = { ..._proactive, mode: "gentle" };
    const db = await import("../db");
    (db.dbListCalendarEvents as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    await expect(runProactiveEventScan(tsAt(10, 0))).resolves.toBeUndefined();
    expect(deliverSpy).not.toHaveBeenCalled();
  });
});

// ── 15. 巡检(heartbeat)不变频:task_stuck / just_completed 仍走旧心跳 ────────
describe("M5: 巡检不变频 — heartbeat 仍处理 task_stuck / just_completed", () => {
  it("heartbeat 仍能产 task_stuck 候选并投递(巡检能力不受影响)", async () => {
    _proactive = { ..._proactive, mode: "active" }; // active 档放低地板,task_stuck(40) 能过线
    const now = tsAt(10, 0);
    const stuckCreatedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
    _fakeTodos = [
      {
        id: "stuck-1",
        title: "卡住的任务",
        priority: "medium",
        tags: [],
        status: "todo",
        createdAt: stuckCreatedAt,
      },
    ];
    _fakeEvents = [];

    await runProactiveHeartbeat(now);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [candidate] = deliverSpy.mock.calls[0] as [ProactiveCandidate, Record<string, unknown>];
    expect(candidate.kind).toBe("task_stuck");
  });

  it("heartbeat job 间隔仍为 heartbeatMin(90min),不被 event-scan 间隔影响", () => {
    _proactive = { ..._proactive, heartbeatMin: 90 };
    const heartbeatJob = createProactiveHeartbeatJob();
    const last = tsAt(10, 0);

    // 89min 后:未到 → false
    expect(heartbeatJob.shouldRun(tsAt(11, 29), { lastRan: last })).toBe(false);
    // 90min 后:到点 → true
    expect(heartbeatJob.shouldRun(tsAt(11, 30), { lastRan: last })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 全合终审:并发双发回归测试
// 根因:两 job 同 tick 都 shouldRun=true(lastRan 都 undefined → 冷启动),
//       各自 collectCandidates 都产出 meeting_soon/deadline_near 候选 →
//       各自 loadGateState 在对方 dbLogProactiveSent 落库前读到同一份空去重状态
//       → 同一会议各投一条(双发)。
// 修法:heartbeat 不再产 EVENT_SCAN_KINDS(meeting_soon/deadline_near)候选,
//       两 job 候选零交集,从根本上消除并发双发可能。
// ════════════════════════════════════════════════════════════════════════════

describe("全合终审:并发双发回归测试 — heartbeat 不产 meeting/ddl 候选", () => {
  it("[并发场景] heartbeat 的候选集不含 meeting_soon(同 tick 两 job 都 shouldRun=true 时不双发)", async () => {
    // 场景:冷启动,两 job 的 lastRan 都 undefined → shouldRun 都 true
    // 但 heartbeat 候选不应含 meeting_soon/deadline_near
    _proactive = { ..._proactive, mode: "gentle" };
    const now = tsAt(10, 0);

    // 设置一个 20min 内将至的会议(在 MEETING_SOON_WINDOW_MS=30min 内)
    _fakeEvents = [eventStartingInMin(now, 20)];
    _fakeTodos = [];

    // 并发时双发复现:两个函数同时用相同的空 gateState 跑
    // heartbeat 不应该产 meeting_soon —— 这是关键断言
    // 我们借助 deliverSpy 来验证:先跑 event-scan,再跑 heartbeat,
    // heartbeat 不应再次投递(即它的候选里没有 meeting_soon)
    await runProactiveEventScan(now);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [firstCandidate] = deliverSpy.mock.calls[0] as [ProactiveCandidate, Record<string, unknown>];
    expect(firstCandidate.kind).toBe("meeting_soon"); // event-scan 正常产

    // 重置 deliverSpy 后跑 heartbeat(gateState 未变 —— 模拟并发时 loadGateState 仍读旧状态)
    deliverSpy.mockClear();
    await runProactiveHeartbeat(now);
    // heartbeat 不应投递 meeting_soon(因为它不产这类候选)
    // 可能投递别的(如 activity_capture),但不能是 meeting_soon/deadline_near
    for (const call of deliverSpy.mock.calls) {
      const [c] = call as [ProactiveCandidate, unknown];
      expect(c.kind).not.toBe("meeting_soon");
      expect(c.kind).not.toBe("deadline_near");
    }
  });

  it("[并发场景] heartbeat 的候选集不含 deadline_near(冷启动,与 event-scan 零交集)", async () => {
    _proactive = { ..._proactive, mode: "gentle" };
    const now = tsAt(10, 0);
    // 设置一个 30min 内到点的 todo(在 DEADLINE_NEAR_WINDOW_MS=60min 内)
    _fakeEvents = [];
    _fakeTodos = [
      {
        id: "todo-deadline",
        title: "截止任务",
        priority: "high",
        tags: [],
        status: "todo",
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
        scheduledDate: "2026-06-15",
        scheduledTime: `${String(new Date(now + 30 * 60 * 1000).getHours()).padStart(2, "0")}:${String(new Date(now + 30 * 60 * 1000).getMinutes()).padStart(2, "0")}-${String(new Date(now + 90 * 60 * 1000).getHours()).padStart(2, "0")}:${String(new Date(now + 90 * 60 * 1000).getMinutes()).padStart(2, "0")}`,
      },
    ];

    // event-scan 应产 deadline_near
    await runProactiveEventScan(now);
    const eventScanDelivered = deliverSpy.mock.calls.some(
      ([c]) => (c as ProactiveCandidate).kind === "deadline_near"
    );
    expect(eventScanDelivered).toBe(true);

    // heartbeat 不应再产 deadline_near
    deliverSpy.mockClear();
    await runProactiveHeartbeat(now);
    for (const call of deliverSpy.mock.calls) {
      const [c] = call as [ProactiveCandidate, unknown];
      expect(c.kind).not.toBe("deadline_near");
      expect(c.kind).not.toBe("meeting_soon");
    }
  });

  it("heartbeat 内部候选过滤:collectCandidates 产出 meeting_soon 时,heartbeat 流程中过滤掉它", async () => {
    // 这个测试直接验证 heartbeat 候选里不含 EVENT_SCAN_KINDS,即使 collectCandidates 产了它们
    _proactive = { ..._proactive, mode: "gentle" };
    const now = tsAt(10, 0);

    // 只有一个 meeting_soon 候选,无其他候选
    _fakeEvents = [eventStartingInMin(now, 5)];
    _fakeTodos = [];

    // heartbeat 应不投递(候选被过滤掉了)
    await runProactiveHeartbeat(now);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("候选分区完整性:event-scan 专管时间敏感(meeting/ddl),heartbeat 专管慢节奏(stuck/completed)", async () => {
    _proactive = { ..._proactive, mode: "active" };
    const now = tsAt(10, 0);
    const stuckCreatedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();

    // 同时存在 meeting_soon 和 task_stuck 候选
    _fakeEvents = [eventStartingInMin(now, 10)];
    _fakeTodos = [
      {
        id: "stuck-1",
        title: "卡住的任务",
        priority: "medium",
        tags: [],
        status: "todo",
        createdAt: stuckCreatedAt,
      },
    ];

    // event-scan 只投 meeting_soon
    await runProactiveEventScan(now);
    const eventScanKinds = deliverSpy.mock.calls.map(([c]) => (c as ProactiveCandidate).kind);
    expect(eventScanKinds).toContain("meeting_soon");
    expect(eventScanKinds).not.toContain("task_stuck");

    deliverSpy.mockClear();

    // heartbeat 只投 task_stuck(不产 meeting_soon)
    await runProactiveHeartbeat(now);
    const heartbeatKinds = deliverSpy.mock.calls.map(([c]) => (c as ProactiveCandidate).kind);
    expect(heartbeatKinds).not.toContain("meeting_soon");
    expect(heartbeatKinds).not.toContain("deadline_near");
    // task_stuck(priority=40) 在 active 档(priorityFloor=30)应能过线
    expect(heartbeatKinds).toContain("task_stuck");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// M-fix:heartbeat 不产 activity_capture + 独立 job
// ════════════════════════════════════════════════════════════════════════════

describe("M-fix: heartbeat 不产 activity_capture 候选", () => {
  it("heartbeat 过滤后候选不含 activity_capture(即使开启了 activityCapture)", async () => {
    // 开启 activityCapture
    _activityCaptureConfig = { enabled: true, intervalMin: 30, activityCaptureMode: "scheduled" };
    const now = tsAt(10, 0);
    _fakeTodos = [];
    _fakeEvents = [];

    // 跑 heartbeat:即使有 activityCapture 配置,heartbeat 候选被过滤掉 activity_capture
    await runProactiveHeartbeat(now);
    // 没有其他候选(todo/event 都空),所以不投递
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("heartbeat 投递时不会投递 activity_capture kind", async () => {
    // 即使 heartbeat 内部运行了 collectCandidates(含 activityCapture 配置),
    // 过滤后候选中不含 activity_capture
    _activityCaptureConfig = { enabled: true, intervalMin: 30, activityCaptureMode: "scheduled" };
    _proactive = { ..._proactive, mode: "active" };
    const now = tsAt(10, 0);
    const stuckCreatedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
    _fakeTodos = [
      { id: "stuck-1", title: "卡住任务", priority: "medium", tags: [], status: "todo", createdAt: stuckCreatedAt },
    ];
    _fakeEvents = [];

    await runProactiveHeartbeat(now);
    // 可能投递 task_stuck,但绝不投递 activity_capture
    for (const call of deliverSpy.mock.calls) {
      const [c] = call as [ProactiveCandidate, unknown];
      expect(c.kind).not.toBe("activity_capture");
    }
  });
});

describe("M-fix: createProactiveActivityCaptureJob shouldRun", () => {
  it("job id 为 proactive-activity-capture", () => {
    const job = createProactiveActivityCaptureJob();
    expect(job.id).toBe("proactive-activity-capture");
  });

  it("activityCapture disabled(未配置)→ shouldRun 返回 false", () => {
    // _activityCaptureConfig 默认 undefined → disabled
    const job = createProactiveActivityCaptureJob();
    expect(job.shouldRun(tsAt(10, 0), { lastRan: undefined })).toBe(false);
  });

  it("工作时段外(8:59)→ shouldRun 返回 false", () => {
    _activityCaptureConfig = { enabled: true, intervalMin: 30, activityCaptureMode: "scheduled" };
    const job = createProactiveActivityCaptureJob();
    expect(job.shouldRun(tsAt(8, 59), { lastRan: undefined })).toBe(false);
  });

  it("间隔未到(29min < 30min)→ shouldRun 返回 false", () => {
    _activityCaptureConfig = { enabled: true, intervalMin: 30, activityCaptureMode: "scheduled" };
    const job = createProactiveActivityCaptureJob();
    const last = tsAt(10, 0);
    expect(job.shouldRun(tsAt(10, 29), { lastRan: last })).toBe(false);
  });

  it("间隔已到(30min = 30min)+ 工作时段内 + enabled → shouldRun 返回 true", () => {
    _activityCaptureConfig = { enabled: true, intervalMin: 30, activityCaptureMode: "scheduled" };
    const job = createProactiveActivityCaptureJob();
    const last = tsAt(10, 0);
    expect(job.shouldRun(tsAt(10, 30), { lastRan: last })).toBe(true);
  });

  it("从未运行过(lastRan=undefined)+ 工作时段内 + enabled → shouldRun 返回 true", () => {
    _activityCaptureConfig = { enabled: true, intervalMin: 30, activityCaptureMode: "gentle" };
    const job = createProactiveActivityCaptureJob();
    expect(job.shouldRun(tsAt(10, 0), { lastRan: undefined })).toBe(true);
  });

  it("registerSecretaryJobs 包含 proactive-activity-capture(共 5 个 job)", () => {
    const registered: string[] = [];
    const scheduler = createScheduler({ windowId: "test-ac" });
    const origRegister = scheduler.registerJob;
    scheduler.registerJob = (job: ScheduledJob) => {
      registered.push(job.id);
      origRegister(job);
    };

    registerSecretaryJobs(scheduler, "zh");

    expect(registered).toContain("proactive-activity-capture");
    expect(registered).toHaveLength(5);
  });
});

describe("M-fix: runProactiveActivityCapture 编排", () => {
  it("activityCapture disabled → 不投递", async () => {
    // _activityCaptureConfig 默认 undefined → disabled
    await runProactiveActivityCapture(tsAt(10, 0));
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("内部异常不抛(静默降级):loadGateState 异常时不投递也不抛", async () => {
    _activityCaptureConfig = { enabled: true, intervalMin: 30, activityCaptureMode: "scheduled" };
    // loadGateState 抛异常 → 整轮静默跳过
    const gateState = await import("./gateState");
    (gateState.loadGateState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gate db down"));
    await expect(runProactiveActivityCapture(tsAt(10, 0))).resolves.toBeUndefined();
    expect(deliverSpy).not.toHaveBeenCalled();
  });
});
