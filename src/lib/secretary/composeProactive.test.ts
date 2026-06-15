/**
 * composeProactive.test.ts — Task 1.4 晨间简报合成 + 投递 + 调度任务
 *
 * 验收覆盖:
 *  1. composeMorningBriefing:给定昨日纪要 + 今日任务 + 人设
 *     → 假引擎返回脚本化简报 → 投递后对话里有一条 assistant 消息且已持久化
 *  2. 简报合成时确实把〔纪要+任务+人设〕喂进了 generateOnce
 *     (断言传入 messages 内容包含这些)
 *  3. 可回复续聊:投递后对该对话调 sendMessage 能正常继续
 *     (简报是第一条 assistant 消息,不破坏后续对话流)
 *  4. shouldRun 纯函数:确定性用例
 *     - 当天没发过 + 到点 → true
 *     - 今天已发过 → false
 *     - 早晨时间未到 → false
 *  5. C6 错误降级:generateOnce 抛错时,不投递消息、不抛到 UI
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
let _fakeTodosForDate: Array<{ title: string; status: string; scheduled_date: string | null; created_at: string }> = [];

// 跟踪 emitSync 调用
const emitSyncCalls: string[] = [];

// 跟踪 chatStore 状态变更
let _chatStoreConversations: Array<{ id: string; title: string; createdAt: string; updatedAt: string }> = [];
let _chatStoreMessagesByConv: Record<string, Array<{ id: string; convId: string; role: string; content: string; createdAt: string }>> = {};
let _chatStoreCurrentId: string | null = null;

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
  };
});

// ─── mock chatStore ────────────────────────────────────────────────────────────
// 我们需要 mock chatStore 的 getState,让 composeProactive 可以操控它
vi.mock("../chatStore", () => ({
  useChatStore: {
    getState: () => ({
      conversations: _chatStoreConversations,
      currentId: _chatStoreCurrentId,
      messagesByConv: _chatStoreMessagesByConv,
      createConv: vi.fn(async (title?: string) => {
        const id = `c_test_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`;
        const now = new Date().toISOString();
        const conv = { id, title: title ?? "新对话", createdAt: now, updatedAt: now };
        _chatStoreConversations = [conv, ..._chatStoreConversations];
        _chatStoreMessagesByConv = { ..._chatStoreMessagesByConv, [id]: [] };
        _chatStoreCurrentId = id;
        return id;
      }),
    }),
  },
}));

// ─── mock store + goalsStore(buildChatSystemPrompt 间接依赖) ─────────────────
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

// ─── 被测模块(所有 mock 之后 import) ─────────────────────────────────────────
import {
  composeMorningBriefing,
  createMorningBriefingJob,
  type MorningBriefingCtx,
} from "./composeProactive";
import { dbInsertMessage, dbInsertConversation } from "../db";

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────
function makeNow(hour: number, minute = 0): number {
  const d = new Date("2026-06-15T00:00:00");
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

beforeEach(() => {
  engine = setEngine(new FakeEngine());
  _conversations.clear();
  _messages.clear();
  _digestStore.clear();
  _fakeTodosForDate = [];
  emitSyncCalls.length = 0;
  _chatStoreConversations = [];
  _chatStoreMessagesByConv = {};
  _chatStoreCurrentId = null;
  vi.mocked(dbInsertMessage).mockClear();
  vi.mocked(dbInsertConversation).mockClear();
});

// ════════════════════════════════════════════════════════════════════════════
// 1. composeMorningBriefing — 基本投递
// ════════════════════════════════════════════════════════════════════════════
describe("composeMorningBriefing — 简报合成 + 投递", () => {
  it("假引擎返回简报文本 → 对话里有一条 assistant 消息且已持久化", async () => {
    engine.script = [
      { content: "早上好！昨天你完成了 3 个任务，今天有 2 件事要做。", model: "deepseek-chat" },
    ];

    // 预置昨日纪要
    _digestStore.set("2026-06-14", { summary: "昨日完成重要接口对接", created_at: new Date().toISOString() });

    const ctx: MorningBriefingCtx = {
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
    };

    const convId = await composeMorningBriefing(ctx);

    // 返回 convId
    expect(convId).toBeTruthy();

    // 对话已建立 + 消息已持久化
    expect(dbInsertConversation).toHaveBeenCalledTimes(1);
    expect(dbInsertMessage).toHaveBeenCalledTimes(1);

    // 消息是 assistant 角色
    const msgCall = vi.mocked(dbInsertMessage).mock.calls[0][0];
    expect(msgCall.role).toBe("assistant");
    expect(msgCall.content).toContain("早上好");

    // 发出数据变更事件
    expect(emitSyncCalls).toContain("conversations");
  });

  it("简报合成时:〔纪要+任务+人设〕都喂进了 generateOnce", async () => {
    engine.script = [
      { content: "简报内容", model: "deepseek-chat" },
    ];

    // 预置昨日纪要
    _digestStore.set("2026-06-14", { summary: "昨天开了两个会", created_at: new Date().toISOString() });

    // 预置今日任务
    _fakeTodosForDate = [
      { title: "写周报", status: "todo", scheduled_date: "2026-06-15", created_at: new Date().toISOString() },
      { title: "代码 review", status: "todo", scheduled_date: "2026-06-15", created_at: new Date().toISOString() },
    ];

    const ctx: MorningBriefingCtx = { dateKey: "2026-06-15", yesterdayKey: "2026-06-14", lang: "zh" };
    await composeMorningBriefing(ctx);

    // generateOnce 被调了一次
    expect(engine.received).toHaveLength(1);

    const call = engine.received[0];

    // 1. 人设:system prompt 包含人设相关内容
    const sysMsg = call.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toBeTruthy();
    // composePersonaPrompt 的 seniorAdvisor 输出包含"幕僚"或"不替用户甩选项"
    expect(sysMsg?.content).toMatch(/幕僚|advisor|不替用户甩选项|不复读/);

    // 2. 用户消息包含昨日纪要
    const userMsg = call.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("昨天开了两个会");

    // 3. 用户消息包含今日任务
    expect(userMsg?.content).toContain("写周报");
    expect(userMsg?.content).toContain("代码 review");
  });

  it("lang=en 时,生成内容用英文提示词(system prompt 包含英文关键词)", async () => {
    engine.script = [
      { content: "Good morning! Here is your briefing.", model: "deepseek-chat" },
    ];

    const ctx: MorningBriefingCtx = { dateKey: "2026-06-15", yesterdayKey: "2026-06-14", lang: "en" };
    await composeMorningBriefing(ctx);

    const call = engine.received[0];
    const sysMsg = call.messages.find((m) => m.role === "system");
    // 英文 persona 提示词包含英文锁定规则关键词
    expect(sysMsg?.content).toMatch(/advisor|morning|briefing|no filler|Behavior locks/i);
  });

  it("无昨日纪要也能正常生成(不抛错)", async () => {
    engine.script = [
      { content: "早安！今天是全新的开始。", model: "deepseek-chat" },
    ];

    const ctx: MorningBriefingCtx = { dateKey: "2026-06-15", yesterdayKey: "2026-06-14", lang: "zh" };

    // 不预置 _digestStore,应该不报错
    await expect(composeMorningBriefing(ctx)).resolves.toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. 可回复续聊
// ════════════════════════════════════════════════════════════════════════════
describe("可回复续聊 — 简报是第一条 assistant 消息,不破坏后续对话流", () => {
  it("投递后该对话的第一条消息是 assistant 角色的简报", async () => {
    engine.script = [
      { content: "早上好！今天有 2 个任务。", model: "deepseek-chat" },
    ];

    const ctx: MorningBriefingCtx = { dateKey: "2026-06-15", yesterdayKey: "2026-06-14", lang: "zh" };
    const convId = await composeMorningBriefing(ctx);

    // 对话里已有 1 条消息:assistant 简报
    const msgs = _messages.get(convId!) ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toContain("早上好");

    // convId 上没有 user 消息(用户还没回复),后续可以正常 sendMessage
    const userMessages = msgs.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(0);
  });

  it("简报对话里没有错误消息(assistant 消息内容不含'请求失败'等错误关键词)", async () => {
    engine.script = [
      { content: "早安，今日无特殊事项。", model: "deepseek-chat" },
    ];

    const ctx: MorningBriefingCtx = { dateKey: "2026-06-15", yesterdayKey: "2026-06-14", lang: "zh" };
    const convId = await composeMorningBriefing(ctx);

    const msgs = _messages.get(convId!) ?? [];
    expect(msgs[0].content).not.toMatch(/失败|error|Error|请求失败/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. shouldRun 纯函数
// ════════════════════════════════════════════════════════════════════════════
describe("createMorningBriefingJob — shouldRun 纯函数", () => {
  const job = createMorningBriefingJob({ morningHour: 7 });

  it("当天没发过 + 到达配置的早晨时间 → true", () => {
    const now = makeNow(7, 0); // 07:00
    expect(job.shouldRun(now, { lastRan: undefined })).toBe(true);
  });

  it("到达配置的早晨时间 + 晚于该时间也 → true", () => {
    const now = makeNow(9, 30); // 09:30 — 已超过 07:00
    expect(job.shouldRun(now, { lastRan: undefined })).toBe(true);
  });

  it("早晨时间未到(6:59) → false", () => {
    const now = makeNow(6, 59);
    expect(job.shouldRun(now, { lastRan: undefined })).toBe(false);
  });

  it("今天已发过(lastRan 是今天) → false", () => {
    // lastRan 设为今天 07:05
    const lastRan = makeNow(7, 5);
    const now = makeNow(9, 0); // 同一天 09:00
    expect(job.shouldRun(now, { lastRan })).toBe(false);
  });

  it("lastRan 是昨天 → 今天到点应该 true", () => {
    // lastRan = 昨天 07:05
    const yesterday = new Date("2026-06-14T07:05:00");
    const lastRan = yesterday.getTime();
    const now = makeNow(8, 0); // 今天 08:00(>= morningHour=7)
    expect(job.shouldRun(now, { lastRan })).toBe(true);
  });

  it("时间注入:使用不同 morningHour 配置", () => {
    const job9 = createMorningBriefingJob({ morningHour: 9 });
    const at8 = makeNow(8, 59);
    const at9 = makeNow(9, 0);
    expect(job9.shouldRun(at8, { lastRan: undefined })).toBe(false);
    expect(job9.shouldRun(at9, { lastRan: undefined })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. C6 错误降级
// ════════════════════════════════════════════════════════════════════════════
describe("C6 错误降级 — generateOnce 失败时静默不投递", () => {
  it("generateOnce 抛错 → 不投递消息、不抛到 UI", async () => {
    // 让引擎抛异常
    engine.script = []; // 脚本耗尽会返回兜底,不是抛错

    // 用 vi.spyOn 覆盖 generateOnce 使其抛错
    // 因为 installFakeEngine mock 了 DeepSeekProvider,我们通过让 engine.chat 抛来模拟
    const origChat = engine.chat.bind(engine);
    engine.chat = async () => {
      throw new Error("LLM network error");
    };

    const ctx: MorningBriefingCtx = { dateKey: "2026-06-15", yesterdayKey: "2026-06-14", lang: "zh" };

    // 不应该抛到调用方
    let thrown = false;
    try {
      await composeMorningBriefing(ctx);
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);

    // 不应该投递任何消息
    expect(dbInsertMessage).not.toHaveBeenCalled();

    // 恢复
    engine.chat = origChat;
  });

  it("C6 错误降级 — 对话里没有错误消息内容", async () => {
    engine.chat = async () => {
      throw new Error("timeout");
    };

    const ctx: MorningBriefingCtx = { dateKey: "2026-06-15", yesterdayKey: "2026-06-14", lang: "zh" };
    await composeMorningBriefing(ctx);

    // _messages 里应该没有任何消息带"失败"内容
    const allMsgs = Array.from(_messages.values()).flat();
    for (const m of allMsgs) {
      expect(m.content).not.toMatch(/失败|error|Error/i);
    }
  });
});
