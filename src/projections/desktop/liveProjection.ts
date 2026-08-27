import type { ActivityRecord, CalendarEvent, DailyDigestRow, Goal } from "../../lib/db";
import type { ProposalRecord } from "../../lib/db";
import type { Todo } from "../../lib/store";
import type {
  AnchorRow,
  CardPresentation,
  ChartCardPayload,
  FeedCardPayload,
  NativeCardKind,
  NativeCardPayload,
  NoteCardPayload,
  ProgressCardPayload,
  ProposalCardPayload,
  ProposalVerdict,
  Secretary
} from "../../dimension/types";
import type { LayoutDocumentV1 } from "../../runtime/layout/types";
import type { DesktopProjection, RuntimeStatus } from "./types";

/**
 * 桌面投影的真实数据 adapter（只读）。
 *
 * 把现有 SQLite 里的真实记录（待办 / 日历 / 目标 / 速记流水 / 晨报 / 提案）
 * 投影成桌面五区。这是前端体验 PRD §13.1 的落地：投影只读已有数据层，
 * 不合成关系、不冒充已接入认知图谱。后端（图谱 / 候选线索 / 策展）
 * 未接入的区域，用诚实的留白代替假内容。
 *
 * 前后端契约边界：
 * - 本模块负责：todos / calendar_events / activities / daily_digest /
 *   proposals → 桌面投影；
 * - 后端负责补齐：候选线索、资讯策展、养成三参数计算。缺席时桌面显示
 *   真实的「没有」，不显示占位假数据。
 */

export interface LiveProjectionInput {
  todos: Todo[];
  todosStatus?: ProjectionSourceStatus;
  calendarEvents: CalendarEvent[];
  calendarStatus?: ProjectionSourceStatus;
  goals: Goal[];
  /** 单独描述 Goal 数据源，避免断库时把 unknown 投影成「没有长期方向」。 */
  goalsStatus?: "starting" | "ready" | "unavailable";
  activities: ActivityRecord[];
  activitiesStatus?: ProjectionSourceStatus;
  now: Date;
  runtimeStatus: RuntimeStatus;
  /** 等待裁决的提案（来自 proposals 表）。缺席时弹性格显示留白。 */
  pendingProposal?: ProposalRecord | null;
  proposalsStatus?: ProjectionSourceStatus;
  /** 今日纪要（秘书每日整理的真实产出）。缺席时资讯区留白。 */
  todayDigest?: DailyDigestRow | null;
  digestStatus?: ProjectionSourceStatus;
}

export type ProjectionSourceStatus = "starting" | "ready" | "unavailable";

/** 裁决五态的日常语言（前端体验 PRD §4.2）。顺序即渲染顺序。 */
export const PROPOSAL_VERDICTS: readonly ProposalVerdict[] = [
  { id: "interesting", label: "有点意思" },
  { id: "holds", label: "这对我成立" },
  { id: "try", label: "要不试试" },
  { id: "reject", label: "不太对" },
  { id: "park", label: "先放着" }
];

/** 把 proposals 表记录映射成提案卡 payload（带完整裁决集与影响说明）。 */
export function proposalPayloadOf(record: ProposalRecord): ProposalCardPayload {
  return {
    kind: "proposal",
    quote: record.quote,
    consequence: record.consequence,
    accept: "好",
    reject: "先不",
    verdicts: [...PROPOSAL_VERDICTS]
  };
}

export interface LiveDesktop {
  projection: DesktopProjection;
  layout: LayoutDocumentV1<NativeCardKind, CardPresentation>;
}

