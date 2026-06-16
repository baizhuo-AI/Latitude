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

import { createScheduler, type Scheduler, type ScheduledJob } from "./scheduler";
import { createDailyScanJob } from "./dailyScan";
import { createMorningBriefingJobWithGate } from "./gate";
import type { GateState } from "./gate";
import { backfillOnStartup, type BackfillResult } from "./startupBackfill";
import {
  dbGetLastProactiveSentAt,
  dbListMessagesOnDate,
  dbListTodos,
  dbListCalendarEvents,
  type CalendarEvent,
} from "../db";
import { useSettingsStore, readSettingsSnapshot } from "../settings";
import type { Lang } from "../settings";
import { WIN_MAIN } from "../windowLayout";
import {
  collectCandidates,
  shouldHeartbeat,
  type ProactiveCandidate,
  type HeartbeatConfig,
  type TriggerSnapshot,
  type ActivityCaptureRunConfig,
} from "./triggers";
import { computeLoad, type LoadAssessment, type LoadSignals } from "./loadSignals";
import {
  gateProactive,
  defaultGateOptions,
  type GateEnv,
  type GateOptions,
} from "./gateProactive";
import { loadGateState } from "./gateState";
import { deliverProactive } from "./deliverProactive";
import {
  resolveProactiveStance,
  type ProactiveEvents,
  type ProactiveStance,
} from "./proactiveConfig";
import type { Todo } from "../store";

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
 *   - proactive-heartbeat:工作时段内按心跳间隔跑一轮主动巡检(Task 3.7,见下)
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
  // Task 3.7:主动引擎心跳——触发→负荷→闸门→合成→投递→打点,只在 owner 窗口跑
  scheduler.registerJob(createProactiveHeartbeatJob());
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

    const pausedUntil = useSettingsStore.getState().reminder?.pausedUntil;

    return await backfillOnStartup({
      now,
      dateKey,
      yesterdayKey,
      lang,
      lastSentAt,
      userActiveToday,
      morningHour: MORNING_HOUR,
      pausedUntil,
    });
  } catch (err) {
    console.warn("[secretary/wiring] runStartupBackfill 异常,跳过补发:", err);
    return { didBackfill: false };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Task 3.7:主动引擎接线 —— 触发→负荷→闸门→合成→投递→打点 的 owner 编排 + 心跳 job
// ════════════════════════════════════════════════════════════════════════════
//
// 全链路只在【单一 owner 窗口】跑(同 reminder / daily-scan;scheduler owner 锁兜底)。
// 真相源:配置走 readSettingsSnapshot(直读 localStorage,跨窗口安全),数据直读 DB,
//        GateState 由 loadGateState 从 proactive_log 派生(跨重启)。
// 纯函数边界:filterCandidatesByEvents / applyLoadToGateOptions / buildHeartbeatConfig /
//            computeInMeeting / buildLoadSignals / buildGateEnv 全是 f(输入[, now]) 纯函数
//            (体内不读 Date.now()/Math.random()),时间从参数注入,便于确定性单测(铁律2)。

/**
 * 候选 kind ↔ proactive.events 开关键 的映射(过滤被关掉的类)。
 *
 * 只映射"受 ProactiveEvents 开关控制"的类型。
 * 没有对应开关的类型(如 activity_capture,有自己独立的 activityCapture.enabled 开关)
 * 不在此 map 里——filterCandidatesByEvents 对未出现的 kind 直接放行。
 */
const KIND_TO_EVENT_KEY: Partial<Record<ProactiveCandidate["kind"], keyof ProactiveEvents>> = {
  meeting_soon: "meetingSoon",
  deadline_near: "deadlineNear",
  task_stuck: "taskStuck",
  just_completed: "justCompleted",
  // activity_capture 有独立开关(proactive.activityCapture.enabled),不受 events 四开关控制
};

/**
 * 纯函数:按事件开关过滤候选——某 kind 对应开关关闭则整类滤掉。
 * 没有对应 events 开关的 kind(如 activity_capture)直接放行。
 * 不原地改入参(返回新数组)。
 *
 * @param candidates 触发层候选
 * @param events     四类事件开关(来自 stance.events)
 */
export function filterCandidatesByEvents(
  candidates: ProactiveCandidate[],
  events: ProactiveEvents
): ProactiveCandidate[] {
  return candidates.filter((c) => {
    const key = KIND_TO_EVENT_KEY[c.kind];
    if (key === undefined) return true; // 无对应 events 开关 → 放行
    return events[key];
  });
}

/**
 * 纯函数:把 3.3 负荷评估的 delta 套到完整闸门 opts 上。
 *
 *   - priorityFloor += priorityFloorDelta(夹紧到 >= 0:地板不为负)
 *   - budgetPerHalfDay += budgetDelta(夹紧到 >= 1:至少留 1 条额度,否则等于变相 off)
 *
 * 其余字段透传。不原地改入参 base(返回新对象)。
 *
 * @param base       基准 opts(通常来自 stance:priorityFloor / budgetPerHalfDay 已按档位定好)
 * @param assessment 负荷评估(computeLoad 产物)
 */
export function applyLoadToGateOptions(
  base: GateOptions,
  assessment: LoadAssessment
): GateOptions {
  return {
    ...base,
    priorityFloor: Math.max(0, base.priorityFloor + assessment.priorityFloorDelta),
    budgetPerHalfDay: Math.max(1, base.budgetPerHalfDay + assessment.budgetDelta),
  };
}

/** 心跳配置从真相源(reminder 工作时段 + proactive 心跳间隔)组装 */
function buildHeartbeatConfig(stance: ProactiveStance): HeartbeatConfig {
  const reminder = readSettingsSnapshot().reminder;
  return {
    workStart: reminder?.workStart ?? 9,
    workEnd: reminder?.workEnd ?? 22,
    intervalMs: stance.heartbeatMin * 60 * 1000,
  };
}

/**
 * 纯函数:now 时刻是否有定时事件正在进行(startTs <= now < endTs)。
 * 用于完整闸门「会议中静默」。cancelled / 全天(无 startTs)/ 无 endTs 不计。
 *
 * @param events 日历事件(直读 DB 的快照)
 * @param now    当前时刻(注入)
 */
export function computeInMeeting(events: CalendarEvent[], now: Date): boolean {
  const nowMs = now.getTime();
  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    if (ev.startTs === undefined || ev.endTs === undefined) continue;
    if (ev.startTs * 1000 <= nowMs && nowMs < ev.endTs * 1000) return true;
  }
  return false;
}

