import { create } from "zustand";
import {
  dbListCalendarEvents,
  dbBulkUpsertCalendarEvents,
  dbSoftDeleteCalendarEvent,
  dbListSyncStates,
  type CalendarEvent,
  type SyncStateRecord,
  type CalRegion
} from "./db";
import { emitSync } from "./syncBus";

/**
 * 飞书/Lark 日历事件 store
 *
 * 同步来的日历事件(独立实体,不混 todos)。真相源是 SQLite,这里只做内存缓存,
 * 不自持久化。主 App 和浮窗共享同一 SQLite,改动后 emitSync("calendar_events")
 * 广播,各窗口 re-hydrate(同 activityStore/goalsStore 范式)。
 *
 * 写路径统一:写库 → set 内存 → emitSync("calendar_events")。
 * 注:同步引擎(Rust 侧)写库后另走 notify("calendar_events"),主窗收到再 emitSync。
 */

export type { CalendarEvent, SyncStateRecord } from "./db";

interface CalendarEventsStore {
  events: CalendarEvent[];
  syncStates: SyncStateRecord[];
  loaded: boolean;
  /** hydrate 失败时的错误；成功或尚未加载时为 null。 */
  error: string | null;
  hydrate: () => Promise<void>;
  /** 批量 upsert 一批事件(整批同事务),写完刷新内存 + 广播 */
  upsertEvents: (events: CalendarEvent[]) => Promise<void>;
  /** 软删一条事件:按 (region, calendarId, remoteEventId) 置 cancelled,内存里移出视图 */
  softDelete: (
    region: CalRegion,
    calendarId: string,
    remoteEventId: string
  ) => Promise<void>;
  /** 只刷新同步游标行(设置页同步状态展示用),不动 events */
  refreshSyncStates: () => Promise<void>;
}

export const useCalendarEventsStore = create<CalendarEventsStore>((set) => ({
  events: [],
  syncStates: [],
  loaded: false,
  error: null,

  hydrate: async () => {
    try {
      // events 与 syncStates 一起拉,失败则整体兜底为空(任一查询挂掉都不让 UI 卡在未加载态)
      const [events, syncStates] = await Promise.all([
        dbListCalendarEvents(),
        dbListSyncStates()
      ]);
      set({ events, syncStates, loaded: true, error: null });
    } catch (err) {
      console.error("[calendarEventsStore] hydrate failed:", err);
      set({ events: [], syncStates: [], loaded: true, error: String(err) });
    }
  },

  upsertEvents: async (events) => {
    if (events.length === 0) return;
    await dbBulkUpsertCalendarEvents(events);
    // 批量 upsert 会触碰 event_map 去重 / 软删行,内存难以精确合并,直接重拉一遍最稳
    const fresh = await dbListCalendarEvents();
    set({ events: fresh });
    emitSync("calendar_events");
  },

  softDelete: async (region, calendarId, remoteEventId) => {
    await dbSoftDeleteCalendarEvent(region, calendarId, remoteEventId);
    // DB 是软删(行保留、status 置 cancelled),视图默认不含 cancelled,这里同步移出内存
    set((s) => ({
      events: s.events.filter(
        (e) =>
          !(
            e.region === region &&
            e.calendarId === calendarId &&
            e.remoteEventId === remoteEventId
          )
      )
    }));
    emitSync("calendar_events");
  },

  refreshSyncStates: async () => {
    try {
      const syncStates = await dbListSyncStates();
      set({ syncStates });
    } catch (err) {
      console.error("[calendarEventsStore] refreshSyncStates failed:", err);
    }
  }
}));
