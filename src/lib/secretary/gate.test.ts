/**
 * gate.test.ts — Task 1.6 防骚扰纯函数闸门 + 简报投递集成
 *
 * 验收覆盖:
 *  1. gate() 纯函数 — 静默时段(工作时段外)
 *  2. gate() 纯函数 — pausedUntil("别烦我")
 *  3. gate() 纯函数 — 去重窗口(与最近同类/同内容重复)
 *  4. gate() 纯函数 — 温和频率(最小间隔)
 *  5. 边界:工作时段起止 ±1min、pausedUntil 临界值
 *  6. 简报投递路径:静默时段时 composeMorningBriefing 不被调用;工作时段内正常投递
 *
 * 所有时间从 now 注入,函数体内不读 Date.now()。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { gate, type GateCandidate, type GateState, DEDUP_WINDOW_MS, MIN_INTERVAL_MS } from "./gate";

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 返回当天 HH:mm 对应的 Date 对象(固定日期 2026-06-15) */
function makeDate(hour: number, min = 0): Date {
  return new Date(2026, 5, 15, hour, min, 0, 0); // month is 0-indexed
}

/** 返回 makeDate(h, m).getTime() */
function makeMs(hour: number, min = 0): number {
  return makeDate(hour, min).getTime();
}

/** 默认工作时段配置 9-22 */
const DEFAULT_WORK_START = 9;
const DEFAULT_WORK_END = 22;

function makeCandidate(overrides: Partial<GateCandidate> = {}): GateCandidate {
  return {
    type: "morning-briefing",
    content: "早上好！今天有 2 个任务。",
    workStart: DEFAULT_WORK_START,
    workEnd: DEFAULT_WORK_END,
    ...overrides,
  };
}

