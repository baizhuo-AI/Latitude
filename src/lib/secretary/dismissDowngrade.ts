/**
 * dismissDowngrade.ts — AI 秘书「dismiss 降频」纯函数 (Task 3.5 part b,R1 命门)
 *
 * 职责:把「用户对主动消息的互动结局序列」算成「是否该自动降一档主动姿态」。
 *      这是评审反复强调的 R1 命门——主动消息连续被无视时,秘书要自己识趣地少说话,
 *      而不是一直按原频率打扰。
 *
 *   输入(由接线层从 DB 真相源采集后打包传入,见 db.dbListProactiveOutcomesSince):
 *     - outcomes:近期每条主动消息的结局(replied / dismissed / ignored),按发送时间升序(旧→新)
 *     - currentMode:当前主动姿态档(settings.proactive.mode)
 *     - now:当前时刻(注入,函数体内不读 Date.now())
 *
 *   输出 DowngradeDecision:
 *     - downgraded:是否建议降档
 *     - suggestedMode:建议生效的档(未降则 === currentMode)
 *     - trailingIgnored:末尾连续未互动条数(供接线层打日志 / 阈值判断透明化)
 *
 * ─── 降档语义 ─────────────────────────────────────────────────────────────────
 *   - 「未互动」= dismissed(用户显式关掉)或 ignored(发了但一直没回复)。两者等价计入。
 *   - 「互动」= replied(用户回复了)。任何一次互动都重置连续计数(用户还愿意聊,不该降)。
 *   - 末尾连续未互动 >= CONSECUTIVE_IGNORE_THRESHOLD → 沿降档阶梯降【一档】:
 *       active → gentle → off(off 为终点,不再降也不会自己升回去)。
 *   - 一次评估最多降一档:即便连续无视很多次,也只降一级,避免「一夜从积极掉到关闭」的突变;
 *     若降档后仍被无视,下一轮(日终)评估会再降。这给用户留出感知与手动恢复的空间。
 *
 * ─── 回看窗口 ─────────────────────────────────────────────────────────────────
 *   - 只数 now - DOWNGRADE_LOOKBACK_MS(含)之后发送的结局。太老的无视不算账——
 *     避免「上个月攒下的几次没理」在今天突然触发降档。边界:sentAtMs >= cutoff 计入。
 *
 * ─── 纯函数铁律(与 gate / triggers / loadSignals 一致) ──────────────────────
 *   - evaluateDismissDowngrade / countTrailingIgnored 给定输入 + now 输出完全确定。
 *   - 函数体内绝不读 Date.now() / Math.random();「现在」从 now 注入。
 *   - 无副作用:不读 DB / 不读 store / 不写 storage。落库 setProactive 由接线层(dailyScan)做。
 *   - 阈值是导出常量,测试精确引用边界。
 *
 * ⚠️ 本层只产「建议档」,不直接改 settings。是否采纳、何时落库、在哪个窗口落库(单 owner)
 *    由 dailyScan 接线层决定——它才是真相源 setProactive 的唯一写入方。
 */

import type { ProactiveMode } from "./proactiveConfig";

// ─── 导出常量:阈值(测试引用这些做边界断言) ────────────────────────────────

/**
 * 触发降档的「连续未互动」次数门槛。
 * 边界语义:末尾连续 ignored/dismissed 条数 >= 此值即降一档(== 阈值即触发)。
 * 取 3:连发三条都没理 → 大概率是打扰过头,降一档。低于 3 容易误判(偶尔忙没看)。
 */
export const CONSECUTIVE_IGNORE_THRESHOLD = 3;

/**
 * 降档评估的回看窗口(ms):只统计 now 往前 7 天内的结局。
 * 太老的无视不计账,避免历史积压在今天突然触发降档。边界:sentAtMs >= now - 此值 计入。
 */
export const DOWNGRADE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/**
 * 单条主动消息的互动结局。
 *   - replied  :用户回复了(互动,重置连续计数)
 *   - dismissed:用户显式关掉了(未互动)
 *   - ignored  :发了但既没回复也没显式关(未互动)
 */
export interface ProactiveOutcome {
  kind: "replied" | "dismissed" | "ignored";
  /** 该条主动消息的发送时间戳(ms) */
  sentAtMs: number;
}

