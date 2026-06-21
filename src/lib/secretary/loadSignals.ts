/**
 * loadSignals.ts — AI 秘书「懂状态」负荷推断纯函数 (Task 3.3)
 *
 * 职责:从四类 DB 信号推断用户当前的【负荷档】(load level),并派生出
 *      给下游消费的「闸门调参建议」与「语气措辞」。
 *
 *   输入信号(由调用方从真相源直读 DB 后打包成 LoadSignals 传入):
 *     ① 日程密度  meetingCount        —— 当天 confirmed、非全天的日历事件数
 *     ② 今日完成率 completedTodoCount / scheduledTodoCount —— 今天排程任务的完成情况
 *     ③ 是否加班   now.getHours() >= workEnd —— 由 now + workEnd 在函数内判定(纯)
 *     ④ 任务推迟   procrastinatedCount —— 标 isProcrastinated 的未完成任务数(推迟代理信号)
 *
 *   输出 LoadAssessment:
 *     - level:负荷档 high / normal / low / unknown
 *     - priorityFloorDelta:给 3.2 闸门——加到优先级地板上的增量(正=抬阈更克制,负=放低更积极)
 *     - budgetDelta:给 3.2 闸门——加到半天打扰预算上的增量(负=收紧,正=放宽)
 *     - tonePhrase:给 3.4 投递——按负荷调语气的一句提示(注入合成层);unknown/缺信号时 undefined
 *
 * ─── 安全版铁律(只推断负荷,不读心情) ──────────────────────────────────────
 *   - 只输出负荷与其派生的克制/积极程度,绝不输出情绪 / 心情 / 状态揣测字段。
 *     负荷是「客观可数的工作量」(几个会、完成几项、是否加班、积压几条),
 *     不是「用户此刻开不开心」。后者信号不可靠,本层一律不碰。
 *   - 冷启动护栏:信号稀疏(既无事件、今天也无排程任务)→ 返回 "unknown" 档,
 *     delta 全 0、tonePhrase undefined —— 宁可不调,不瞎调。单条孤立信号
 *     (如只有几条推迟任务但今天没安排)不足以定档,同样回 unknown。
 *
 * ─── 纯函数铁律(与 gate / triggers / scheduler 一致) ────────────────────────
 *   - computeLoad(signals, now) 给定输入 + now 输出完全确定。
 *   - 函数体内绝不读 Date.now() / Math.random();「现在」「是否加班」从 now + workEnd 注入。
 *   - 无副作用:不读 DB / 不读 store / 不写 storage。
 *   - 所有阈值是导出常量,测试精确引用边界。
 *
 * ⚠️ 本层只产「建议值」,不直接改 3.2 闸门 / 3.4 投递。如何套用 delta、是否采用
 *    tonePhrase,由 3.2 / 3.4 的接线代码决定(它们才是 delta / phrase 的消费方)。
 */

import type { Lang } from "../settings";

// ─── 导出常量:阈值(测试引用这些做边界断言) ────────────────────────────────

/**
 * 稠密日程阈值:日程密度(或推迟积压)>= 此值视为「满」,推向 high。
 * 边界语义:>= 阈值算稠密(== 阈值即 high)。
 */
export const DENSE_SCHEDULE_THRESHOLD = 3;

/**
 * 轻日程阈值:日程密度 <= 此值视为「稀疏」,是判 low 的必要条件之一。
 * 边界语义:<= 阈值算稀疏。
 */
export const LIGHT_SCHEDULE_THRESHOLD = 1;

/**
 * 判 low 还需要的「完成率」下限:今日完成率 >= 此值才算「进度从容」。
 * 注:仅当今天确实有排程任务时才参与判定;没有排程任务时不靠完成率判 low。
 */
export const LIGHT_COMPLETION_RATIO = 0.8;

// ─── 闸门调参 delta(给 3.2 消费;正负号语义见各常量注释) ──────────────────

/** high 档:抬高优先级地板(更克制,只放紧迫的)。正值。 */
export const HIGH_LOAD_FLOOR_DELTA = 15;
/** high 档:收紧半天打扰预算。负值。 */
export const HIGH_LOAD_BUDGET_DELTA = -1;

