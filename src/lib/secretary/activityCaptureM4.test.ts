/**
 * activityCaptureM4.test.ts — 定时×主动全合 M4:修多轮重复写 验收
 *
 * 背景(M3 遗留缺陷):chatStore.sendMessage 里的 activity_capture 回写块,只看
 * "这个对话是不是 activity_capture 类型"(dbGetProactiveTypeForConv === "activity_capture"),
 * 不看"是不是首次回复"。结果:用户在同一条 activity_capture 对话里多轮往返(第 2、3… 句),
 * 每一句都会再写一条 activity_log + 一条记忆事实 —— 同一次活动捕获被重复落库,污染时间线 + 记忆。
 *
 * M4 修复:回写块用 dbHasUnrepliedProactive 门控,与 Task 1.7 的"标记已回复"共用同一信号:
 *   - 首次回复(has-unreplied = true):dbMarkProactiveReplied + 写 activity_log/记忆。
 *   - 后续回复(has-unreplied = false,已被首次标记掉):跳过回写,只走正常对话。
 *
 * 这把"标记已回复"和"回写活动/记忆"收敛到同一个门后:一条主动消息只回写一次。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEngine, installFakeEngine } from "../llm/fakeEngine";

// ─── 注入共享假引擎 ────────────────────────────────────────────────────────────
const { setEngine } = installFakeEngine();
let engine: FakeEngine;

// ─── 内存 DB 状态 ─────────────────────────────────────────────────────────────
const _messages: Array<{ id: string; convId: string; role: string; content: string }> = [];
const _proactiveLogs: Array<{
  id: string;
  type: string;
  convId: string;
  repliedAt: string | null;
}> = [];
const _activityLogs: Array<{ id: string; content: string }> = [];
const _memoryFacts: Array<{ id: string; category: string; content: string }> = [];

// 记录关键 db 调用次数(断言"只写一次")
let insertActivityCalls = 0;
let insertMemoryCalls = 0;
let markRepliedCalls = 0;

vi.mock("../syncBus", () => ({ emitSync: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => "denied"),
  sendNotification: vi.fn(),
}));
vi.mock("../windowLayout", () => ({
  openTodoFloat: vi.fn(async () => undefined),
  WIN_MAIN: "main",
}));

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dbInsertUsage: vi.fn(async () => undefined),
    dbInsertConversation: vi.fn(async () => undefined),
    dbInsertMessage: vi.fn(async (msg: { id: string; convId: string; role: string; content: string }) => {
      _messages.push(msg);
    }),
    dbUpdateMessageContent: vi.fn(async () => undefined),
    dbTouchConversation: vi.fn(async () => undefined),
    // has-unreplied:派生自 _proactiveLogs(有 repliedAt===null 的记录就算未回复)
    dbHasUnrepliedProactive: vi.fn(async (convId: string) =>
      _proactiveLogs.some((r) => r.convId === convId && r.repliedAt === null)
    ),
    dbMarkProactiveReplied: vi.fn(async (convId: string, at: string) => {
      markRepliedCalls += 1;
      for (const r of _proactiveLogs) {
        if (r.convId === convId && r.repliedAt === null) r.repliedAt = at;
      }
    }),
    dbMarkProactiveDismissed: vi.fn(async () => undefined),
    dbGetProactiveTypeForConv: vi.fn(async (convId: string) => {
      const rec = _proactiveLogs.find((r) => r.convId === convId);
      return rec?.type ?? undefined;
    }),
    dbInsertActivity: vi.fn(async (rec: { id: string; content: string }) => {
      insertActivityCalls += 1;
      _activityLogs.push(rec);
    }),
    dbInsertMemoryFact: vi.fn(async (input: { category: string; content: string }) => {
      insertMemoryCalls += 1;
      const id = `mf${Date.now()}_${Math.random()}`;
      _memoryFacts.push({ id, ...input });
      return id;
    }),
    dbListConversations: vi.fn(async () => []),
    dbListMessages: vi.fn(async (convId: string) => _messages.filter((m) => m.convId === convId)),
  };
});

vi.mock("../settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fakeState = { lang: "zh", persona: { presetKey: "seniorAdvisor" }, chatBackend: "deepseek-api" };
  return {
    ...actual,
    useSettingsStore: {
      getState: vi.fn(() => fakeState),
      setState: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    },
    readSettingsSnapshot: vi.fn(() => fakeState),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("../llm", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildChatSystemPrompt: vi.fn(async () => "mock system prompt"),
    chatAgentCall: vi.fn(async () => ({ content: "mock assistant reply" })),
  };
});
vi.mock("../cliPrompt", () => ({ buildCliPrompt: vi.fn(() => "mock cli prompt") }));
vi.mock("../mcpConn", () => ({ mcpUrlFrom: vi.fn(() => undefined) }));

beforeEach(() => {
  engine = new FakeEngine();
  setEngine(engine);
  _messages.length = 0;
  _proactiveLogs.length = 0;
  _activityLogs.length = 0;
  _memoryFacts.length = 0;
  insertActivityCalls = 0;
  insertMemoryCalls = 0;
  markRepliedCalls = 0;
});

/** 装一个 activity_capture 对话到 store + proactive_log(未回复态)。 */
async function seedActivityCaptureConv(convId: string) {
  _proactiveLogs.push({ id: `pl_${convId}`, type: "activity_capture", convId, repliedAt: null });
  const { useChatStore } = await import("../chatStore");
  const now = new Date().toISOString();
  useChatStore.setState({
    conversations: [{ id: convId, title: "活动捕获", createdAt: now, updatedAt: now }],
    currentId: convId,
    messagesByConv: {
      [convId]: [{ id: `m_assist_${convId}`, convId, role: "assistant", content: "在忙啥?", createdAt: now }],
    },
    loading: false,
  });
  return useChatStore;
}

