/**
 * startupBackfill.ts — 启动时补发逻辑 (Task 1.5)
 *
 * 职责:
 *   1. shouldBackfill(input) — 纯函数:判断启动时是否该补发当日简报
 *   2. backfillOnStartup(ctx) — 编排函数:查条件 → 该补则调 composeMorningBriefing(isBackfill=true)
 *   3. runDigestBackfill(opts) — 纪要补跑:检测近 N 天缺失的纪要并补生成
 *
 * 设计原则:
 *   - 纯函数(shouldBackfill):所有时间状态从参数注入,函数体内不读 Date.now()
 *   - 不在 App.tsx 挂载(wiring 留给后续任务)
 *   - backfillOnStartup 不对外暴露"要不要补"的决策,只对外暴露结果
 *
 * 护栏逻辑(shouldBackfill):
 *   - 今天还没发过简报 AND 已过晨报时间 → 基础条件
 *   - 已过晌午(noonHour)→ 不再补发"早安简报"(降级跳过)
 *   - 用户今天已活跃过(有发消息记录)→ 不误补(人已经在用了,不需要叫醒)
 */

import { composeMorningBriefing } from "./composeProactive";
import { generateOnce } from "../llm/index";
import {
  dbGetRecentDigests,
  dbListMessagesOnDate,
  dbListTodosOnDate,
  dbUpsertDailyDigest,
} from "../db";
import type { Lang } from "../settings";

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/**
 * shouldBackfill 的输入(全部从外部注入,保持纯函数)
 */
export interface BackfillInput {
  /**
   * 上次成功发送晨间简报的时间戳(ms)。
   * undefined 表示今天之前从没发过(或第一次启动)。
   */
  lastSentAt: number | undefined;

  /** 当前时间戳(ms),由调用方注入 */
  now: number;

  /** 常规晨报触发小时(本地时间 0-23),默认 7 */
  morningHour: number;

  /**
   * 晌午小时(本地时间 0-23)。
   * 已过晌午则不再补发"早安简报"(已经是下午了)。
   * 默认 12。
   */
  noonHour: number;

  /**
   * 用户今天是否已活跃过(即今天有过用户发送的消息)。
   * 活跃过 → 人已经在用了 → 不需要补发早安简报。
   */
  userActiveToday: boolean;
}

/**
 * backfillOnStartup 的调用上下文
 */
export interface BackfillCtx {
  /** 当前时间戳(ms) */
  now: number;
  /** 今日日期键 YYYY-MM-DD */
  dateKey: string;
  /** 昨日日期键 YYYY-MM-DD */
  yesterdayKey: string;
  /** 简报语言 */
  lang?: Lang;
  /** 上次发送晨间简报的时间戳(ms),undefined = 从未发过 */
  lastSentAt: number | undefined;
  /** 用户今天是否活跃过 */
  userActiveToday: boolean;
  /** 晨报触发小时(默认 7) */
  morningHour?: number;
  /** 晌午小时(默认 12) */
  noonHour?: number;
  /**
   * "别烦我"截止时间戳(ms)。
   * now < pausedUntil 时跳过补发(与调度器路径 gate 的 pausedUntil 语义一致)。
   * undefined = 未设置,不影响补发。
   * 由 wiring 层从 reminder.pausedUntil 读取后注入,保持此函数可测。
   */
  pausedUntil?: number;
}

/** backfillOnStartup 的返回值 */
export interface BackfillResult {
  /** 是否补发了简报 */
  didBackfill: boolean;
  /** 补发的对话 id(未补发时 undefined) */
  convId?: string;
}

/** runDigestBackfill 的选项 */
export interface DigestBackfillOpts {
  /** 今日日期键 YYYY-MM-DD(补跑范围 = 今天之前 lookbackDays 天) */
  dateKey: string;
  /** 往前看多少天检测缺失(不含今天) */
  lookbackDays?: number;
  /** 纪要生成语言 */
  lang?: Lang;
}

/** runDigestBackfill 的返回值 */
export interface DigestBackfillResult {
  /** 成功补跑的日期列表(YYYY-MM-DD) */
  backfilledDates: string[];
  /** 补跑失败的日期列表 */
  failedDates: string[];
}

// ─── 辅助 ────────────────────────────────────────────────────────────────────

/** 把时间戳格式化为 YYYY-MM-DD(按本地时区) */
function tsToDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 把 YYYY-MM-DD + 偏移天数 → 新日期键 */
function shiftDateKey(dateKey: string, deltaDays: number): string {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return tsToDateKey(d.getTime());
}