/** low 档:放低优先级地板(更积极,允许背景类)。负值。 */
export const LOW_LOAD_FLOOR_DELTA = -10;
/** low 档:放宽半天打扰预算。正值。 */
export const LOW_LOAD_BUDGET_DELTA = 1;

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** 负荷档枚举。unknown = 信号不足,不调整不出措辞(冷启动护栏)。 */
export type LoadLevel = "high" | "normal" | "low" | "unknown";

/**
 * 负荷推断输入信号快照。
 * 由调用方(owner 窗口)从真相源直读 DB 取好后打包传入;本层不读 DB / store。
 *
 * 字段口径:
 *   - workStart / workEnd:工作时段(小时,0-23),开区间 [workStart, workEnd)。
 *     加班 = now.getHours() >= workEnd(由调用方从 settings 真相源读 reminder.workEnd 传入)。
 *   - meetingCount:当天 confirmed、非全天的日历事件数(日程密度)。
 *   - scheduledTodoCount:今天排程的任务总数(分母);0 表示今天没安排。
 *   - completedTodoCount:今天排程任务里已完成的数(分子);内部对分母夹紧。
 *   - procrastinatedCount:标 isProcrastinated 的未完成任务数(推迟/积压代理信号)。
 */
export interface LoadSignals {
  workStart: number;
  workEnd: number;
  meetingCount: number;
  scheduledTodoCount: number;
  completedTodoCount: number;
  procrastinatedCount: number;
}

/**
 * 负荷推断结果。
 * 安全版:只含负荷与其派生的调参 / 措辞,绝不含情绪 / 心情字段。
 */
export interface LoadAssessment {
  /** 负荷档 */
  level: LoadLevel;
  /** 给 3.2 闸门:加到优先级地板上的增量(正=抬阈,负=放低);unknown/normal = 0 */
  priorityFloorDelta: number;
  /** 给 3.2 闸门:加到半天打扰预算上的增量(负=收紧,正=放宽);unknown/normal = 0 */
  budgetDelta: number;
  /** 给 3.4 投递:按负荷调语气的一句提示;unknown 时 undefined(不出措辞) */
  tonePhrase?: string;
}

// ─── i18n 语气措辞(内嵌 Record,与 triggers / dailyScan 同风格) ──────────────
//   tonePhrase 是给【合成层】的「调语气提示」,不是直接给用户的最终话术;
//   合成层(带人设)会据此把简报措辞往「更简短克制」或「更松弛」的方向带。

const TONE_PHRASE: Record<Exclude<LoadLevel, "unknown">, Record<Lang, string>> = {
  high: {
    zh: "用户当前负荷偏高(日程密/有积压/或在加班),措辞更简短克制,只说要紧的。",
    en: "User load is high (packed schedule / backlog / overtime). Keep it short and only surface what matters.",
  },
  normal: {
    zh: "用户负荷正常,正常温和措辞即可。",
    en: "User load is normal. Use the usual gentle tone.",
  },
  low: {
    zh: "用户当前较从容(日程松、进度好),措辞可稍松弛,适度多给一点背景或建议。",
    en: "User has bandwidth (light schedule, good progress). Tone can be a bit more relaxed with extra context if useful.",
  },
};

// ─── 内部纯辅助 ────────────────────────────────────────────────────────────────

/** 是否处于加班:now 的本地小时 >= workEnd(开区间,== workEnd 即加班) */
function isOvertime(now: Date, workEnd: number): boolean {
  return now.getHours() >= workEnd;
}

/**
 * 今日完成率。分母夹紧:completed 不超过 scheduled,scheduled<=0 视为无完成率(返回 undefined)。
 * 返回 undefined 表示「今天没有可计完成率的任务」,判定时不依赖它。
 */
function completionRatio(scheduled: number, completed: number): number | undefined {
  if (scheduled <= 0) return undefined;
  const c = Math.max(0, Math.min(completed, scheduled)); // 脏数据夹紧到 [0, scheduled]
  return c / scheduled;
}

