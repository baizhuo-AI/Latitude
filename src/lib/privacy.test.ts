/**
 * privacy.test.ts — Task 4.6a 隐私 + 成本设置的纯逻辑单测
 *
 * 覆盖三件事:
 *   1. settings defaults: localOnlyBrain / noSensitiveMemory / lowPowerMode 的默认值
 *   2. isCloudBackend: 判断当前 chatBackend 是否为云端 API
 *   3. shouldInjectMemoryToEngine: 仅本地大脑模式下的注入决策
 *   4. buildSensitiveMemoryInstruction: noSensitiveMemory 开启时的补充指令
 *   5. applyLowPowerPreset: 低频预设写入 proactive heartbeatMin
 */

import { describe, it, expect } from "vitest";
import {
  isCloudBackend,
  shouldInjectMemoryToEngine,
  buildSensitiveMemoryInstruction,
  applyLowPowerPreset,
  LOW_POWER_HEARTBEAT_MIN,
} from "./privacy";
import type { ChatBackend } from "./settings";

// ─── 1. isCloudBackend ────────────────────────────────────────────────────────

describe("isCloudBackend — 判断后端是否为云端 API", () => {
  it("deepseek-api → 云端", () => {
    expect(isCloudBackend("deepseek-api")).toBe(true);
  });

  it("claude-cli → 本地 CLI(非云端)", () => {
    expect(isCloudBackend("claude-cli")).toBe(false);
  });

  it("codex-cli → 本地 CLI(非云端)", () => {
    expect(isCloudBackend("codex-cli")).toBe(false);
  });

  it("kiro-cli → 本地 CLI(非云端)", () => {
    expect(isCloudBackend("kiro-cli")).toBe(false);
  });
});

// ─── 2. shouldInjectMemoryToEngine ───────────────────────────────────────────

describe("shouldInjectMemoryToEngine — 仅本地大脑开关的注入决策", () => {
  it("localOnlyBrain=false → 无论后端都注入(默认行为)", () => {
    expect(shouldInjectMemoryToEngine(false, "deepseek-api")).toBe(true);
    expect(shouldInjectMemoryToEngine(false, "claude-cli")).toBe(true);
    expect(shouldInjectMemoryToEngine(false, "codex-cli")).toBe(true);
  });

  it("localOnlyBrain=true + 本地 CLI → 注入(本地引擎可接收记忆)", () => {
    expect(shouldInjectMemoryToEngine(true, "claude-cli")).toBe(true);
    expect(shouldInjectMemoryToEngine(true, "codex-cli")).toBe(true);
    expect(shouldInjectMemoryToEngine(true, "kiro-cli")).toBe(true);
  });

  it("localOnlyBrain=true + 云端 API → 不注入(隐私保护)", () => {
    expect(shouldInjectMemoryToEngine(true, "deepseek-api")).toBe(false);
  });
});

// ─── 3. buildSensitiveMemoryInstruction ──────────────────────────────────────

describe("buildSensitiveMemoryInstruction — 敏感不记指令", () => {
  it("noSensitiveMemory=false → 返回空字符串(不注入额外指令)", () => {
    expect(buildSensitiveMemoryInstruction(false, "zh")).toBe("");
    expect(buildSensitiveMemoryInstruction(false, "en")).toBe("");
  });

  it("noSensitiveMemory=true + zh → 返回中文禁记指令", () => {
    const out = buildSensitiveMemoryInstruction(true, "zh");
    expect(out.length).toBeGreaterThan(0);
    // 指令应涵盖典型敏感类别
    expect(out.toLowerCase()).toMatch(/密码|财务|身份证|隐私|敏感/);
  });

  it("noSensitiveMemory=true + en → 返回英文禁记指令", () => {
    const out = buildSensitiveMemoryInstruction(true, "en");
    expect(out.length).toBeGreaterThan(0);
    expect(out.toLowerCase()).toMatch(/password|financial|sensitive|private/);
  });

  it("指令是字符串(不含 undefined/null)", () => {
    const zh = buildSensitiveMemoryInstruction(true, "zh");
    const en = buildSensitiveMemoryInstruction(true, "en");
    expect(typeof zh).toBe("string");
    expect(typeof en).toBe("string");
  });
});

// ─── 4. applyLowPowerPreset ───────────────────────────────────────────────────

describe("applyLowPowerPreset — 省电/低频模式预设", () => {
  it("返回的 heartbeatMin 等于 LOW_POWER_HEARTBEAT_MIN(>=120)", () => {
    const patch = applyLowPowerPreset();
    expect(patch.heartbeatMin).toBe(LOW_POWER_HEARTBEAT_MIN);
    expect(LOW_POWER_HEARTBEAT_MIN).toBeGreaterThanOrEqual(120);
  });

  it("返回的 budgetPerHalfDay 是正整数且 ≤ 2(低频预算紧缩)", () => {
    const patch = applyLowPowerPreset();
    expect(patch.budgetPerHalfDay).toBeGreaterThan(0);
    expect(patch.budgetPerHalfDay).toBeLessThanOrEqual(2);
  });

  it("返回纯对象,可直接传入 setProactive", () => {
    const patch = applyLowPowerPreset();
    expect(typeof patch).toBe("object");
    expect(patch).not.toBeNull();
  });
});

// ─── 5. LOW_POWER_HEARTBEAT_MIN 常量自检 ─────────────────────────────────────

describe("LOW_POWER_HEARTBEAT_MIN 常量", () => {
  it("是比默认心跳(90min)更大的值", () => {
    // defaultProactiveConfig().heartbeatMin = 90 (DEFAULT_HEARTBEAT_MIN)
    expect(LOW_POWER_HEARTBEAT_MIN).toBeGreaterThan(90);
  });
});
