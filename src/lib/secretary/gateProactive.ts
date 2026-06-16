/**
 * gateProactive.ts — AI 秘书完整闸门(防骚扰升级版,Task 3.2)
 *
 * gate.ts 的 gate() 是 gate-lite:只判定「单条简报该不该现在发」。
 * 本文件的 gateProactive() 是【完整闸门】:接触发层产出的候选列表
 * (ProactiveCandidate[],来自 triggers.ts),在 gate-lite 五件套之上再叠四层:
 *
 *   ① 打扰预算:每半天(上午 [00:00,12:00) / 下午 [12:00,24:00))有发送上限,
 *      跨半天(过 12:00)清零重置。预算计数从 gateState.recentlySent 的时间戳派生,
 *      不另存计数字段——避免计数与日志两套真相源漂移(R1 防骚扰要可证明)。
 *   ② 静默升级:工作时段外 + pausedUntil 未过 + 会议进行中(inMeeting)+ 专注中(inFocus)。
 *      inMeeting / inFocus 是「现在的环境事实」,由调用方在 now 时刻算好后从 env 注入,
 *      函数体内绝不自己读日历 / 读 Date.now()(懂状态安全版:只推断负荷不读心情)。
 *   ③ 按类型冷却:不同 kind 各有冷却(COOLDOWN_BY_KIND_MS),比 gate-lite 的全局
 *      最小间隔更细;全局最小间隔(minIntervalMs)仍作为跨类型的硬底保留。
 *   ④ 去重合并:同 refId 在去重窗口内不重复;一次 gateProactive 调用【至多放行一条】
 *      ——按优先级降序逐个试,首个通过全部检查的胜出,其余记为 merged/deferred。
 *      绝不一次糊用户一脸(温和姿态)。
 *   ⑤ 优先级阈值:低于地板(priorityFloor)的候选直接拒。温和姿态地板更高
 *      (PRIORITY_FLOOR_GENTLE),把"可有可无"的正反馈类挡在门外。
 *
 * ─── 铁律 ──────────────────────────────────────────────────────────────────────
 *   1. 纯函数:gateProactive(candidates, gateState, env, now, opts?) 给定输入 + now
 *      输出完全确定。函数体内绝不读 Date.now() / Math.random();「现在」「是否在会 /
 *      专注」全从参数注入。这是 R1 防骚扰可证明、R3 弱模型地板可测的关键。
 *   2. 无副作用:不读 DB / 不读 store / 不写 storage / 无引擎句柄。gateState 由调用方
 *      从真相源(proactive_log 派生,见 gateState.ts)取好后传入;放行后由调用方落库。
 *   3. 所有阈值是导出常量 / opts.默认值,测试可精确引用边界(±1ms / ±1min)。
 *
 * ⚠️ 本层只决策,不投递、不打点。投递与接线在 Task 3.7。
 */

import type { GateState, SentRecord } from "./gate";
import { DEDUP_WINDOW_MS, MIN_INTERVAL_MS } from "./gate";
import type { ProactiveCandidate, CandidateKind } from "./triggers";

// ─── 导出常量:阈值(测试引用这些做边界断言) ────────────────────────────────

/** 半天打扰预算默认上限:每个半天(上午 / 下午)最多放行这么多条主动消息 */
export const HALF_DAY_BUDGET_DEFAULT = 3;

/**
 * 温和姿态的优先级地板:候选 priority < 此值直接拒。
 *
 * 与 triggers.ts 的优先级基准对齐:
 *   meeting_soon 80(+15)/ deadline_near 70 → 过线;
 *   task_stuck 40 / just_completed 30 → 默认被这个地板挡住(温和:背景/正反馈类不主动打扰)。
 * 调用方可用 opts.priorityFloor 调低(更"积极")或调高(更"克制")。
 */
export const PRIORITY_FLOOR_GENTLE = 50;

/**
 * 各候选类型的冷却(ms):同 kind 距上次发送 <= 该值则仍在冷却内(严格 > 才算过)。
 *
 * 语义梯度:越打扰的越克制。
 *   - meeting_soon:会议提醒每次都是新会议(refId 不同),冷却短,避免误压真有用的提醒。
 *   - deadline_near:任务临近同理,短冷却。
 *   - task_stuck:背景提醒,卡住的任务别反复念叨 → 长冷却(12h)。
 *   - just_completed:正反馈,克制 → 中冷却(2h)。
 */
export const COOLDOWN_BY_KIND_MS: Record<CandidateKind, number> = {
  meeting_soon: 30 * 60 * 1000, // 30min
  deadline_near: 30 * 60 * 1000, // 30min
  task_stuck: 12 * 60 * 60 * 1000, // 12h
  just_completed: 2 * 60 * 60 * 1000, // 2h
  // 活动捕获:冷却与 intervalMin 挂钩(调用方配置);这里给默认 120min(与 DEFAULT_ACTIVITY_CAPTURE_INTERVAL_MIN 一致)。
  // M2 在 gate 策略里可据 activityCaptureMode 进一步调制。
  activity_capture: 120 * 60 * 1000, // 120min 默认
};

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/**
 * 闸门环境事实——「现在」时刻的外部状态,由调用方在 now 算好后注入。
 * 全是 now 的快照值,函数体内绝不自己去读(保证纯函数)。
 */
