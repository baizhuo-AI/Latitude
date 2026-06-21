/**
 * activityCapture.test.ts — M1 定时提醒×主动提醒全合
 *
 * 验收覆盖(全部纯函数、时间注入、确定性边界 ±):
 *   1. shouldRunActivityCapture — 移植 reminder 的工作时段/间隔/pausedUntil 判定
 *      边界:工作时段起/止、间隔边界(±1ms)、pausedUntil(未到/已过/无)、开关关
 *   2. detectActivityCapture — 依 shouldRunActivityCapture 产候选(开关+间隔)
 *   3. ProactiveConfig.activityCapture 默认值断言
 *      activityCaptureMode="gentle" / enabled=false / intervalMin=120
 *   4. collectCandidates 不含 activity_capture 候选
 *      (本步候选未接入 collectCandidates 管线,M2 才接)
 *
 * 设计铁律:
 *   - 函数体内绝不读 Date.now() / Math.random();now/lastFiredMs 均注入。
 *   - 给定输入 + now,输出完全确定。
 */

import { describe, it, expect } from "vitest";
import {
  shouldRunActivityCapture,
  detectActivityCapture,
  ACTIVITY_CAPTURE_PRIORITY,
  type ActivityCaptureRunConfig,
} from "./triggers";
import {
  defaultProactiveConfig,
  DEFAULT_ACTIVITY_CAPTURE_INTERVAL_MIN,
} from "./proactiveConfig";

// ─── 辅助 ─────────────────────────────────────────────────────────────────────

/** 固定基准时刻 2026-06-16 14:00:00 本地时间(工作时段内) */
function baseNow(hour = 14, min = 0, sec = 0): Date {
  return new Date(2026, 5, 16, hour, min, sec, 0);
}

const MIN = 60 * 1000;

