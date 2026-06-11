import { describe, it, expect } from "vitest";
import { eventToFeishuPayload, buildChangeInput } from "./calendarQueue";
import { normalizeEventTiming } from "./calendar";
import type { CalendarEvent } from "./db";

function mkEvent(o: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "ce1",
    region: "feishu",
    calendarId: "cal1",
    remoteEventId: "ev1",
    title: "会议",
    description: undefined,
    location: undefined,
    isAllDay: false,
    startTs: undefined,
    endTs: undefined,
    timezone: undefined,
    scheduledDate: "2026-05-30",
    scheduledTime: "09:00-10:00",
    status: "confirmed",
    isRecurringInstance: false,
    recurrenceMasterId: undefined,
    instanceStartIso: undefined,
    calendarName: undefined,
    isWritable: true,
    localDraft: false,
    etag: "etag-1",
    createdAt: "x",
    updatedAt: "x",
    ...o
  } as CalendarEvent;
}

describe("eventToFeishuPayload", () => {
  it("定时事件往返：payload 时间戳经 normalizeEventTiming 还原回相同 scheduledDate/scheduledTime", () => {
    const ev = mkEvent({ scheduledDate: "2026-05-30", scheduledTime: "09:00-10:00" });
    const p = eventToFeishuPayload(ev, "Asia/Shanghai") as any;
    expect(p.start_time.timezone).toBe("Asia/Shanghai");
    const back = normalizeEventTiming({
      isAllDay: false,
      startTs: parseInt(p.start_time.timestamp, 10),
      endTs: parseInt(p.end_time.timestamp, 10),
      timezone: "Asia/Shanghai"
    });
    expect(back.scheduledDate).toBe("2026-05-30");
    expect(back.scheduledTime).toBe("09:00-10:00");
  });

  it("跨时区往返（America/New_York，含夏令时）", () => {
    const ev = mkEvent({ scheduledDate: "2026-05-30", scheduledTime: "14:30-15:30" });
    const p = eventToFeishuPayload(ev, "America/New_York") as any;
    const back = normalizeEventTiming({
      isAllDay: false,
      startTs: +p.start_time.timestamp,
      endTs: +p.end_time.timestamp,
      timezone: "America/New_York"
    });
    expect(back.scheduledDate).toBe("2026-05-30");
    expect(back.scheduledTime).toBe("14:30-15:30");
  });

  it("全天事件用 date、不带 timestamp/timezone", () => {
    const ev = mkEvent({ isAllDay: true, scheduledDate: "2026-05-30", scheduledTime: undefined });
    const p = eventToFeishuPayload(ev, "Asia/Shanghai") as any;
    expect(p.start_time.date).toBe("2026-05-30");
    expect(p.start_time.timestamp).toBeUndefined();
    const back = normalizeEventTiming({ isAllDay: true, startDate: p.start_time.date });
    expect(back.scheduledDate).toBe("2026-05-30");
  });
});

describe("buildChangeInput", () => {
  it("update：base_etag 取自 ev.etag，op/localId/remoteEventId/calendarId 正确", () => {
    const ev = mkEvent({ id: "ce9", etag: "etag-9", remoteEventId: "rev9", calendarId: "calX" });
    const inp = buildChangeInput(ev, "update", "Asia/Shanghai");
    expect(inp.op).toBe("update");
    expect(inp.localId).toBe("ce9");
    expect(inp.remoteEventId).toBe("rev9");
    expect(inp.calendarId).toBe("calX");
    expect(inp.baseEtag).toBe("etag-9");
    expect(JSON.parse(inp.payloadJson).summary).toBe("会议");
  });

  it("重复事件实例：payload 带 scope:single + 母事件信息（P4-6 改单次）", () => {
    const ev = mkEvent({ recurrenceMasterId: "master1", instanceStartIso: "1730000000" });
    const inp = buildChangeInput(ev, "update", "Asia/Shanghai");
    const pl = JSON.parse(inp.payloadJson);
    expect(pl.scope).toBe("single");
    expect(pl.recurrence_master_id).toBe("master1");
    expect(pl.instance_start_iso).toBe("1730000000");
  });

  it("delete：op=delete，remoteEventId 定位保留", () => {
    const ev = mkEvent({ remoteEventId: "rev-del" });
    const inp = buildChangeInput(ev, "delete", "Asia/Shanghai");
    expect(inp.op).toBe("delete");
    expect(inp.remoteEventId).toBe("rev-del");
  });
});