/** 本地日期键 YYYY-MM-DD(与 triggers / loadSignals 口径一致) */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/**
 * 纯函数:从 DB 快照(全部 todo + 全部 event)派生 3.3 负荷信号。
 *
 *   - meetingCount:今天(scheduledDate===今天)非全天、未取消的事件数(日程密度)
 *   - scheduledTodoCount / completedTodoCount:今天排程任务的总数 / 已完成数
 *   - procrastinatedCount:标 isProcrastinated 的未完成任务数(推迟/积压代理信号)
 *
 * @param todos      全部 todo(dbListTodos)
 * @param events     全部 event(dbListCalendarEvents)
 * @param now        当前时刻(注入,算今天日期键)
 * @param workStart  工作时段起(给 LoadSignals 透传;computeLoad 用 workEnd 判加班)
 * @param workEnd    工作时段止
 */
export function buildLoadSignals(
  todos: Todo[],
  events: CalendarEvent[],
  now: Date,
  workStart: number,
  workEnd: number
): LoadSignals {
  const todayKey = localDateKey(now);

  let meetingCount = 0;
  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    if (ev.isAllDay) continue;
    if (ev.scheduledDate === todayKey) meetingCount += 1;
  }

  let scheduledTodoCount = 0;
  let completedTodoCount = 0;
  let procrastinatedCount = 0;
  for (const t of todos) {
    if (t.scheduledDate === todayKey) {
      scheduledTodoCount += 1;
      if (t.status === "done") completedTodoCount += 1;
    }
    if (t.isProcrastinated && t.status !== "done" && t.status !== "dropped") {
      procrastinatedCount += 1;
    }
  }

  return {
    workStart,
    workEnd,
    meetingCount,
    scheduledTodoCount,
    completedTodoCount,
    procrastinatedCount,
  };
}

