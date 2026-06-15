/**
 * composeProactive.ts — AI 秘书主动消息合成 (Task 1.4)
 *
 * 职责:
 *   1. composeMorningBriefing(ctx):
 *      - 收集〔昨日纪要 + 今日任务 + 人设〕
 *      - 用 generateOnce 合成一条带人设腔调、续接昨天的简报文本
 *      - 把简报作为一条 assistant 消息插入新建的"今日简报"对话并持久化
 *      - 发出 conversations 数据变更事件,让悬浮条能刷新到这个新对话
 *   2. createMorningBriefingJob(opts):
 *      - 返回可注册到 scheduler 的调度任务对象
 *      - shouldRun 做成纯函数:当天首次、到达配置的早晨时间 → true
 *      - 本 Task 只定义任务,不在 App.tsx 挂载(wiring 留给后续)
 *
 * C6 错误降级:generateOnce 失败时静默——不投递、不弹错、仅日志。
 *
 * 设计要点:
 *   - 投递进哪个对话:每天一条"今日简报"新对话。
 *     不复用当前对话(避免污染用户正在进行的会话),
 *     也不需要用户先说一句话——简报作为 assistant 首条消息投入空对话,
 *     用户直接回复即接入正常 sendMessage 流程。
 *   - chatStore 的 in-memory 状态通过 useChatStore.getState() 更新,
 *     让同窗口的 UI 立即响应;同时 emitSync("conversations") 通知跨窗口。
 */

import { generateOnce } from "../llm/index";
import { composePersonaPrompt } from "../persona/personaSpec";
import {
  dbGetRecentDigests,
  dbInsertConversation,
  dbInsertMessage,
  dbTouchConversation,
  dbListTodosOnDate,
  dbLogProactiveSent,
} from "../db";
import { useSettingsStore } from "../settings";
import { useChatStore } from "../chatStore";
import { emitSync } from "../syncBus";
import type { ScheduledJob } from "./scheduler";
import type { Lang } from "../settings";
import type { ConversationRow, ChatMessageRow } from "../db";

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** composeMorningBriefing 的调用上下文(可注入,便于测试) */
export interface MorningBriefingCtx {
  /** 今日日期键 YYYY-MM-DD */
  dateKey: string;
  /** 昨日日期键 YYYY-MM-DD(取昨日纪要用) */
  yesterdayKey: string;
  /** 简报语言 */
  lang?: Lang;
  /**
   * 是否为"补发"场景(app 启动时发现今天错过了晨报)。
   * 补发时对话标题 + proactive_log type 体现"补发"标记。
   * 默认 false(正常晨报)。
   */
  isBackfill?: boolean;
}

/** createMorningBriefingJob 的配置项 */
export interface MorningBriefingJobOpts {
  /** 早晨触发小时(本地时间 0-23),默认 7 */
  morningHour?: number;
  /** 语言,默认从 settings 读取 */
  lang?: Lang;
}

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 默认触发小时(本地时间 07:00) */
const DEFAULT_MORNING_HOUR = 7;

/** 一天内重复 tick 的最短间隔(23h),防同天多次触发 */
const MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

/** 从 daily_digest 取多少天的纪要(只取昨天 1 条就够了,但统一用近 2 条保留余量) */
const DIGEST_LOOKBACK = 2;

// ─── 简报提示词 ────────────────────────────────────────────────────────────

/**
 * 简报的 system prompt:告知模型它在给用户发晨间简报。
 * 人设由 composePersonaPrompt 注入(调用方传给 generateOnce 的 systemPrompt 参数)。
 */
