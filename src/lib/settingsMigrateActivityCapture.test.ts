/**
 * settingsMigrateActivityCapture.test.ts — 定时×主动全合 M4:配置迁移验收
 *
 * 背景:M4 退役老 reminder 的"活动记录"定时器,改由 activity_capture 接手。
 * 老用户曾在「定时提醒」里开过提醒(reminder.enabled=true / 设过 intervalMin),
 * 升级后应等价地由 activity_capture 接管 —— 把 reminder.{enabled,intervalMin}
 * 平滑映射到 activityCapture.{enabled,intervalMin}。
 *
 * 迁移在 readStored() 里做(读 localStorage → 合并 defaults 时一次性映射),兜底安全:
 *   - 幂等护栏:存档里【已有】 proactive.activityCapture(用户已在新 schema 下保存过)
 *     → 一律以存档为准,不再迁移(避免反复覆盖用户在新 UI 里的设置)。
 *   - 仅当存档【没有】 activityCapture(纯老用户)时,才用 reminder 的值初始化 activityCapture。
 *
 * ⚠️ 共享字段不受迁移影响:workStart / workEnd / pausedUntil 是整个主动引擎的唯一真相源,
 *    原样留在 reminder 里,迁移绝不搬走 / 删除它们(本测试也锁这一点)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const STORAGE_KEY = "latitude.settings";

/**
 * 装一个可用的内存 localStorage。
 * 本仓库的 jsdom@29 环境下 window.localStorage 是个没有可用方法的对象(故 settings.ts
 * 每处访问都包了 try/catch),测试必须自己注入一个真正能 set/get 的实现。
 */
function installMemoryLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("localStorage", mock);
  // window.localStorage 与全局 localStorage 在 jsdom 下是同一引用;stubGlobal 已覆盖 window.*
  return store;
}

/** 往 localStorage 写一份部分 settings 存档,模拟老用户升级前的状态。 */
function seedStored(partial: Record<string, unknown>): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(partial));
}

/**
 * readStored 不直接导出,但 readSettingsSnapshot() 是它的薄封装(返回当前 localStorage 的合并态)。
 * 用动态 import 避免模块级单例缓存(useSettingsStore 在 import 时就 readStored 一次)。
 */
async function freshSnapshot() {
  // 清模块缓存,确保 readSettingsSnapshot 反映本次 seed 的 localStorage
  const mod = await import("./settings");
  return mod.readSettingsSnapshot();
}

describe("配置迁移:老 reminder → activityCapture (M4)", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("纯老用户(reminder.enabled=true,无 activityCapture)→ 迁移 enabled 到 activityCapture", async () => {
    seedStored({
      reminder: { enabled: true, intervalMin: 45, channel: "both", workStart: 8, workEnd: 20 },
      // 故意不带 proactive,模拟老 schema
    });
    const snap = await freshSnapshot();
    expect(snap.proactive.activityCapture.enabled).toBe(true);
    expect(snap.proactive.activityCapture.intervalMin).toBe(45);
  });

  it("纯老用户的 intervalMin 被继承到 activityCapture(即使 reminder.enabled=false)", async () => {
    seedStored({
      reminder: { enabled: false, intervalMin: 90, channel: "floating", workStart: 9, workEnd: 22 },
    });
    const snap = await freshSnapshot();
    // enabled 跟随老 reminder(false),但间隔继承
    expect(snap.proactive.activityCapture.enabled).toBe(false);
    expect(snap.proactive.activityCapture.intervalMin).toBe(90);
  });

  it("幂等护栏:存档已有 activityCapture → 以存档为准,不被 reminder 覆盖", async () => {
    seedStored({
      reminder: { enabled: true, intervalMin: 45, channel: "both", workStart: 8, workEnd: 20 },
      proactive: {
        mode: "gentle",
        activityCapture: { enabled: false, intervalMin: 180, activityCaptureMode: "scheduled" },
      },
    });
    const snap = await freshSnapshot();
    // 用户已在新 schema 下保存过(activityCapture 存在)→ 完全以存档为准
    expect(snap.proactive.activityCapture.enabled).toBe(false);
    expect(snap.proactive.activityCapture.intervalMin).toBe(180);
    expect(snap.proactive.activityCapture.activityCaptureMode).toBe("scheduled");
  });

  it("迁移不破坏共享字段:workStart/workEnd/pausedUntil 原样留在 reminder", async () => {
    seedStored({
      reminder: {
        enabled: true,
        intervalMin: 30,
        channel: "both",
        workStart: 7,
        workEnd: 19,
        pausedUntil: 9999999999999,
      },
    });
    const snap = await freshSnapshot();
    // 共享字段必须仍在 reminder 上,值不变
    expect(snap.reminder.workStart).toBe(7);
    expect(snap.reminder.workEnd).toBe(19);
    expect(snap.reminder.pausedUntil).toBe(9999999999999);
  });

  it("全新用户(无任何存档)→ activityCapture 用默认值(关闭 / 120 / gentle)", async () => {
    // 不 seed,localStorage 空
    const snap = await freshSnapshot();
    expect(snap.proactive.activityCapture.enabled).toBe(false);
    expect(snap.proactive.activityCapture.intervalMin).toBe(120);
    expect(snap.proactive.activityCapture.activityCaptureMode).toBe("gentle");
  });

  it("迁移保留 activityCaptureMode 默认 gentle(老 schema 无此概念)", async () => {
    seedStored({
      reminder: { enabled: true, intervalMin: 60, channel: "both", workStart: 9, workEnd: 22 },
    });
    const snap = await freshSnapshot();
    expect(snap.proactive.activityCapture.activityCaptureMode).toBe("gentle");
  });
});
