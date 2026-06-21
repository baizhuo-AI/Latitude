/**
 * dismissDowngradeWiring.test.ts — Task 3.5 接线层:dailyScan 末尾跑降档评估并落库
 *
 * 这里测的是「接线」而非纯逻辑(纯逻辑在 dismissDowngrade.test.ts):
 *   - 从真相源读当前档(readSettingsSnapshot.proactive.mode)
 *   - 从 DB 采集近期结局(dbListProactiveOutcomesSince)
 *   - 调纯函数 evaluateDismissDowngrade(注入 now)判定
 *   - 若降档 → setProactive({ mode }) 落库(单 owner 窗口由 wiring 保证)
 *   - 不降档 / 已 off → 不写
 *
 * 时间注入:runDismissDowngrade(now) 把 now 透传给纯函数,确定性可测。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProactiveOutcomeRow } from "../db";
import {
  CONSECUTIVE_IGNORE_THRESHOLD,
  DOWNGRADE_LOOKBACK_MS,
} from "./dismissDowngrade";
import type { ProactiveMode } from "./proactiveConfig";

// ─── 可变 mock 状态 ────────────────────────────────────────────────────────────
let _mode: ProactiveMode = "active";
let _outcomes: ProactiveOutcomeRow[] = [];
const setProactiveSpy = vi.fn((patch: { mode?: ProactiveMode }) => {
  if (patch.mode) _mode = patch.mode;
});

// ─── mock db ────────────────────────────────────────────────────────────────
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dbListProactiveOutcomesSince: vi.fn(async (_sinceMs: number) => _outcomes),
  };
});

// ─── mock settings(真相源:readSettingsSnapshot + store setProactive) ─────────
// llm/index 在 import 期会调 onProviderConfigChange + readSettingsSnapshot,故 mock 要带上。
const WIRING_SETTINGS_BASE = {
  lang: "zh" as const,
  persona: { presetKey: "seniorAdvisor" as const },
  llmProvider: "deepseek" as const,
  providers: {
    deepseek: {
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: "deepseek-chat",
    },
  },
};
vi.mock("../settings", () => ({
  onProviderConfigChange: () => () => undefined,
  readSettingsSnapshot: () => ({ ...WIRING_SETTINGS_BASE, proactive: { mode: _mode } }),
  useSettingsStore: { getState: () => ({ ...WIRING_SETTINGS_BASE, setProactive: setProactiveSpy }) },
}));

// llm/index 间接依赖(避免 import 副作用拖入真实模块)
vi.mock("../chatTools", () => ({ toolsForLLM: () => [], runChatTool: async () => "{}" }));
vi.mock("../store", () => ({ useTodoStore: { getState: () => ({ todos: [] }) } }));
vi.mock("../goalsStore", () => ({ useGoalsStore: { getState: () => ({ goals: [] }) } }));

// ─── mock syncBus(避免 tauri event 副作用) ───────────────────────────────────
vi.mock("../syncBus", () => ({ emitSync: vi.fn() }));

// 被测接线函数(mock 之后 import)
import { runDismissDowngrade } from "./dailyScan";
import { dbListProactiveOutcomesSince } from "../db";

const NOW = Date.parse("2026-06-16T22:30:00.000Z");
const HOUR = 60 * 60 * 1000;

function ignoredRows(n: number): ProactiveOutcomeRow[] {
  const rows: ProactiveOutcomeRow[] = [];
  for (let i = 0; i < n; i++) rows.push({ kind: "ignored", sentAtMs: NOW - (n - i) * HOUR });
  return rows;
}

beforeEach(() => {
  _mode = "active";
  _outcomes = [];
  setProactiveSpy.mockClear();
  vi.mocked(dbListProactiveOutcomesSince).mockClear();
});

describe("runDismissDowngrade — 接线降档评估", () => {
  it("连续无视达阈值(active)→ setProactive({mode:'gentle'}) 落库", async () => {
    _outcomes = ignoredRows(CONSECUTIVE_IGNORE_THRESHOLD);
    await runDismissDowngrade(NOW);
    expect(setProactiveSpy).toHaveBeenCalledTimes(1);
    expect(setProactiveSpy).toHaveBeenCalledWith({ mode: "gentle" });
  });

  it("未达阈值 → 不写库", async () => {
    _outcomes = ignoredRows(CONSECUTIVE_IGNORE_THRESHOLD - 1);
    await runDismissDowngrade(NOW);
    expect(setProactiveSpy).not.toHaveBeenCalled();
  });

  it("当前已 off → 直接跳过,连 DB 都不查(省事且无可再降)", async () => {
    _mode = "off";
    _outcomes = ignoredRows(CONSECUTIVE_IGNORE_THRESHOLD + 3);
    await runDismissDowngrade(NOW);
    expect(dbListProactiveOutcomesSince).not.toHaveBeenCalled();
    expect(setProactiveSpy).not.toHaveBeenCalled();
  });

  it("gentle 达阈值 → 降到 off", async () => {
    _mode = "gentle";
    _outcomes = ignoredRows(CONSECUTIVE_IGNORE_THRESHOLD);
    await runDismissDowngrade(NOW);
    expect(setProactiveSpy).toHaveBeenCalledWith({ mode: "off" });
  });

  it("采集查询用 now - DOWNGRADE_LOOKBACK_MS 作为 since(时间注入透传)", async () => {
    _outcomes = ignoredRows(CONSECUTIVE_IGNORE_THRESHOLD);
    await runDismissDowngrade(NOW);
    expect(dbListProactiveOutcomesSince).toHaveBeenCalledWith(NOW - DOWNGRADE_LOOKBACK_MS);
  });

  it("末尾有 replied(用户仍互动)→ 不降档", async () => {
    _outcomes = [...ignoredRows(CONSECUTIVE_IGNORE_THRESHOLD), { kind: "replied", sentAtMs: NOW - 1 }];
    await runDismissDowngrade(NOW);
    expect(setProactiveSpy).not.toHaveBeenCalled();
  });
});