export interface GateEnv {
  /** 工作时段起始小时 (0-23) */
  workStart: number;
  /** 工作时段结束小时 (0-23),开区间 [workStart, workEnd) */
  workEnd: number;
  /** now 时刻是否正在开会(由调用方据 calendar_events 算好) */
  inMeeting: boolean;
  /** now 时刻用户是否处于专注 / 勿扰(由调用方据专注态算好) */
  inFocus: boolean;
}

/** 完整闸门可调项;不传时用 defaultGateOptions() */
export interface GateOptions {
  /** 每半天打扰预算上限 */
  budgetPerHalfDay: number;
  /** 优先级地板:priority < 此值直接拒 */
  priorityFloor: number;
  /** 跨类型全局最小间隔(ms):距任意上次主动消息 <= 此值则拒(严格 > 才放行) */
  minIntervalMs: number;
  /** 同 refId 去重窗口(ms) */
  dedupWindowMs: number;
  /** 各 kind 冷却(ms) */
  cooldownByKind: Record<CandidateKind, number>;
}

/** 一条被拒候选 + 原因(供日志 / 测试断言) */
export interface RejectedCandidate {
  candidate: ProactiveCandidate;
  /** 英文关键词为主的拒绝原因(供日志和测试 toMatch) */
  reason: string;
}

/** gateProactive 的决策结果 */
export interface GateDecision {
  /** 本次放行的候选(完整闸门下至多 1 条) */
  sent: ProactiveCandidate[];
  /** 被拒 / 被合并让位的候选 + 原因 */
  rejected: RejectedCandidate[];
}

// ─── 默认 opts ──────────────────────────────────────────────────────────────

/** 默认完整闸门配置(温和姿态) */
export function defaultGateOptions(): GateOptions {
  return {
    budgetPerHalfDay: HALF_DAY_BUDGET_DEFAULT,
    priorityFloor: PRIORITY_FLOOR_GENTLE,
    minIntervalMs: MIN_INTERVAL_MS,
    dedupWindowMs: DEDUP_WINDOW_MS,
    cooldownByKind: { ...COOLDOWN_BY_KIND_MS },
  };
}

// ─── 内部纯辅助 ────────────────────────────────────────────────────────────────

/** 半天枚举:上午 [00:00,12:00) / 下午 [12:00,24:00) */
type HalfDay = "am" | "pm";

/** 判断某本地时间戳属于当天的哪个半天(<12:00 上午,>=12:00 下午) */
function halfDayOf(ts: number): HalfDay {
  return new Date(ts).getHours() < 12 ? "am" : "pm";
}

/** 本地日期键 YYYY-MM-DD(用于「同一天的同一半天」判定) */
function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/**
 * 统计「与 now 处于同一天同一半天」的已发送条数(打扰预算计数)。
 * 跨半天 / 跨天的发送自然不计入 → 跨界即重置。
 */
function countSentInCurrentHalfDay(recentlySent: SentRecord[], nowMs: number): number {
  const nowDay = localDateKey(nowMs);
  const nowHalf = halfDayOf(nowMs);
  let n = 0;
  for (const r of recentlySent) {
    if (localDateKey(r.sentAt) === nowDay && halfDayOf(r.sentAt) === nowHalf) n += 1;
  }
  return n;
}

/**
 * 判断候选是否为 activity_capture 的"按时硬提醒"(scheduled)模式。
 *
 * 从候选 payload.activityCaptureMode 读取(由 triggers.detectActivityCapture 在 M2 写入)。
 * 只有 activity_capture 类型且 payload 里记录了 "scheduled" 才返回 true;
 * 其他类型、gentle/undefined 均返回 false。
 *
 * 内部纯辅助,不导出。
 */
function isScheduledActivityCapture(c: ProactiveCandidate): boolean {
  return (
    c.kind === "activity_capture" &&
    (c.payload?.activityCaptureMode as string | undefined) === "scheduled"
  );
}

/**
 * 单条候选的逐项检查(不含「一次至多一条」「预算」这类跨候选 / 跨调用的约束)。
 * 返回 undefined = 通过本条所有【针对单条】的检查;否则返回拒绝原因。
 *
 * 注意:静默(工作时段 / 会议 / 专注)与 pausedUntil 是【全局】的,
 *       但写在这里逐条返回原因便于 rejected 列表记录每条的拒因,语义不变
 *       (静默时所有候选都会拿到同一类原因)。
 *
 * M2 策略档扩展:
 *   - "gentle"(默认):activity_capture 与其他候选行为一致,受会议/专注静默挡。
 *   - "scheduled"(硬提醒):跳过「会议进行中」和「专注中」两项检查;
 *     但【仍遵守】工作时段(quiet hours)、pausedUntil(别烦我)、预算、冷却、去重、全局间隔。
 */
