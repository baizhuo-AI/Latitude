/**
 * proactiveConfig.test.ts — Task 3.4 主动姿态配置(三档 + 高玩字段)
 *
 * 配置真相源在 settings.ts 的 SettingsState.proactive(ProactiveConfig)。
 * 本文件测两件事:
 *   1. settings defaults():proactive 默认存在且为「温和」(gentle),各高玩字段有合理默认。
 *   2. proactiveConfig.ts 的纯函数 modeDefaults / resolveProactiveStance:
 *      懒人三档 → 具体「是否启用 / 优先级地板基准 / 默认事件开关」的确定性映射。
 *
 * 纯函数铁律:modeDefaults / resolveProactiveStance 体内不读 Date.now()/Math.random()/store。
 */

import { describe, it, expect } from "vitest";
import { defaultSettingsForTest } from "../settings";
import {
  modeDefaults,
  resolveProactiveStance,
  PROACTIVE_FLOOR_GENTLE,
  PROACTIVE_FLOOR_ACTIVE,
  type ProactiveConfig,
} from "./proactiveConfig";
import { PRIORITY_FLOOR_GENTLE } from "./gateProactive";

// ─── 0. 防漂移:温和地板字面量必须与 gateProactive 真相对齐 ──────────────────
// proactiveConfig.ts 为破循环依赖把温和地板写成字面量 50;这里在测试侧(可安全
// import gateProactive)断言两者一致,任一改动另一个不改就会在这里红。
describe("PROACTIVE_FLOOR_GENTLE 防漂移", () => {
  it("=== gateProactive.PRIORITY_FLOOR_GENTLE", () => {
    expect(PROACTIVE_FLOOR_GENTLE).toBe(PRIORITY_FLOOR_GENTLE);
  });
});

// ─── 1. settings defaults 默认温和 ────────────────────────────────────────────
describe("settings defaults() — proactive 默认温和", () => {
  it("proactive 存在且 mode='gentle'(默认温和)", () => {
    const d = defaultSettingsForTest();
    expect(d.proactive).toBeDefined();
    expect(d.proactive.mode).toBe("gentle");
  });

  it("高玩字段有合理默认:morningHour=7 / 渠道=chat", () => {
    const d = defaultSettingsForTest();
    expect(d.proactive.morningHour).toBe(7);
    expect(d.proactive.channel).toBe("chat");
  });

  it("事件开关默认全开(具体放不放由闸门 + 优先级地板把关)", () => {
    const d = defaultSettingsForTest();
    expect(d.proactive.events.meetingSoon).toBe(true);
    expect(d.proactive.events.deadlineNear).toBe(true);
    expect(d.proactive.events.taskStuck).toBe(true);
    expect(d.proactive.events.justCompleted).toBe(true);
  });
});

// ─── 2. modeDefaults 纯函数 ───────────────────────────────────────────────────
describe("modeDefaults — 三档 → 具体行为(纯)", () => {
  it("off:不启用主动", () => {
    expect(modeDefaults("off").enabled).toBe(false);
  });

  it("gentle:启用 + 地板=温和(更高,只放紧迫的)", () => {
    const m = modeDefaults("gentle");
    expect(m.enabled).toBe(true);
    expect(m.priorityFloor).toBe(PROACTIVE_FLOOR_GENTLE);
  });

  it("active:启用 + 地板=积极(更低,允许背景类)", () => {
    const m = modeDefaults("active");
    expect(m.enabled).toBe(true);
    expect(m.priorityFloor).toBe(PROACTIVE_FLOOR_ACTIVE);
    expect(m.priorityFloor).toBeLessThan(PROACTIVE_FLOOR_GENTLE);
  });

  it("确定性:同档多次调用结果相同", () => {
    expect(modeDefaults("gentle")).toEqual(modeDefaults("gentle"));
  });
});

// ─── 3. resolveProactiveStance 纯函数(config → 生效姿态) ──────────────────────
describe("resolveProactiveStance — config → 生效姿态(纯)", () => {
  function cfg(over: Partial<ProactiveConfig> = {}): ProactiveConfig {
    return {
      mode: "gentle",
      heartbeatMin: 90,
      morningHour: 7,
      budgetPerHalfDay: 3,
      channel: "chat",
      events: { meetingSoon: true, deadlineNear: true, taskStuck: true, justCompleted: true },
      ...over,
    };
  }

  it("mode=off:enabled=false(其余字段不影响这个总闸)", () => {
    expect(resolveProactiveStance(cfg({ mode: "off" })).enabled).toBe(false);
  });

  it("mode=gentle:enabled=true + 地板=温和 + 预算/心跳/渠道透传", () => {
    const s = resolveProactiveStance(cfg({ mode: "gentle", budgetPerHalfDay: 2, heartbeatMin: 120, channel: "notification" }));
    expect(s.enabled).toBe(true);
    expect(s.priorityFloor).toBe(PROACTIVE_FLOOR_GENTLE);
    expect(s.budgetPerHalfDay).toBe(2);
    expect(s.heartbeatMin).toBe(120);
    expect(s.channel).toBe("notification");
  });

  it("mode=active:地板=积极", () => {
    expect(resolveProactiveStance(cfg({ mode: "active" })).priorityFloor).toBe(PROACTIVE_FLOOR_ACTIVE);
  });

  it("事件开关透传:关掉 justCompleted 后 stance 里它为 false", () => {
    const s = resolveProactiveStance(cfg({ events: { meetingSoon: true, deadlineNear: true, taskStuck: false, justCompleted: false } }));
    expect(s.events.taskStuck).toBe(false);
    expect(s.events.justCompleted).toBe(false);
    expect(s.events.meetingSoon).toBe(true);
  });

  it("确定性:同 config 多次调用结果相同", () => {
    const c = cfg();
    expect(resolveProactiveStance(c)).toEqual(resolveProactiveStance(c));
  });
});