/** 组装完整闸门 env(工作时段 + now 时刻是否在会 / 专注) */
function buildGateEnv(
  workStart: number,
  workEnd: number,
  inMeeting: boolean,
  inFocus: boolean
): GateEnv {
  return { workStart, workEnd, inMeeting, inFocus };
}

/**
 * 跑一轮主动巡检(owner 窗口在心跳到点时调)。串起整条主动链路:
 *
 *   1. 读姿态(readSettingsSnapshot().proactive → resolveProactiveStance):
 *      stance.enabled=false(off 档)→ 整轮不跑,直接返回(省 DB)。
 *   2. 直读 DB 真相源:全部 todo + 全部 calendar_events(打包成触发快照)。
 *   3. 触发(3.1):collectCandidates 产候选(纯,now 注入)。
 *   4. 事件开关过滤(filterCandidatesByEvents):用户关掉的类整类丢弃。
 *   5. 负荷(3.3):buildLoadSignals + computeLoad → 评估档 + delta + tonePhrase。
 *   6. 闸门(3.2,带持久化):loadGateState(从 proactive_log 派生,跨重启)+
 *      applyLoadToGateOptions(套负荷 delta) + computeInMeeting/buildGateEnv → gateProactive。
 *      gateProactive 至多放行一条(温和:绝不一次糊一脸)。
 *   7. 投递(3.4):deliverProactive(放行候选, { channel: stance.channel, tonePhrase })。
 *      合成→按渠道投递(聊天必走 + 通知/弹窗可选)→打点 proactive_log(打点在 deliver 内置)。
 *
 * 全程不抛:任何异常吞掉并静默跳过本轮(绝不影响 app / 调度循环)。pausedUntil(别烦我)、
 * 工作时段、负荷、预算、冷却、去重全在 gateProactive 里把关——本函数只负责取数据 + 串链路。
 *
 * @param now 当前时刻(ms,注入;由 createProactiveHeartbeatJob.run 传 Date.now(),测试可注入)
 */