function makeState(overrides: Partial<GateState> = {}): GateState {
  return {
    recentlySent: [],
    pausedUntil: undefined,
    lastProactiveSentMs: undefined,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 静默时段:工作时段外 → 不发
// ════════════════════════════════════════════════════════════════════════════
describe("gate — 静默时段(工作时段外)", () => {
  it("工作时段前(08:59)→ allow=false", () => {
    const result = gate(makeCandidate(), makeState(), makeDate(8, 59));
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/silent|quiet|时段|work/i);
  });

  it("工作时段开始边界(09:00)→ allow=true", () => {
    const result = gate(makeCandidate(), makeState(), makeDate(9, 0));
    expect(result.allow).toBe(true);
  });

  it("工作时段内(14:00)→ allow=true", () => {
    const result = gate(makeCandidate(), makeState(), makeDate(14, 0));
    expect(result.allow).toBe(true);
  });

  it("工作时段结束边界(22:00)→ allow=false(workEnd 是开区间)", () => {
    const result = gate(makeCandidate(), makeState(), makeDate(22, 0));
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/silent|quiet|时段|work/i);
  });

  it("工作时段内最后一分钟(21:59)→ allow=true", () => {
    const result = gate(makeCandidate(), makeState(), makeDate(21, 59));
    expect(result.allow).toBe(true);
  });

  it("深夜(23:00)→ allow=false", () => {
    const result = gate(makeCandidate(), makeState(), makeDate(23, 0));
    expect(result.allow).toBe(false);
  });

  it("凌晨(00:00)→ allow=false", () => {
    const result = gate(makeCandidate(), makeState(), makeDate(0, 0));
    expect(result.allow).toBe(false);
  });

  it("自定义 workStart=8 workEnd=20:工作时段 8-20,07:59 不发,08:00 发,19:59 发,20:00 不发", () => {
    const c = makeCandidate({ workStart: 8, workEnd: 20 });
    expect(gate(c, makeState(), makeDate(7, 59)).allow).toBe(false);
    expect(gate(c, makeState(), makeDate(8, 0)).allow).toBe(true);
    expect(gate(c, makeState(), makeDate(19, 59)).allow).toBe(true);
    expect(gate(c, makeState(), makeDate(20, 0)).allow).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. pausedUntil("别烦我")
// ════════════════════════════════════════════════════════════════════════════
describe("gate — pausedUntil", () => {
  const nowMs = makeMs(10, 0); // 工作时段内
  const now = new Date(nowMs);

  it("pausedUntil > now → allow=false", () => {
    const state = makeState({ pausedUntil: nowMs + 1 });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/pause|paused|暂停/i);
  });

  it("pausedUntil === now → allow=false(临界:严格小于才过期)", () => {
    const state = makeState({ pausedUntil: nowMs });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(false);
  });

  it("pausedUntil < now(已过) → allow=true(其余条件满足)", () => {
    const state = makeState({ pausedUntil: nowMs - 1 });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(true);
  });

  it("pausedUntil undefined → 不限制", () => {
    const state = makeState({ pausedUntil: undefined });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. 去重:与最近同类/同内容重复 → 不发
// ════════════════════════════════════════════════════════════════════════════
describe("gate — 去重窗口", () => {
  const nowMs = makeMs(10, 0);
  const now = new Date(nowMs);

  it("刚发过同类(sentAt 在去重窗口内)→ allow=false", () => {
    const state = makeState({
      recentlySent: [
        { type: "morning-briefing", content: "某些内容", sentAt: nowMs - 1000 }, // 1s 前
      ],
    });
    const result = gate(makeCandidate({ type: "morning-briefing" }), state, now);
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/dup|dedup|重复|duplicate/i);
  });

  it("同类但 sentAt 在去重窗口外 → allow=true", () => {
    const state = makeState({
      recentlySent: [
        { type: "morning-briefing", content: "某些内容", sentAt: nowMs - DEDUP_WINDOW_MS - 1 },
      ],
    });
    const result = gate(makeCandidate({ type: "morning-briefing" }), state, now);
    expect(result.allow).toBe(true);
  });

  it("去重窗口边界(sentAt = nowMs - DEDUP_WINDOW_MS)→ allow=false(窗口内边界)", () => {
    const state = makeState({
      recentlySent: [
        { type: "morning-briefing", content: "某些内容", sentAt: nowMs - DEDUP_WINDOW_MS },
      ],
    });
    // 边界:elapsed === DEDUP_WINDOW_MS → 仍在窗口内(< 不满足)
    const result = gate(makeCandidate({ type: "morning-briefing" }), state, now);
    expect(result.allow).toBe(false);
  });

  it("不同类型的最近发送不触发去重 → allow=true", () => {
    const state = makeState({
      recentlySent: [
        { type: "daily-digest", content: "日报内容", sentAt: nowMs - 1000 },
      ],
    });
    const result = gate(makeCandidate({ type: "morning-briefing" }), state, now);
    expect(result.allow).toBe(true);
  });

  it("recentlySent 为空 → 不触发去重", () => {
    const state = makeState({ recentlySent: [] });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 温和频率:最小间隔
// ════════════════════════════════════════════════════════════════════════════
describe("gate — 温和频率(最小间隔)", () => {
  const nowMs = makeMs(10, 0);
  const now = new Date(nowMs);

  it("上次主动发送在 MIN_INTERVAL_MS 内 → allow=false", () => {
    const state = makeState({ lastProactiveSentMs: nowMs - MIN_INTERVAL_MS + 1 });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/interval|频率|rate/i);
  });

  it("lastProactiveSentMs === nowMs - MIN_INTERVAL_MS → allow=false(边界:严格 >)", () => {
    const state = makeState({ lastProactiveSentMs: nowMs - MIN_INTERVAL_MS });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(false);
  });

  it("上次主动发送超过 MIN_INTERVAL_MS → allow=true", () => {
    const state = makeState({ lastProactiveSentMs: nowMs - MIN_INTERVAL_MS - 1 });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(true);
  });

  it("lastProactiveSentMs undefined(从未发过)→ 不限制", () => {
    const state = makeState({ lastProactiveSentMs: undefined });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. 综合:多个拦截条件同时满足时任一触发即拒绝
// ════════════════════════════════════════════════════════════════════════════
describe("gate — 综合拒绝优先级", () => {
  it("工作时段外 + pausedUntil 未过 → allow=false(静默时段优先)", () => {
    const now = makeDate(8, 0); // 工作时段前
    const state = makeState({ pausedUntil: now.getTime() + 1000 });
    const result = gate(makeCandidate(), state, now);
    expect(result.allow).toBe(false);
  });

  it("所有条件都满足 → allow=true", () => {
    const now = makeDate(10, 0); // 工作时段内
    const state = makeState({
      pausedUntil: now.getTime() - 1, // 已过
      recentlySent: [
        {
          type: "daily-digest", // 不同类型,不触发去重
          content: "xxx",
          sentAt: now.getTime() - 1000,
        },
      ],
      lastProactiveSentMs: now.getTime() - MIN_INTERVAL_MS - 1, // 超过最小间隔
    });
    const result = gate(makeCandidate({ type: "morning-briefing" }), state, now);
    expect(result.allow).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. 简报投递路径:gate 接进 createMorningBriefingJob
// ════════════════════════════════════════════════════════════════════════════

// ─── mock 依赖(简报路径集成测试) ────────────────────────────────────────────
//
// 策略:直接 mock composeMorningBriefing(gate.ts 的直接依赖边界),
// 避免 LLM provider 单例缓存 / 网络请求等深层干扰。
// 这样可以精准断言:gate 通过时 compose 被调,gate 拒绝时 compose 不被调。

let composeMorningBriefingMock: ReturnType<typeof vi.fn>;

vi.mock("./composeProactive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./composeProactive")>();
  return {
    ...actual,
    composeMorningBriefing: vi.fn(async () => "conv-mock-id"),
  };
});

vi.mock("../settings", () => ({
  onProviderConfigChange: () => () => undefined,
  useSettingsStore: {
    getState: () => ({
      lang: "zh",
      persona: { presetKey: "seniorAdvisor" },
      reminder: {
        enabled: true,
        workStart: 9,
        workEnd: 22,
        intervalMin: 120,
        channel: "both",
      },
      llmProvider: "deepseek",
      providers: {
        deepseek: {
          apiKey: "test-key",
          baseUrl: "https://example.test",
          model: "deepseek-chat",
        },
      },
    }),
  },
}));

import { composeMorningBriefing } from "./composeProactive";
import { createMorningBriefingJobWithGate } from "./gate";

beforeEach(() => {
  composeMorningBriefingMock = vi.mocked(composeMorningBriefing);
  composeMorningBriefingMock.mockClear();
});

describe("简报投递路径 — gate 接入 createMorningBriefingJob", () => {
  it("静默时段(工作时段外)触发简报 run() → 不投递(composeMorningBriefing 不被调用)", async () => {
    const job = createMorningBriefingJobWithGate({
      morningHour: 7,
      gateStateProvider: () => makeState(),
      nowProvider: () => makeDate(3, 0), // 凌晨 03:00 → 工作时段外
    });

    await (job.run as () => Promise<void>)();
    expect(composeMorningBriefingMock).not.toHaveBeenCalled();
  });

  it("工作时段内触发简报 run() → 正常投递(composeMorningBriefing 被调用)", async () => {
    const job = createMorningBriefingJobWithGate({
      morningHour: 7,
      gateStateProvider: () => makeState(),
      nowProvider: () => makeDate(9, 0), // 09:00 → 工作时段内
    });

    await (job.run as () => Promise<void>)();
    expect(composeMorningBriefingMock).toHaveBeenCalledTimes(1);
  });

  it("pausedUntil 未过时触发简报 run() → 不投递", async () => {
    const now = makeDate(10, 0);
    const nowMs = now.getTime();

    const job = createMorningBriefingJobWithGate({
      morningHour: 7,
      gateStateProvider: () =>
        makeState({
          pausedUntil: nowMs + 60 * 60 * 1000, // 1h 后才解除
        }),
      nowProvider: () => now,
    });

    await (job.run as () => Promise<void>)();
    expect(composeMorningBriefingMock).not.toHaveBeenCalled();
  });

  it("已发过简报(去重窗口内)→ 不投递", async () => {
    const now = makeDate(10, 0);
    const nowMs = now.getTime();

    const job = createMorningBriefingJobWithGate({
      morningHour: 7,
      gateStateProvider: () =>
        makeState({
          recentlySent: [
            { type: "morning-briefing", content: "已发过", sentAt: nowMs - 1000 },
          ],
        }),
      nowProvider: () => now,
    });

    await (job.run as () => Promise<void>)();
    expect(composeMorningBriefingMock).not.toHaveBeenCalled();
  });
});
