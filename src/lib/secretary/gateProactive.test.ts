/**
 * gateProactive.test.ts — Task 3.2 完整闸门(防骚扰升级版)
 *
 * gate-lite(gate.test.ts)只管单条简报的「该不该现在发」。
 * 完整闸门 gateProactive() 接的是触发层的候选列表(ProactiveCandidate[]),
 * 在 gate-lite 五件套之上再叠四层防骚扰:
 *
 *   ① 打扰预算:每半天(上午 / 下午)有发送上限,跨半天(过 12:00)清零重置。
 *   ② 静默升级:工作时段外 + 会议进行中(inMeeting)+ 专注中(inFocus)都静默。
 *   ③ 按类型冷却:不同 kind 有各自冷却,比 gate-lite 的全局最小间隔更细。
 *   ④ 去重合并:同 refId 在去重窗口内不重复;一次 gate 调用至多放行一条
 *      (最高优先级胜出,其余记为 merged/deferred,绝不一次糊一脸)。
 *   ⑤ 优先级阈值:低于地板的候选直接拒(温和姿态地板更高)。
 *
 * 铁律:gateProactive(candidates, gateState, env, now) 纯函数。
 *   - 函数体内绝不读 Date.now() / Math.random();「现在」「是否在会 / 专注」全从参数注入。
 *   - 无引擎句柄、无 DB、无 store。给定输入 + now,输出完全确定。
 *   - 所有阈值是导出常量 / opts,测试精确引用边界(±1ms / ±1min)。
 */

import { describe, it, expect } from "vitest";
import {
  gateProactive,
  defaultGateOptions,
  HALF_DAY_BUDGET_DEFAULT,
  PRIORITY_FLOOR_GENTLE,
  COOLDOWN_BY_KIND_MS,
  type GateEnv,
  type GateOptions,
} from "./gateProactive";
import type { GateState, SentRecord } from "./gate";
import type { ProactiveCandidate, CandidateKind } from "./triggers";

// ─── 固定基准时刻 ──────────────────────────────────────────────────────────────
// 2026-06-15 是周一;下面所有 makeDate 都落在这天,半天边界 = 当天 12:00。

/** 当天 HH:mm:ss.SSS 的 Date(月份 0-indexed) */
function makeDate(hour: number, min = 0, sec = 0, ms = 0): Date {
  return new Date(2026, 5, 15, hour, min, sec, ms);
}
function makeMs(hour: number, min = 0, sec = 0, ms = 0): number {
  return makeDate(hour, min, sec, ms).getTime();
}

const WORK_START = 9;
const WORK_END = 22;

/** 默认环境:工作时段内、不在会、不专注 */
function makeEnv(overrides: Partial<GateEnv> = {}): GateEnv {
  return {
    workStart: WORK_START,
    workEnd: WORK_END,
    inMeeting: false,
    inFocus: false,
    ...overrides,
  };
}

function makeState(overrides: Partial<GateState> = {}): GateState {
  return {
    recentlySent: [],
    pausedUntil: undefined,
    lastProactiveSentMs: undefined,
    ...overrides,
  };
}

let __seq = 0;
function makeCandidate(overrides: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  __seq += 1;
  return {
    kind: "meeting_soon",
    priority: 80,
    refId: `ref-${__seq}`,
    title: "候选",
    payload: {},
    ...overrides,
  };
}

/** 构造一条 SentRecord(type 用 CandidateKind 字面量,与候选 kind 同口径) */
function sent(type: CandidateKind | string, sentAt: number, refId = ""): SentRecord {
  return { type, content: refId, sentAt };
}

