/**
 * triggers.ts — AI 秘书主动消息「触发层」(Task 3.1)
 *
 * 职责:从当前数据快照(todos + calendar_events)里检出「值得主动说一句」的时机,
 *      产出主动消息「候选」(ProactiveCandidate)。
 *
 * ⚠️ 本层只产候选,绝不投递、绝不接调度:
 *   - 不调 generateOnce / composeProactive
 *   - 不过 gate、不打 proactive_log
 *   - 不注册 scheduler job
 *   投递与接线在 Task 3.7;闸门在 gate.ts(3.x);本层是它们的上游纯数据源。
 *
 * ─── 设计铁律(与 gate.ts / scheduler.ts / dailyScan.ts 一致) ───────────────
 *   1. 所有判定一律纯函数 f(输入, now):函数体内绝不读 Date.now() / Math.random(),
 *      「现在」一律从参数 now(Date)注入。这是 R1 防骚扰可证明、R3 弱模型地板
 *      可测的关键——给定输入 + now,输出完全确定。
 *   2. 无副作用:不读 DB、不读 store、不写 storage。数据由调用方(3.7 的 owner 窗口)
 *      先从真相源(直读 DB)取好,打包成 TriggerSnapshot 传进来。
 *   3. 所有窗口/阈值是导出常量,测试精确引用边界。
 *
 * ─── 触发源 ────────────────────────────────────────────────────────────────
 *   A. 心跳(shouldHeartbeat):工作时段内,每隔可配间隔产一次「巡检」节拍。
 *      心跳本身不直接是候选——它是 3.7 用来「该不该跑一轮巡检」的节拍判定。
 *   B. 事件触发(四个 detectXxx 纯函数):
 *      - detectMeetingSoon   会议将至(calendar_events,startTs)
 *      - detectDeadlineNear  ddl 临近(todos 的 scheduledDate + scheduledTime)
 *      - detectStuckTask     任务卡很久(createdAt 老 + 未完成)
 *      - detectJustCompleted 刚完成(completedAt 在最近窗口)
 *   C. collectCandidates:把所有事件触发源跑一遍,合并 + 按优先级降序稳定排序。
 *
 * ─── 关于 deadline 字段为何不解析 ──────────────────────────────────────────
 *   Todo.deadline 是自由文本(如 "周五下午" / "今天 14:00"),不可靠解析。
 *   "ddl 临近" 的时间判定改用结构化的 scheduledDate + scheduledTime
 *   (scheduledTime 格式契约见 calendar.ts 的 parseScheduledTime:"HH:MM-HH:MM")。
 *   没有可解析时段的任务,本层不臆断其临近度,直接跳过(信号稀疏返回"未知")。
 */

import type { Todo } from "../store";
import type { CalendarEvent } from "../db";
import type { Lang } from "../settings";
import type { ActivityCaptureMode } from "./proactiveConfig";
import { parseScheduledTime } from "../calendar";

// ─── 导出常量:窗口/阈值(测试引用这些做边界断言) ──────────────────────────

/** 会议将至窗口:会议在 now 之后这段时间内开始才提醒 (30min) */
export const MEETING_SOON_WINDOW_MS = 30 * 60 * 1000;

/** "很临近"细分阈值:会议距开始 <= 此值视为更紧迫,优先级更高 (10min) */
export const MEETING_VERY_SOON_MS = 10 * 60 * 1000;

/** ddl 临近窗口:今天排程的任务、开始时间在 now 之后这段时间内 (60min) */
export const DEADLINE_NEAR_WINDOW_MS = 60 * 60 * 1000;

/** 任务卡住阈值:创建超过这个时长仍未完成视为"卡很久" (3 天) */
export const STUCK_TASK_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** 刚完成窗口:completedAt 落在 now 之前这段时间内视为"刚完成" (10min) */
export const JUST_COMPLETED_WINDOW_MS = 10 * 60 * 1000;

// ─── 优先级基准(数值越大越紧迫;collectCandidates 按此降序排) ──────────────
//   不同触发源给一个基准 + 临近度微调,保证排序有确定的语义层级。

