/**
 * dailyScan.ts — AI 秘书每日纪要生成 (Task 1.3)
 *
 * 职责:
 *   1. 收集当天发生了什么(today's messages + todo 活动)
 *   2. 用 generateOnce 配写纪要提示词生成一条事实性纪要
 *   3. 按 date upsert 进 daily_digest 表(同一天重跑覆盖,不重复)
 *   4. 注册成调度任务:日终(22:00+)由 scheduler owner 窗口自动触发
 *
 * 不在本文件做的:remember 工具、记忆卫生(过期/冲突/去重)——那是 Phase 2。
 *
 * 设计要点:
 *   - generateOnce 是裸调用:不绑会话、不记 usage、不调工具。纯事实性总结。
 *   - 提示词不用人设腔调:纪要是内部数据,给"以后的对话看",不是用户直接读的。
 *   - 调度任务挂 scheduler.registerJob;shouldRun 逻辑:当天 22:00 后且今日未跑过。
 */

import { generateOnce } from "../llm/index";
import {
  dbUpsertDailyDigest,
  dbListMessagesOnDate,
  dbListTodosOnDate,
} from "../db";
import type { ScheduledJob } from "./scheduler";
import type { Lang } from "../settings";

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 日终扫描触发小时(本地时间 22:00 后)。 */
const DAILY_SCAN_HOUR = 22;

/** 一天内重复 tick 的最短间隔(避免同一天多次触发)。设为 23 小时保险。 */
const MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

// ─── 提示词(zh/en 双语) ───────────────────────────────────────────────────

/**
 * 写纪要的 system prompt。
 * 要求:事实性总结——只写"今天发生了什么",不加评价/建议/人设腔调。
 * 这是内部数据,供以后的对话和扫描引用,不直接给用户看。
 */
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

// ─── 辅助:格式化当天上下文 ────────────────────────────────────────────────

/**
 * 把消息和 todo 活动拼成喂给 generateOnce 的用户消息。
 * 事实性文本:列出消息摘要(取每条 content 前 80 字)+任务活动清单。
 */
function buildContextMessage(
  messages: Array<{ role: string; content: string }>,
  todos: Array<{ title: string; status: string; completed_at: string | null }>,
  lang: Lang
): string {
  const parts: string[] = [];

  if (messages.length > 0) {
    if (lang === "zh") {
      parts.push("【今日对话摘要】");
      for (const m of messages.slice(0, 20)) {
        // 最多取 20 条避免超 token
        const prefix = m.role === "user" ? "用户: " : "助手: ";
        parts.push(`${prefix}${m.content.slice(0, 80)}`);
      }
    } else {
      parts.push("[Today's Conversation]");
      for (const m of messages.slice(0, 20)) {
        const prefix = m.role === "user" ? "User: " : "Assistant: ";
        parts.push(`${prefix}${m.content.slice(0, 80)}`);
      }
    }
  }

  if (todos.length > 0) {
    if (lang === "zh") {
      parts.push("\n【今日任务活动】");
      for (const t of todos) {
        const status =
          t.status === "done"
            ? "(已完成)"
            : t.status === "todo"
            ? "(待办)"
            : `(${t.status})`;
        parts.push(`- ${t.title} ${status}`);
      }
    } else {
      parts.push("\n[Today's Task Activity]");
      for (const t of todos) {
        const status =
          t.status === "done" ? "(done)" : t.status === "todo" ? "(pending)" : `(${t.status})`;
        parts.push(`- ${t.title} ${status}`);
      }
    }
  }

  if (parts.length === 0) {
    return lang === "zh" ? "今日无对话也无任务活动" : "No conversation or task activity today";
  }

  return parts.join("\n");
}

// ─── 核心函数 ──────────────────────────────────────────────────────────────

/**
 * 运行一次每日扫描:收集今天的数据 → 生成纪要 → upsert。
 *
 * @param dateKey  YYYY-MM-DD,由调用方按本地时区传入
 * @param lang     提示词语言,默认 "zh"
 *
 * 错误处理:内部不捕获异常,由调用方(scheduler.run 的 try/catch)处理。
 * 这样 scheduler 能统一记录错误并决定是否重试。
 */
export async function runDailyScan(dateKey: string, lang: Lang = "zh"): Promise<void> {
  // 1. 收集当天数据(两个 DB 查询并行)
  const [messages, todos] = await Promise.all([
    dbListMessagesOnDate(dateKey),
    dbListTodosOnDate(dateKey),
  ]);

  // 2. 组装用户消息
  const contextMessage = buildContextMessage(messages, todos, lang);

  // 3. 调 generateOnce 生成纪要(裸调用:不记 usage,不调工具)
  const summary = await generateOnce(DIGEST_SYSTEM[lang], [
    { role: "user", content: contextMessage },
  ]);

  // 4. upsert 进 daily_digest(同天重跑覆盖)
  await dbUpsertDailyDigest(dateKey, summary);
}

// ─── 调度任务工厂 ──────────────────────────────────────────────────────────

/**
 * 创建每日扫描调度任务。
 *
 * 挂载方:在主窗口入口处调用 scheduler.registerJob(createDailyScanJob())。
 *
 * shouldRun 规则:
 *   - 当前本地时间 >= 22:00
 *   - 距上次运行 >= MIN_INTERVAL_MS(防同一天反复触发)
 *
 * @param lang 纪要语言(默认 "zh")
 */
export function createDailyScanJob(lang: Lang = "zh"): ScheduledJob {
  return {
    id: "daily-scan",

    shouldRun(now: number, ctx: { lastRan: number | undefined }): boolean {
      // 按当前时刻的本地小时判断是否到了日终
      const hour = new Date(now).getHours();
      if (hour < DAILY_SCAN_HOUR) return false;

      // 防同一天重复触发:距上次 < MIN_INTERVAL_MS 则跳过
      if (ctx.lastRan !== undefined && now - ctx.lastRan < MIN_INTERVAL_MS) return false;

      return true;
    },

    async run(): Promise<void> {
      // 按本地时间算当日日期键(YYYY-MM-DD)
      const today = new Date();
      const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      await runDailyScan(dateKey, lang);
      console.info(`[DailyScan] 纪要生成完成: ${dateKey}`);
    },
  };
}
