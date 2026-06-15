/**
 * wiring.ts — AI 秘书运行时挂载 (Task 1.8)
 *
 * 把 Phase 1 的零件接进真实 app:调度器 + 注册任务 + 启动补发。
 * App.tsx 只在「单一 owner 窗口」(工作台主窗 label "main",同 reminder 的挂法)调用本模块,
 * 不在悬浮窗起第二份——避免重复触发。scheduler 内部另有 owner 锁兜底。
 *
 * 本模块职责拆三层(便于单测):
 *   1. 纯/半纯辅助:computeUserActiveToday / buildGateStateProvider / todayDateKeys
 *   2. 编排:runStartupBackfill —— 查 lastSentAt + userActiveToday → backfillOnStartup
 *   3. 副作用挂载:startSecretaryScheduler —— 解析真实 Tauri 窗口 label,创建并启动调度器
 *
 * 设计要点:
 *   - Tauri API 一律动态 import(无 runtime 的 jsdom 单测 / Ladle 安静降级,沿用 windowLayout 范式)。
 *   - 调度器 windowId 用真实 Tauri 窗口 label(取不到时兜底 WIN_MAIN="main",即主窗的真实 label)。
 *   - gate 的 GateState 只能同步取(gate() 是同步纯函数):pausedUntil 从 reminder 设置同步读;
 *     recentlySent / lastProactiveSentMs 留空——同日重复由各任务自己的 shouldRun(当天首次)+
 *     gate 去重窗口 + backfill 的 lastSentAt 三重护栏覆盖,无需异步查 DB。
 */

import { createScheduler, type Scheduler } from "./scheduler";
import { createDailyScanJob } from "./dailyScan";
import { createMorningBriefingJobWithGate } from "./gate";
import type { GateState } from "./gate";
import { backfillOnStartup, type BackfillResult } from "./startupBackfill";
import {
  dbGetLastProactiveSentAt,
  dbListMessagesOnDate,
} from "../db";
import { useSettingsStore } from "../settings";
import type { Lang } from "../settings";
import { WIN_MAIN } from "../windowLayout";

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 晨间简报触发小时(本地 07:00),与 backfill 的 morningHour 对齐 */
const MORNING_HOUR = 7;

/**
 * 主动消息 type 前缀:正常("morning_briefing")与补发("morning_briefing_backfill")共用此前缀,
 * 查"今天是否已发过简报"时用 LIKE 'morning_briefing%' 一并覆盖。
 * 注意:这是 proactive_log 里的 type(下划线),不是 gate candidate.type("morning-briefing",连字符)。
 */
const BRIEFING_TYPE_PREFIX = "morning_briefing";

// ─── 辅助:日期键 ─────────────────────────────────────────────────────────────

/** 把时间戳格式化为本地 YYYY-MM-DD */
function fmtDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** 由"现在"算出今日 / 昨日日期键(本地时区) */
export function todayDateKeys(now: number): { dateKey: string; yesterdayKey: string } {
  return {
    dateKey: fmtDateKey(now),
    yesterdayKey: fmtDateKey(now - 24 * 60 * 60 * 1000),
  };
}

// ─── 辅助:userActiveToday ────────────────────────────────────────────────────

/**
 * 判断用户今天是否已活跃(今天有过 user/assistant 消息记录)。
 * 用 dbListMessagesOnDate(今天) 的 length > 0 判定(口径与 dailyScan / backfill 一致)。
 *
 * 活跃 → 人已经在用 app 了 → 启动补发不该再"叫醒"(见 shouldBackfill 条件 4)。
 *
 * 容错:DB 查询失败时保守返回 true(宁可不补发,也不要在异常时误打扰用户)。
 *
 * @param dateKey 今日日期键 YYYY-MM-DD
 */
export async function computeUserActiveToday(dateKey: string): Promise<boolean> {
  try {
    const messages = await dbListMessagesOnDate(dateKey);
    return messages.length > 0;
  } catch (err) {
    console.warn("[secretary/wiring] computeUserActiveToday 查询失败,保守视为已活跃:", err);
    return true;
  }
}

// ─── gate 状态提供者 ─────────────────────────────────────────────────────────

/**
 * 构造传给 createMorningBriefingJobWithGate 的 gateStateProvider(同步函数)。
 *
 * gate() 是同步纯函数,无法在其中 await DB,因此这里只同步读 reminder 设置:
 *   - pausedUntil:用户点"别烦我"的截止时间戳 → 让闸门据此静默
 *   - recentlySent / lastProactiveSentMs:留空(理由见文件头)
 */