function checkSingle(
  c: ProactiveCandidate,
  gateState: GateState,
  env: GateEnv,
  now: Date,
  opts: GateOptions
): string | undefined {
  const nowMs = now.getTime();
  const hour = now.getHours();

  // ── 静默:工作时段外(硬约束,scheduled 也不跳过) ──
  if (hour < env.workStart || hour >= env.workEnd) {
    return `quiet hours: hour=${hour}, work=[${env.workStart},${env.workEnd})`;
  }
  // ── 静默:会议进行中(scheduled 模式跳过此项) ──
  if (env.inMeeting && !isScheduledActivityCapture(c)) {
    return "silent: meeting in progress (会议中)";
  }
  // ── 静默:专注中(scheduled 模式跳过此项) ──
  if (env.inFocus && !isScheduledActivityCapture(c)) {
    return "silent: focus mode (专注中)";
  }

  // ── pausedUntil 未过(别烦我) ──
  if (gateState.pausedUntil !== undefined && nowMs <= gateState.pausedUntil) {
    return `paused until ${new Date(gateState.pausedUntil).toISOString()}`;
  }

  // ── 优先级阈值 ──
  if (c.priority < opts.priorityFloor) {
    return `priority below floor: ${c.priority} < ${opts.priorityFloor} (阈值)`;
  }

  // ── 去重:同 refId 在去重窗口内已发过 ──
  const dup = gateState.recentlySent.find(
    (r) => r.content === c.refId && r.content !== "" && nowMs - r.sentAt <= opts.dedupWindowMs
  );
  if (dup) {
    return `duplicate refId=${c.refId} sent at ${new Date(dup.sentAt).toISOString()} (dedup window)`;
  }

  // ── 按类型冷却:同 kind 距上次 <= 该类冷却 → 仍在冷却内 ──
  const cd = opts.cooldownByKind[c.kind];
  const lastSameKind = gateState.recentlySent
    .filter((r) => r.type === c.kind)
    .reduce<number | undefined>((acc, r) => (acc === undefined ? r.sentAt : Math.max(acc, r.sentAt)), undefined);
  if (lastSameKind !== undefined && nowMs - lastSameKind <= cd) {
    return `cooldown: kind=${c.kind} last ${nowMs - lastSameKind}ms ago, cooldown=${cd}ms (冷却中)`;
  }

  // ── 全局最小间隔(温和频率硬底) ──
  if (
    gateState.lastProactiveSentMs !== undefined &&
    nowMs - gateState.lastProactiveSentMs <= opts.minIntervalMs
  ) {
    return `rate limit: last ${nowMs - gateState.lastProactiveSentMs}ms ago, min interval=${opts.minIntervalMs}ms (间隔)`;
  }

  return undefined;
}

// ─── 核心纯函数 ──────────────────────────────────────────────────────────────

/**
 * 完整闸门:从候选列表里决定此刻【至多放行一条】哪条主动消息。
 *
 * 流程:
 *   1. 先查打扰预算:本半天已发满 → 全拒(reason: budget)。
 *   2. 候选按 priority 降序稳定排序(同优先级保持输入相对顺序)。
 *   3. 逐条 checkSingle:首个全部通过的 → 放行,其余记为 merged/deferred。
 *      —— 若某条因去重 / 冷却 / 优先级等被拒,继续试下一条(退而求其次)。
 *      —— 一旦选出一条放行,后面所有候选记为「合并让位」(一次至多一条)。
 *
 * @param candidates 触发层候选列表(可乱序,内部自排序)
 * @param gateState  闸门状态(由调用方从真相源派生传入)
 * @param env        now 时刻的环境事实(工作时段 / 会议 / 专注),注入
 * @param now        当前时刻(注入,函数体内不读 Date.now())
 * @param opts       可调阈值,默认 defaultGateOptions()
 */
export function gateProactive(
  candidates: ProactiveCandidate[],
  gateState: GateState,
  env: GateEnv,
  now: Date,
  opts: GateOptions = defaultGateOptions()
): GateDecision {
  const sent: ProactiveCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  if (candidates.length === 0) return { sent, rejected };

  const nowMs = now.getTime();

  // ── 1. 打扰预算:本半天已发满 → 全拒 ──
  const usedThisHalf = countSentInCurrentHalfDay(gateState.recentlySent, nowMs);
  const budgetExhausted = usedThisHalf >= opts.budgetPerHalfDay;

  // ── 2. 按优先级降序稳定排序(不原地改入参) ──
  const ordered = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.priority - a.c.priority || a.i - b.i)
    .map((x) => x.c);

  // ── 3. 逐条试,至多放行一条 ──
  let chosen = false;
  for (const c of ordered) {
    if (chosen) {
      // 已选出一条 → 其余合并让位
      rejected.push({ candidate: c, reason: "merged/deferred: one proactive per pass (合并让位)" });
      continue;
    }
    if (budgetExhausted) {
      rejected.push({
        candidate: c,
        reason: `budget exhausted: ${usedThisHalf}/${opts.budgetPerHalfDay} this half-day (预算/额度用尽)`,
      });
      continue;
    }
    const reason = checkSingle(c, gateState, env, now, opts);
    if (reason === undefined) {
      sent.push(c);
      chosen = true;
    } else {
      rejected.push({ candidate: c, reason });
    }
  }

  return { sent, rejected };
}
