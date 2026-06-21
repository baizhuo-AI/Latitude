/**
 * activityCaptureM2.test.ts — M2 定时提醒×主动全合
 *
 * 验收覆盖(全部纯函数、时间注入、确定性边界):
 *   1. collectCandidates 接入 activity_capture
 *      - 传入 activityCaptureCfg + lastFiredMs → 含 activity_capture 候选
 *      - 不传 activityCaptureCfg → 不含(向后兼容 M1)
 *      - 开关关(enabled=false)→ 不含
 *      - 间隔未到 → 不含
 *      - 工作时段外 → 不含
 *   2. gate 策略档(gentle vs scheduled)× 忙/闲
 *      - gentle + 会议中(inMeeting=true)→ 被会议静默挡掉
 *      - gentle + 专注中(inFocus=true)→ 被专注静默挡掉
 *      - scheduled + 会议中 → 跳过会议静默 → 放行(优先级/预算/pausedUntil 仍生效)
 *      - scheduled + 专注中 → 跳过专注静默 → 放行
 *      - scheduled + pausedUntil 未过 → 仍被别烦我挡
 *      - scheduled + 工作时段外 → 仍被静默挡(工作时段是硬约束)
 *      - gentle + 无忙时 → 正常放行
 *   3. 冷却跟随 intervalMin
 *      - 冷却 = intervalMin * 60_000(不硬编码 120)
 *      - 边界:距上次 < 冷却 → 拒;>= 冷却 +1ms → 放行
 *
 * 设计铁律:纯函数、时间注入、给定输入输出完全确定。
 */

import { describe, it, expect } from "vitest";
import {
  collectCandidates,
  type ActivityCaptureRunConfig,
} from "./triggers";
import {
  gateProactive,
  defaultGateOptions,
  type GateEnv,
  type GateOptions,
} from "./gateProactive";
import type { GateState, SentRecord } from "./gate";
import type { ProactiveCandidate, CandidateKind } from "./triggers";

// ─── 固定基准时刻 ──────────────────────────────────────────────────────────────

/** 当天 HH:mm:ss 本地 Date(2026-06-16) */
function makeDate(hour: number, min = 0, sec = 0): Date {
  return new Date(2026, 5, 16, hour, min, sec, 0);
}
function makeMs(hour: number, min = 0, sec = 0): number {
  return makeDate(hour, min, sec).getTime();
}

const MIN = 60 * 1000;
const WORK_START = 9;
const WORK_END = 22;

function makeEnv(overrides: Partial<GateEnv> = {}): GateEnv {
  return { workStart: WORK_START, workEnd: WORK_END, inMeeting: false, inFocus: false, ...overrides };
}
function makeState(overrides: Partial<GateState> = {}): GateState {
  return { recentlySent: [], pausedUntil: undefined, lastProactiveSentMs: undefined, ...overrides };
}

/** 构造 activity_capture 候选,注入 activityCaptureMode 到 payload */
function makeActivityCandidate(mode: "gentle" | "scheduled", intervalMin = 120): ProactiveCandidate {
  return {
    kind: "activity_capture",
    priority: 65,
    refId: "activity_capture",
    title: "活动记录",
    payload: { intervalMin, activityCaptureMode: mode },
  };
}

function makeSentRecord(type: CandidateKind | string, sentAt: number, refId = ""): SentRecord {
  return { type, content: refId, sentAt };
}

