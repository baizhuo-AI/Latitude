import { describe, it, expect } from "vitest";
import { dedupeEventsByDate } from "./calendar";
import type { CalendarEvent } from "./db";

/**
 * P2-5 渲染去重纯函数。
 *
 * 去重键 `${recurrenceMasterId ?? id}|${instanceStartIso ?? ''}`:
 * 同一重复事件的同一实例(同 master + 同 instanceStart)可能因增量乱序/多日历重复落多条,
 * 视图层只留一条。另过滤 status==='cancelled'(软删行不上视图,双保险:dbListCalendarEvents
 * 也已过滤,但纯函数自洽,单测/草稿场景也不漏)。
 */

/** 造一条 CalendarEvent,只填测试关心的字段,其余给合理默认。 */
function makeEvent(partial: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    region: "feishu",
    calendarId: "cal-1",
    remoteEventId: partial.id,
    title: partial.id,
    isAllDay: false,
    status: "confirmed",
    isRecurringInstance: false,
    isWritable: false,
    localDraft: false,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...partial
  };
}

describe("dedupeEventsByDate", () => {
  it("两条同 (masterId, instanceStartIso) → 输出一条", () => {
    const a = makeEvent({
      id: "ce-a",
      isRecurringInstance: true,
      recurrenceMasterId: "master-1",
      instanceStartIso: "2026-05-29T01:00:00Z"
    });
    const b = makeEvent({
      id: "ce-b",
      isRecurringInstance: true,
      recurrenceMasterId: "master-1",
      instanceStartIso: "2026-05-29T01:00:00Z"
    });
    const out = dedupeEventsByDate([a, b]);
    expect(out).toHaveLength(1);
    // 同键留先到的那条
    expect(out[0].id).toBe("ce-a");
  });

  it("cancelled 事件被过滤掉", () => {
    const ok = makeEvent({ id: "ce-ok" });
    const dead = makeEvent({ id: "ce-dead", status: "cancelled" });
    const out = dedupeEventsByDate([ok, dead]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("ce-ok");
  });

  it("无 recurrenceMasterId 时按 id 区分:不同 id 各留一条", () => {
    const a = makeEvent({ id: "ce-a" });
    const b = makeEvent({ id: "ce-b" });
    expect(dedupeEventsByDate([a, b])).toHaveLength(2);
  });

  it("同 master 不同 instanceStart → 两条都留(不同实例)", () => {
    const a = makeEvent({
      id: "ce-a",
      isRecurringInstance: true,
      recurrenceMasterId: "master-1",
      instanceStartIso: "2026-05-29T01:00:00Z"
    });
    const b = makeEvent({
      id: "ce-b",
      isRecurringInstance: true,
      recurrenceMasterId: "master-1",
      instanceStartIso: "2026-05-30T01:00:00Z"
    });
    expect(dedupeEventsByDate([a, b])).toHaveLength(2);
  });

  it("缺 instanceStartIso 的同 master 多条 → 视为同键留一条", () => {
    const a = makeEvent({ id: "ce-a", recurrenceMasterId: "master-1" });
    const b = makeEvent({ id: "ce-b", recurrenceMasterId: "master-1" });
    const out = dedupeEventsByDate([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("ce-a");
  });

  it("冲突场景:重复事件的主记录(远端)与本地草稿同 master+instance → 两条都留(P4-4)", () => {
    const remote = makeEvent({
      id: "ce-main",
      isRecurringInstance: true,
      recurrenceMasterId: "master-1",
      instanceStartIso: "2026-05-29T01:00:00Z",
      localDraft: false
    });
    const draft = makeEvent({
      id: "ce-draft",
      isRecurringInstance: true,
      recurrenceMasterId: "master-1",
      instanceStartIso: "2026-05-29T01:00:00Z",
      localDraft: true
    });
    // 不加 localDraft 维度的话这俩会被折成一条、草稿(用户改动)被吃掉。
    const out = dedupeEventsByDate([remote, draft]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.localDraft).sort()).toEqual([false, true]);
  });

  it("空数组 → 空数组", () => {
    expect(dedupeEventsByDate([])).toEqual([]);
  });
});