// ════════════════════════════════════════════════════════════════════════════
// 0. 基本放行:工作时段内 + 单条达标候选 → 放行该候选
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — 基本放行", () => {
  it("工作时段内 + 单条高优先级候选 → sent 含该候选,rejected 空", () => {
    const now = makeDate(10, 0);
    const c = makeCandidate({ kind: "meeting_soon", priority: 95 });
    const d = gateProactive([c], makeState(), makeEnv(), now);
    expect(d.sent.map((x) => x.refId)).toEqual([c.refId]);
    expect(d.rejected).toHaveLength(0);
  });

  it("空候选列表 → sent 空,rejected 空(不报错)", () => {
    const now = makeDate(10, 0);
    const d = gateProactive([], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1. 静默升级:工作时段外 / 会议中 / 专注中 → 全部拒
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — 静默(工作时段 / 会议 / 专注)", () => {
  it("工作时段前(08:59)→ 全拒,reason 命中 quiet/silent/work", () => {
    const now = makeDate(8, 59);
    const c = makeCandidate({ priority: 99 });
    const d = gateProactive([c], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected).toHaveLength(1);
    expect(d.rejected[0].reason).toMatch(/quiet|silent|work|时段/i);
  });

  it("工作时段开始边界(09:00)→ 不因静默被拒", () => {
    const now = makeDate(9, 0);
    const c = makeCandidate({ priority: 99 });
    const d = gateProactive([c], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(1);
  });

  it("工作时段结束边界(22:00,开区间)→ 全拒", () => {
    const now = makeDate(22, 0);
    const c = makeCandidate({ priority: 99 });
    const d = gateProactive([c], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(0);
  });

  it("会议进行中(inMeeting=true)→ 全拒,reason 命中 meeting/会议", () => {
    const now = makeDate(10, 0);
    const c = makeCandidate({ priority: 99 });
    const d = gateProactive([c], makeState(), makeEnv({ inMeeting: true }), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/meeting|会议/i);
  });

  it("专注中(inFocus=true)→ 全拒,reason 命中 focus/专注", () => {
    const now = makeDate(10, 0);
    const c = makeCandidate({ priority: 99 });
    const d = gateProactive([c], makeState(), makeEnv({ inFocus: true }), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/focus|专注/i);
  });

  it("pausedUntil 未过(别烦我)→ 全拒", () => {
    const now = makeDate(10, 0);
    const c = makeCandidate({ priority: 99 });
    const state = makeState({ pausedUntil: now.getTime() + 1 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/pause|暂停/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. 优先级阈值:低于地板直接拒(温和姿态地板较高)
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — 优先级阈值", () => {
  it("低于温和地板(priority < PRIORITY_FLOOR_GENTLE)→ 拒,reason 命中 priority/阈值", () => {
    const now = makeDate(10, 0);
    const low = makeCandidate({ priority: PRIORITY_FLOOR_GENTLE - 1 });
    const d = gateProactive([low], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/priority|threshold|阈值|优先/i);
  });

  it("恰好等于地板(priority === PRIORITY_FLOOR_GENTLE)→ 放行(>= 通过)", () => {
    const now = makeDate(10, 0);
    const onFloor = makeCandidate({ priority: PRIORITY_FLOOR_GENTLE });
    const d = gateProactive([onFloor], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(1);
  });

  it("可调地板:opts.priorityFloor 提高后,原本达标的候选被拒", () => {
    const now = makeDate(10, 0);
    const c = makeCandidate({ priority: 50 });
    const opts: GateOptions = { ...defaultGateOptions(), priorityFloor: 60 };
    const d = gateProactive([c], makeState(), makeEnv(), now, opts);
    expect(d.sent).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. 按类型冷却:同 kind 距上次发送未过该类冷却 → 拒
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — 按类型冷却", () => {
  it("同 kind 距上次发送 < 该类冷却 → 拒,reason 命中 cooldown/冷却", () => {
    const now = makeDate(12, 0);
    const cd = COOLDOWN_BY_KIND_MS.task_stuck;
    const state = makeState({
      recentlySent: [sent("task_stuck", now.getTime() - cd + 1)],
    });
    const c = makeCandidate({ kind: "task_stuck", priority: 80 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/cooldown|冷却/i);
  });

  it("冷却临界(elapsed === 该类冷却)→ 仍在冷却内 → 拒(严格 > 才算过)", () => {
    const now = makeDate(12, 0);
    const cd = COOLDOWN_BY_KIND_MS.task_stuck;
    const state = makeState({
      recentlySent: [sent("task_stuck", now.getTime() - cd)],
    });
    const c = makeCandidate({ kind: "task_stuck", priority: 80 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(0);
  });

  it("冷却临界 +1ms(elapsed === 该类冷却 + 1)→ 过冷却 → 放行", () => {
    const now = makeDate(12, 0);
    const cd = COOLDOWN_BY_KIND_MS.task_stuck;
    const state = makeState({
      recentlySent: [sent("task_stuck", now.getTime() - cd - 1)],
    });
    const c = makeCandidate({ kind: "task_stuck", priority: 80 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(1);
  });

  it("不同 kind 的冷却互不影响:task_stuck 冷却中,meeting_soon 仍可发", () => {
    const now = makeDate(12, 0);
    const cd = COOLDOWN_BY_KIND_MS.task_stuck;
    const state = makeState({
      recentlySent: [sent("task_stuck", now.getTime() - 1000)], // task_stuck 刚发过
      lastProactiveSentMs: now.getTime() - cd - 1, // 全局间隔已过
    });
    const c = makeCandidate({ kind: "meeting_soon", priority: 95 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent.map((x) => x.kind)).toEqual(["meeting_soon"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 去重合并:同 refId 去重 + 一次至多放行一条(最高优先级胜出)
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — 去重合并", () => {
  it("同 refId 在去重窗口内已发过 → 拒,reason 命中 dup/重复", () => {
    const now = makeDate(12, 0);
    const state = makeState({
      recentlySent: [sent("meeting_soon", now.getTime() - 1000, "ev-1")],
    });
    const c = makeCandidate({ kind: "meeting_soon", refId: "ev-1", priority: 95 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/dup|dedup|重复/i);
  });

  it("多条都达标 → 只放行最高优先级一条,其余记为 merged/deferred", () => {
    const now = makeDate(12, 0);
    const high = makeCandidate({ kind: "meeting_soon", priority: 95, refId: "hi" });
    const mid = makeCandidate({ kind: "deadline_near", priority: 70, refId: "mid" });
    const low = makeCandidate({ kind: "task_stuck", priority: 45, refId: "lo" });
    // 注意乱序传入,验证 gate 内部自己按优先级挑
    const d = gateProactive([mid, low, high], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].refId).toBe("hi");
    // 另外两条进 rejected,reason 体现「合并 / 让位」
    const rejReasons = d.rejected.map((r) => r.reason).join(" ");
    expect(d.rejected).toHaveLength(2);
    expect(rejReasons).toMatch(/merge|defer|合并|让位/i);
  });

  it("最高优先级那条恰好被去重命中 → 退而放行次高的达标候选", () => {
    const now = makeDate(12, 0);
    const high = makeCandidate({ kind: "meeting_soon", priority: 95, refId: "dup-hi" });
    const second = makeCandidate({ kind: "deadline_near", priority: 70, refId: "ok-2" });
    const state = makeState({
      // high 的 refId 已在去重窗口内发过
      recentlySent: [sent("meeting_soon", now.getTime() - 1000, "dup-hi")],
    });
    const d = gateProactive([high, second], state, makeEnv(), now);
    expect(d.sent.map((x) => x.refId)).toEqual(["ok-2"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. 打扰预算:每半天上限 + 跨 12:00 重置
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — 打扰预算(半天上限 + 跨界重置)", () => {
  it("本半天已发满额(== HALF_DAY_BUDGET_DEFAULT)→ 拒,reason 命中 budget/预算", () => {
    const now = makeDate(11, 0); // 上午
    // 当天上午已发 HALF_DAY_BUDGET_DEFAULT 条
    const recentlySent: SentRecord[] = [];
    for (let i = 0; i < HALF_DAY_BUDGET_DEFAULT; i++) {
      recentlySent.push(sent("meeting_soon", makeMs(9, i), `am-${i}`));
    }
    const state = makeState({ recentlySent });
    const c = makeCandidate({ kind: "deadline_near", refId: "new", priority: 99 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/budget|预算|额度/i);
  });

  it("本半天已发 (额度-1) 条 → 还能再发一条", () => {
    const now = makeDate(11, 0);
    const recentlySent: SentRecord[] = [];
    for (let i = 0; i < HALF_DAY_BUDGET_DEFAULT - 1; i++) {
      recentlySent.push(sent("meeting_soon", makeMs(9, i), `am-${i}`));
    }
    const state = makeState({ recentlySent });
    const c = makeCandidate({ kind: "deadline_near", refId: "new", priority: 99 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(1);
  });

  it("跨界重置:上午发满,下午(12:00 后)预算清零 → 可再发", () => {
    const now = makeDate(13, 0); // 下午
    // 上午发满额,但这些都落在上午(< 12:00),不计入下午半天
    const recentlySent: SentRecord[] = [];
    for (let i = 0; i < HALF_DAY_BUDGET_DEFAULT; i++) {
      recentlySent.push(sent("meeting_soon", makeMs(9, i), `am-${i}`));
    }
    const state = makeState({ recentlySent });
    const c = makeCandidate({ kind: "deadline_near", refId: "pm-new", priority: 99 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(1);
  });

  it("半天边界:11:59:59.999 算上午,12:00:00.000 算下午", () => {
    // 在 12:00 整发起,且上午已发满 → 应放行(因为已跨入下午半天)
    const now = makeDate(12, 0, 0, 0);
    const recentlySent: SentRecord[] = [];
    for (let i = 0; i < HALF_DAY_BUDGET_DEFAULT; i++) {
      // 11:59:59.999 之前的发送都算上午
      recentlySent.push(sent("meeting_soon", makeMs(11, 0, i), `am-${i}`));
    }
    const state = makeState({ recentlySent });
    const c = makeCandidate({ kind: "deadline_near", refId: "noon", priority: 99 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(1);
  });

  it("昨天的发送不计入今天任一半天的预算", () => {
    const now = makeDate(11, 0);
    const yesterdayAm = new Date(2026, 5, 14, 9, 0, 0, 0).getTime();
    const recentlySent: SentRecord[] = [];
    for (let i = 0; i < HALF_DAY_BUDGET_DEFAULT; i++) {
      recentlySent.push(sent("meeting_soon", yesterdayAm + i * 60000, `y-${i}`));
    }
    const state = makeState({ recentlySent });
    const c = makeCandidate({ kind: "deadline_near", refId: "today-new", priority: 99 });
    const d = gateProactive([c], state, makeEnv(), now);
    expect(d.sent).toHaveLength(1);
  });

  it("一次调用放行 1 条后,即便还有达标候选也不超本半天剩余额度", () => {
    const now = makeDate(11, 0);
    // 本半天剩余额度 = 1
    const recentlySent: SentRecord[] = [];
    for (let i = 0; i < HALF_DAY_BUDGET_DEFAULT - 1; i++) {
      recentlySent.push(sent("meeting_soon", makeMs(9, i), `am-${i}`));
    }
    const state = makeState({ recentlySent });
    const c1 = makeCandidate({ kind: "deadline_near", refId: "a", priority: 95 });
    const c2 = makeCandidate({ kind: "task_stuck", refId: "b", priority: 90 });
    const d = gateProactive([c1, c2], state, makeEnv(), now);
    // 单次本来就至多放行 1 条;此处也不超额度
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].refId).toBe("a"); // 最高优先级
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. 全局最小间隔(沿用 gate-lite 的温和频率,作为冷却之外的硬底)
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — 全局最小间隔(温和频率硬底)", () => {
  it("距任意上次主动消息 < 全局最小间隔 → 拒", () => {
    const now = makeDate(12, 0);
    const opts = defaultGateOptions();
    const state = makeState({
      lastProactiveSentMs: now.getTime() - opts.minIntervalMs + 1,
    });
    const c = makeCandidate({ kind: "meeting_soon", priority: 99 });
    const d = gateProactive([c], state, makeEnv(), now, opts);
    expect(d.sent).toHaveLength(0);
    expect(d.rejected[0].reason).toMatch(/interval|rate|频率|间隔/i);
  });

  it("距上次 > 全局最小间隔 → 放行", () => {
    const now = makeDate(12, 0);
    const opts = defaultGateOptions();
    const state = makeState({
      lastProactiveSentMs: now.getTime() - opts.minIntervalMs - 1,
    });
    const c = makeCandidate({ kind: "meeting_soon", priority: 99 });
    const d = gateProactive([c], state, makeEnv(), now, opts);
    expect(d.sent).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. 拒绝优先级:静默 > 其它(静默时段所有候选都不应放行)
// ════════════════════════════════════════════════════════════════════════════
describe("gateProactive — 综合", () => {
  it("工作时段外即便候选优先级 99 也全拒", () => {
    const now = makeDate(7, 0);
    const c = makeCandidate({ priority: 99 });
    const d = gateProactive([c], makeState(), makeEnv(), now);
    expect(d.sent).toHaveLength(0);
  });

  it("纯函数:相同输入两次调用结果一致(无内部随机 / 时钟读取)", () => {
    const now = makeDate(10, 30);
    const cands = [
      makeCandidate({ kind: "meeting_soon", priority: 95, refId: "x" }),
      makeCandidate({ kind: "deadline_near", priority: 70, refId: "y" }),
    ];
    const state = makeState();
    const env = makeEnv();
    const a = gateProactive(cands, state, env, now);
    const b = gateProactive(cands, state, env, now);
    expect(a.sent.map((c) => c.refId)).toEqual(b.sent.map((c) => c.refId));
    expect(a.rejected.length).toBe(b.rejected.length);
  });
});