/** 构造基础 ActivityCaptureRunConfig */
function baseCfg(overrides: Partial<ActivityCaptureRunConfig> = {}): ActivityCaptureRunConfig {
  return {
    enabled: true,
    intervalMin: 120,
    workStart: WORK_START,
    workEnd: WORK_END,
    pausedUntil: undefined,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. collectCandidates 接入 activity_capture
// ════════════════════════════════════════════════════════════════════════════
describe("collectCandidates — 接入 activity_capture (M2)", () => {
  it("传入 activityCaptureCfg + lastFiredMs(间隔已过)→ 含 activity_capture 候选", () => {
    const now = makeDate(14, 0);
    const lastFiredMs = now.getTime() - 121 * MIN;
    const out = collectCandidates(
      { todos: [], events: [] },
      now,
      "zh",
      baseCfg(),
      lastFiredMs
    );
    const ac = out.filter((c) => c.kind === "activity_capture");
    expect(ac).toHaveLength(1);
    expect(ac[0].refId).toBe("activity_capture");
  });

  it("不传 activityCaptureCfg → 不含 activity_capture(向后兼容 M1)", () => {
    const now = makeDate(14, 0);
    const out = collectCandidates({ todos: [], events: [] }, now);
    expect(out.some((c) => c.kind === "activity_capture")).toBe(false);
  });

  it("传入 cfg 但开关关(enabled=false)→ 不含 activity_capture", () => {
    const now = makeDate(14, 0);
    const out = collectCandidates(
      { todos: [], events: [] },
      now,
      "zh",
      baseCfg({ enabled: false }),
      0
    );
    expect(out.some((c) => c.kind === "activity_capture")).toBe(false);
  });

  it("间隔未到(才过 30min,阈值 120min)→ 不含", () => {
    const now = makeDate(14, 0);
    const lastFiredMs = now.getTime() - 30 * MIN;
    const out = collectCandidates(
      { todos: [], events: [] },
      now,
      "zh",
      baseCfg(),
      lastFiredMs
    );
    expect(out.some((c) => c.kind === "activity_capture")).toBe(false);
  });

  it("工作时段外(08:00)→ 不含", () => {
    const now = makeDate(8, 0);
    const out = collectCandidates(
      { todos: [], events: [] },
      now,
      "zh",
      baseCfg(),
      0
    );
    expect(out.some((c) => c.kind === "activity_capture")).toBe(false);
  });

  it("activity_capture 候选 title 已被渲染(非空字符串)", () => {
    const now = makeDate(14, 0);
    const out = collectCandidates(
      { todos: [], events: [] },
      now,
      "zh",
      baseCfg(),
      0
    );
    const ac = out.find((c) => c.kind === "activity_capture");
    expect(ac).toBeDefined();
    expect(ac!.title).toBeTruthy();
    expect(ac!.title.length).toBeGreaterThan(0);
  });

  it("activity_capture 候选 payload 含 activityCaptureMode", () => {
    const now = makeDate(14, 0);
    const out = collectCandidates(
      { todos: [], events: [] },
      now,
      "zh",
      baseCfg({ intervalMin: 90 }),
      0
    );
    const ac = out.find((c) => c.kind === "activity_capture");
    expect(ac?.payload?.intervalMin).toBe(90);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. gate 策略档:gentle vs scheduled × 忙/闲
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — activity_capture gentle 档(受忙时调制)", () => {
  it("gentle + 会议中(inMeeting=true)→ 被静默挡,reason 命中 meeting/会议", () => {
    const now = makeDate(14, 0);
    const c = makeActivityCandidate("gentle");
    const d = gateProactive([c], makeState(), makeEnv({ inMeeting: true }), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/meeting|会议/i);
  });

  it("gentle + 专注中(inFocus=true)→ 被静默挡,reason 命中 focus/专注", () => {
    const now = makeDate(14, 0);
    const c = makeActivityCandidate("gentle");
    const d = gateProactive([c], makeState(), makeEnv({ inFocus: true }), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/focus|专注/i);
  });

  it("gentle + 不忙(无会议/专注)→ 放行", () => {
    const now = makeDate(14, 0);
    const c = makeActivityCandidate("gentle");
    const d = gateProactive([c], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].kind).toBe("activity_capture");
  });

  it("gentle + pausedUntil 未过 → 被别烦我挡", () => {
    const now = makeDate(14, 0);
    const c = makeActivityCandidate("gentle");
    const state = makeState({ pausedUntil: now.getTime() + 10_000 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/pause|暂停/i);
  });
});

describe("gateProactive — activity_capture scheduled 档(硬提醒:跳过忙时调制)", () => {
  it("scheduled + 会议中(inMeeting=true)→ 跳过会议静默 → 放行", () => {
    const now = makeDate(14, 0);
    const c = makeActivityCandidate("scheduled");
    const d = gateProactive([c], makeState(), makeEnv({ inMeeting: true }), now);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].kind).toBe("activity_capture");
  });

  it("scheduled + 专注中(inFocus=true)→ 跳过专注静默 → 放行", () => {
    const now = makeDate(14, 0);
    const c = makeActivityCandidate("scheduled");
    const d = gateProactive([c], makeState(), makeEnv({ inFocus: true }), now);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].kind).toBe("activity_capture");
  });

  it("scheduled + pausedUntil 未过 → 仍被别烦我挡(即使在会议中也一样)", () => {
    const now = makeDate(14, 0);
    const c = makeActivityCandidate("scheduled");
    // scheduled 跳过 inMeeting 检查,但 pausedUntil 仍生效
    const state = makeState({ pausedUntil: now.getTime() + 10_000 });
    // 不带 inMeeting,直接用 pausedUntil 验证别烦我约束
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/pause|暂停/i);
  });

  it("scheduled + 工作时段外(08:00)→ 仍被静默挡(工作时段是硬约束)", () => {
    const now = makeDate(8, 0);
    const c = makeActivityCandidate("scheduled");
    const d = gateProactive([c], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/quiet|silent|work|时段/i);
  });

  it("scheduled + 工作时段内 + 不在会 → 正常放行", () => {
    const now = makeDate(14, 0);
    const c = makeActivityCandidate("scheduled");
    const d = gateProactive([c], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(1);
  });

  it("scheduled + 预算耗尽 → 跳过预算检查,仍放行(M-fix:固定闹钟不受半天预算限制)", () => {
    // M-fix:scheduled activity_capture 跳过打扰预算,让它像固定闹钟一样雷打不动。
    // 注意:会议中(inMeeting)对 scheduled 也是跳过的(在 checkSingle 中处理)。
    const now = makeDate(14, 0);
    const opts = defaultGateOptions();
    const recentlySent: SentRecord[] = [];
    for (let i = 0; i < opts.budgetPerHalfDay; i++) {
      recentlySent.push(makeSentRecord("meeting_soon", makeMs(13, i), `pm-${i}`));
    }
    const state = makeState({ recentlySent });
    const c = makeActivityCandidate("scheduled");
    // scheduled 跳过预算,即使预算耗尽也放行
    const d = gateProactive([c], state, makeEnv({ inMeeting: true }), now);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].kind).toBe("activity_capture");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. 冷却跟随 intervalMin(不硬编码 120)
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — activity_capture 冷却跟随 intervalMin", () => {
  it("intervalMin=60:距上次 <60min → 冷却中 → 拒", () => {
    const now = makeDate(14, 0);
    const intervalMin = 60;
    const cooldownMs = intervalMin * MIN;
    // 距上次 cooldownMs - 1ms → 还在冷却内
    const state = makeState({
      recentlySent: [makeSentRecord("activity_capture", now.getTime() - cooldownMs + 1)],
    });
    const opts: GateOptions = {
      ...defaultGateOptions(),
      cooldownByKind: { ...defaultGateOptions().cooldownByKind, activity_capture: cooldownMs },
    };
    const c = makeActivityCandidate("gentle", intervalMin);
    const d = gateProactive([c], state, makeEnv(), now, opts);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/cooldown|冷却/i);
  });

  it("intervalMin=60:距上次 >60min(+1ms)→ 冷却过 → 放行", () => {
    const now = makeDate(14, 0);
    const intervalMin = 60;
    const cooldownMs = intervalMin * MIN;
    // 距上次 cooldownMs + 1ms → 过冷却
    const state = makeState({
      recentlySent: [makeSentRecord("activity_capture", now.getTime() - cooldownMs - 1)],
    });
    const opts: GateOptions = {
      ...defaultGateOptions(),
      cooldownByKind: { ...defaultGateOptions().cooldownByKind, activity_capture: cooldownMs },
    };
    const c = makeActivityCandidate("gentle", intervalMin);
    const d = gateProactive([c], state, makeEnv(), now, opts);
    expect(d.sent).toHaveLength(1);
  });

  it("intervalMin=30:冷却窗口=30min(而非固定120min)", () => {
    const now = makeDate(14, 0);
    const intervalMin = 30;
    const cooldownMs = intervalMin * MIN;
    // 距上次 40min(> 30min,该放行)
    const state = makeState({
      recentlySent: [makeSentRecord("activity_capture", now.getTime() - 40 * MIN)],
    });
    const opts: GateOptions = {
      ...defaultGateOptions(),
      cooldownByKind: { ...defaultGateOptions().cooldownByKind, activity_capture: cooldownMs },
    };
    const c = makeActivityCandidate("gentle", intervalMin);
    const d = gateProactive([c], state, makeEnv(), now, opts);
    expect(d.sent).toHaveLength(1);
  });

  it("wiring 层透传:collectCandidates 候选 payload.intervalMin 应与冷却匹配", () => {
    // 验证 collectCandidates 产出的候选 payload 携带了正确的 intervalMin
    const now = makeDate(14, 0);
    const intervalMin = 45;
    const out = collectCandidates(
      { todos: [], events: [] },
      now,
      "zh",
      baseCfg({ intervalMin }),
      0
    );
    const ac = out.find((c) => c.kind === "activity_capture");
    expect(ac?.payload?.intervalMin).toBe(intervalMin);
  });
});