/** 是否有任何可用于定档的信号(冷启动护栏:既无事件、也无今天排程 → 无信号) */
function hasSignal(s: LoadSignals): boolean {
  return s.meetingCount > 0 || s.scheduledTodoCount > 0;
}

/** 按档位组装最终结果(集中处理 delta 与 tonePhrase 的对应,避免散落) */
function assess(level: LoadLevel, lang: Lang): LoadAssessment {
  switch (level) {
    case "high":
      return {
        level,
        priorityFloorDelta: HIGH_LOAD_FLOOR_DELTA,
        budgetDelta: HIGH_LOAD_BUDGET_DELTA,
        tonePhrase: TONE_PHRASE.high[lang],
      };
    case "low":
      return {
        level,
        priorityFloorDelta: LOW_LOAD_FLOOR_DELTA,
        budgetDelta: LOW_LOAD_BUDGET_DELTA,
        tonePhrase: TONE_PHRASE.low[lang],
      };
    case "normal":
      return {
        level,
        priorityFloorDelta: 0,
        budgetDelta: 0,
        tonePhrase: TONE_PHRASE.normal[lang],
      };
    case "unknown":
    default:
      // 冷启动护栏:不调整、不出措辞
      return { level: "unknown", priorityFloorDelta: 0, budgetDelta: 0, tonePhrase: undefined };
  }
}

// ─── 核心纯函数 ──────────────────────────────────────────────────────────────

/**
 * 推断当前负荷档并给出下游调参 / 措辞建议。
 *
 * 判定顺序(短路,前者优先):
 *   0. 冷启动护栏:无信号 → unknown(直接返回,不调不出措辞)。
 *   1. high:满足任一「压力信号」→ high(抬阈、收预算):
 *        - 加班(now >= workEnd)
 *        - 日程稠密(meetingCount >= DENSE_SCHEDULE_THRESHOLD)
 *        - 推迟积压重(procrastinatedCount >= DENSE_SCHEDULE_THRESHOLD)
 *      加班即判 high 在最前,保证「空闲但加班」仍走 high(测试约束)。
 *   2. low:全部「从容信号」成立 → low(放低、放宽预算):
 *        - 日程稀疏(meetingCount <= LIGHT_SCHEDULE_THRESHOLD)
 *        - 无推迟积压(procrastinatedCount === 0)—— 有积压就不算从容
 *        - 今日完成率达标(>= LIGHT_COMPLETION_RATIO);
 *          若今天没有排程任务(无完成率),则不靠完成率判 low,需另有正向信号才行,
 *          这里要求「有排程任务且完成率达标」才判 low,避免空数据误判从容。
 *   3. 其余 → normal。
 *
 * @param signals 负荷信号快照(调用方从 DB 取好)
 * @param now     当前时刻(注入,函数体内不读 Date.now())
 * @param lang    措辞语言,默认 "zh"
 */
export function computeLoad(
  signals: LoadSignals,
  now: Date,
  lang: Lang = "zh"
): LoadAssessment {
  // ── 0. 冷启动护栏:信号稀疏 → unknown ──
  if (!hasSignal(signals)) {
    return assess("unknown", lang);
  }

  const overtime = isOvertime(now, signals.workEnd);
  const denseSchedule = signals.meetingCount >= DENSE_SCHEDULE_THRESHOLD;
  const heavyBacklog = signals.procrastinatedCount >= DENSE_SCHEDULE_THRESHOLD;

  // ── 1. high:任一压力信号 ──
  if (overtime || denseSchedule || heavyBacklog) {
    return assess("high", lang);
  }

  // ── 2. low:全部从容信号成立 ──
  const lightSchedule = signals.meetingCount <= LIGHT_SCHEDULE_THRESHOLD;
  const noBacklog = signals.procrastinatedCount === 0;
  const ratio = completionRatio(signals.scheduledTodoCount, signals.completedTodoCount);
  const progressOk = ratio !== undefined && ratio >= LIGHT_COMPLETION_RATIO;

  if (lightSchedule && noBacklog && progressOk) {
    return assess("low", lang);
  }

  // ── 3. 其余 → normal ──
  return assess("normal", lang);
}