export function buildGateStateProvider(): () => GateState {
  return () => {
    const reminder = useSettingsStore.getState().reminder;
    return {
      recentlySent: [],
      pausedUntil: reminder?.pausedUntil,
      lastProactiveSentMs: undefined,
    };
  };
}

// ─── 注册集合 ────────────────────────────────────────────────────────────────

/**
 * 给定调度器,注册秘书的所有定时任务:
 *   - daily-scan:日终(22:00+)生成当日纪要
 *   - morning-briefing:晨间(07:00+)投递简报(带 gate 防骚扰闸门)
 *
 * 抽成独立函数便于单测断言"注册了哪些 job"。
 *
 * @param scheduler 目标调度器
 * @param lang      纪要 / 简报语言(默认从 settings 读)
 */
export function registerSecretaryJobs(scheduler: Scheduler, lang: Lang): void {
  scheduler.registerJob(createDailyScanJob(lang));
  scheduler.registerJob(
    createMorningBriefingJobWithGate({
      morningHour: MORNING_HOUR,
      lang,
      gateStateProvider: buildGateStateProvider(),
    })
  );
}

// ─── 副作用:启动调度器(单 owner 窗口调用) ──────────────────────────────────

/**
 * 解析当前窗口的真实 Tauri label;无 Tauri runtime(单测 / Ladle)时兜底 WIN_MAIN。
 * 主窗的真实 label 恰为 "main"(= WIN_MAIN),所以兜底值在生产也正确。
 */
async function resolveWindowLabel(): Promise<string> {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    return mod.getCurrentWebviewWindow().label || WIN_MAIN;
  } catch {
    return WIN_MAIN;
  }
}

/**
 * 启动 AI 秘书调度器,返回停止函数(同 reminder 的 startReminderScheduler 范式)。
 *
 * ⚠️ 只在工作台主窗(label "main")挂载——调用方(App.tsx MainWindow)用 windowRole 已经做了单窗口分发;
 *    scheduler 内部还有 localStorage owner 锁兜底,双保险防重复触发。
 *
 * 实现:label 解析是异步的,但本函数同步返回 stop()(契合 React useEffect cleanup)。
 * 在 label 解析完成前就调用 stop(),会置 cancelled 标志,resolve 后不再 start。
 *
 * @returns stop 函数:停止 tick 循环并释放本窗口持有的 owner 锁
 */
export function startSecretaryScheduler(): () => void {
  let scheduler: Scheduler | null = null;
  let cancelled = false;

  void (async () => {
    const windowId = await resolveWindowLabel();
    if (cancelled) return; // 已在解析期间被卸载

    const sched = createScheduler({ windowId });
    const lang: Lang = useSettingsStore.getState().lang ?? "zh";
    registerSecretaryJobs(sched, lang);
    sched.start(); // 内部默认 5s tick,启动时立即跑一次以尽快抢/续锁
    scheduler = sched;
  })();

  return () => {
    cancelled = true;
    scheduler?.stop();
    scheduler = null;
  };
}

// ─── 副作用:启动补发(单 owner 窗口调用) ────────────────────────────────────

/**
 * 启动时按需补发当日晨间简报(同 reminder 一样只在主窗调一次)。
 *
 * 编排:
 *   1. 算今日 / 昨日日期键
 *   2. 查"今天用户是否已活跃"(dbListMessagesOnDate 今天 length>0)
 *   3. 查"最近一次简报发送时间"(LIKE morning_briefing%,正常+补发都算)作为 lastSentAt
 *   4. 交给 backfillOnStartup 决策并(如该补)投递
 *
 * 全程不抛:任何异常都吞掉并返回 didBackfill=false,绝不影响 app 启动。
 *
 * @param now 当前时间戳(默认 Date.now();测试可注入)
 */
export async function runStartupBackfill(now: number = Date.now()): Promise<BackfillResult> {
  try {
    const { dateKey, yesterdayKey } = todayDateKeys(now);
    const lang: Lang = useSettingsStore.getState().lang ?? "zh";

    const [userActiveToday, lastSentAt] = await Promise.all([
      computeUserActiveToday(dateKey),
      dbGetLastProactiveSentAt(BRIEFING_TYPE_PREFIX),
    ]);

    return await backfillOnStartup({
      now,
      dateKey,
      yesterdayKey,
      lang,
      lastSentAt,
      userActiveToday,
      morningHour: MORNING_HOUR,
    });
  } catch (err) {
    console.warn("[secretary/wiring] runStartupBackfill 异常,跳过补发:", err);
    return { didBackfill: false };
  }
}