/* ---------- 时间工具（本地时区） ---------- */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地日期键 YYYY-MM-DD，与 store.ts 的 dateKeyToday 同口径。 */
export function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "09:30-11:00" → 570；无法解析时 null。 */
function startMinutesOf(timeRange?: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(timeRange ?? "");
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** CalendarEvent.startTs 是 Unix 秒（见 calendarNormalize.test.ts 的 utcSec）。 */
function eventStartDate(ev: CalendarEvent): Date | null {
  return ev.startTs ? new Date(ev.startTs * 1000) : null;
}

function isEventOnDay(ev: CalendarEvent, key: string): boolean {
  if (ev.scheduledDate) return ev.scheduledDate === key;
  const start = eventStartDate(ev);
  return start ? dateKeyOf(start) === key : false;
}

function eventStartMinutes(ev: CalendarEvent): number | null {
  const fromText = startMinutesOf(ev.scheduledTime);
  if (fromText !== null) return fromText;
  const start = eventStartDate(ev);
  return start ? start.getHours() * 60 + start.getMinutes() : null;
}

function eventMeta(ev: CalendarEvent): string {
  if (ev.isAllDay) return "全天";
  if (ev.scheduledTime) return ev.scheduledTime;
  const start = eventStartDate(ev);
  return start ? `${pad2(start.getHours())}:${pad2(start.getMinutes())}` : "今天";
}

/* ---------- 日程区：今天的锚点 ---------- */

const MAX_SCHEDULE_ROWS = 7;

function buildScheduleRows(todos: Todo[], events: CalendarEvent[], todayKey: string): {
  rows: AnchorRow[];
  pendingCount: number;
  doneToday: Todo[];
  eventCount: number;
  nextAnchor: AnchorRow | null;
} {
  const pendingTodos = todos.filter(
    (t) =>
      (t.status === "todo" || t.status === "doing") &&
      t.scheduledDate === todayKey
  );
  const doneToday = todos.filter(
    (t) =>
      t.status === "done" &&
      t.completedAt &&
      dateKeyOf(new Date(t.completedAt)) === todayKey
  );
  const todaysEvents = events.filter((ev) => isEventOnDay(ev, todayKey));

  const allDayRows: AnchorRow[] = todaysEvents
    .filter((ev) => ev.isAllDay || eventStartMinutes(ev) === null)
    .map((ev) => ({
      text: ev.title,
      meta: "全天",
      epistemic: "recorded",
      lineage: {
        entityType: "calendar_event",
        entityId: ev.id,
        label: `来自日历${ev.calendarName ? ` · ${ev.calendarName}` : ""}`
      }
    }));

  type TimedRow = { minutes: number; row: AnchorRow };
  const timed: TimedRow[] = [];

  for (const ev of todaysEvents) {
    const minutes = eventStartMinutes(ev);
    if (ev.isAllDay || minutes === null) continue;
    timed.push({
      minutes,
      row: {
        text: ev.title,
        meta: eventMeta(ev),
        epistemic: "recorded",
        lineage: {
          entityType: "calendar_event",
          entityId: ev.id,
          label: `来自日历${ev.calendarName ? ` · ${ev.calendarName}` : ""}`
        }
      }
    });
  }

  const untimedTodoRows: AnchorRow[] = [];
  for (const t of pendingTodos) {
    const minutes = startMinutesOf(t.scheduledTime);
    const row: AnchorRow = {
      text: t.title,
      meta: t.scheduledTime ?? (t.isProcrastinated ? "拖延中" : "今天"),
      tags: t.tags,
      epistemic: "recorded",
      actionable: true,
      lineage: {
        entityType: "todo",
        entityId: t.id,
        label: "来自你的待办"
      }
    };
    if (minutes === null) untimedTodoRows.push(row);
    else timed.push({ minutes, row });
  }

  timed.sort((a, b) => a.minutes - b.minutes);

  const pendingRows = [...allDayRows, ...timed.map((t) => t.row), ...untimedTodoRows];
  const totalPending = pendingRows.length;

  // 「已完成」摘要行和「另有 N 件」折叠行都要占位置；先预留，再决定可见条数。
  let cap = MAX_SCHEDULE_ROWS - (doneToday.length > 0 ? 1 : 0);
  if (totalPending > cap) cap -= 1; // 需要折叠行，再让出一个位置
  const visible = pendingRows.slice(0, cap);
  const overflow = totalPending - visible.length;
  const rows: AnchorRow[] = [...visible];
  if (overflow > 0) {
    rows.push({
      text: `另有 ${overflow} 件事在今天的待办里`,
      meta: "待办",
      epistemic: "recorded"
    });
  }
  if (doneToday.length > 0) {
    const titles = doneToday.slice(0, 2).map((t) => t.title).join("、");
    rows.push({
      text: `已完成：${titles}${doneToday.length > 2 ? ` 等 ${doneToday.length} 件` : ""}`,
      meta: "今天",
      epistemic: "recorded",
      done: true
    });
  }

  return {
    rows,
    pendingCount: pendingTodos.length,
    doneToday,
    eventCount: todaysEvents.length,
    nextAnchor: visible.find((r) => r.actionable) ?? null
  };
}

/* ---------- 节奏区：今天的忙闲与下一段完整时间 ---------- */

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 22;
const RHYTHM_SEGMENTS = 8;

function buildRhythm(
  events: CalendarEvent[],
  todayKey: string,
  now: Date,
  status: ProjectionSourceStatus = "ready"
): {
  payload: ChartCardPayload;
  title: string;
} {
  if (status !== "ready" && events.length === 0) {
    return {
      payload: { kind: "chart", bars: Array(RHYTHM_SEGMENTS).fill(0) },
      title:
        status === "starting" ? "正在读取今天的日程" : "日历记录暂时不可用"
    };
  }

  const timed = events.filter(
    (ev) => isEventOnDay(ev, todayKey) && !ev.isAllDay && ev.startTs
  );

  const windowStart = new Date(now);
  windowStart.setHours(DAY_START_HOUR, 0, 0, 0);
  const windowEnd = new Date(now);
  windowEnd.setHours(DAY_END_HOUR, 0, 0, 0);
  const segMinutes = ((DAY_END_HOUR - DAY_START_HOUR) * 60) / RHYTHM_SEGMENTS;

  const blocks = timed.map((ev) => {
    const start = eventStartDate(ev)!;
    const end = ev.endTs ? new Date(ev.endTs * 1000) : new Date(start.getTime() + 30 * 60_000);
    return { start, end };
  });

  if (blocks.length === 0) {
    return {
      payload: { kind: "chart", bars: Array(RHYTHM_SEGMENTS).fill(0) },
      title: "今天没有日程事件"
    };
  }

  const bars = Array.from({ length: RHYTHM_SEGMENTS }, (_, i) => {
    const segStart = new Date(windowStart.getTime() + i * segMinutes * 60_000);
    const segEnd = new Date(segStart.getTime() + segMinutes * 60_000);
    let busyMs = 0;
    for (const b of blocks) {
      const overlapStart = Math.max(segStart.getTime(), b.start.getTime());
      const overlapEnd = Math.min(segEnd.getTime(), b.end.getTime());
      if (overlapEnd > overlapStart) busyMs += overlapEnd - overlapStart;
    }
    return Math.round((busyMs / (segMinutes * 60_000)) * 100) / 100;
  });

  // 下一段完整时间：从此刻到 22:00 之间，最长的一段连续无日程时间。
  let title: string;
  if (now >= windowEnd) {
    title = "今天的日程已经过完";
  } else {
    let cursor = now < windowStart ? windowStart : now;
    let best = 0;
    const sorted = [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
    for (const b of sorted) {
      if (b.end <= cursor) continue;
      if (b.start > cursor) {
        best = Math.max(best, (b.start.getTime() - cursor.getTime()) / 60_000);
      }
      cursor = b.end > cursor ? b.end : cursor;
    }
    if (windowEnd > cursor) {
      best = Math.max(best, (windowEnd.getTime() - cursor.getTime()) / 60_000);
    }
    title =
      best >= 30
        ? `下一段完整时间：${Math.round(best)} 分钟`
        : "今天剩下的时间都比较碎";
  }

  return { payload: { kind: "chart", bars }, title };
}

/* ---------- 复盘区：这周到今天的真实进度 ---------- */

function weekStartOf(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=周日
  d.setDate(d.getDate() - ((day + 6) % 7)); // 回到周一
  return d;
}

function buildReviewPlan(
  todos: Todo[],
  activities: ActivityRecord[],
  now: Date,
  todosStatus: ProjectionSourceStatus = "ready",
  activitiesStatus: ProjectionSourceStatus = "ready"
): ProgressCardPayload {
  const weekStart = weekStartOf(now);
  const inWeek = (iso?: string) => iso && new Date(iso) >= weekStart;

  const doneThisWeek = todos.filter(
    (t) => t.status === "done" && inWeek(t.completedAt)
  );
  const scheduledThisWeek = todos.filter((t) => {
    if (!t.scheduledDate) return false;
    const d = new Date(`${t.scheduledDate}T00:00:00`);
    return d >= weekStart && d <= now;
  });
  const pendingWeek = scheduledThisWeek.filter(
    (t) => t.status === "todo" || t.status === "doing"
  );
  const recordedThisWeek = activities.filter((a) => inWeek(a.occurredAt));

  const denominator = new Set([
    ...scheduledThisWeek.map((t) => t.id),
    ...doneThisWeek.map((t) => t.id)
  ]).size;
  const percent =
    denominator > 0 ? Math.round((doneThisWeek.length / denominator) * 100) : 0;

  if (todosStatus !== "ready") {
    const activitySuffix =
      activitiesStatus === "ready"
        ? `当前只读到 ${recordedThisWeek.length} 条活动记录。`
        : "活动流水也还不可用。";
    return {
      kind: "progress",
      body: `${todosStatus === "starting" ? "待办记录正在读取" : "待办记录暂时不可用"}，现在无法计算本周完成度。${activitySuffix}`,
      leftMeta: "复盘 · 等真实记录可用后再计算"
    };
  }

  const body =
    denominator === 0 && recordedThisWeek.length === 0
      ? activitiesStatus === "ready"
        ? "这周还没有留下记录。记下的每一件事，都会成为周末回顾的材料。"
        : "这周的待办记录里还没有完成项；活动流水暂时不可用，不能据此判断没有做事。"
      : `这周到今天：完成 ${doneThisWeek.length} 件，记下 ${recordedThisWeek.length} 条记录${
          pendingWeek.length > 0 ? `，还有 ${pendingWeek.length} 件没收口` : ""
        }。${activitiesStatus === "ready" ? "" : " 活动流水暂时不可用，记录数可能不完整。"}`;

  return {
    kind: "progress",
    body,
    percent,
    leftMeta: "复盘 · 周日一起回头看"
  };
}

/* ---------- 留白区 ---------- */

function buildFeed(
  todayDigest?: DailyDigestRow | null,
  status: ProjectionSourceStatus = "ready"
): FeedCardPayload {
  // 今日纪要是秘书整理的真实产出，以「记录显示」身份出现（不是策展推测）。
  // 资讯策展（换一个角度）未接入，没有纪要时宁缺（PRD §4.3）。
  if (!todayDigest?.summary.trim()) {
    return {
      kind: "feed",
      items: [],
      emptyHint:
        status === "starting"
          ? "正在读取每日整理；完成前不判断今天有没有材料。"
          : status === "unavailable"
            ? "每日整理这次没有读出来；这里的空白不代表今天没有材料。"
            : "现在没有值得你换一个角度看的材料。没有合格的，就空着。"
    };
  }
  const summary = todayDigest.summary.trim();
  return {
    kind: "feed",
    items: [
      {
        id: `digest-${todayDigest.date}`,
        title: "今早的整理",
        why: summary.length > 80 ? `${summary.slice(0, 80)}…` : summary,
        source:
          status === "unavailable"
            ? "每日纪要 · 已缓存，当前刷新失败"
            : status === "starting"
              ? "每日纪要 · 已缓存，正在刷新"
              : "每日纪要 · 记录显示",
        lineage: {
          entityType: "digest",
          entityId: todayDigest.date,
          label: "来自秘书的每日整理"
        }
      }
    ]
  };
}

function buildFlexPayload(
  pendingProposal?: ProposalRecord | null,
  status: ProjectionSourceStatus = "ready"
): NoteCardPayload | ProposalCardPayload {
  // 弹性格：提案优先 > 待抉择 > 留白。提案来自 proposals 表（秘书递交）。
  if (pendingProposal) return proposalPayloadOf(pendingProposal);
  return {
    kind: "note",
    body:
      status === "starting"
        ? "正在读取等待裁决的提案。"
        : status === "unavailable"
          ? "提案记录这次没有读出来；现在无法判断有没有等你决定的事。"
          : "现在没有等你决定的事。",
    quote: status === "ready" ? "有事情我会来问。" : "先不把未知说成没有。"
  };
}

/* ---------- 秘书：只说她真实知道的 ---------- */

function buildSecretary(input: {
  pendingCount: number;
  doneCount: number;
  hasAnyReality: boolean;
  unavailableSources: string[];
  startingSources: string[];
}): Secretary {
  const { pendingCount, doneCount, hasAnyReality, unavailableSources, startingSources } = input;
  const headline = unavailableSources.length > 0 && !hasAnyReality
    ? "我在，但有些真实记录这次没读出来。"
    : startingSources.length > 0 && !hasAnyReality
      ? "我在，正在读取今天的记录。"
      : !hasAnyReality
    ? "我在。今天还没有安排。"
    : pendingCount > 0
      ? `今天有 ${pendingCount} 个锚点${doneCount > 0 ? `，${doneCount} 件已经完成` : ""}。`
      : "今天的事都收完了。";
  return {
    eyebrow: "YOUR SECRETARY",
    state: "ready",
    gesture: "idle",
    stateCn: "在岗",
    headline,
    // 明确承认边界（PRD §13.1）：什么接了真实数据，什么还没有。
    note:
      unavailableSources.length > 0
        ? `${unavailableSources.join("、")}暂时不可用；当前只显示已经读到的内容，空白不代表没有。认知线索仍要等图谱接入。`
        : startingSources.length > 0
          ? `${startingSources.join("、")}仍在读取；完成前不把未知说成没有。认知线索仍要等图谱接入。`
          : "日程、待办、提案都来自你的真实记录。线索要等认知图谱接入后才会出现——现在看到的空，是真的空。",
    stageLabel: "熟悉 · 初见",
    stageProgress: 0,
    stageNote: "我还不了解你。你纠正我一次，我就记住一次。",
    metrics: []
  };
}

/* ---------- 长期方向：只读取用户明确记录的 Goal ---------- */

const GOAL_PERIOD_LABEL: Record<Goal["period"], string> = {
  year: "年度",
  quarter: "季度",
  month: "月度"
};

function buildConstellation(
  goals: Goal[],
  goalsStatus: LiveProjectionInput["goalsStatus"] = "ready"
): DesktopProjection["constellation"] {
  if (goalsStatus === "starting") {
    return {
      northStar: {
        title: "正在读取长期方向",
        detail: "长期目标还在从本地记录中载入；完成前不判断有没有目标。",
        status: "loading"
      },
      cognitions: []
    };
  }

  if (goalsStatus === "unavailable") {
    return {
      northStar: {
        title: "长期目标暂时不可用",
        detail: "本地目标记录这次没有读出来；当前无法判断你是否已经设定长期方向。",
        status: "unavailable"
      },
      cognitions: []
    };
  }

  const active = goals.filter((goal) => goal.status === "active");
  const annual = active
    .filter((goal) => goal.period === "year")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (annual.length === 0) {
    const shortTermCount = active.filter((goal) => goal.period !== "year").length;
    return {
      northStar: {
        title: "还没有设定长期方向",
        detail:
          shortTermCount > 0
            ? `你有 ${shortTermCount} 个进行中的阶段目标，但还没有年度方向；这里不会拿短期目标冒充北极星。`
            : "这里会显示你明确记录的年度目标；没有目标时保持留白。",
        status: "empty"
      },
      cognitions: []
    };
  }

  if (annual.length > 1) {
    const preview = annual.slice(0, 3).map((goal) => goal.title).join("、");
    return {
      northStar: {
        title: `你有 ${annual.length} 个长期方向`,
        detail: `${preview}${annual.length > 3 ? "等" : ""}。目前没有指定唯一主目标，所以不替你挑一个。`,
        status: "multiple"
      },
      cognitions: []
    };
  }

  const [goal] = annual;
  const period = GOAL_PERIOD_LABEL[goal.period];
  const target = goal.targetDate ? ` · 目标日期 ${goal.targetDate}` : "";
  return {
    northStar: {
      title: goal.title,
      detail: goal.description?.trim() || `来自你记录的${period}目标${target}`,
      status: "single",
      lineage: {
        entityType: "goal",
        entityId: goal.id,
        label: `来自你的${period}目标`
      }
    },
    // 认知星必须等 Observation / Claim 图谱；Goal 不能冒充认知节点。
    cognitions: []
  };
}

/* ---------- 组装 ---------- */

export function buildLiveProjection(input: LiveProjectionInput): LiveDesktop {
  const todosStatus = input.todosStatus ?? "ready";
  const calendarStatus = input.calendarStatus ?? "ready";
  const activitiesStatus = input.activitiesStatus ?? "ready";
  const proposalsStatus = input.proposalsStatus ?? "ready";
  const digestStatus = input.digestStatus ?? "ready";
  const todayKey = dateKeyOf(input.now);
  const schedule = buildScheduleRows(input.todos, input.calendarEvents, todayKey);
  const rhythm = buildRhythm(input.calendarEvents, todayKey, input.now, calendarStatus);
  const reviewPlan = buildReviewPlan(
    input.todos,
    input.activities,
    input.now,
    todosStatus,
    activitiesStatus
  );
  const flex = buildFlexPayload(input.pendingProposal, proposalsStatus);

  const unavailableSources = [
    ...(todosStatus === "unavailable" ? ["待办"] : []),
    ...(calendarStatus === "unavailable" ? ["日历"] : []),
    ...(activitiesStatus === "unavailable" ? ["活动流水"] : []),
    ...(proposalsStatus === "unavailable" ? ["提案"] : []),
    ...(digestStatus === "unavailable" ? ["每日整理"] : [])
  ];
  const startingSources = [
    ...(todosStatus === "starting" ? ["待办"] : []),
    ...(calendarStatus === "starting" ? ["日历"] : []),
    ...(activitiesStatus === "starting" ? ["活动流水"] : []),
    ...(proposalsStatus === "starting" ? ["提案"] : []),
    ...(digestStatus === "starting" ? ["每日整理"] : [])
  ];
  const scheduleUnavailable = [
    ...(todosStatus === "unavailable" ? ["待办"] : []),
    ...(calendarStatus === "unavailable" ? ["日历"] : [])
  ];
  const scheduleStarting = [
    ...(todosStatus === "starting" ? ["待办"] : []),
    ...(calendarStatus === "starting" ? ["日历"] : [])
  ];

  const hasAnyReality =
    schedule.rows.length > 0 || input.activities.length > 0;

  const subtitleParts: string[] = [];
  if (schedule.pendingCount > 0) subtitleParts.push(`${schedule.pendingCount} 件待办`);
  if (schedule.eventCount > 0) subtitleParts.push(`${schedule.eventCount} 个日程`);
  if (schedule.doneToday.length > 0)
    subtitleParts.push(`已完成 ${schedule.doneToday.length} 件`);

  const bindings: Record<string, NativeCardPayload> = {
    "desktop.feed": buildFeed(input.todayDigest, digestStatus),
    "desktop.schedule": {
      kind: "anchors",
      rows: schedule.rows,
      emptyHint:
        scheduleUnavailable.length > 0
          ? `${scheduleUnavailable.join("、")}记录暂时不可用；这里的空白不代表今天没有安排。`
          : scheduleStarting.length > 0
            ? `${scheduleStarting.join("、")}记录正在读取；完成前不判断今天有没有安排。`
            : "今天还没有锚点。可以从待办里挑一件事放到今天；没有安排也是真实的一天。"
    },
    "desktop.reviewPlan": reviewPlan,
    "desktop.rhythm": rhythm.payload,
    "desktop.flex": flex
  };

  const projection: DesktopProjection = {
    generatedAt: input.now.toISOString(),
    runtimeStatus: input.runtimeStatus,
    header: {
      breadcrumb: "TODAY · FOCUS",
      title: schedule.nextAnchor
        ? schedule.nextAnchor.text
        : schedule.doneToday.length > 0
          ? "今天的事都收完了"
          : scheduleUnavailable.length > 0
            ? "部分安排暂时不可用"
            : scheduleStarting.length > 0
              ? "正在读取今天的安排"
              : "今天还没有锚点",
      subtitle:
        subtitleParts.length > 0
          ? `${subtitleParts.join(" · ")}${scheduleUnavailable.length > 0 ? ` · ${scheduleUnavailable.join("、")}未读到` : ""}`
          : scheduleUnavailable.length > 0
            ? `${scheduleUnavailable.join("、")}这次没有读出来；当前内容可能不完整。`
            : scheduleStarting.length > 0
              ? `${scheduleStarting.join("、")}仍在读取。`
              : "记下此刻正在做的事，桌面就有了一份现实。"
    },
    secretary: buildSecretary({
      pendingCount: schedule.pendingCount,
      doneCount: schedule.doneToday.length,
      hasAnyReality,
      unavailableSources,
      startingSources
    }),
    bindings,
    journalSpreads: {},
    constellation: buildConstellation(input.goals, input.goalsStatus)
  };

  const layout: LayoutDocumentV1<NativeCardKind, CardPresentation> = {
    schemaVersion: 1,
    id: "dimension-live-desktop",
    revision: 2,
    background: {
      theme: "paper",
      texture: "linen",
      density: "comfortable",
      tokenOverrides: { "--dim-desk": "#e9e4d6" }
    },
    cards: [
      {
        id: "live-feed",
        region: "feed",
        renderer: "native",
        kind: "feed",
        span: 5,
        binding: "desktop.feed",
        presentation: {
          eyebrow: "今日资讯",
          title: "今日早报",
          tilt: -0.8,
          offsetY: 4,
          paper: "newsprint",
          clip: true
        }
      },
      {
        id: "live-schedule",
        region: "schedule",
        renderer: "native",
        kind: "anchors",
        span: 7,
        binding: "desktop.schedule",
        presentation: {
          eyebrow: "今天",
          title: "今天的锚点",
          tilt: 0.35,
          offsetY: -2
        }
      },
      {
        id: "live-review-plan",
        region: "review-plan",
        renderer: "native",
        kind: "progress",
        span: 4,
        binding: "desktop.reviewPlan",
        presentation: {
          eyebrow: "本周",
          title: "这周到这里",
          tilt: -1.1,
          offsetY: 12
        }
      },
      {
        id: "live-rhythm",
        region: "rhythm",
        renderer: "native",
        kind: "chart",
        span: 4,
        binding: "desktop.rhythm",
        presentation: {
          eyebrow: "专注时间",
          title: rhythm.title,
          tilt: 0.7,
          offsetY: 2,
          paper: "grid"
        }
      },
      {
        id: "live-flex",
        region: "flex",
        renderer: "native",
        kind: flex.kind,
        span: 4,
        binding: "desktop.flex",
        presentation: {
          eyebrow:
            flex.kind === "proposal"
              ? "WAITING FOR YOU"
              : proposalsStatus === "ready"
                ? "CLEAR · NOTHING PENDING"
                : "PROPOSALS · STATUS UNKNOWN",
          title:
            flex.kind === "proposal"
              ? "等你决定"
              : proposalsStatus === "starting"
                ? "正在读取待裁决提案"
                : proposalsStatus === "unavailable"
                  ? "提案记录暂时不可用"
                  : "这一刻没有待决定的事",
          tilt: -1.6,
          offsetY: 7,
          paper: "sticky",
          dogear: true,
          tape: {
            side: "right",
            offset: 26,
            width: 64,
            color: "rgb(198 216 48 / 40%)",
            tilt: 3
          }
        }
      }
    ],
    arrangement: {
      strategy: "frequency-weighted",
      orderedCardIds: [
        "live-feed",
        "live-schedule",
        "live-review-plan",
        "live-rhythm",
        "live-flex"
      ],
      params: { maxChangesPerRefresh: 1 },
      rationale: [
        "先放一条和今天直接相关的材料，不做信息流",
        "日程是今天最常看的内容，因此占最大面积",
        "复盘、节奏和待确认的事情留在下排，需要时再点亮"
      ]
    }
  };

  return { projection, layout };
}