/** 会议将至:很紧迫(临近度再加成) */
const PRIORITY_MEETING_BASE = 80;
const PRIORITY_MEETING_VERY_SOON_BONUS = 15;
/** ddl 临近:紧迫 */
const PRIORITY_DEADLINE = 70;
/** 任务卡住:中(背景提醒,不抢眼) */
const PRIORITY_STUCK = 40;
/** 刚完成:低(正反馈,可有可无) */
const PRIORITY_JUST_COMPLETED = 30;
/**
 * 活动捕获:中等(65)——高于"任务搁置"(40)和"刚完成"(30),低于"会议将至"(80+)和"ddl 临近"(70)。
 * gentle 姿态地板 50:activity_capture 在 gentle 下默认可过线(65 > 50);
 * 这避免了它在温和模式下被直接挡住(因为用户开启活动捕获是主动选择,应该能看到)。
 * M2 gate 里"随克制"模式可在候选 type 层额外调制,本层只定优先级基准。
 */
export const ACTIVITY_CAPTURE_PRIORITY = 65;

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** 主动消息候选的类型枚举 */
export type CandidateKind =
  | "meeting_soon"
  | "deadline_near"
  | "task_stuck"
  | "just_completed"
  | "activity_capture";

/**
 * 一条主动消息候选。
 * 这是触发层产物,交给下游(3.7)去过 gate、合成、投递。
 *
 * - kind:候选类型,下游据此选措辞模板 / 去重。
 * - priority:紧迫度数值(越大越紧迫),collectCandidates 按此降序排。
 * - refId:触发源实体 id(todo.id / event.id),下游去重 + 跳转用。
 * - title:已按 lang 渲染好的一句话摘要(给日志/调试/简报草稿用)。
 * - payload:结构化补充信息(分钟数、标题等),下游合成措辞时取用,可选。
 */
export interface ProactiveCandidate {
  kind: CandidateKind;
  priority: number;
  refId: string;
  title: string;
  payload?: Record<string, unknown>;
}

/**
 * 触发层输入快照。
 * 由调用方(3.7 owner 窗口)从真相源(直读 DB)取好后打包传入。
 * 本层不读 DB / store,纯函数只认这个快照 + now。
 */
export interface TriggerSnapshot {
  todos: Todo[];
  events: CalendarEvent[];
}

/** 心跳配置(由调用方从 settings 真相源读 reminder.workStart/workEnd + 间隔后传入) */
export interface HeartbeatConfig {
  /** 工作时段起始小时 (0-23) */
  workStart: number;
  /** 工作时段结束小时 (0-23),开区间 [workStart, workEnd) */
  workEnd: number;
  /** 心跳最小间隔 (ms) */
  intervalMs: number;
}

// ─── i18n 文案(内嵌 Record,与 dailyScan/composeProactive 同风格) ────────────
//   触发层产的 title 是给日志/草稿用的简短摘要,不是最终用户措辞;
//   最终措辞由下游合成层(带人设)生成。这里只做确定性的事实性渲染。

interface TitleParams {
  title: string;
  minutes?: number;
}

const RENDER: Record<CandidateKind, Record<Lang, (p: TitleParams) => string>> = {
  meeting_soon: {
    zh: (p) => `会议将至:${p.title}(约 ${p.minutes} 分钟后开始)`,
    en: (p) => `Meeting soon: ${p.title} (in about ${p.minutes} min)`,
  },
  deadline_near: {
    zh: (p) => `任务临近:${p.title}(约 ${p.minutes} 分钟后到点)`,
    en: (p) => `Task due soon: ${p.title} (in about ${p.minutes} min)`,
  },
  task_stuck: {
    zh: (p) => `任务搁置较久:${p.title}`,
    en: (p) => `Task stalled: ${p.title}`,
  },
  just_completed: {
    zh: (p) => `刚完成:${p.title}`,
    en: (p) => `Just completed: ${p.title}`,
  },
  activity_capture: {
    zh: (_p) => "活动记录:过去这段时间在忙什么?",
    en: (_p) => "Activity capture: what have you been working on?",
  },
};

function renderTitle(kind: CandidateKind, lang: Lang, p: TitleParams): string {
  return RENDER[kind][lang](p);
}

// ─── A. 心跳节拍判定(纯函数) ──────────────────────────────────────────────────

/**
 * 此刻是否应该跑一轮主动巡检。
 *
 * 规则:
 *   1. 必须在工作时段内 [workStart, workEnd)(结束小时为开区间,与 gate 一致)
 *   2. 从未跑过(lastBeatMs undefined)→ 跑
 *   3. 距上次 >= intervalMs → 跑(严格 >=,边界即触发)
 *
 * ⚠️ 函数体内不读 Date.now():now / lastBeatMs 均由调用方注入。
 *
 * @param cfg        心跳配置(工作时段 + 间隔)
 * @param lastBeatMs 上次心跳时间戳(ms),从未跑过为 undefined
 * @param now        当前时刻(注入)
 */