describe("chatStore.sendMessage — activity_capture 多轮只回写一次 (M4)", () => {
  it("首次回复:写 1 条 activity_log + 1 条记忆 + 标记已回复一次", async () => {
    const convId = "ac_multi_1";
    const useChatStore = await seedActivityCaptureConv(convId);

    await useChatStore.getState().sendMessage("第一句:在写 M4 方案");

    expect(insertActivityCalls).toBe(1);
    expect(insertMemoryCalls).toBe(1);
    expect(markRepliedCalls).toBe(1);
  });

  it("第二轮回复(已回复过)→ 不再写 activity_log / 记忆(仍只 1 条)", async () => {
    const convId = "ac_multi_2";
    const useChatStore = await seedActivityCaptureConv(convId);

    await useChatStore.getState().sendMessage("第一句");
    // 第一句后,proactive_log 已被标记已回复 → has-unreplied 变 false
    await useChatStore.getState().sendMessage("第二句:继续聊");
    await useChatStore.getState().sendMessage("第三句:还在聊");

    // 三轮往返,但活动/记忆只在首次写了一次
    expect(insertActivityCalls).toBe(1);
    expect(insertMemoryCalls).toBe(1);
    // markReplied 也只发生在首次(后续 has-unreplied=false)
    expect(markRepliedCalls).toBe(1);
  });

  it("普通对话(无 proactive_log)多轮:从不写 activity_log / 记忆", async () => {
    const convId = "c_plain";
    const { useChatStore } = await import("../chatStore");
    const now = new Date().toISOString();
    useChatStore.setState({
      conversations: [{ id: convId, title: "普通", createdAt: now, updatedAt: now }],
      currentId: convId,
      messagesByConv: { [convId]: [] },
      loading: false,
    });

    await useChatStore.getState().sendMessage("帮我列个任务");
    await useChatStore.getState().sendMessage("再帮我排一下");

    expect(insertActivityCalls).toBe(0);
    expect(insertMemoryCalls).toBe(0);
  });
});
