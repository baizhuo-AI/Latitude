/**
 * startupBackfill.test.ts — Task 1.5 验收测试
 *
 * 覆盖:
 *  1. composeMorningBriefing 首日分支 — 无任何往日纪要时走首日 prompt
 *  2. shouldBackfill 纯函数 — 全部确定性用例 + 边界
 *  3. 补发的简报有"补"标记(content 或 type 体现)
 *  4. backfillOnStartup — 编排函数,该补时调 compose,不该补时静默
 *  5. 漏跑纪要场景 — 缺一天纪要时 composeMorningBriefing 不报错 + 能补跑
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEngine, installFakeEngine } from "../llm/fakeEngine";

// ─── 注入共享假引擎 ───────────────────────────────────────────────────────────
const { setEngine } = installFakeEngine();
let engine: FakeEngine;

// ─── 内存 DB 状态 ─────────────────────────────────────────────────────────────
const _conversations = new Map<string, { id: string; title: string; createdAt: string; updatedAt: string }>();
const _messages = new Map<string, Array<{ id: string; convId: string; role: string; content: string; createdAt: string }>>();
const _digestStore = new Map<string, { summary: string; created_at: string }>();
let _fakeTodosForDate: Array<{ title: string; status: string; scheduled_date: string | null; created_at: string; completed_at: string | null }> = [];
let _fakeProactiveLog: Array<{ type: string; sent_at: string; conv_id: string }> = [];
let _fakeMessagesOnDate: Array<{ role: string; content: string; created_at: string }> = [];

// 跟踪 emitSync 调用
const emitSyncCalls: string[] = [];

// ─── mock syncBus ─────────────────────────────────────────────────────────────
vi.mock("../syncBus", () => ({
  emitSync: vi.fn((topic: string) => {
    emitSyncCalls.push(topic);
  }),
}));

// ─── mock db ─────────────────────────────────────────────────────────────────
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dbInsertUsage: vi.fn(async () => undefined),
    dbGetRecentDigests: vi.fn(async (n: number) => {
      return Array.from(_digestStore.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, n)
        .map(([date, row]) => ({ date, summary: row.summary, createdAt: row.created_at }));
    }),
    dbListTodosOnDate: vi.fn(async (_dateKey: string) => _fakeTodosForDate),
    dbListMessagesOnDate: vi.fn(async (_dateKey: string) => _fakeMessagesOnDate),
    dbUpsertDailyDigest: vi.fn(async (date: string, summary: string) => {
      _digestStore.set(date, { summary, created_at: new Date().toISOString() });
    }),
    dbInsertConversation: vi.fn(async (conv: { id: string; title: string; createdAt: string; updatedAt: string }) => {
      _conversations.set(conv.id, conv);
      if (!_messages.has(conv.id)) _messages.set(conv.id, []);
    }),
    dbInsertMessage: vi.fn(async (msg: { id: string; convId: string; role: string; content: string; createdAt: string }) => {
      const list = _messages.get(msg.convId) ?? [];
      list.push(msg);
      _messages.set(msg.convId, list);
    }),
    dbTouchConversation: vi.fn(async (id: string) => {
      const conv = _conversations.get(id);
      if (conv) _conversations.set(id, { ...conv, updatedAt: new Date().toISOString() });
    }),
    dbListConversations: vi.fn(async () => {
      return Array.from(_conversations.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }),
    dbListMessages: vi.fn(async (convId: string) => {
      return (_messages.get(convId) ?? []).map(m => ({
        id: m.id,
        convId: m.convId,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      }));
    }),
    dbLogProactiveSent: vi.fn(async (entry: { type: string; convId: string; contentPreview: string }) => {
      _fakeProactiveLog.push({ type: entry.type, sent_at: new Date().toISOString(), conv_id: entry.convId });
    }),
  };
});

// ─── mock chatStore ────────────────────────────────────────────────────────────
vi.mock("../chatStore", () => ({
  useChatStore: {
    getState: () => ({
      conversations: [],
      currentId: null,
      messagesByConv: {},
    }),
  },
}));

// ─── mock store + goalsStore ──────────────────────────────────────────────────
vi.mock("../store", () => ({
  useTodoStore: { getState: () => ({ todos: [] }) },
}));
vi.mock("../goalsStore", () => ({
  useGoalsStore: { getState: () => ({ goals: [] }) },
}));

// ─── mock settings ────────────────────────────────────────────────────────────
vi.mock("../settings", () => ({
  onProviderConfigChange: () => () => undefined,
  useSettingsStore: {
    getState: () => ({
      lang: "zh",
      persona: { presetKey: "seniorAdvisor" },
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

// ─── mock chatTools ───────────────────────────────────────────────────────────
vi.mock("../chatTools", () => ({
  toolsForLLM: () => [],
  runChatTool: async () => "{}",
}));

// ─── 被测模块 ─────────────────────────────────────────────────────────────────
import { composeMorningBriefing, type MorningBriefingCtx } from "./composeProactive";
import {
  shouldBackfill,
  backfillOnStartup,
  runDigestBackfill,
  type BackfillCtx,
  type BackfillInput,
} from "./startupBackfill";
import { dbInsertMessage, dbInsertConversation, dbGetRecentDigests } from "../db";

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────
function makeTs(hour: number, minute = 0, dateStr = "2026-06-15"): number {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function makeDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

beforeEach(() => {
  engine = setEngine(new FakeEngine());
  engine.script = [{ content: "测试简报内容", model: "deepseek-chat" }];
  _conversations.clear();
  _messages.clear();
  _digestStore.clear();
  _fakeTodosForDate = [];
  _fakeProactiveLog = [];
  _fakeMessagesOnDate = [];
  emitSyncCalls.length = 0;
  vi.mocked(dbInsertMessage).mockClear();
  vi.mocked(dbInsertConversation).mockClear();
  vi.mocked(dbGetRecentDigests).mockClear();
});

// ════════════════════════════════════════════════════════════════════════════
// 1. composeMorningBriefing — 首日分支
// ════════════════════════════════════════════════════════════════════════════
describe("composeMorningBriefing — 首日分支(无任何往日纪要)", () => {
  it("首日(无纪要)→ system prompt 走首日分支,包含自我介绍/引导关键词", async () => {
    // 不向 _digestStore 写入任何数据 → 首日场景
    engine.script = [{ content: "你好！我是你的 AI 秘书 Daybreak…", model: "deepseek-chat" }];

    const ctx: MorningBriefingCtx = {
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
    };

    const convId = await composeMorningBriefing(ctx);
    expect(convId).toBeTruthy();

    // generateOnce 被调了一次
    expect(engine.received).toHaveLength(1);
    const call = engine.received[0];

    // 首日分支:system prompt 应含首日/自我介绍相关关键词
    const sysMsg = call.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toMatch(
      /首日|初次|自我介绍|欢迎|关于你|about you|first day|introduce|welcome/i
    );
  });

  it("首日(无纪要)→ 用户消息不含昨日纪要内容,但包含今日数据", async () => {
    _fakeTodosForDate = [
      { title: "完成项目计划", status: "todo", scheduled_date: "2026-06-15", created_at: new Date().toISOString(), completed_at: null },
    ];

    engine.script = [{ content: "首日简报内容", model: "deepseek-chat" }];

    const ctx: MorningBriefingCtx = {
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
    };

    await composeMorningBriefing(ctx);

    const call = engine.received[0];
    const userMsg = call.messages.find((m) => m.role === "user");
    // 不含昨日纪要正文(因为没有)
    expect(userMsg?.content).not.toContain("昨天");
    // 包含今日任务
    expect(userMsg?.content).toContain("完成项目计划");
  });

  it("首日 lang=en 时,system prompt 包含英文首日关键词", async () => {
    engine.script = [{ content: "Hello! I'm your AI secretary...", model: "deepseek-chat" }];

    const ctx: MorningBriefingCtx = {
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "en",
    };

    await composeMorningBriefing(ctx);

    const call = engine.received[0];
    const sysMsg = call.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toMatch(
      /first day|introduce|welcome|about you/i
    );
  });

  it("有往日纪要时,走普通分支(不走首日)", async () => {
    _digestStore.set("2026-06-14", { summary: "昨日已有纪要", created_at: new Date().toISOString() });
    engine.script = [{ content: "普通晨报", model: "deepseek-chat" }];

    const ctx: MorningBriefingCtx = {
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
    };

    await composeMorningBriefing(ctx);

    const call = engine.received[0];
    const sysMsg = call.messages.find((m) => m.role === "system");
    // 有历史纪要时不应出现首日引导
    expect(sysMsg?.content).not.toMatch(/首日|初次|自我介绍|first day|introduce/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. shouldBackfill 纯函数
// ════════════════════════════════════════════════════════════════════════════
describe("shouldBackfill — 纯函数确定性用例", () => {
  // 基准:今天 2026-06-15,晨报时间 07:00,晌午 12:00
  // morningHour=7, noonHour=12

  it("今天没发过 + 已过晨报时间 + 未过晌午 + 用户今天未活跃 → true", () => {
    const input: BackfillInput = {
      lastSentAt: undefined,            // 今天没发过
      now: makeTs(9, 0),               // 09:00,已过 07:00,未过 12:00
      morningHour: 7,
      noonHour: 12,
      userActiveToday: false,
    };
    expect(shouldBackfill(input)).toBe(true);
  });

  it("今天已发过简报 → false", () => {
    const input: BackfillInput = {
      lastSentAt: makeTs(7, 5),        // 今天 07:05 已发过
      now: makeTs(9, 0),
      morningHour: 7,
      noonHour: 12,
      userActiveToday: false,
    };
    expect(shouldBackfill(input)).toBe(false);
  });

  it("已过晌午(12:00) → false (不误补'早安简报')", () => {
    const input: BackfillInput = {
      lastSentAt: undefined,
      now: makeTs(12, 0),              // 正好 12:00 = noonHour,过了
      morningHour: 7,
      noonHour: 12,
      userActiveToday: false,
    };
    expect(shouldBackfill(input)).toBe(false);
  });

  it("已过晌午(14:30) → false", () => {
    const input: BackfillInput = {
      lastSentAt: undefined,
      now: makeTs(14, 30),
      morningHour: 7,
      noonHour: 12,
      userActiveToday: false,
    };
    expect(shouldBackfill(input)).toBe(false);
  });

  it("用户今天已开过对话(活跃) → false", () => {
    const input: BackfillInput = {
      lastSentAt: undefined,
      now: makeTs(9, 0),
      morningHour: 7,
      noonHour: 12,
      userActiveToday: true,
    };
    expect(shouldBackfill(input)).toBe(false);
  });

  it("未到晨报时间(06:59) → false", () => {
    const input: BackfillInput = {
      lastSentAt: undefined,
      now: makeTs(6, 59),
      morningHour: 7,
      noonHour: 12,
      userActiveToday: false,
    };
    expect(shouldBackfill(input)).toBe(false);
  });

  it("边界:正好晨报时间(07:00)且未过晌午 → true", () => {
    const input: BackfillInput = {
      lastSentAt: undefined,
      now: makeTs(7, 0),
      morningHour: 7,
      noonHour: 12,
      userActiveToday: false,
    };
    expect(shouldBackfill(input)).toBe(true);
  });

  it("边界:晌午前 1 分钟(11:59) → true", () => {
    const input: BackfillInput = {
      lastSentAt: undefined,
      now: makeTs(11, 59),
      morningHour: 7,
      noonHour: 12,
      userActiveToday: false,
    };
    expect(shouldBackfill(input)).toBe(true);
  });

  it("lastSentAt 是昨天的 → 今天没发过,应 true(若其他条件满足)", () => {
    const yesterday = new Date("2026-06-14T07:05:00");
    const input: BackfillInput = {
      lastSentAt: yesterday.getTime(),
      now: makeTs(9, 0),               // 今天 09:00
      morningHour: 7,
      noonHour: 12,
      userActiveToday: false,
    };
    expect(shouldBackfill(input)).toBe(true);
  });

  it("lastSentAt 是今天早些时候(今天已发过) → false", () => {
    const input: BackfillInput = {
      lastSentAt: makeTs(7, 30),       // 今天 07:30 已发过
      now: makeTs(10, 0),
      morningHour: 7,
      noonHour: 12,
      userActiveToday: false,
    };
    expect(shouldBackfill(input)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. 补发简报有"补"标记
// ════════════════════════════════════════════════════════════════════════════
describe("补发简报 — backfillOnStartup 产出有'补'标记", () => {
  it("backfillOnStartup 补发时,对话标题或日志类型体现'补发'", async () => {
    engine.script = [{ content: "补发晨报内容", model: "deepseek-chat" }];

    const now = makeTs(9, 0);
    const dateKey = makeDateKey(now);
    const yesterdayTs = now - 24 * 60 * 60 * 1000;
    const yesterdayKey = makeDateKey(yesterdayTs);

    const ctx: BackfillCtx = {
      now,
      dateKey,
      yesterdayKey,
      lang: "zh",
      lastSentAt: undefined,          // 今天没发过
      userActiveToday: false,
      morningHour: 7,
      noonHour: 12,
    };

    const result = await backfillOnStartup(ctx);
    expect(result.didBackfill).toBe(true);

    // 对话标题体现"补发"
    const conv = _conversations.get(result.convId!);
    expect(conv?.title).toMatch(/补发|backfill|missed/i);
  });

  it("backfillOnStartup:不该补发时返回 didBackfill=false 且不投递", async () => {
    const now = makeTs(14, 0); // 已过晌午

    const ctx: BackfillCtx = {
      now,
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
      lastSentAt: undefined,
      userActiveToday: false,
      morningHour: 7,
      noonHour: 12,
    };

    const result = await backfillOnStartup(ctx);
    expect(result.didBackfill).toBe(false);
    expect(result.convId).toBeUndefined();
    expect(dbInsertMessage).not.toHaveBeenCalled();
  });

  it("backfillOnStartup 补发时,proactive_log type 体现'补发'", async () => {
    engine.script = [{ content: "补发的简报", model: "deepseek-chat" }];

    const now = makeTs(9, 0);
    const ctx: BackfillCtx = {
      now,
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
      lastSentAt: undefined,
      userActiveToday: false,
      morningHour: 7,
      noonHour: 12,
    };

    await backfillOnStartup(ctx);

    // proactive_log 里应有 type 含 backfill 的记录
    const backfillLog = _fakeProactiveLog.find(
      (r) => r.type.includes("backfill") || r.type.includes("补")
    );
    expect(backfillLog).toBeTruthy();
  });

  it("用户今天活跃过 → 不补发", async () => {
    const now = makeTs(9, 0);
    const ctx: BackfillCtx = {
      now,
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
      lastSentAt: undefined,
      userActiveToday: true,   // 用户已活跃
      morningHour: 7,
      noonHour: 12,
    };

    const result = await backfillOnStartup(ctx);
    expect(result.didBackfill).toBe(false);
    expect(dbInsertMessage).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 漏跑纪要场景 — 缺一天纪要时不报错 + 能补跑
// ════════════════════════════════════════════════════════════════════════════
describe("漏跑纪要场景 — 缺天纪要时续接/补跑", () => {
  it("composeMorningBriefing:缺昨日纪要(但有前天)时不报错,走首日分支或普通分支均可", async () => {
    // 前天有纪要,昨天没有(漏跑)
    _digestStore.set("2026-06-13", { summary: "前天的纪要", created_at: new Date().toISOString() });
    // 昨天没有纪要

    engine.script = [{ content: "简报(昨天漏跑纪要)", model: "deepseek-chat" }];

    const ctx: MorningBriefingCtx = {
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
    };

    // 不应该抛错
    await expect(composeMorningBriefing(ctx)).resolves.toBeTruthy();
  });

  it("runDigestBackfill:检测出昨天漏跑纪要并补跑", async () => {
    // 只有前天有纪要,昨天(2026-06-14)没有
    _digestStore.set("2026-06-13", { summary: "前天纪要", created_at: new Date().toISOString() });

    engine.script = [{ content: "补跑的昨日纪要", model: "deepseek-chat" }];
    // 补跑时需要消息和任务数据(空也可以)
    _fakeMessagesOnDate = [];
    _fakeTodosForDate = [];

    const result = await runDigestBackfill({
      dateKey: "2026-06-15",   // 今天
      lang: "zh",
      lookbackDays: 3,         // 往前看 3 天
    });

    // 应该成功补跑昨天的纪要
    expect(result.backfilledDates.length).toBeGreaterThan(0);
    expect(result.backfilledDates).toContain("2026-06-14");
    // _digestStore 里应该有 2026-06-14 的纪要了
    expect(_digestStore.has("2026-06-14")).toBe(true);
  });

  it("runDigestBackfill:所有近期纪要都有时,不重复补跑", async () => {
    // lookbackDays=3: 检查 2026-06-14(昨天)、2026-06-13、2026-06-12 三天
    // 全部预置,应该一条都不补
    _digestStore.set("2026-06-12", { summary: "三天前", created_at: new Date().toISOString() });
    _digestStore.set("2026-06-13", { summary: "前天", created_at: new Date().toISOString() });
    _digestStore.set("2026-06-14", { summary: "昨天", created_at: new Date().toISOString() });

    const result = await runDigestBackfill({
      dateKey: "2026-06-15",
      lang: "zh",
      lookbackDays: 3,
    });

    expect(result.backfilledDates).toHaveLength(0);
    // engine 不应被调用
    expect(engine.received).toHaveLength(0);
  });

  it("runDigestBackfill:缺多天时能补跑所有缺失天", async () => {
    // 只有 2026-06-12(3 天前)有纪要,13/14 都缺
    _digestStore.set("2026-06-12", { summary: "老纪要", created_at: new Date().toISOString() });

    engine.script = [
      { content: "补 2026-06-13 纪要", model: "deepseek-chat" },
      { content: "补 2026-06-14 纪要", model: "deepseek-chat" },
    ];

    const result = await runDigestBackfill({
      dateKey: "2026-06-15",
      lang: "zh",
      lookbackDays: 3,
    });

    // 补了 2026-06-13 和 2026-06-14
    expect(result.backfilledDates).toContain("2026-06-13");
    expect(result.backfilledDates).toContain("2026-06-14");
  });

  it("首日(完全没有纪要)→ composeMorningBriefing 不报错", async () => {
    // _digestStore 为空
    engine.script = [{ content: "首日简报", model: "deepseek-chat" }];

    const ctx: MorningBriefingCtx = {
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
    };

    await expect(composeMorningBriefing(ctx)).resolves.toBeTruthy();
    // 消息应该被投递
    expect(dbInsertMessage).toHaveBeenCalledTimes(1);
  });
});