export async function runProactiveHeartbeat(now: number = Date.now()): Promise<void> {
  try {
    const nowDate = new Date(now);
    const snapshot = readSettingsSnapshot();
    const stance = resolveProactiveStance(snapshot.proactive);

    // 1. 总闸:off → 不跑(连 DB 都不查)
    if (!stance.enabled) return;

    const lang: Lang = snapshot.lang ?? "zh";
    const workStart = snapshot.reminder?.workStart ?? 9;
    const workEnd = snapshot.reminder?.workEnd ?? 22;

    // 2. 直读 DB 真相源(并行)
    const [todos, events] = await Promise.all([dbListTodos(), dbListCalendarEvents()]);

    // 3. 触发:产候选
    const triggerSnapshot: TriggerSnapshot = { todos, events };
    // M2:activity_capture 接入 collectCandidates;activityCaptureCfg 从真相源组装后传入
    const activityCaptureCfg: ActivityCaptureRunConfig | undefined =
      snapshot.proactive?.activityCapture?.enabled
        ? {
            enabled: true,
            intervalMin:
              snapshot.proactive.activityCapture.intervalMin ?? 120,
            workStart,
            workEnd,
            pausedUntil: snapshot.reminder?.pausedUntil,
            activityCaptureMode:
              snapshot.proactive.activityCapture.activityCaptureMode ?? "gentle",
          }
        : undefined;
    // lastActivityFiredMs:M3 投递层完成前暂无持久化真相源,保守传 0(间隔未到则不产候选)
    // M3 接入后改为从 proactive_log 派生(同 loadGateState 读法)
    const candidates = collectCandidates(triggerSnapshot, nowDate, lang, activityCaptureCfg, 0);

    // 4. 事件开关过滤
    const filtered = filterCandidatesByEvents(candidates, stance.events);
    if (filtered.length === 0) return; // 无候选 → 省去后续 DB/闸门开销

    // 5. 负荷评估
    const signals = buildLoadSignals(todos, events, nowDate, workStart, workEnd);
    const load = computeLoad(signals, nowDate, lang);

    // 6. 闸门(带持久化 GateState + 负荷 delta + 环境事实)
    const gateState = await loadGateState(snapshot.reminder?.pausedUntil, nowDate);
    const baseOpts: GateOptions = {
      ...defaultGateOptions(),
      priorityFloor: stance.priorityFloor,
      budgetPerHalfDay: stance.budgetPerHalfDay,
    };
    // M2:activity_capture 冷却跟随用户配置的 intervalMin(不硬编码 120min 默认)
    if (snapshot.proactive?.activityCapture?.intervalMin !== undefined) {
      baseOpts.cooldownByKind = {
        ...baseOpts.cooldownByKind,
        activity_capture:
          snapshot.proactive.activityCapture.intervalMin * 60 * 1000,
      };
    }
    const opts = applyLoadToGateOptions(baseOpts, load);
    const inMeeting = computeInMeeting(events, nowDate);
    // inFocus 暂无真相源信号(专注态未接入),保守 false——懂状态安全版:信号稀疏不臆断
    const env = buildGateEnv(workStart, workEnd, inMeeting, false);

    const decision = gateProactive(filtered, gateState, env, nowDate, opts);
    if (decision.sent.length === 0) return; // 闸门全拒 → 本轮不投

    // 7. 投递(放行候选;deliver 内置合成 + 打点)
    const chosen = decision.sent[0];
    await deliverProactive(chosen, {
      lang,
      channel: stance.channel,
      tonePhrase: load.tonePhrase,
    });
  } catch (err) {
    console.warn("[secretary/wiring] runProactiveHeartbeat 异常,跳过本轮巡检:", err);
  }
}

/**
 * 创建主动引擎「心跳巡检」调度任务(Task 3.7)。
 *
 * shouldRun:用 triggers.shouldHeartbeat(纯,时间注入)——工作时段内 + 距上次 >= 心跳间隔。
 *   心跳间隔从真相源 proactive.heartbeatMin 读(用户在设置里可调)。
 *   工作时段从 reminder.workStart/workEnd 读(唯一真相源,不另造)。
 *   ctx.lastRan(scheduler 持久化的上次运行时刻)即「上次心跳」。
 *
 * run:调 runProactiveHeartbeat(Date.now()) 跑完整链路(off 档由 run 内部短路)。
 *
 * ⚠️ off 档不在 shouldRun 拦——shouldRun 仍按心跳节拍返回 true,但 run 进 runProactiveHeartbeat
 *    后第一步就因 stance.enabled=false 返回,不产生任何投递。这样用户从 off 切回 gentle/active
 *    时无需重启调度器即可恢复(配置走真相源,run 时实时读)。
 */
export function createProactiveHeartbeatJob(): ScheduledJob {
  return {
    id: "proactive-heartbeat",

    shouldRun(now: number, ctx: { lastRan: number | undefined }): boolean {
      const stance = resolveProactiveStance(readSettingsSnapshot().proactive);
      const cfg = buildHeartbeatConfig(stance);
      return shouldHeartbeat(cfg, ctx.lastRan, new Date(now));
    },

    async run(): Promise<void> {
      await runProactiveHeartbeat(Date.now());
    },
  };
}
