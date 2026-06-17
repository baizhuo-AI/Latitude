import type { ReminderConfig } from "./settings";

/**
 * 间歇式时间日志 — 工作时段/间隔判定(纯函数)
 *
 * ⚠️ 退役说明(定时×主动全合 M4):
 *   老版本这里有一个独立 setInterval(每分钟 tick),满足"工作时段内 + 距上次 >= 间隔 + 未暂停"
 *   就弹 todo 悬浮窗 + 可选系统通知,催用户手填"刚才在做什么"。该裸定时器不看用户忙不忙、
 *   不调大脑、不认"别烦我/忙时",会与 AI 秘书的主动消息双重打扰。
 *
 *   M4 已把"活动记录"升维成主动引擎的触发类型 activity_capture(走完整闸门:别烦我/静默/忙时档/
 *   预算/冷却/去重),由 src/lib/secretary/wiring.ts 的心跳统一驱动。本文件的独立 setInterval、
 *   弹窗 fireReminder、系统通知 sendSystemNotification、lastFired 持久化等副作用逻辑【已全部移除】。
 *
 *   保留下面这个纯判定函数 shouldFireReminder:它是当年"工作时段 + 间隔"判定的特征化基线
 *   (有 reminder.test.ts 锁行为),不含任何副作用。activity_capture 的等价判定见 triggers.ts 的
 *   shouldRunActivityCapture(同样的工作时段 + 间隔语义,但工作时段/暂停从全局唯一真相源注入)。
 *
 * ⚠️ 共享配置:reminder.workStart / workEnd / pausedUntil 是整个主动引擎的唯一真相源
 *   (gateProactive / wiring 都读它),M4 原样保留在 settings.reminder 里,未搬动。
 */

/**
 * 纯判断:给定 reminder 配置 + 当前时刻,此刻是否满足"该触发活动提醒"的全部条件。
 * 抽成纯函数便于单测(见 reminder.test.ts)。无副作用。
 *
 * 条件:enabled && 在工作时段 [workStart, workEnd) && 未暂停 && 距上次提醒 >= 间隔。
 *
 * @param reminder  reminder 配置(enabled / intervalMin / workStart / workEnd / pausedUntil)
 * @param now       当前时刻(Date,用于取小时判工作时段)
 * @param nowMs     当前时刻毫秒(与 lastFired 比间隔、与 pausedUntil 比是否暂停)
 * @param lastFired 上次触发的毫秒时间戳(0 表示从未触发)
 */
export function shouldFireReminder(
  reminder: ReminderConfig,
  now: Date,
  nowMs: number,
  lastFired: number
): boolean {
  if (!reminder.enabled) return false;
  const hour = now.getHours();
  if (hour < reminder.workStart || hour >= reminder.workEnd) return false; // 非工作时段
  if (reminder.pausedUntil != null && nowMs < reminder.pausedUntil) return false; // 暂停中
  if (nowMs - lastFired < reminder.intervalMin * 60 * 1000) return false; // 间隔未到
  return true;
}
