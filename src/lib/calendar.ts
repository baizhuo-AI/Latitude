/**
 * Calendar 用的日期工具
 *
 * 周一作为一周的起始(中文场景标准),周末是周日。
 * 时间表示统一用 minutes since midnight(0-1439)。
 */

import type { CalendarEvent } from "./db";

/** "2026-05-09" 格式的日期字符串(本地时区) */
export type DateKey = string;

export function dateKey(date: Date): DateKey {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/**
 * 返回包含 date 的那一周(周一-周日)的 7 个 Date
 */
export function weekDays(date: Date): Date[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  // getDay():周日=0,周一=1...周六=6。我们要"周一是 0"。
  const dow = (d.getDay() + 6) % 7;
  return addDays(d, -dow);
}

/* ---------- deadline 快捷词 ---------- */

export type QuickDeadlineKind = "today" | "tomorrow" | "thisFri" | "nextMon";

/**
 * deadline 快捷词 → "YYYY-MM-DD"。本周五 = 本周一+4,下周一 = 本周一+7。
 * 传 now 便于单测(默认当前时间)。
 */
export function quickDeadline(kind: QuickDeadlineKind, now: Date = new Date()): DateKey {
  switch (kind) {
    case "today":
      return dateKey(now);
    case "tomorrow":
      return dateKey(addDays(now, 1));
    case "thisFri":
      return dateKey(addDays(startOfWeek(now), 4));
    case "nextMon":
      return dateKey(addDays(startOfWeek(now), 7));
  }
}

/**
 * 返回月视图的 6x7 矩阵(42 个 Date),包含上月尾和下月头填充
 */
export function monthMatrix(year: number, month0: number): Date[] {
  const first = new Date(year, month0, 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/* ---------- 时间段 parse ---------- */

export interface TimeRange {
  startMin: number; // 0-1439
  endMin: number; // 0-1439, > startMin
}

/**
 * "09:30-11:00" → { startMin: 570, endMin: 660 }
 * 失败返回 null
 */
export function parseScheduledTime(s: string | undefined): TimeRange | null {
  if (!s) return null;
  const m = s.match(/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
  if (!m) return null;
  const startMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const endMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  if (
    startMin < 0 ||
    startMin >= 1440 ||
    endMin <= startMin ||
    endMin > 1440
  ) {
    return null;
  }
  return { startMin, endMin };
}

export function formatHM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/* ---------- 飞书/Lark 事件时间归一 ---------- */

/** 远端事件的原始时间（定时事件用 startTs/endTs+timezone，全天用 startDate）。 */
export interface RawEventTiming {
  isAllDay: boolean;
  /** 定时事件起止：Unix 秒（UTC） */
  startTs?: number;
  endTs?: number;
  /** 全天事件日期 "YYYY-MM-DD"（飞书全天固定 UTC+0，不带时区） */
  startDate?: string;
  /** 定时事件的 IANA 时区；缺省按 Asia/Shanghai（飞书定时日程默认时区） */
  timezone?: string;
}

/** 归一产物，喂日历视图（与 parseScheduledTime 的格式契约一致）。 */
export interface NormalizedTiming {
  scheduledDate?: string;
  scheduledTime?: string;
}

/** 把一个 UTC 秒时间戳按目标时区折算成 { 本地日期, 当日分钟数 }。 */
function localParts(ts: number, tz: string): { date: string; min: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(ts * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let h = parseInt(get("hour"), 10);
  if (h === 24) h = 0; // 某些运行时午夜返回 "24"
  const mi = parseInt(get("minute"), 10);
  return { date: `${get("year")}-${get("month")}-${get("day")}`, min: h * 60 + mi };
}

/**
 * 远端事件时间 → { scheduledDate, scheduledTime }，喂月/周视图。
 *
 * 两条独立路径（混用会串天/漂钟点，是高危坑）：
 *  - 全天：startDate 是 UTC+0 日历日，**直接原样落 scheduledDate，绝不做时区转换**。
 *  - 定时：startTs/endTs(UTC) 按事件 timezone 折算本地钟点。跨天（end 落在不同本地日）
 *    或 end<=start 时，因 parseScheduledTime 无法表达跨天，scheduledTime 落起始日、
 *    end 截到 23:59（已知近似，注释在此）。
 */
export function normalizeEventTiming(t: RawEventTiming): NormalizedTiming {
  if (t.isAllDay) {
    return t.startDate ? { scheduledDate: t.startDate } : {};
  }
  if (t.startTs == null) return {};
  const tz = t.timezone || "Asia/Shanghai";
  const start = localParts(t.startTs, tz);

  let endMin: number;
  if (t.endTs == null) {
    endMin = Math.min(start.min + 60, 1439);
  } else {
    const end = localParts(t.endTs, tz);
    endMin = end.date === start.date && end.min > start.min ? end.min : 1439;
  }
  if (endMin <= start.min) endMin = Math.min(start.min + 1, 1440);

  return {
    scheduledDate: start.date,
    scheduledTime: `${formatHM(start.min)}-${formatHM(endMin)}`
  };
}

/* ---------- 渲染前去重(喂日历视图) ---------- */

/**
 * 渲染层去重 + 过滤软删,供 CalendarPage 算 eventsByDate(纯函数,单测在 calendarDedup.test.ts)。
 *
 * 为什么前端还要再去重:DB 的 event_map 唯一索引已在写入侧防重,但增量乱序、多日历挂同一
 * 重复事件、或日后本地草稿叠加,内存里仍可能出现同一实例多条。视图只该渲染一条。
 *
 * 去重键 `${recurrenceMasterId ?? id}|${instanceStartIso ?? ''}|${localDraft?'d':'r'}`:
 *  - 重复事件的同一实例 = 同 master + 同 instanceStart,折成一条;
 *  - 非重复事件 recurrenceMasterId 为空 → 退化用 id,天然各占一键。
 *  - **localDraft 维度(P4-4)**:真冲突时主记录(localDraft=false)与本地草稿(localDraft=true)
 *    会共享同一 master+instanceStart;不加这一维,草稿会被主记录吃掉、用户改动静默丢。两者都要上
 *    视图(草稿带冲突 badge 让用户决断),故按草稿/远端分两键。
 * 同键留先到的那条(调用方已按 scheduled_time 升序拉,先到即更早时段)。
 * 另过滤 status==='cancelled'(软删行不上视图)。
 */
export function dedupeEventsByDate(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const e of events) {
    if (e.status === "cancelled") continue;
    const key = `${e.recurrenceMasterId ?? e.id}|${e.instanceStartIso ?? ""}|${e.localDraft ? "d" : "r"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/* ---------- label ---------- */

/**
 * "2026 年 5 月" / "May 2026"
 */
export function monthLabel(date: Date, lang: "zh" | "en"): string {
  if (lang === "en") {
    return date.toLocaleDateString("en-US", { year: "numeric", month: "long" });
  }
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

/**
 * "5 月 4-10 日" / "May 4-10"
 */
export function weekLabel(start: Date, end: Date, lang: "zh" | "en"): string {
  if (lang === "en") {
    const m1 = start.toLocaleDateString("en-US", { month: "short" });
    return `${m1} ${start.getDate()}–${end.getDate()}`;
  }
  return `${start.getMonth() + 1} 月 ${start.getDate()}-${end.getDate()} 日`;
}

/* ---------- 工作日内空档/占用计算 ---------- */

export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 18;

/**
 * 合并重叠时段(范围已按 startMin 升序时也 OK)
 */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.startMin - b.startMin);
  const merged: TimeRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, r.endMin);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * 给定一组 scheduledTime,计算 9:00-18:00 工作时段内:
 *  - 剩余空档分钟数(总工作 - 已占用)
 *  - 已占用的时段列表(合并重叠后,按时间顺序)
 */
export function workdayUsage(scheduledRanges: TimeRange[]): {
  freeMin: number;
  occupied: TimeRange[];
} {
  const workStart = WORK_START_HOUR * 60;
  const workEnd = WORK_END_HOUR * 60;

  // 裁剪到工作时段
  const clipped = scheduledRanges
    .map((r) => ({
      startMin: Math.max(r.startMin, workStart),
      endMin: Math.min(r.endMin, workEnd)
    }))
    .filter((r) => r.startMin < r.endMin);

  const occupied = mergeRanges(clipped);
  const occupiedMin = occupied.reduce(
    (acc, r) => acc + (r.endMin - r.startMin),
    0
  );

  return {
    freeMin: workEnd - workStart - occupiedMin,
    occupied
  };
}

/**
 * 把分钟数格式化成 "3.5h" / "45m"(去尾 0)
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = minutes / 60;
  // 1.0 → "1h",1.5 → "1.5h",2.25 → "2.3h"
  return `${(Math.round(h * 10) / 10).toString().replace(/\.0$/, "")}h`;
}

/**
 * 把一组时段格式化成 "09:30-11:00, 14:00-15:00"
 */
export function formatRangeList(ranges: TimeRange[]): string {
  return ranges
    .map((r) => `${formatHM(r.startMin)}-${formatHM(r.endMin)}`)
    .join(", ");
}

/**
 * 把分钟数吸附到最近的 step(默认 15 分钟)
 */
export function snapMinutes(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step;
}
