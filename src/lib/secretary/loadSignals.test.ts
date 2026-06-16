/**
 * loadSignals.test.ts — Task 3.3 懂状态(负荷推断)
 *
 * computeLoad(signals, now) 纯函数:从「日程密度 / 今日完成率 / 是否加班 /
 * 任务推迟次数」四类 DB 信号推断当前【负荷档】(load level)。
 *
 * 安全版铁律(只测负荷,不读心情):
 *   - 输出只有负荷档 + 派生的「闸门调参建议」+「语气措辞」,绝不含情绪/心情判断。
 *   - 冷启动护栏:信号不足(无事件且今天无排程任务)→ 返回 "unknown" 档,
 *     不给阈值调整(delta 全 0)、不给措辞(tonePhrase undefined)。
 *   - 纯函数:computeLoad(signals, now) 给定输入 + now 输出完全确定;
 *     函数体内绝不读 Date.now() / Math.random();「现在」「是否加班」从 now + workEnd 注入。
 *
 * 下游消费(本测试只验证产出值,不验证 3.2/3.4 真去消费):
 *   - 3.2 闸门:priorityFloorDelta(抬/降优先级地板)、budgetDelta(增/减半天预算)。
 *   - 3.4 投递:tonePhrase(按负荷调语气的一句提示,注入合成层)。
 */

import { describe, it, expect } from "vitest";
import {
  computeLoad,
  DENSE_SCHEDULE_THRESHOLD,
  LIGHT_SCHEDULE_THRESHOLD,
  HIGH_LOAD_FLOOR_DELTA,
  HIGH_LOAD_BUDGET_DELTA,
  LOW_LOAD_FLOOR_DELTA,
  LOW_LOAD_BUDGET_DELTA,
  type LoadSignals,
  type LoadAssessment,
  type LoadLevel,
} from "./loadSignals";

// ─── 固定基准时刻 ──────────────────────────────────────────────────────────────
// 2026-06-15 是周一。workEnd 默认 22:00。

function makeDate(hour: number, min = 0): Date {
  return new Date(2026, 5, 15, hour, min, 0, 0);
}

const WORK_START = 9;
const WORK_END = 22;

/** 默认信号:工作时段配置 + 空数据(会触发 unknown 护栏,各测试按需覆盖) */
function makeSignals(overrides: Partial<LoadSignals> = {}): LoadSignals {
  return {
    workStart: WORK_START,
    workEnd: WORK_END,
    meetingCount: 0,
    scheduledTodoCount: 0,
    completedTodoCount: 0,
    procrastinatedCount: 0,
    ...overrides,
  };
}

describe("computeLoad — 冷启动护栏(信号稀疏 → unknown)", () => {
  it("无事件且今天无排程任务 → unknown 档,不调整不出措辞", () => {
    const a = computeLoad(makeSignals(), makeDate(10));
    expect(a.level).toBe<LoadLevel>("unknown");
    // 不调整:所有 delta = 0
    expect(a.priorityFloorDelta).toBe(0);
    expect(a.budgetDelta).toBe(0);
    // 不出措辞
    expect(a.tonePhrase).toBeUndefined();
    // 安全版:不含任何情绪/心情字段
    expect(a).not.toHaveProperty("mood");
    expect(a).not.toHaveProperty("emotion");
  });

  it("仅 1 个推迟任务、但无事件无排程任务 → 仍 unknown(单一稀疏信号不足以定档)", () => {
    const a = computeLoad(
      makeSignals({ procrastinatedCount: 1 }),
      makeDate(10)
    );
    expect(a.level).toBe<LoadLevel>("unknown");
    expect(a.priorityFloorDelta).toBe(0);
    expect(a.budgetDelta).toBe(0);
    expect(a.tonePhrase).toBeUndefined();
  });

  it("有排程任务即视为有信号,可定档(脱离 unknown)", () => {
    const a = computeLoad(
      makeSignals({ scheduledTodoCount: 3, completedTodoCount: 1 }),
      makeDate(10)
    );
    expect(a.level).not.toBe<LoadLevel>("unknown");
  });

  it("有事件即视为有信号,可定档(脱离 unknown)", () => {
    const a = computeLoad(makeSignals({ meetingCount: 1 }), makeDate(10));
    expect(a.level).not.toBe<LoadLevel>("unknown");
  });
});

