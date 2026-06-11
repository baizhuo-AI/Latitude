/**
 * 本地变更队列的前端侧：把一条被编辑/删除的日历事件组装成「飞书可接受的请求体 + 队列入参」，
 * 写进 calendar_change_queue 表，等 Rust 的 feishu_flush_queue 回写飞书。
 *
 * 核心难点是 eventToFeishuPayload：日历视图里事件是本地墙钟（scheduledDate + scheduledTime），
 * 写回飞书要 UTC 时间戳 + 时区——这是 calendar.ts 里 normalizeEventTiming 的**逆运算**。
 * 往返一致性（normalizeEventTiming(eventToFeishuPayload(ev)) === ev 的时间）由单测锁死。
 */

import { parseScheduledTime } from "./calendar";
import { dbEnqueueChange, type CalendarEvent, type ChangeOp, type ChangeQueueInput } from "./db";

/** 用户本地 IANA 时区（写回时区基准）；取不到退 Asia/Shanghai。 */
function localTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
}

/**
 * 某个 UTC 秒在目标时区下的偏移（秒）：local_wallclock = utc + offset。
 * 用 Intl 把 UTC 瞬间投影成 tz 墙钟，再当作 UTC 反算，差值即偏移。
 */
function tzOffsetSec(utcSec: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date(utcSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let h = parseInt(get("hour"), 10);
  if (h === 24) h = 0;
  const localAsUtc =
    Date.UTC(+get("year"), +get("month") - 1, +get("day"), h, +get("minute"), +get("second")) / 1000;
  return localAsUtc - utcSec;
}

/**
 * 本地墙钟（"YYYY-MM-DD" + 当日分钟）在目标时区下对应的 UTC 秒。
 * 先把墙钟当 UTC 减一次偏移近似，再用近似点的偏移校一次——这第二次校正处理 DST 边界
 * （偏移在跳变日会变，单次近似可能差一小时）。
 */
function zonedToUtcSec(dateStr: string, min: number, tz: string): number {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, Math.floor(min / 60), min % 60) / 1000;
  let utc = wallAsUtc - tzOffsetSec(wallAsUtc, tz);
  utc = wallAsUtc - tzOffsetSec(utc, tz);
  return utc;
}

/**
 * 事件 → 飞书 events 接口请求体。定时事件给 timestamp(UTC秒字符串)+timezone；全天给 date。
 * tz 默认用户本地时区（视图里就是按本地排的，写回也按本地理解）。
 */
export function eventToFeishuPayload(
  ev: CalendarEvent,
  tz: string = localTz()
): Record<string, unknown> {
  const payload: Record<string, unknown> = { summary: ev.title };

  if (ev.isAllDay) {
    // 全天：飞书用 start/end 的 date（UTC+0 日历日），直接用本地 scheduledDate，不折时区。
    payload.start_time = { date: ev.scheduledDate };
    payload.end_time = { date: ev.scheduledDate };
    return payload;
  }

  // 定时：scheduledDate + scheduledTime(HH:MM-HH:MM) 在 tz 下折回 UTC 秒。
  const range = parseScheduledTime(ev.scheduledTime);
  const date = ev.scheduledDate ?? "";
  const startSec = zonedToUtcSec(date, range ? range.startMin : 0, tz);
  const endSec = zonedToUtcSec(date, range ? range.endMin : (range ? 60 : 60), tz);
  payload.start_time = { timestamp: String(startSec), timezone: tz };
  payload.end_time = { timestamp: String(endSec), timezone: tz };
  return payload;
}

/**
 * 组一条队列入参（纯函数，不写库，便于单测）。
 * 重复事件实例（recurrenceMasterId 非空）额外带 scope:'single' + 母事件信息——只改这一次（P4-6），
 * 让 Rust 写回时走「改单实例」语义，不动整个系列。
 */
export function buildChangeInput(
  ev: CalendarEvent,
  op: ChangeOp,
  tz: string = localTz()
): ChangeQueueInput {
  const payload = eventToFeishuPayload(ev, tz);
  if (ev.recurrenceMasterId) {
    payload.recurrence_master_id = ev.recurrenceMasterId;
    payload.instance_start_iso = ev.instanceStartIso;
    payload.scope = "single";
  }
  return {
    op,
    localId: ev.id,
    calendarId: ev.calendarId,
    remoteEventId: ev.remoteEventId,
    payloadJson: JSON.stringify(payload),
    baseEtag: ev.etag
  };
}

/** 入队一条事件编辑/删除（写库）。返回队列项 id。调用方应在 await 之后再 invoke flush。 */
export async function enqueueEventEdit(ev: CalendarEvent, op: ChangeOp): Promise<string> {
  return dbEnqueueChange(buildChangeInput(ev, op));
}
