/**
 * gateState.ts — 完整闸门 GateState 的持久化派生(Task 3.2)
 *
 * gateProactive() 是纯函数,但它的判断依赖「最近发过哪些主动消息」。这份状态必须
 * 跨 app 重启生效:用户关机前已发满半天预算 / 某会议已提醒过,重启后不能清零再骚扰。
 *
 * 真相源 = proactive_log 表(投递成功后落库)。本模块两层:
 *   1. buildGateStateFromLog(rows, pausedUntil, now) —— 纯函数:日志行 → GateState,
 *      裁掉超出最大关注窗口的老行。给定输入 + now 输出确定(测试覆盖边界)。
 *   2. loadGateState(pausedUntil, now) —— 薄读取器:直读 DB(真相源)取窗口内日志,
 *      再调纯函数组装。这是给 3.7 owner 窗口在「跑一轮主动巡检」前调的。
 *
 * 多窗口铁律:主动逻辑只在单一 owner 窗口跑;GateState 直读 DB(不读任何 store 内存态),
 *            pausedUntil 由调用方从 settings 真相源(readSettingsSnapshot)同步读后传入。
 */

import type { GateState, SentRecord } from "./gate";
import { dbListProactiveLogSince, type ProactiveLogSinceRow } from "../db";

/**
 * GateState 最大关注窗口(ms)。
 *
 * 取值依据:闸门里「回看最久」的约束 = 同实体去重窗口 DEDUP_WINDOW_MS(23h)。
 * 比它老的记录对任何判断都不再有影响(冷却最长 task_stuck 12h < 23h;
 * 半天预算只看今天)。留到 26h 给一点余量,避免临界抖动。
 */
export const GATE_STATE_LOOKBACK_MS = 26 * 60 * 60 * 1000;

/** 一条主动消息日志记录(buildGateStateFromLog 的输入,与 db.ProactiveLogSinceRow 同构) */
export interface ProactiveLogRecord {
  /** 主动消息类型(= 候选 kind 或 "morning_briefing" 等) */
  type: string;
  /** 触发源实体 id(旧简报日志为空串) */
  refId: string;
  /** 发送时间戳(ms) */
  sentAtMs: number;
}

/**
 * 纯函数:把 proactive_log 行映射成完整闸门用的 GateState。
 *
 * 处理:
 *   - 裁窗:now - sentAt > GATE_STATE_LOOKBACK_MS 的老记录剔除(<= 窗口保留)。
 *   - 映射:type→SentRecord.type、refId→SentRecord.content(闸门去重键)、sentAtMs→sentAt。
 *   - lastProactiveSentMs = 窗口内最大 sentAt(无记录则 undefined)。
 *   - pausedUntil 透传。
 *
 * ⚠️ 函数体内不读 Date.now();now 注入。
 *
 * @param rows         proactive_log 记录(可乱序)
 * @param pausedUntil  "别烦我"截止时间戳(ms),从 settings 真相源读后传入
 * @param now          当前时刻(注入)
 */
export function buildGateStateFromLog(
  rows: ProactiveLogRecord[],
  pausedUntil: number | undefined,
  now: Date
): GateState {
  const nowMs = now.getTime();
  const recentlySent: SentRecord[] = [];
  let lastProactiveSentMs: number | undefined;

  for (const r of rows) {
    // 裁窗:超出最大关注窗口的老记录不要(== 窗口保留)
    if (nowMs - r.sentAtMs > GATE_STATE_LOOKBACK_MS) continue;

    recentlySent.push({
      type: r.type,
      content: r.refId, // 闸门去重键是 refId,存进 SentRecord.content(与 gate.ts 口径一致)
      sentAt: r.sentAtMs,
    });

    if (lastProactiveSentMs === undefined || r.sentAtMs > lastProactiveSentMs) {
      lastProactiveSentMs = r.sentAtMs;
    }
  }

  return { recentlySent, pausedUntil, lastProactiveSentMs };
}

/**
 * 直读 DB(真相源)派生当前 GateState,供完整闸门在 owner 窗口跑巡检前调用。
 *
 * 只取关注窗口内的日志(GATE_STATE_LOOKBACK_MS),再交给纯函数组装。
 * 容错:DB 查询失败时返回「空 + pausedUntil」的保守状态——宁可少限制也别让巡检整轮崩;
 *       注意「空 recentlySent」意味着当轮去重 / 冷却 / 预算暂时不生效,但 pausedUntil
 *       与各任务自身的 shouldRun / 全局最小间隔仍兜底,不会失控。
 *
 * @param pausedUntil 从 settings 真相源(readSettingsSnapshot)读到的 reminder.pausedUntil
 * @param now         当前时刻(默认 new Date();测试可注入)
 */
export async function loadGateState(
  pausedUntil: number | undefined,
  now: Date = new Date()
): Promise<GateState> {
  try {
    const sinceMs = now.getTime() - GATE_STATE_LOOKBACK_MS;
    const rows: ProactiveLogSinceRow[] = await dbListProactiveLogSince(sinceMs);
    return buildGateStateFromLog(rows, pausedUntil, now);
  } catch (err) {
    console.warn("[secretary/gateState] loadGateState 读取失败,返回保守空状态:", err);
    return { recentlySent: [], pausedUntil, lastProactiveSentMs: undefined };
  }
}