// ─── 纪要 system prompt(补跑纪要,复用 dailyScan.ts 的提示词风格) ─────────────

const DIGEST_SYSTEM: Record<Lang, string> = {
  zh: `你是一个事实性总结助手。用户会提供今日的对话摘要和任务活动记录，
请生成一条简短的今日纪要(100 字以内)，要求：
- 只陈述今天发生了什么（完成了哪些任务、讨论了哪些话题），不加评价和建议
- 用第三人称叙述（"用户今天…"）
- 不加日期头（调用方会自动加日期）
- 如果今天没有活动，输出"今日无记录"
只输出纪要正文，不要解释。`,
  en: `You are a factual summarization assistant. The user will provide today's conversation highlights and task activity.
Generate a brief daily digest (under 100 words):
- Only state what happened today (tasks completed, topics discussed) — no evaluation or advice
- Write in third person ("The user today…")
- Do not include a date header (the caller will add it)
- If there was no activity, output "No activity today"
Output only the digest text, no explanation.`,
};

// ─── 核心函数 ─────────────────────────────────────────────────────────────────

/**
 * 纯函数:判断启动时是否应该补发当日晨间简报。
 *
 * 返回 true 的条件(全部满足):
 *   1. 今天还没发过简报(lastSentAt 为 undefined 或在昨天以前)
 *   2. 当前时间已过晨报时间(>= morningHour)
 *   3. 当前时间未过晌午(< noonHour) — 过了就不补"早安"
 *   4. 用户今天没有活跃过 — 活跃说明人已在用,不需要叫醒
 *
 * 所有时间从参数注入,函数体内不读 Date.now()。
 */
export function shouldBackfill(input: BackfillInput): boolean {
  const { lastSentAt, now, morningHour, noonHour, userActiveToday } = input;

  // 条件 4:用户今天已活跃 → 不补
  if (userActiveToday) return false;

  // 算今天 00:00:00 的时间戳(本地时区)
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  // 条件 1:今天已发过简报(lastSentAt >= 今天 00:00)
  if (lastSentAt !== undefined && lastSentAt >= todayStartMs) return false;

  // 条件 2:还没到晨报时间
  const hour = new Date(now).getHours();
  if (hour < morningHour) return false;

  // 条件 3:已过晌午 — 不补"早安"
  if (hour >= noonHour) return false;

  return true;
}

/**
 * 启动时检查并按需补发当日晨间简报。
 *
 * 判断逻辑委托给 shouldBackfill 纯函数。
 * 补发时以 isBackfill=true 调用 composeMorningBriefing,对话标题 + 日志 type 带"补发"标记。
 *
 * ⚠️ 不在 App.tsx 挂载(wiring 留给 Task 1.8)。
 *
 * @param ctx 调用上下文(now / dateKey / lastSentAt / userActiveToday 等)
 * @returns BackfillResult { didBackfill, convId }
 */
export async function backfillOnStartup(ctx: BackfillCtx): Promise<BackfillResult> {
  const {
    now,
    dateKey,
    yesterdayKey,
    lang = "zh",
    lastSentAt,
    userActiveToday,
    morningHour = 7,
    noonHour = 12,
    pausedUntil,
  } = ctx;

  // "别烦我"闸门:与调度器路径的 gate pausedUntil 检查语义一致
  if (pausedUntil !== undefined && now < pausedUntil) {
    console.info(
      `[BackfillOnStartup] 跳过补发:pausedUntil 未过(${new Date(pausedUntil).toISOString()})`
    );
    return { didBackfill: false };
  }

  const shouldDo = shouldBackfill({
    lastSentAt,
    now,
    morningHour,
    noonHour,
    userActiveToday,
  });

  if (!shouldDo) {
    return { didBackfill: false };
  }

  // 补发:调 composeMorningBriefing 并标记 isBackfill=true
  try {
    const convId = await composeMorningBriefing({
      dateKey,
      yesterdayKey,
      lang,
      isBackfill: true,
    });

    if (convId) {
      console.info(`[BackfillOnStartup] 补发简报成功: conv=${convId}, date=${dateKey}`);
      return { didBackfill: true, convId };
    }

    // composeMorningBriefing 内部 C6 静默返回 undefined
    console.warn("[BackfillOnStartup] 补发:composeMorningBriefing 返回 undefined(LLM 失败?)");
    return { didBackfill: false };
  } catch (err) {
    // 兜底:补发失败不影响 app 启动
    console.warn("[BackfillOnStartup] 补发异常,静默忽略:", err);
    return { didBackfill: false };
  }
}