describe("computeLoad — 高负荷(满日程 → 抬阈)", () => {
  it("日程密度达到稠密阈值 → high 档,抬高优先级地板 + 收紧预算", () => {
    const a = computeLoad(
      makeSignals({ meetingCount: DENSE_SCHEDULE_THRESHOLD }),
      makeDate(10)
    );
    expect(a.level).toBe<LoadLevel>("high");
    // 抬阈:地板 delta 为正(更克制,只放紧迫的)
    expect(a.priorityFloorDelta).toBe(HIGH_LOAD_FLOOR_DELTA);
    expect(a.priorityFloorDelta).toBeGreaterThan(0);
    // 收紧预算:budget delta 为负(更少打扰)
    expect(a.budgetDelta).toBe(HIGH_LOAD_BUDGET_DELTA);
    expect(a.budgetDelta).toBeLessThan(0);
    // 出措辞(供 3.4 调语气)
    expect(a.tonePhrase).toBeDefined();
  });

  it("稠密阈值边界:= 阈值算 high,< 阈值不算(±1)", () => {
    const atThreshold = computeLoad(
      makeSignals({ meetingCount: DENSE_SCHEDULE_THRESHOLD }),
      makeDate(10)
    );
    expect(atThreshold.level).toBe<LoadLevel>("high");

    const belowThreshold = computeLoad(
      makeSignals({ meetingCount: DENSE_SCHEDULE_THRESHOLD - 1 }),
      makeDate(10)
    );
    expect(belowThreshold.level).not.toBe<LoadLevel>("high");
  });

  it("加班(now 已过 workEnd)+ 有信号 → high 档", () => {
    // 21:59 还在工作时段内;22:00 即加班(workEnd 开区间)
    const beforeEnd = computeLoad(
      makeSignals({ scheduledTodoCount: 2, completedTodoCount: 1 }),
      makeDate(21, 59)
    );
    expect(beforeEnd.level).not.toBe<LoadLevel>("high");

    const atEnd = computeLoad(
      makeSignals({ scheduledTodoCount: 2, completedTodoCount: 1 }),
      makeDate(WORK_END, 0)
    );
    expect(atEnd.level).toBe<LoadLevel>("high");
    expect(atEnd.priorityFloorDelta).toBe(HIGH_LOAD_FLOOR_DELTA);
  });

  it("推迟任务多(>= 稠密阈值)+ 有信号 → high 档", () => {
    const a = computeLoad(
      makeSignals({
        scheduledTodoCount: 4,
        completedTodoCount: 0,
        procrastinatedCount: DENSE_SCHEDULE_THRESHOLD,
      }),
      makeDate(10)
    );
    expect(a.level).toBe<LoadLevel>("high");
  });
});

describe("computeLoad — 低负荷(空闲 → 放低)", () => {
  it("日程稀疏 + 完成率高 → low 档,放低地板 + 放宽预算", () => {
    const a = computeLoad(
      makeSignals({
        meetingCount: LIGHT_SCHEDULE_THRESHOLD,
        scheduledTodoCount: 4,
        completedTodoCount: 4, // 100% 完成
      }),
      makeDate(11)
    );
    expect(a.level).toBe<LoadLevel>("low");
    // 放低:地板 delta 为负(更积极,允许背景类)
    expect(a.priorityFloorDelta).toBe(LOW_LOAD_FLOOR_DELTA);
    expect(a.priorityFloorDelta).toBeLessThan(0);
    // 放宽预算:budget delta 为正
    expect(a.budgetDelta).toBe(LOW_LOAD_BUDGET_DELTA);
    expect(a.budgetDelta).toBeGreaterThan(0);
    expect(a.tonePhrase).toBeDefined();
  });

  it("即使空闲,加班时也不放低(加班优先判 high)", () => {
    const a = computeLoad(
      makeSignals({
        meetingCount: 0,
        scheduledTodoCount: 2,
        completedTodoCount: 2,
      }),
      makeDate(WORK_END, 30) // 已加班
    );
    expect(a.level).toBe<LoadLevel>("high");
  });

  it("空闲但有未完成的推迟任务积压 → 不算 low(有压力信号)", () => {
    const a = computeLoad(
      makeSignals({
        meetingCount: 0,
        scheduledTodoCount: 5,
        completedTodoCount: 5,
        procrastinatedCount: 2, // 有积压
      }),
      makeDate(11)
    );
    expect(a.level).not.toBe<LoadLevel>("low");
  });
});

describe("computeLoad — 普通负荷(normal,介于高低之间)", () => {
  it("中等日程 + 中等完成率 → normal,不调整阈值", () => {
    const a = computeLoad(
      makeSignals({
        meetingCount: 1,
        scheduledTodoCount: 4,
        completedTodoCount: 2, // 50%
      }),
      makeDate(14)
    );
    expect(a.level).toBe<LoadLevel>("normal");
    expect(a.priorityFloorDelta).toBe(0);
    expect(a.budgetDelta).toBe(0);
    // normal 仍可出一句中性措辞(可选,但不能是 high/low 的措辞)
  });
});

describe("computeLoad — 纯函数确定性 / 安全版", () => {
  it("同输入 + 同 now 多次调用结果完全一致(无随机/无读时钟)", () => {
    const sig = makeSignals({
      meetingCount: DENSE_SCHEDULE_THRESHOLD,
      scheduledTodoCount: 3,
      completedTodoCount: 1,
    });
    const now = makeDate(10);
    const a1 = computeLoad(sig, now);
    const a2 = computeLoad(sig, now);
    expect(a1).toEqual(a2);
  });

  it("不修改入参 signals", () => {
    const sig = makeSignals({ meetingCount: 2, scheduledTodoCount: 3 });
    const snapshot = JSON.parse(JSON.stringify(sig));
    computeLoad(sig, makeDate(10));
    expect(sig).toEqual(snapshot);
  });

  it("完成率分母为 0 不崩(scheduledTodoCount=0 但有事件)", () => {
    const a = computeLoad(
      makeSignals({ meetingCount: 1, scheduledTodoCount: 0, completedTodoCount: 0 }),
      makeDate(10)
    );
    // 不抛异常、有合法档位
    expect(["high", "low", "normal", "unknown"]).toContain(a.level);
  });

  it("脏数据:completedTodoCount > scheduledTodoCount 被夹紧,不产生 > 1 的完成率", () => {
    // 不应因完成率 > 1 而误判;只验证不崩 + 档位合法
    const a = computeLoad(
      makeSignals({ scheduledTodoCount: 2, completedTodoCount: 5 }),
      makeDate(11)
    );
    expect(["high", "low", "normal", "unknown"]).toContain(a.level);
  });
});
