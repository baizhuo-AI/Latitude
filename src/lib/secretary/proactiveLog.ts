/**
 * proactiveLog.ts — AI 秘书主动消息投递日志 (Task 1.7)
 *
 * 职责:
 *   - 对外导出数据层函数(实际调用 db.ts 里的实现):
 *       dbLogProactiveSent(entry)   — 记录一条投递成功日志
 *       dbMarkProactiveReplied(convId, repliedAt) — 标记用户已回复
 *       dbGetProactiveStats(sinceDays) — 统计 N 天内 发送/已回复/未回复 数
 *       dbMarkProactiveDismissed(convId, dismissedAt) — 标记用户显式关掉(Task 3.5)
 *       dbListProactiveOutcomesSince(sinceMs) — 采集近期结局给降档评估(Task 3.5)
 *   - 降频判定本身是纯函数,在 dismissDowngrade.ts;这里只透传数据层。
 *
 * 设计:
 *   - 这三个函数直接 re-export 自 db.ts,保持与其他 secretary 模块的统一调用习惯。
 *   - 测试 mock 的是 db.ts 层(工厂 mock),这里只是透传,无需额外逻辑。
 */

export {
  dbLogProactiveSent,
  dbMarkProactiveReplied,
  dbGetProactiveStats,
  dbMarkProactiveDismissed,
  dbListProactiveOutcomesSince,
} from "../db";
export type { ProactiveOutcomeRow } from "../db";