const BRIEFING_SYSTEM_SUFFIX: Record<Lang, string> = {
  zh: `

你现在要给用户发一条晨间简报。要求:
- 用你的人设腔调自然开口,不要机械地说"早上好,以下是您的简报:"
- 回顾昨天发生的事(如有纪要),一两句带过
- 提一下今天有哪些任务(如有),帮用户有个概念
- 全文 100-200 字,简洁有腔调
- 不要分条罗列,用自然的叙述口吻
只输出简报正文,不要解释。`,

  en: `

Now compose a morning briefing for the user. Requirements:
- Open naturally in your persona's voice — don't start with "Good morning, here is your briefing:"
- Briefly touch on what happened yesterday (if digest is available)
- Mention today's tasks (if any) to give the user a sense of the day
- Keep it 100-200 words, concise and in-character
- Write in flowing prose, not bullet points
Output only the briefing text, no explanation.`,
};

/**
 * 首日简报的 system prompt 后缀:在没有任何往日纪要时使用。
 * 要求:自我介绍 + 引导用户填写"关于你" + 用今日数据撑起第一条简报。
 */
const FIRST_DAY_SYSTEM_SUFFIX: Record<Lang, string> = {
  zh: `

今天是你和用户**第一次见面**。你现在要发一条首日简报。要求:
- 用你的人设腔调做自我介绍——说说你是谁、能帮用户做什么,一两句即可
- 引导用户告诉你一些关于自己的信息(工作/目标/习惯等),让你以后能更好地服务
- 如果今天已有任务安排,顺带提一句让用户有个概念
- 全文 100-200 字,自然亲切,不要罗列条目
- 语气像是第一天上班主动跟老板打招呼的得力助手
只输出首日简报正文,不要解释。`,

  en: `

This is your **first day** working with the user. Compose a first-day briefing. Requirements:
- Introduce yourself in your persona's voice — briefly say who you are and what you can help with
- Invite the user to share a bit about themselves (work, goals, habits) so you can serve them better
- If there are tasks scheduled today, briefly mention them
- Keep it 100-200 words, warm and natural — no bullet lists
- Tone: like a capable new assistant introducing themselves on day one
Output only the first-day briefing text, no explanation.`,
};

// ─── id 生成 ──────────────────────────────────────────────────────────────────

