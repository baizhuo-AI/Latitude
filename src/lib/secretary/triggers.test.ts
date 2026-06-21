/**
 * triggers.test.ts — Task 3.1 触发层
 *
 * 验收覆盖(全部纯函数、时间注入、确定性边界±):
 *   1. detectMeetingSoon — 会议将至(calendar_events,startTs 秒)
 *   2. detectDeadlineNear — ddl 临近(todos 的 scheduledDate + scheduledTime)
 *   3. detectStuckTask — 任务卡很久(createdAt 老 + 未完成)
 *   4. detectJustCompleted — 刚完成(completedAt 在最近窗口)
 *   5. shouldHeartbeat — 心跳巡检判定(工作时段内 + 距上次 >= 间隔)
 *   6. collectCandidates — 聚合所有触发源 + 按优先级排序
 *
 * 设计铁律:
 *   - 所有判定函数签名 f(输入, now),函数体内绝不读 Date.now()/Math.random()
 *   - 时间从 now(Date)注入,边界用 ±1 分钟/秒精确断言
 *   - 只产候选,不投递、不接调度(那是 3.7)
 */

import { describe, it, expect } from "vitest";
import {
  detectMeetingSoon,
  detectDeadlineNear,
  detectStuckTask,
  detectJustCompleted,
  shouldHeartbeat,
  collectCandidates,
  MEETING_SOON_WINDOW_MS,
  DEADLINE_NEAR_WINDOW_MS,
  STUCK_TASK_AGE_MS,
  JUST_COMPLETED_WINDOW_MS,
  type ProactiveCandidate,
  type TriggerSnapshot,
  type HeartbeatConfig,
} from "./triggers";
import type { Todo } from "../store";
import type { CalendarEvent } from "../db";

// ─── 辅助:构造测试数据 ─────────────────────────────────────────────────────────

/** 固定基准时刻 2026-06-15 14:00:00 本地时间(工作时段内) */
function baseNow(hour = 14, min = 0, sec = 0): Date {
  return new Date(2026, 5, 15, hour, min, sec, 0); // month 0-indexed
}

/** 把本地 Date 转成 Unix 秒(calendar_events.startTs 口径) */
function toUnixSec(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/** YYYY-MM-DD 本地日期键 */
function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: "t1",
    title: "写方案",
    priority: "medium",
    tags: [],
    status: "todo",
    createdAt: baseNow().toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "ce1",
    region: "feishu",
    calendarId: "cal1",
    remoteEventId: "r1",
    title: "产品周会",
    isAllDay: false,
    status: "confirmed",
    isRecurringInstance: false,
    isWritable: true,
    localDraft: false,
    createdAt: baseNow().toISOString(),
    updatedAt: baseNow().toISOString(),
    ...overrides,
  };
}