export function shouldHeartbeat(
  cfg: HeartbeatConfig,
  lastBeatMs: number | undefined,
  now: Date
): boolean {
  const hour = now.getHours();
  // 1. 工作时段外不跑
  if (hour < cfg.workStart || hour >= cfg.workEnd) return false;
  // 2. 从未跑过 → 跑
  if (lastBeatMs === undefined) return true;
  // 3. 距上次是否到间隔(>= 即触发)
  return now.getTime() - lastBeatMs >= cfg.intervalMs;
}

// ─── B. 事件触发纯函数 ─────────────────────────────────────────────────────────

/**
 * 会议将至:confirmed 的定时事件,startTs 落在 (now, now + 窗口] 内。
 *
 * 时间口径:CalendarEvent.startTs 是 Unix 秒(UTC),这里换算成 ms 与 now 比较。
 * 跳过:cancelled、全天(无 startTs)、已开始/过去、超出窗口。
 * 临近度:距开始 <= MEETING_VERY_SOON_MS 时优先级加成(更抢眼)。
 */
export function detectMeetingSoon(
  events: CalendarEvent[],
  now: Date
): ProactiveCandidate[] {
  const nowMs = now.getTime();
  const out: ProactiveCandidate[] = [];

  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    if (ev.startTs === undefined) continue; // 全天/无定时 → 跳过

    const startMs = ev.startTs * 1000;
    const deltaMs = startMs - nowMs;

    // 必须是未来(已开始/过去不算"将至"),且在窗口内(含边界)
    if (deltaMs <= 0 || deltaMs > MEETING_SOON_WINDOW_MS) continue;

    const minutesUntil = Math.round(deltaMs / 60000);
    const veryClose = deltaMs <= MEETING_VERY_SOON_MS;
    const priority =
      PRIORITY_MEETING_BASE + (veryClose ? PRIORITY_MEETING_VERY_SOON_BONUS : 0);

    out.push({
      kind: "meeting_soon",
      priority,
      refId: ev.id,
      title: "", // 由 finalize 阶段按 lang 渲染
      payload: { eventTitle: ev.title, minutesUntil, startMs },
    });
  }

  return out;
}

/**
 * ddl 临近:今天排程的待办/进行中任务,且 scheduledTime 的开始时刻落在
 * (now, now + 窗口] 内。
 *
 * 为什么不解析 deadline 字段:见文件头说明(自由文本,不可靠)。
 * 跳过:done/dropped、非今天、无可解析 scheduledTime、已过开始时刻、超窗口。
 */
export function detectDeadlineNear(
  todos: Todo[],
  now: Date
): ProactiveCandidate[] {
  const nowMs = now.getTime();
  const todayKey = localDateKey(now);
  const out: ProactiveCandidate[] = [];

  for (const t of todos) {
    if (t.status === "done" || t.status === "dropped") continue;
    if (t.scheduledDate !== todayKey) continue;

    const range = parseScheduledTime(t.scheduledTime);
    if (!range) continue; // 无可解析时段 → 跳过(不臆断)

    // 把今天 + startMin 折算成本地时刻
    const startMs = startOfLocalDay(now).getTime() + range.startMin * 60000;
    const deltaMs = startMs - nowMs;

    if (deltaMs <= 0 || deltaMs > DEADLINE_NEAR_WINDOW_MS) continue;

    const minutesUntil = Math.round(deltaMs / 60000);
    out.push({
      kind: "deadline_near",
      priority: PRIORITY_DEADLINE,
      refId: t.id,
      title: "",
      payload: { todoTitle: t.title, minutesUntil, startMs },
    });
  }

  return out;
}

/**
 * 任务卡很久:createdAt 早于 (now - 阈值) 且仍未完成(todo / doing)。
 *
 * 用 createdAt 作为"年龄"基准(任务在库里躺了多久还没收尾)。
 * 跳过:已完成/已丢弃、年龄未到阈值。
 * 边界:年龄严格 > 阈值 才算(== 阈值不算,与测试 ±1s 边界一致)。
 */
export function detectStuckTask(
  todos: Todo[],
  now: Date
): ProactiveCandidate[] {
  const nowMs = now.getTime();
  const out: ProactiveCandidate[] = [];

  for (const t of todos) {
    if (t.status === "done" || t.status === "dropped") continue;

    const createdMs = Date.parse(t.createdAt);
    if (Number.isNaN(createdMs)) continue; // 脏数据跳过

    const ageMs = nowMs - createdMs;
    if (ageMs <= STUCK_TASK_AGE_MS) continue; // 严格大于才算

    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    out.push({
      kind: "task_stuck",
      priority: PRIORITY_STUCK,
      refId: t.id,
      title: "",
      payload: { todoTitle: t.title, ageDays, createdMs },
    });
  }

  return out;
}

