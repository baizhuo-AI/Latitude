/**
 * gateState.test.ts — Task 3.2 GateState 持久化(跨重启)
 *
 * 完整闸门(gateProactive)是纯函数,但它的 GateState 必须能跨 app 重启生效:
 * 用户关机前已发满半天预算 / 某会议已提醒过,重启后不能重新清零再骚扰一遍。
 *
 * 真相源:proactive_log 表(投递成功后落库)。本文件测两层:
 *   1. buildGateStateFromLog(rows, pausedUntil, now) —— 纯函数:
 *      把日志行映射成 GateState(recentlySent / lastProactiveSentMs),
 *      并裁掉过老(超出最大关注窗口)的行。给定输入 + now 输出确定。
 *   2. db 读取器只做薄取数 + 调纯函数(读取器的集成在 proactiveLog/db 测试覆盖,
 *      这里聚焦纯函数的确定性与边界)。
 *
 * 铁律:纯函数体内不读 Date.now();now 注入。
 */

import { describe, it, expect } from "vitest";
import {
  buildGateStateFromLog,
  GATE_STATE_LOOKBACK_MS,
  type ProactiveLogRecord,
} from "./gateState";

// 固定基准:2026-06-15 12:00:00 本地
function makeMs(hour: number, min = 0, sec = 0): number {
  return new Date(2026, 5, 15, hour, min, sec, 0).getTime();
}
const NOW = new Date(makeMs(12, 0, 0));

function rec(type: string, refId: string, sentAtMs: number): ProactiveLogRecord {
  return { type, refId, sentAtMs };
}

describe("buildGateStateFromLog — 日志映射成 GateState", () => {
  it("映射 type→type、refId→content、sentAtMs→sentAt", () => {
    const rows = [rec("meeting_soon", "ev-1", makeMs(10, 0))];
    const gs = buildGateStateFromLog(rows, undefined, NOW);
    expect(gs.recentlySent).toHaveLength(1);
    expect(gs.recentlySent[0].type).toBe("meeting_soon");
    expect(gs.recentlySent[0].content).toBe("ev-1");
    expect(gs.recentlySent[0].sentAt).toBe(makeMs(10, 0));
  });

  it("lastProactiveSentMs = 关注窗口内最大 sentAt", () => {
    const rows = [
      rec("meeting_soon", "a", makeMs(9, 0)),
      rec("deadline_near", "b", makeMs(11, 30)),
      rec("task_stuck", "c", makeMs(10, 0)),
    ];
    const gs = buildGateStateFromLog(rows, undefined, NOW);
    expect(gs.lastProactiveSentMs).toBe(makeMs(11, 30));
  });

  it("空日志 → recentlySent 空,lastProactiveSentMs undefined", () => {
    const gs = buildGateStateFromLog([], undefined, NOW);
    expect(gs.recentlySent).toHaveLength(0);
    expect(gs.lastProactiveSentMs).toBeUndefined();
  });

  it("pausedUntil 透传进 GateState", () => {
    const paused = makeMs(13, 0);
    const gs = buildGateStateFromLog([], paused, NOW);
    expect(gs.pausedUntil).toBe(paused);
  });

  it("裁掉超出关注窗口的老记录(now - sentAt > GATE_STATE_LOOKBACK_MS 被剔除)", () => {
    const tooOld = NOW.getTime() - GATE_STATE_LOOKBACK_MS - 1;
    const justInside = NOW.getTime() - GATE_STATE_LOOKBACK_MS + 1;
    const rows = [
      rec("meeting_soon", "old", tooOld),
      rec("meeting_soon", "fresh", justInside),
    ];
    const gs = buildGateStateFromLog(rows, undefined, NOW);
    expect(gs.recentlySent.map((r) => r.content)).toEqual(["fresh"]);
  });

  it("窗口边界:now - sentAt === GATE_STATE_LOOKBACK_MS 保留(<= 窗口算在内)", () => {
    const onBoundary = NOW.getTime() - GATE_STATE_LOOKBACK_MS;
    const rows = [rec("meeting_soon", "boundary", onBoundary)];
    const gs = buildGateStateFromLog(rows, undefined, NOW);
    expect(gs.recentlySent.map((r) => r.content)).toEqual(["boundary"]);
  });

  it("被裁掉的老记录不影响 lastProactiveSentMs(只统计窗口内)", () => {
    const tooOld = NOW.getTime() - GATE_STATE_LOOKBACK_MS - 1000;
    const rows = [rec("meeting_soon", "old", tooOld)];
    const gs = buildGateStateFromLog(rows, undefined, NOW);
    expect(gs.lastProactiveSentMs).toBeUndefined();
  });

  it("refId 缺失(空串,如旧简报日志)→ content 为空串,仍保留(供按 type 冷却/预算计数)", () => {
    const rows = [rec("morning_briefing", "", makeMs(7, 0))];
    const gs = buildGateStateFromLog(rows, undefined, NOW);
    expect(gs.recentlySent).toHaveLength(1);
    expect(gs.recentlySent[0].content).toBe("");
  });

  it("纯函数:相同输入两次调用结果一致", () => {
    const rows = [rec("meeting_soon", "x", makeMs(10, 0)), rec("task_stuck", "y", makeMs(11, 0))];
    const a = buildGateStateFromLog(rows, undefined, NOW);
    const b = buildGateStateFromLog(rows, undefined, NOW);
    expect(a).toEqual(b);
  });
});