/** 基准运行配置:工作时段 9-22、间隔 120min、已开启 */
function baseCfg(overrides: Partial<ActivityCaptureRunConfig> = {}): ActivityCaptureRunConfig {
  return {
    enabled: true,
    intervalMin: 120,
    workStart: 9,
    workEnd: 22,
    pausedUntil: undefined,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. shouldRunActivityCapture — 移植 reminder 纯函数判定
// ════════════════════════════════════════════════════════════════════════════
describe("shouldRunActivityCapture — 移植 reminder 工作时段/间隔/pausedUntil", () => {
  it("满足全部条件(工作时段内 + 间隔已过)→ true", () => {
    const now = baseNow(14, 0);
    const lastFiredMs = now.getTime() - 121 * MIN;
    expect(shouldRunActivityCapture(baseCfg(), now, lastFiredMs)).toBe(true);
  });

  it("开关关(enabled=false)→ false", () => {
    const now = baseNow(14, 0);
    const lastFiredMs = now.getTime() - 200 * MIN;
    expect(shouldRunActivityCapture(baseCfg({ enabled: false }), now, lastFiredMs)).toBe(false);
  });

  it("工作时段之前(08:59)→ false", () => {
    const now = baseNow(8, 59);
    expect(shouldRunActivityCapture(baseCfg(), now, 0)).toBe(false);
  });

  it("工作时段起始边界(09:00)→ true", () => {
    const now = baseNow(9, 0);
    const lastFiredMs = now.getTime() - 200 * MIN;
    expect(shouldRunActivityCapture(baseCfg(), now, lastFiredMs)).toBe(true);
  });

  it("工作时段结束边界(22:00,开区间)→ false", () => {
    const now = baseNow(22, 0);
    expect(shouldRunActivityCapture(baseCfg(), now, 0)).toBe(false);
  });

  it("工作时段内(21:59)→ 通过时段检查", () => {
    const now = baseNow(21, 59);
    const lastFiredMs = now.getTime() - 200 * MIN;
    expect(shouldRunActivityCapture(baseCfg(), now, lastFiredMs)).toBe(true);
  });

  it("间隔未到(才过 60min,阈值 120min)→ false", () => {
    const now = baseNow(14, 0);
    const lastFiredMs = now.getTime() - 60 * MIN;
    expect(shouldRunActivityCapture(baseCfg(), now, lastFiredMs)).toBe(false);
  });

  it("间隔恰好到(距上次恰等于 intervalMin * 60_000)→ true(≥ 即触发)", () => {
    const now = baseNow(14, 0);
    const lastFiredMs = now.getTime() - 120 * MIN;
    expect(shouldRunActivityCapture(baseCfg(), now, lastFiredMs)).toBe(true);
  });

  it("边界:距上次 intervalMs - 1ms → false;intervalMs + 1ms → true", () => {
    const now = baseNow(14, 0);
    const intervalMs = 120 * MIN;
    const under = now.getTime() - (intervalMs - 1);
    const over = now.getTime() - (intervalMs + 1);
    expect(shouldRunActivityCapture(baseCfg(), now, under)).toBe(false);
    expect(shouldRunActivityCapture(baseCfg(), now, over)).toBe(true);
  });

  it("lastFiredMs=0(从未触发)→ 在工作时段内为 true", () => {
    const now = baseNow(14, 0);
    expect(shouldRunActivityCapture(baseCfg(), now, 0)).toBe(true);
  });

  it("暂停中(pausedUntil 未过)→ false", () => {
    const now = baseNow(14, 0);
    const nowMs = now.getTime();
    const cfg = baseCfg({ pausedUntil: nowMs + 10_000 });
    expect(shouldRunActivityCapture(cfg, now, 0)).toBe(false);
  });

  it("暂停已过期(pausedUntil < nowMs)→ 恢复,按间隔决定", () => {
    const now = baseNow(14, 0);
    const nowMs = now.getTime();
    const cfg = baseCfg({ pausedUntil: nowMs - 10_000 });
    // 距上次 0(lastFiredMs=0),间隔已远超 → true
    expect(shouldRunActivityCapture(cfg, now, 0)).toBe(true);
  });

  it("pausedUntil=undefined → 不阻塞(正常按间隔)", () => {
    const now = baseNow(14, 0);
    const lastFiredMs = now.getTime() - 200 * MIN;
    const cfg = baseCfg({ pausedUntil: undefined });
    expect(shouldRunActivityCapture(cfg, now, lastFiredMs)).toBe(true);
  });

  it("纯函数:相同入参多次调用结果完全一致", () => {
    const now = baseNow(14, 0);
    const lastFiredMs = now.getTime() - 121 * MIN;
    const cfg = baseCfg();
    expect(shouldRunActivityCapture(cfg, now, lastFiredMs)).toBe(
      shouldRunActivityCapture(cfg, now, lastFiredMs)
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. detectActivityCapture — 依条件产候选
// ════════════════════════════════════════════════════════════════════════════
describe("detectActivityCapture — 产候选", () => {
  it("条件满足 → 产出 1 条 activity_capture 候选", () => {
    const now = baseNow(14, 0);
    const lastFiredMs = now.getTime() - 121 * MIN;
    const out = detectActivityCapture(baseCfg(), now, lastFiredMs);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("activity_capture");
    expect(out[0].refId).toBe("activity_capture");
  });

  it("条件不满足(工作时段外)→ 空数组", () => {
    const now = baseNow(8, 0);
    expect(detectActivityCapture(baseCfg(), now, 0)).toHaveLength(0);
  });

  it("开关关 → 空数组", () => {
    const now = baseNow(14, 0);
    expect(detectActivityCapture(baseCfg({ enabled: false }), now, 0)).toHaveLength(0);
  });

  it("间隔未到 → 空数组", () => {
    const now = baseNow(14, 0);
    const lastFiredMs = now.getTime() - 30 * MIN;
    expect(detectActivityCapture(baseCfg(), now, lastFiredMs)).toHaveLength(0);
  });

  it("候选 priority 等于 ACTIVITY_CAPTURE_PRIORITY", () => {
    const now = baseNow(14, 0);
    const out = detectActivityCapture(baseCfg(), now, 0);
    expect(out[0].priority).toBe(ACTIVITY_CAPTURE_PRIORITY);
  });

  it("候选 payload 携带 intervalMin", () => {
    const now = baseNow(14, 0);
    const out = detectActivityCapture(baseCfg({ intervalMin: 90 }), now, 0);
    expect(out[0].payload?.intervalMin).toBe(90);
  });

  it("纯函数:相同入参两次产出相同", () => {
    const now = baseNow(14, 0);
    const lastFiredMs = now.getTime() - 121 * MIN;
    const cfg = baseCfg();
    const run1 = detectActivityCapture(cfg, now, lastFiredMs);
    const run2 = detectActivityCapture(cfg, now, lastFiredMs);
    expect(run1).toEqual(run2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. ProactiveConfig.activityCapture 默认值
// ════════════════════════════════════════════════════════════════════════════
describe("defaultProactiveConfig — activityCapture 子配置默认值", () => {
  it("activityCapture 字段存在", () => {
    const d = defaultProactiveConfig();
    expect(d.activityCapture).toBeDefined();
  });

  it("默认关闭(enabled=false):不扰现有用户,需主动开启", () => {
    const d = defaultProactiveConfig();
    expect(d.activityCapture.enabled).toBe(false);
  });

  it("默认模式 gentle(随秘书克制)", () => {
    const d = defaultProactiveConfig();
    expect(d.activityCapture.activityCaptureMode).toBe("gentle");
  });

  it("默认间隔 DEFAULT_ACTIVITY_CAPTURE_INTERVAL_MIN(120 min,继承 reminder 语义)", () => {
    const d = defaultProactiveConfig();
    expect(d.activityCapture.intervalMin).toBe(DEFAULT_ACTIVITY_CAPTURE_INTERVAL_MIN);
    expect(DEFAULT_ACTIVITY_CAPTURE_INTERVAL_MIN).toBe(120);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. collectCandidates 本步不含 activity_capture
//    (M1 只产候选+定义配置;M2 才接入 collectCandidates 管线)
// ════════════════════════════════════════════════════════════════════════════
describe("collectCandidates 本步不含 activity_capture 候选", () => {
  it("collectCandidates 返回的候选中无 activity_capture kind", async () => {
    // 动态 import 避免顶层循环依赖风险
    const { collectCandidates } = await import("./triggers");
    const now = baseNow(14, 0);
    const out = collectCandidates({ todos: [], events: [] }, now);
    const hasActivityCapture = out.some((c) => c.kind === "activity_capture");
    expect(hasActivityCapture).toBe(false);
  });
});
