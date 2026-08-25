import { create } from "zustand";
import {
  dbInsertActivity,
  dbListActivities,
  dbDeleteActivity,
  type ActivityRecord
} from "./db";
import { emitSync } from "./syncBus";

/**
 * 间歇式时间日志 store
 *
 * 记录「刚才做了什么」的一句话流水。主 App 和浮窗共享同一 SQLite,
 * 改动后 emitSync("activities") 广播,各窗口 re-hydrate。
 */

export type { ActivityRecord } from "./db";

export function newActivityId(): string {
  return `a${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

interface ActivityStore {
  activities: ActivityRecord[];
  loaded: boolean;
  /** hydrate 失败时的错误；成功或尚未加载时为 null。 */
  error: string | null;
  hydrate: () => Promise<void>;
  /** 记一条活动(自由文本)。occurredAt = 事情实际发生时间(ISO);省略时按当前时间(适合「刚才/正在」)。 */
  addActivity: (content: string, occurredAt?: string) => Promise<void>;
  removeActivity: (id: string) => Promise<void>;
}

export const useActivityStore = create<ActivityStore>((set) => ({
  activities: [],
  loaded: false,
  error: null,

  hydrate: async () => {
    try {
      const activities = await dbListActivities();
      set({ activities, loaded: true, error: null });
    } catch (err) {
      console.error("[activityStore] hydrate failed:", err);
      set({ activities: [], loaded: true, error: String(err) });
    }
  },

  addActivity: async (content, occurredAt) => {
    const now = new Date().toISOString();
    const rec: ActivityRecord = {
      id: newActivityId(),
      content,
      occurredAt: occurredAt ?? now, // 没指定就按当前时间(刚才/正在做的事)
      createdAt: now // 记录时间永远是写入这一刻
    };
    await dbInsertActivity(rec);
    // occurredAt 可能早于已有条目(比如晚上补记早上的事),插入后按发生时间倒序重排,
    // 让它落到时间线正确位置,不必等下次 re-hydrate。
    set((s) => ({
      activities: [rec, ...s.activities].sort((a, b) =>
        a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0
      )
    }));
    emitSync("activities");
  },

  removeActivity: async (id) => {
    await dbDeleteActivity(id);
    set((s) => ({ activities: s.activities.filter((a) => a.id !== id) }));
    emitSync("activities");
  }
}));