/**
 * 检测近 N 天缺失的每日纪要并补跑。
 *
 * 策略:
 *   1. 取近 lookbackDays 天(不含今天)的日期列表
 *   2. 查 daily_digest 已有哪些天
 *   3. 缺失的每天:拉当天 messages + todos → generateOnce → upsert
 *   4. 返回 { backfilledDates, failedDates }
 *
 * 目的:防止"续接昨天"断链(昨天没开 app,今天晨报找不到昨日纪要)。
 * 补跑完成后,下次 composeMorningBriefing 就能找到昨日纪要了。
 *
 * 容错:单天补跑失败不影响其他天,失败天记入 failedDates。
 *
 * ⚠️ 不在 App.tsx 挂载(wiring 留给 Task 1.8)。
 */
export async function runDigestBackfill(opts: DigestBackfillOpts): Promise<DigestBackfillResult> {
  const { dateKey, lookbackDays = 7, lang = "zh" } = opts;

  const backfilledDates: string[] = [];
  const failedDates: string[] = [];

  // 1. 构建需要检查的日期列表(今天之前的 lookbackDays 天,不含今天)
  const datesToCheck: string[] = [];
  for (let i = 1; i <= lookbackDays; i++) {
    datesToCheck.push(shiftDateKey(dateKey, -i));
  }
  // 排序:从最近往前(i=1 → 昨天,i=2 → 前天…)
  // datesToCheck 已按 i=1..N 排好(昨天在前)

  // 2. 查已有的纪要
  const existing = await dbGetRecentDigests(lookbackDays + 1);
  const existingDates = new Set(existing.map((d) => d.date));

  // 3. 找缺失的天
  const missing = datesToCheck.filter((d) => !existingDates.has(d));
  if (missing.length === 0) return { backfilledDates: [], failedDates: [] };

  // 4. 按日期升序补跑(先补早的,保证链路连续)
  const sortedMissing = [...missing].sort();

  for (const missingDate of sortedMissing) {
    try {
      // 拉当天数据
      const [messages, todos] = await Promise.all([
        dbListMessagesOnDate(missingDate),
        dbListTodosOnDate(missingDate),
      ]);

      // 组装 context(复用 dailyScan 风格)
      const contextParts: string[] = [];
      if (messages.length > 0) {
        if (lang === "zh") {
          contextParts.push("【当日对话摘要】");
          for (const m of messages.slice(0, 20)) {
            const prefix = m.role === "user" ? "用户: " : "助手: ";
            contextParts.push(`${prefix}${m.content.slice(0, 80)}`);
          }
        } else {
          contextParts.push("[Day's Conversation]");
          for (const m of messages.slice(0, 20)) {
            const prefix = m.role === "user" ? "User: " : "Assistant: ";
            contextParts.push(`${prefix}${m.content.slice(0, 80)}`);
          }
        }
      }
      if (todos.length > 0) {
        if (lang === "zh") {
          contextParts.push("\n【任务活动】");
          for (const t of todos) {
            const status = t.status === "done" ? "(已完成)" : t.status === "todo" ? "(待办)" : `(${t.status})`;
            contextParts.push(`- ${t.title} ${status}`);
          }
        } else {
          contextParts.push("\n[Task Activity]");
          for (const t of todos) {
            const status = t.status === "done" ? "(done)" : t.status === "todo" ? "(pending)" : `(${t.status})`;
            contextParts.push(`- ${t.title} ${status}`);
          }
        }
      }

      const contextMsg =
        contextParts.length > 0
          ? contextParts.join("\n")
          : lang === "zh"
          ? "今日无对话也无任务活动"
          : "No conversation or task activity today";

      // 调 generateOnce 生成纪要
      const summary = await generateOnce(DIGEST_SYSTEM[lang], [
        { role: "user", content: contextMsg },
      ]);

      // upsert 进 daily_digest
      await dbUpsertDailyDigest(missingDate, summary);
      backfilledDates.push(missingDate);
      console.info(`[DigestBackfill] 补跑纪要成功: ${missingDate}`);
    } catch (err) {
      failedDates.push(missingDate);
      console.warn(`[DigestBackfill] 补跑纪要失败: ${missingDate}`, err);
    }
  }

  return { backfilledDates, failedDates };
}