/** evaluateDismissDowngrade 的产物 */
export interface DowngradeDecision {
  /** 是否建议降档(已是 off 或未达阈值时为 false) */
  downgraded: boolean;
  /** 建议生效的档(未降则 === currentMode) */
  suggestedMode: ProactiveMode;
  /** 末尾连续未互动条数(回看窗口内),供接线层打日志 / 透明化判断 */
  trailingIgnored: number;
}

// ─── 降档阶梯(active → gentle → off,off 终点) ──────────────────────────────

/**
 * 单步降档映射。off 不在表内 → 已是 off 时无可再降。
 * 纯数据,无副作用。
 */
const DOWNGRADE_STEP: Partial<Record<ProactiveMode, ProactiveMode>> = {
  active: "gentle",
  gentle: "off",
};

// ─── 纯函数:proactive_log 行 → 结局类型 ─────────────────────────────────────

/**
 * 把 proactive_log 一行的 replied_at / dismissed_at 两列映射成结局类型(纯函数)。
 *
 * 优先级:replied > dismissed > ignored。
 *   - replied_at 有值 → "replied"(用户回复过,即便后来又点了关也算互动过)。
 *   - 否则 dismissed_at 有值 → "dismissed"(显式关掉)。
 *   - 两者都空 → "ignored"(发了但没回也没关)。
 *
 * 空串与 null/undefined 等价处理(SQLite 列可能存 NULL,也可能历史脏数据存空串)。
 *
 * 供 db.dbListProactiveOutcomesSince 采集时复用,集中映射逻辑便于单测。
 *
 * @param repliedAt   replied_at 列值(ISO 或 null/空)
 * @param dismissedAt dismissed_at 列值(ISO 或 null/空)
 */
export function outcomeKindFromRow(
  repliedAt: string | null | undefined,
  dismissedAt: string | null | undefined
): ProactiveOutcome["kind"] {
  if (repliedAt) return "replied";
  if (dismissedAt) return "dismissed";
  return "ignored";
}

// ─── 纯函数:末尾连续未互动计数 ──────────────────────────────────────────────

/**
 * 统计「回看窗口内、末尾连续未互动(ignored/dismissed)」的条数。
 *
 * 算法:
 *   1. 过滤掉 sentAtMs < now - DOWNGRADE_LOOKBACK_MS 的老结局(窗外不计)。
 *   2. 从最新一条往回数:遇到 replied 立即停(互动重置);ignored/dismissed 累加。
 *
 * 入参 outcomes 约定按发送时间【升序】(旧→新);本函数内部从尾部回扫,
 * 不依赖严格全序,只要末尾段是最新的即可(接线层用 ORDER BY 保证)。
 *
 * @param outcomes 互动结局序列(升序)
 * @param now      当前时刻(ms,注入)
 */
export function countTrailingIgnored(outcomes: ProactiveOutcome[], now: number): number {
  const cutoff = now - DOWNGRADE_LOOKBACK_MS;
  let count = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    const o = outcomes[i];
    // 窗外的老结局:跳过(不计、也不当作中断——它根本不该参与本轮判定)
    if (o.sentAtMs < cutoff) continue;
    if (o.kind === "replied") break; // 互动重置,停止回数
    count += 1;
  }
  return count;
}

// ─── 纯函数:降档评估 ────────────────────────────────────────────────────────

/**
 * 据结局序列评估是否降一档。f(输入, now) 纯函数。
 *
 * @param outcomes    互动结局序列(升序,由接线层从 DB 采集)
 * @param currentMode 当前主动姿态档(settings.proactive.mode 真相源)
 * @param now         当前时刻(ms,注入)
 */
export function evaluateDismissDowngrade(
  outcomes: ProactiveOutcome[],
  currentMode: ProactiveMode,
  now: number
): DowngradeDecision {
  const trailingIgnored = countTrailingIgnored(outcomes, now);

  // 未达阈值:不降
  if (trailingIgnored < CONSECUTIVE_IGNORE_THRESHOLD) {
    return { downgraded: false, suggestedMode: currentMode, trailingIgnored };
  }

  // 达阈值:尝试沿阶梯降一档;已是 off(无下一档)则不降
  const next = DOWNGRADE_STEP[currentMode];
  if (next === undefined) {
    return { downgraded: false, suggestedMode: currentMode, trailingIgnored };
  }

  return { downgraded: true, suggestedMode: next, trailingIgnored };
}