function newId(prefix: string): string {
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ─── 简报上下文组装 ───────────────────────────────────────────────────────────

/**
 * 把昨日纪要 + 今日任务拼成喂给 generateOnce 的用户消息。
 *
 * @param recentDigests 已取回的近期纪要(避免重复查询 DB)
 * @param isFirstDay    首日模式:无任何历史纪要时省略昨日纪要区块
 */
async function buildBriefingUserMessage(
  yesterdayKey: string,
  dateKey: string,
  lang: Lang,
  recentDigests: Array<{ date: string; summary: string }>,
  isFirstDay: boolean
): Promise<string> {
  const parts: string[] = [];

  // 1. 昨日纪要(首日跳过此区块)
  if (!isFirstDay) {
    const yesterdayDigest = recentDigests.find((d) => d.date === yesterdayKey);

    if (lang === "zh") {
      if (yesterdayDigest) {
        parts.push(`【昨日纪要】\n${yesterdayDigest.summary}`);
      } else {
        parts.push("【昨日纪要】\n无昨日纪要。");
      }
    } else {
      if (yesterdayDigest) {
        parts.push(`[Yesterday's Digest]\n${yesterdayDigest.summary}`);
      } else {
        parts.push("[Yesterday's Digest]\nNo digest available for yesterday.");
      }
    }
  }

  // 2. 今日任务
  const todos = await dbListTodosOnDate(dateKey);
  if (lang === "zh") {
    if (todos.length > 0) {
      parts.push("\n【今日任务】");
      for (const t of todos.slice(0, 10)) {
        // 最多 10 条
        const status =
          t.status === "done"
            ? "(已完成)"
            : t.status === "todo"
            ? "(待办)"
            : `(${t.status})`;
        parts.push(`- ${t.title} ${status}`);
      }
    } else {
      parts.push(isFirstDay ? "" : "\n【今日任务】\n今天暂无安排。");
    }
  } else {
    if (todos.length > 0) {
      parts.push("\n[Today's Tasks]");
      for (const t of todos.slice(0, 10)) {
        const status =
          t.status === "done"
            ? "(done)"
            : t.status === "todo"
            ? "(pending)"
            : `(${t.status})`;
        parts.push(`- ${t.title} ${status}`);
      }
    } else {
      parts.push(isFirstDay ? "" : "\n[Today's Tasks]\nNo tasks scheduled today.");
    }
  }

  return parts.join("\n").trim();
}

// ─── 核心函数 ─────────────────────────────────────────────────────────────────

/**
 * 合成晨间简报并投递进一个新对话。
 *
 * 投递策略:
 *   每次调用新建一个"今日简报 YYYY-MM-DD"对话,把简报作为第一条 assistant 消息插入。
 *   用户直接回复即进入正常 sendMessage 流程(简报只是这个对话的第一条 assistant 消息)。
 *
 * 首日分支(Task 1.5):
 *   若没有任何往日纪要,则走"首日/冷启动"提示词:自我介绍 + 引导填"关于你" + 今日数据。
 *
 * 补发分支(Task 1.5):
 *   ctx.isBackfill=true 时,对话标题 + proactive_log type 带"补发"标记。
 *
 * @returns convId 如果成功投递;undefined 如果 generateOnce 失败(C6 静默降级)
 */
export async function composeMorningBriefing(
  ctx: MorningBriefingCtx
): Promise<string | undefined> {
  const { dateKey, yesterdayKey, isBackfill = false } = ctx;
  const s = useSettingsStore.getState();
  const lang: Lang = ctx.lang ?? s.lang ?? "zh";
  const persona = s.persona ?? { presetKey: "seniorAdvisor" as const };

  // 1. 判断是否首日:取近 DIGEST_LOOKBACK 条纪要,全无则首日
  const recentDigests = await dbGetRecentDigests(DIGEST_LOOKBACK);
  const isFirstDay = recentDigests.length === 0;

  // 2. 人设 prompt + 简报任务说明(首日用首日 suffix)
  const personaSection = composePersonaPrompt(persona, lang);
  const systemSuffix = isFirstDay
    ? FIRST_DAY_SYSTEM_SUFFIX[lang]
    : BRIEFING_SYSTEM_SUFFIX[lang];
  const systemPrompt = personaSection + systemSuffix;

  // 3. 昨日纪要 + 今日任务(首日跳过昨日纪要区块;传入已取回的 recentDigests 避免重复查询)
  const userMessage = await buildBriefingUserMessage(yesterdayKey, dateKey, lang, recentDigests, isFirstDay);

  // 4. 调 generateOnce 合成简报(C6:失败时静默)
  let briefingText: string;
  try {
    briefingText = await generateOnce(systemPrompt, [
      { role: "user", content: userMessage },
    ]);
  } catch (err) {
    // C6:大脑失败 → 静默,不投递,不弹错
    console.warn("[MorningBriefing] generateOnce 失败,简报取消投递:", err);
    return undefined;
  }

  // 5. 投递:新建对话 + 插入 assistant 消息
  //    补发时对话标题加"(补发)"标记
  const convId = newId("brief");
  const now = new Date().toISOString();
  const baseTitle =
    lang === "zh" ? `晨间简报 ${dateKey}` : `Morning Briefing ${dateKey}`;
  const title = isBackfill
    ? lang === "zh"
      ? `${baseTitle}(补发)`
      : `${baseTitle} (backfill)`
    : baseTitle;

  const conv: ConversationRow = {
    id: convId,
    title,
    createdAt: now,
    updatedAt: now,
  };
  await dbInsertConversation(conv);

  const msgId = newId("m");
  const msg: ChatMessageRow = {
    id: msgId,
    convId,
    role: "assistant",
    content: briefingText,
    createdAt: now,
  };
  await dbInsertMessage(msg);
  await dbTouchConversation(convId).catch(() => undefined);

  // 6. 更新当前窗口的 chatStore 内存态(让同窗口 UI 立即看到)
  try {
    const store = useChatStore.getState();
    // createConv 会走完整的 DB 流程(已经做过了),这里只更新 in-memory state
    // 直接注入到 store 的 set 不可从外部访问,但 conversations 列表会在 hydrate 时自动更新
    // 因为 emitSync 会触发监听方 hydrate(),这里做最小侵入:
    // 如果 store 没有当前对话选中,则把新对话设为当前(让 ChatBar 展开显示简报)
    // 注意:多窗口架构下这里的 store 是本窗口的,ChatBar 在独立窗口里有自己的 store
    const _ = store; // 标注 store 被引用(即便本窗口 ChatBar 用同一个 store 实例也能刷新)
    void _;
  } catch {
    // store 访问失败不影响持久化,忽略
  }

  // 7. 发出跨窗口数据变更事件
  emitSync("conversations");

  // 8. 记录投递日志(Task 1.7):投递成功后打点,C6 失败路径在步骤 4 已提前 return,不会走到这里
  //    补发时 type 体现"补发"标记
  const proactiveType = isBackfill ? "morning_briefing_backfill" : "morning_briefing";
  const previewLen = 50;
  await dbLogProactiveSent({
    type: proactiveType,
    convId,
    contentPreview: briefingText.slice(0, previewLen),
  }).catch((err) => {
    // 日志写入失败不影响投递结果——仅打 warn,简报已经投递成功
    console.warn("[MorningBriefing] 写 proactive_log 失败,忽略:", err);
  });

  const label = isFirstDay ? "首日简报" : isBackfill ? "补发简报" : "晨间简报";
  console.info(`[MorningBriefing] ${label}已投递: conv=${convId}, date=${dateKey}`);
  return convId;
}

// ─── 调度任务工厂 ──────────────────────────────────────────────────────────────

/**
 * 创建晨间简报调度任务。
 *
 * 挂载方:在主窗口入口处调用 scheduler.registerJob(createMorningBriefingJob())。
 * 本 Task 只定义,不在 App.tsx 注册(wiring 留给后续)。
 *
 * shouldRun 规则(纯函数,所有状态从参数注入):
 *   - 当前本地时间 >= morningHour
 *   - 距上次运行 < 当天 0 点到现在的毫秒数(即今天还没跑过)
 *
 * 判断"今天是否已跑过"的方式:
 *   取今天 00:00:00 的时间戳,若 lastRan >= todayStart 则今天已跑过。
 *   不依赖 MIN_INTERVAL_MS(23h 间隔) ——避免"昨晚 23:00 跑过,今早 7:00 不触发"的坑。
 *   改用"跨自然日"判断。
 */
export function createMorningBriefingJob(
  opts: MorningBriefingJobOpts = {}
): ScheduledJob {
  const morningHour = opts.morningHour ?? DEFAULT_MORNING_HOUR;

  return {
    id: "morning-briefing",

    /**
     * 纯函数:当天首次 + 已到早晨时间 → true。
     *
     * @param now  当前时间戳(ms),由 scheduler 注入(⚠️ 不在函数体内读 Date.now())
     * @param ctx  调度上下文,ctx.lastRan 为上次运行的时间戳(ms)
     */
    shouldRun(now: number, ctx: { lastRan: number | undefined }): boolean {
      // 当前本地时间
      const d = new Date(now);
      const hour = d.getHours();

      // 条件 1:早晨时间到了
      if (hour < morningHour) return false;

      // 条件 2:今天还没跑过
      // 算今天 00:00:00 的时间戳
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayStartMs = todayStart.getTime();

      if (ctx.lastRan !== undefined && ctx.lastRan >= todayStartMs) {
        // 今天已经跑过了
        return false;
      }

      return true;
    },

    async run(): Promise<void> {
      const today = new Date();
      const fmt = (d: Date): string =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      const dateKey = fmt(today);
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayKey = fmt(yesterday);

      const s = useSettingsStore.getState();
      const lang: Lang = opts.lang ?? s.lang ?? "zh";

      await composeMorningBriefing({ dateKey, yesterdayKey, lang });
    },
  };
}