/**
 * 刚完成:status=done 且 completedAt 落在 [now - 窗口, now] 内。
 *
 * 跳过:未完成、无 completedAt(数据不全不臆断)、超窗口、未来时间(时钟漂移)。
 * 用途:给一句正反馈 / 顺势问下一步——下游决定要不要发。
 */
export function detectJustCompleted(
  todos: Todo[],
  now: Date
): ProactiveCandidate[] {
  const nowMs = now.getTime();
  const out: ProactiveCandidate[] = [];

  for (const t of todos) {
    if (t.status !== "done") continue;
    if (!t.completedAt) continue;

    const completedMs = Date.parse(t.completedAt);
    if (Number.isNaN(completedMs)) continue;

    const ageMs = nowMs - completedMs;
    // 未来时间(ageMs < 0)跳过;超窗口跳过(含边界:== 窗口仍算"刚")
    if (ageMs < 0 || ageMs > JUST_COMPLETED_WINDOW_MS) continue;

    out.push({
      kind: "just_completed",
      priority: PRIORITY_JUST_COMPLETED,
      refId: t.id,
      title: "",
      payload: { todoTitle: t.title, completedMs },
    });
  }

  return out;
}

// ─── C. 聚合 ──────────────────────────────────────────────────────────────────

/**
 * 聚合所有事件触发源,合并 + 按优先级降序稳定排序,并渲染 title。
 *
 * 排序:
 *   - 主键:priority 降序(越紧迫越前)
 *   - 次键(同优先级):稳定 —— Array.prototype.sort 在现代 V8/JSC 是稳定排序,
 *     这里各 detect 函数按输入顺序 push,同优先级即保持原始相对顺序,确定可测。
 *
 * ⚠️ 仍是纯函数:不读 Date.now() / 不读 DB / 不读 store。now 注入。
 *
 * @param snapshot            数据快照(由调用方从真相源取好)
 * @param now                 当前时刻(注入)
 * @param lang                渲染 title 用的语言,默认 "zh"
 * @param activityCaptureCfg  活动捕获运行时配置(M2 接入;不传则不产 activity_capture 候选)
 * @param lastActivityFiredMs 上次活动捕获触发时间戳(ms);不传或 undefined 时视为 0(从未触发)
 */