function emptySnapshot(overrides: Partial<TriggerSnapshot> = {}): TriggerSnapshot {
  return {
    todos: [],
    events: [],
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. detectMeetingSoon — 会议将至(calendar_events,startTs 秒)
// ════════════════════════════════════════════════════════════════════════════
describe("detectMeetingSoon — 会议将至", () => {
  it("会议在窗口内(15min 后)→ 产出一条候选", () => {
    const now = baseNow();
    const ev = makeEvent({ startTs: toUnixSec(new Date(now.getTime() + 15 * 60 * 1000)) });
    const out = detectMeetingSoon([ev], now);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("meeting_soon");
    expect(out[0].refId).toBe(ev.id);
  });

  it("会议已经开始(过去)→ 不产候选", () => {
    const now = baseNow();
    const ev = makeEvent({ startTs: toUnixSec(new Date(now.getTime() - 60 * 1000)) });
    expect(detectMeetingSoon([ev], now)).toHaveLength(0);
  });

  it("会议超出窗口(窗口 + 1min)→ 不产候选", () => {
    const now = baseNow();
    const ev = makeEvent({
      startTs: toUnixSec(new Date(now.getTime() + MEETING_SOON_WINDOW_MS + 60 * 1000)),
    });
    expect(detectMeetingSoon([ev], now)).toHaveLength(0);
  });

  it("边界:恰好在窗口边缘(窗口整 - 1s)→ 产候选;(窗口整 + 1s)→ 不产", () => {
    const now = baseNow();
    const inside = makeEvent({
      id: "in",
      startTs: toUnixSec(new Date(now.getTime() + MEETING_SOON_WINDOW_MS - 1000)),
    });
    const outside = makeEvent({
      id: "out",
      startTs: toUnixSec(new Date(now.getTime() + MEETING_SOON_WINDOW_MS + 1000)),
    });
    expect(detectMeetingSoon([inside], now)).toHaveLength(1);
    expect(detectMeetingSoon([outside], now)).toHaveLength(0);
  });

  it("已取消(cancelled)的会议 → 跳过", () => {
    const now = baseNow();
    const ev = makeEvent({
      status: "cancelled",
      startTs: toUnixSec(new Date(now.getTime() + 10 * 60 * 1000)),
    });
    expect(detectMeetingSoon([ev], now)).toHaveLength(0);
  });

  it("全天事件(无 startTs)→ 跳过", () => {
    const now = baseNow();
    const ev = makeEvent({ isAllDay: true, startTs: undefined });
    expect(detectMeetingSoon([ev], now)).toHaveLength(0);
  });

  it("候选 payload 携带分钟数,优先级随临近度上升(<=5min 高于 >5min)", () => {
    const now = baseNow();
    const veryClose = makeEvent({
      id: "vc",
      startTs: toUnixSec(new Date(now.getTime() + 3 * 60 * 1000)),
    });
    const lessClose = makeEvent({
      id: "lc",
      startTs: toUnixSec(new Date(now.getTime() + 20 * 60 * 1000)),
    });
    const a = detectMeetingSoon([veryClose], now)[0];
    const b = detectMeetingSoon([lessClose], now)[0];
    expect(a.priority).toBeGreaterThan(b.priority);
    expect(typeof a.payload?.minutesUntil).toBe("number");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. detectDeadlineNear — ddl 临近(todos 的 scheduledDate + scheduledTime)
// ════════════════════════════════════════════════════════════════════════════
describe("detectDeadlineNear — ddl 临近", () => {
  it("今天排程、开始时间在窗口内 → 产候选", () => {
    const now = baseNow(14, 0); // 14:00
    const todo = makeTodo({
      scheduledDate: dateKeyOf(now),
      scheduledTime: "14:30-15:30", // 30min 后开始
      status: "todo",
    });
    const out = detectDeadlineNear([todo], now);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("deadline_near");
    expect(out[0].refId).toBe(todo.id);
  });

  it("已完成的任务 → 不产候选(不催已完成)", () => {
    const now = baseNow(14, 0);
    const todo = makeTodo({
      scheduledDate: dateKeyOf(now),
      scheduledTime: "14:30-15:30",
      status: "done",
    });
    expect(detectDeadlineNear([todo], now)).toHaveLength(0);
  });

  it("已丢弃(dropped)的任务 → 不产候选", () => {
    const now = baseNow(14, 0);
    const todo = makeTodo({
      scheduledDate: dateKeyOf(now),
      scheduledTime: "14:30-15:30",
      status: "dropped",
    });
    expect(detectDeadlineNear([todo], now)).toHaveLength(0);
  });

  it("开始时间已过 → 不产候选(已经迟到,不在'临近'语义内)", () => {
    const now = baseNow(15, 0);
    const todo = makeTodo({
      scheduledDate: dateKeyOf(now),
      scheduledTime: "14:00-15:00", // 已经开始/过去
    });
    expect(detectDeadlineNear([todo], now)).toHaveLength(0);
  });

  it("非今天排程(明天)→ 不产候选", () => {
    const now = baseNow(14, 0);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const todo = makeTodo({
      scheduledDate: dateKeyOf(tomorrow),
      scheduledTime: "14:30-15:30",
    });
    expect(detectDeadlineNear([todo], now)).toHaveLength(0);
  });

  it("无 scheduledTime(无可解析时段)→ 跳过(deadline 自由文本不解析)", () => {
    const now = baseNow(14, 0);
    const todo = makeTodo({
      scheduledDate: dateKeyOf(now),
      scheduledTime: undefined,
      deadline: "今天下午", // 自由文本,不应被解析
    });
    expect(detectDeadlineNear([todo], now)).toHaveLength(0);
  });

  it("边界:开始时间距 now 恰为窗口整 → 产;窗口整 + 1min → 不产", () => {
    // 用窗口换算成分钟,构造一个刚好落边界的 scheduledTime
    const windowMin = DEADLINE_NEAR_WINDOW_MS / 60000;
    const now = baseNow(9, 0); // 09:00
    const startMinInside = 9 * 60 + windowMin; // 恰好窗口边缘
    const hhInside = Math.floor(startMinInside / 60);
    const mmInside = startMinInside % 60;
    const inside = makeTodo({
      id: "in",
      scheduledDate: dateKeyOf(now),
      scheduledTime: `${String(hhInside).padStart(2, "0")}:${String(mmInside).padStart(2, "0")}-23:00`,
    });
    const startMinOutside = startMinInside + 1;
    const hhOut = Math.floor(startMinOutside / 60);
    const mmOut = startMinOutside % 60;
    const outside = makeTodo({
      id: "out",
      scheduledDate: dateKeyOf(now),
      scheduledTime: `${String(hhOut).padStart(2, "0")}:${String(mmOut).padStart(2, "0")}-23:30`,
    });
    expect(detectDeadlineNear([inside], now)).toHaveLength(1);
    expect(detectDeadlineNear([outside], now)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. detectStuckTask — 任务卡很久(createdAt 老 + 未完成)
// ════════════════════════════════════════════════════════════════════════════
describe("detectStuckTask — 任务卡很久", () => {
  it("创建超过阈值且未完成 → 产候选", () => {
    const now = baseNow();
    const old = new Date(now.getTime() - STUCK_TASK_AGE_MS - 60 * 1000);
    const todo = makeTodo({ createdAt: old.toISOString(), status: "todo" });
    const out = detectStuckTask([todo], now);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("task_stuck");
    expect(out[0].refId).toBe(todo.id);
  });

  it("创建超过阈值但已完成 → 不产候选", () => {
    const now = baseNow();
    const old = new Date(now.getTime() - STUCK_TASK_AGE_MS - 60 * 1000);
    const todo = makeTodo({ createdAt: old.toISOString(), status: "done" });
    expect(detectStuckTask([todo], now)).toHaveLength(0);
  });

  it("刚创建(未到阈值)→ 不产候选", () => {
    const now = baseNow();
    const todo = makeTodo({ createdAt: now.toISOString(), status: "todo" });
    expect(detectStuckTask([todo], now)).toHaveLength(0);
  });

  it("边界:年龄恰为阈值 - 1s → 不产;阈值 + 1s → 产", () => {
    const now = baseNow();
    const justUnder = makeTodo({
      id: "under",
      createdAt: new Date(now.getTime() - (STUCK_TASK_AGE_MS - 1000)).toISOString(),
    });
    const justOver = makeTodo({
      id: "over",
      createdAt: new Date(now.getTime() - (STUCK_TASK_AGE_MS + 1000)).toISOString(),
    });
    expect(detectStuckTask([justUnder], now)).toHaveLength(0);
    expect(detectStuckTask([justOver], now)).toHaveLength(1);
  });

  it("doing 状态(进行中但很久没动)也算卡住", () => {
    const now = baseNow();
    const old = new Date(now.getTime() - STUCK_TASK_AGE_MS - 60 * 1000);
    const todo = makeTodo({ createdAt: old.toISOString(), status: "doing" });
    expect(detectStuckTask([todo], now)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. detectJustCompleted — 刚完成(completedAt 在最近窗口)
// ════════════════════════════════════════════════════════════════════════════
describe("detectJustCompleted — 刚完成", () => {
  it("刚完成(窗口内)→ 产候选", () => {
    const now = baseNow();
    const todo = makeTodo({
      status: "done",
      completedAt: new Date(now.getTime() - 60 * 1000).toISOString(),
    });
    const out = detectJustCompleted([todo], now);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("just_completed");
    expect(out[0].refId).toBe(todo.id);
  });

  it("很久前完成(超窗口)→ 不产候选", () => {
    const now = baseNow();
    const todo = makeTodo({
      status: "done",
      completedAt: new Date(now.getTime() - JUST_COMPLETED_WINDOW_MS - 60 * 1000).toISOString(),
    });
    expect(detectJustCompleted([todo], now)).toHaveLength(0);
  });

  it("status=done 但无 completedAt → 跳过(数据不全不臆断)", () => {
    const now = baseNow();
    const todo = makeTodo({ status: "done", completedAt: undefined });
    expect(detectJustCompleted([todo], now)).toHaveLength(0);
  });

  it("未完成(todo)→ 跳过", () => {
    const now = baseNow();
    const todo = makeTodo({ status: "todo" });
    expect(detectJustCompleted([todo], now)).toHaveLength(0);
  });

  it("边界:完成于窗口整 - 1s → 产;窗口整 + 1s → 不产", () => {
    const now = baseNow();
    const inside = makeTodo({
      id: "in",
      status: "done",
      completedAt: new Date(now.getTime() - (JUST_COMPLETED_WINDOW_MS - 1000)).toISOString(),
    });
    const outside = makeTodo({
      id: "out",
      status: "done",
      completedAt: new Date(now.getTime() - (JUST_COMPLETED_WINDOW_MS + 1000)).toISOString(),
    });
    expect(detectJustCompleted([inside], now)).toHaveLength(1);
    expect(detectJustCompleted([outside], now)).toHaveLength(0);
  });

  it("未来时间的 completedAt(时钟漂移)→ 跳过(不产负窗口候选)", () => {
    const now = baseNow();
    const todo = makeTodo({
      status: "done",
      completedAt: new Date(now.getTime() + 60 * 1000).toISOString(),
    });
    expect(detectJustCompleted([todo], now)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. shouldHeartbeat — 心跳巡检判定
// ════════════════════════════════════════════════════════════════════════════
describe("shouldHeartbeat — 心跳巡检判定", () => {
  const cfg: HeartbeatConfig = {
    workStart: 9,
    workEnd: 22,
    intervalMs: 60 * 60 * 1000, // 1h
  };

  it("工作时段内 + 从未跑过(lastBeatMs undefined)→ true", () => {
    expect(shouldHeartbeat(cfg, undefined, baseNow(14))).toBe(true);
  });

  it("工作时段外(08:59)→ false", () => {
    expect(shouldHeartbeat(cfg, undefined, baseNow(8, 59))).toBe(false);
  });

  it("工作时段起始边界(09:00)→ true;结束边界(22:00,开区间)→ false", () => {
    expect(shouldHeartbeat(cfg, undefined, baseNow(9, 0))).toBe(true);
    expect(shouldHeartbeat(cfg, undefined, baseNow(22, 0))).toBe(false);
  });

  it("工作时段内但距上次 < 间隔 → false", () => {
    const now = baseNow(14, 0);
    const last = now.getTime() - 30 * 60 * 1000; // 30min 前
    expect(shouldHeartbeat(cfg, last, now)).toBe(false);
  });

  it("工作时段内且距上次 >= 间隔 → true", () => {
    const now = baseNow(14, 0);
    const last = now.getTime() - 60 * 60 * 1000; // 恰好 1h 前
    expect(shouldHeartbeat(cfg, last, now)).toBe(true);
  });

  it("边界:距上次恰为 间隔 - 1ms → false;间隔 + 1ms → true", () => {
    const now = baseNow(14, 0);
    const under = now.getTime() - (cfg.intervalMs - 1);
    const over = now.getTime() - (cfg.intervalMs + 1);
    expect(shouldHeartbeat(cfg, under, now)).toBe(false);
    expect(shouldHeartbeat(cfg, over, now)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. collectCandidates — 聚合所有触发源 + 优先级排序
// ════════════════════════════════════════════════════════════════════════════
describe("collectCandidates — 聚合 + 优先级排序", () => {
  it("空快照 → 空候选", () => {
    expect(collectCandidates(emptySnapshot(), baseNow())).toEqual([]);
  });

  it("聚合多源:会议将至 + ddl 临近 + 卡住 + 刚完成 都出现", () => {
    const now = baseNow(14, 0);
    const snapshot = emptySnapshot({
      events: [
        makeEvent({ id: "m", startTs: toUnixSec(new Date(now.getTime() + 10 * 60 * 1000)) }),
      ],
      todos: [
        makeTodo({
          id: "dn",
          scheduledDate: dateKeyOf(now),
          scheduledTime: "14:20-15:00",
        }),
        makeTodo({
          id: "stuck",
          createdAt: new Date(now.getTime() - STUCK_TASK_AGE_MS - 60 * 1000).toISOString(),
        }),
        makeTodo({
          id: "done",
          status: "done",
          completedAt: new Date(now.getTime() - 60 * 1000).toISOString(),
        }),
      ],
    });
    const out = collectCandidates(snapshot, now);
    const kinds = out.map((c) => c.kind).sort();
    expect(kinds).toContain("meeting_soon");
    expect(kinds).toContain("deadline_near");
    expect(kinds).toContain("task_stuck");
    expect(kinds).toContain("just_completed");
  });

  it("按优先级降序排列(高优先在前)", () => {
    const now = baseNow(14, 0);
    const snapshot = emptySnapshot({
      events: [
        makeEvent({ id: "m", startTs: toUnixSec(new Date(now.getTime() + 3 * 60 * 1000)) }),
      ],
      todos: [
        makeTodo({
          id: "stuck",
          createdAt: new Date(now.getTime() - STUCK_TASK_AGE_MS - 60 * 1000).toISOString(),
        }),
      ],
    });
    const out = collectCandidates(snapshot, now);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].priority).toBeGreaterThanOrEqual(out[i].priority);
    }
  });

  it("候选稳定排序:同优先级保持确定顺序(同输入同输出)", () => {
    const now = baseNow(14, 0);
    const snapshot = emptySnapshot({
      todos: [
        makeTodo({
          id: "a",
          createdAt: new Date(now.getTime() - STUCK_TASK_AGE_MS - 60 * 1000).toISOString(),
        }),
        makeTodo({
          id: "b",
          createdAt: new Date(now.getTime() - STUCK_TASK_AGE_MS - 120 * 1000).toISOString(),
        }),
      ],
    });
    const run1 = collectCandidates(snapshot, now).map((c) => c.refId);
    const run2 = collectCandidates(snapshot, now).map((c) => c.refId);
    expect(run1).toEqual(run2);
  });

  it("每条候选都带 i18n 渲染好的 title(非空字符串)", () => {
    const now = baseNow(14, 0);
    const snapshot = emptySnapshot({
      events: [
        makeEvent({ id: "m", startTs: toUnixSec(new Date(now.getTime() + 10 * 60 * 1000)) }),
      ],
    });
    const out: ProactiveCandidate[] = collectCandidates(snapshot, now, "zh");
    expect(out[0].title.length).toBeGreaterThan(0);
    // 英文也能渲染
    const outEn = collectCandidates(snapshot, now, "en");
    expect(outEn[0].title.length).toBeGreaterThan(0);
    expect(outEn[0].title).not.toBe(out[0].title);
  });
});