export function collectCandidates(
  snapshot: TriggerSnapshot,
  now: Date,
  lang: Lang = "zh",
  activityCaptureCfg?: ActivityCaptureRunConfig,
  lastActivityFiredMs?: number
): ProactiveCandidate[] {
  const candidates: ProactiveCandidate[] = [
    ...detectMeetingSoon(snapshot.events, now),
    ...detectDeadlineNear(snapshot.todos, now),
    ...detectStuckTask(snapshot.todos, now),
    ...detectJustCompleted(snapshot.todos, now),
  ];

  // M2:把 activity_capture 触发接入聚合管线(只在调用方传入 cfg 时才产候选)
  if (activityCaptureCfg !== undefined) {
    const lastFired = lastActivityFiredMs ?? 0;
    candidates.push(...detectActivityCapture(activityCaptureCfg, now, lastFired));
  }

  // 渲染 title(确定性事实性文案;最终带人设的措辞在下游合成层)
  for (const c of candidates) {
    c.title = renderTitle(c.kind, lang, {
      title: titleOf(c),
      minutes: numMinutes(c),
    });
  }

  // priority 降序稳定排序
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

// ─── D. 活动捕获触发(全合 M1) ────────────────────────────────────────────────

/**
 * 活动捕获触发的运行时配置。
 *
 * 调用方(3.7 owner 窗口)在心跳时从真相源组装后传入,函数体内不读 store / Date.now()。
 * 工作时段(workStart/workEnd)来自 reminder.workStart/workEnd(全局唯一真相源);
 * pausedUntil 来自 gateState.pausedUntil(别烦我的共享字段)。
 * 两者都不在子配置 ActivityCaptureConfig 里重复存,这里运行时注入。
 */
export interface ActivityCaptureRunConfig {
  /** 活动捕获总开关(来自 proactive.activityCapture.enabled) */
  enabled: boolean;
  /** 提醒间隔(分钟)(来自 proactive.activityCapture.intervalMin) */
  intervalMin: number;
  /** 工作时段起始小时(来自 reminder.workStart,全局唯一真相源) */
  workStart: number;
  /** 工作时段结束小时,开区间 [workStart, workEnd)(来自 reminder.workEnd) */
  workEnd: number;
  /** 别烦我截止(ms);来自 gateState.pausedUntil。undefined = 未暂停 */
  pausedUntil: number | undefined;
  /**
   * 策略档(M2 新增):随秘书克制(gentle,默认)/ 按时硬提醒(scheduled)。
   * gate 据此决定是否跳过忙时/负荷调制。
   * 来自 proactive.activityCapture.activityCaptureMode。默认 "gentle"。
   */
  activityCaptureMode?: ActivityCaptureMode;
}

/**
 * 纯判断:此刻是否应触发活动捕获。移植自 reminder.ts 的 shouldFireReminder 逻辑。
 *
 * 规则(与 shouldFireReminder 对齐):
 *   1. 开关必须为 true
 *   2. 当前小时在工作时段 [workStart, workEnd) 内(结束为开区间)
 *   3. 未暂停(pausedUntil 未定义,或 nowMs > pausedUntil)
 *   4. 距上次触发 >= intervalMin * 60_000(lastFiredMs=0 视为"从未触发",间隔已远超)
 *
 * ⚠️ 函数体内绝不读 Date.now();now / lastFiredMs 均由调用方注入。给定入参输出完全确定。
 *
 * @param cfg         活动捕获运行时配置(工作时段 + 间隔 + pausedUntil + 开关)
 * @param now         当前时刻(注入)
 * @param lastFiredMs 上次触发时间戳(ms);0 表示从未触发
 */
export function shouldRunActivityCapture(
  cfg: ActivityCaptureRunConfig,
  now: Date,
  lastFiredMs: number
): boolean {
  if (!cfg.enabled) return false;
  const hour = now.getHours();
  if (hour < cfg.workStart || hour >= cfg.workEnd) return false; // 工作时段外
  const nowMs = now.getTime();
  if (cfg.pausedUntil !== undefined && nowMs <= cfg.pausedUntil) return false; // 暂停中
  if (nowMs - lastFiredMs < cfg.intervalMin * 60 * 1000) return false; // 间隔未到
  return true;
}

/**
 * 活动捕获触发:依 shouldRunActivityCapture 决定是否产候选。
 *
 * 产出至多 1 条 `activity_capture` 候选。
 * refId 固定为 "activity_capture"(无实体 id,仅作去重键;去重窗口由 gate 控制)。
 *
 * M2 新增:把 activityCaptureMode 放进 payload,供 gateProactive 据此决定是否跳过忙时调制。
 *
 * @param cfg         活动捕获运行时配置
 * @param now         当前时刻(注入)
 * @param lastFiredMs 上次触发时间戳(ms)
 */
export function detectActivityCapture(
  cfg: ActivityCaptureRunConfig,
  now: Date,
  lastFiredMs: number
): ProactiveCandidate[] {
  if (!shouldRunActivityCapture(cfg, now, lastFiredMs)) return [];
  return [
    {
      kind: "activity_capture",
      priority: ACTIVITY_CAPTURE_PRIORITY,
      refId: "activity_capture",
      title: "", // 由调用方按 lang 渲染(或下游合成层据人设生成)
      payload: {
        intervalMin: cfg.intervalMin,
        triggeredAt: now.getTime(),
        // M2:策略档传给 gate,让其决定是否跳过忙时/负荷调制
        activityCaptureMode: cfg.activityCaptureMode ?? "gentle",
      },
    },
  ];
}

// ─── 内部辅助 ─────────────────────────────────────────────────────────────────

/** 从候选 payload 取展示用的实体标题(会议/任务) */
function titleOf(c: ProactiveCandidate): string {
  const p = c.payload ?? {};
  return (
    (p.eventTitle as string | undefined) ??
    (p.todoTitle as string | undefined) ??
    ""
  );
}

/** 从候选 payload 取"还有几分钟"(仅 meeting/deadline 有) */
function numMinutes(c: ProactiveCandidate): number | undefined {
  const v = c.payload?.minutesUntil;
  return typeof v === "number" ? v : undefined;
}

/** 本地日期键 YYYY-MM-DD(与 dailyScan / composeProactive 的口径一致) */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** 当天本地 00:00:00 的 Date */
function startOfLocalDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
