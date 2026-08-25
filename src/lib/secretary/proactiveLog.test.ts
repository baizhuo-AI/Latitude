/**
 * proactiveLog.test.ts — Task 1.7 主动消息投递日志
 *
 * 验收覆盖:
 *  1. dbLogProactiveSent:投递成功后写一条 proactive_log(type/conv_id/sent_at/preview 正确)
 *  2. dbMarkProactiveReplied:用户回复后 replied_at 被填
 *  3. dbGetProactiveStats:统计 发送数 / 已回复 / 未回复 正确
 *  4. C6 路径:generateOnce 失败时 composeMorningBriefing 返回 undefined → 不记日志
 *  5. chatStore.sendMessage 在"主动消息对话"里回复 → 调 dbMarkProactiveReplied(不破坏流程)
 *  6. chatStore.sendMessage 在普通对话里回复 → 不调 dbMarkProactiveReplied
 *  7. dbMarkProactiveReplied 失败时 sendMessage 仍然正常完成(不被拖垮)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeEngine, installFakeEngine } from "../llm/fakeEngine";

// ─── 共享假引擎 ────────────────────────────────────────────────────────────────
const { setEngine } = installFakeEngine();
let engine: FakeEngine;

// ─── 内存 DB 状态 ──────────────────────────────────────────────────────────────

interface ProactiveLogEntry {
  id: string;
  type: string;
  conv_id: string;
  sent_at: string;
  content_preview: string;
  replied_at: string | null;
  dismissed_at: string | null;
}

// proactive_log 内存表
const _proactiveLogs = new Map<string, ProactiveLogEntry>();

// conversations/messages 内存表(chatStore 测试用)
const _conversations = new Map<string, { id: string; title: string; createdAt: string; updatedAt: string }>();
const _messages = new Map<string, Array<{ id: string; convId: string; role: string; content: string; createdAt: string }>>();

// ─── mock db ──────────────────────────────────────────────────────────────────
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // proactive_log 函数 — 由测试通过 import 获取并断言
    dbLogProactiveSent: vi.fn(async (entry: {
      type: string;
      convId: string;
      contentPreview: string;
    }) => {
      const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      _proactiveLogs.set(id, {
        id,
        type: entry.type,
        conv_id: entry.convId,
        sent_at: now,
        content_preview: entry.contentPreview,
        replied_at: null,
        dismissed_at: null,
      });
    }),
    dbMarkProactiveReplied: vi.fn(async (convId: string, repliedAt: string) => {
      for (const [key, entry] of _proactiveLogs) {
        if (entry.conv_id === convId && entry.replied_at === null) {
          _proactiveLogs.set(key, { ...entry, replied_at: repliedAt });
        }
      }
    }),
    dbMarkProactiveDismissed: vi.fn(async (convId: string, dismissedAt: string) => {
      for (const [key, entry] of _proactiveLogs) {
        if (entry.conv_id === convId && entry.dismissed_at === null) {
          _proactiveLogs.set(key, { ...entry, dismissed_at: dismissedAt });
        }
      }
    }),
    dbDeleteConversation: vi.fn(async (id: string) => {
      _conversations.delete(id);
      _messages.delete(id);
    }),
    dbGetProactiveStats: vi.fn(async (sinceDays: number) => {
      const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
      const relevant = Array.from(_proactiveLogs.values()).filter(
        (e) => e.sent_at >= cutoff
      );
      const total = relevant.length;
      const replied = relevant.filter((e) => e.replied_at !== null).length;
      return { total, replied, unreplied: total - replied };
    }),
    // chat 相关
    dbInsertConversation: vi.fn(async (conv: { id: string; title: string; createdAt: string; updatedAt: string }) => {
      _conversations.set(conv.id, conv);
      if (!_messages.has(conv.id)) _messages.set(conv.id, []);
    }),
    dbInsertMessage: vi.fn(async (msg: { id: string; convId: string; role: string; content: string; createdAt: string }) => {
      const list = _messages.get(msg.convId) ?? [];
      list.push(msg);
      _messages.set(msg.convId, list);
    }),
    dbListConversations: vi.fn(async () => Array.from(_conversations.values())),
    dbListMessages: vi.fn(async (convId: string) => _messages.get(convId) ?? []),
    dbHasUnrepliedProactive: vi.fn(async (convId: string) => {
      // 有 proactive_log 且 replied_at IS NULL → true
      for (const entry of _proactiveLogs.values()) {
        if (entry.conv_id === convId && entry.replied_at === null) return true;
      }
      return false;
    }),
    // composeMorningBriefing 间接依赖(buildBriefingUserMessage)
    dbGetRecentDigests: vi.fn(async () => []),
    dbListTodosOnDate: vi.fn(async () => []),
    dbUpdateMessageContent: vi.fn(async () => undefined),
    dbTouchConversation: vi.fn(async () => undefined),
    dbUpdateConversationTitle: vi.fn(async () => undefined),
    dbInsertUsage: vi.fn(async () => undefined),
  };
});

// ─── mock syncBus ─────────────────────────────────────────────────────────────
vi.mock("../syncBus", () => ({
  emitSync: vi.fn(),
}));

// ─── mock settings ────────────────────────────────────────────────────────────
const PROACTIVE_LOG_SETTINGS = {
  lang: "zh" as const,
  persona: { presetKey: "seniorAdvisor" as const },
  chatBackend: "deepseek-api" as const,
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
  useSettingsStore: { getState: () => PROACTIVE_LOG_SETTINGS },
  // getProvider / buildChatSystemPrompt 改走真相源读取器,测试里与 store 值保持一致
  readSettingsSnapshot: () => PROACTIVE_LOG_SETTINGS,
}));

// ─── mock store 依赖 ──────────────────────────────────────────────────────────
vi.mock("../store", () => ({
  useTodoStore: { getState: () => ({ todos: [] }) },
}));
vi.mock("../goalsStore", () => ({
  useGoalsStore: { getState: () => ({ goals: [] }) },
}));
vi.mock("../chatTools", () => ({
  toolsForLLM: () => [],
  runChatTool: async () => "{}",
}));

// ─── mock @tauri-apps/api ─────────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

// ─── mock LLM ────────────────────────────────────────────────────────────────
// chatAgentCall/buildChatSystemPrompt: chatStore 发消息用(深度链路)
// 注意:不能整体 mock ../llm — 否则会遮掉 generateOnce,导致 composeMorningBriefing 失败
// installFakeEngine() 已经通过 mock ./deepseek 拦截了 generateOnce 调用链
vi.mock("../llm", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    chatAgentCall: vi.fn(async () => ({ content: "AI 回复", usage: null })),
    buildChatSystemPrompt: vi.fn(async () => "system"),
  };
});

// ─── import 被测模块(所有 mock 之后) ──────────────────────────────────────────
import {
  dbLogProactiveSent,
  dbMarkProactiveReplied,
  dbGetProactiveStats,
} from "./proactiveLog";
import { useChatStore } from "../chatStore";
import { emitSync } from "../syncBus";
import {
  dbLogProactiveSent as dbLogMock,
  dbMarkProactiveReplied as dbMarkMock,
  dbMarkProactiveDismissed as dbDismissMock,
} from "../db";
import { composeMorningBriefing } from "./composeProactive";

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────
function getAllLogs(): ProactiveLogEntry[] {
  return Array.from(_proactiveLogs.values());
}

beforeEach(() => {
  engine = setEngine(new FakeEngine());
  _proactiveLogs.clear();
  _conversations.clear();
  _messages.clear();
  vi.clearAllMocks();
  // 重置 chatStore 内存态
  useChatStore.setState({
    conversations: [],
    currentId: null,
    messagesByConv: {},
    streaming: "",
    streamingReasoning: "",
    loading: false,
    abort: null,
  });
});

describe("chatStore.selectConv — 跨入口消息刷新", () => {
  it("reload=true 会覆盖已有缓存，读回其他窗口刚写入的消息", async () => {
    const convId = "conv_reload";
    const now = new Date().toISOString();
    _conversations.set(convId, {
      id: convId,
      title: "共享会话",
      createdAt: now,
      updatedAt: now
    });
    _messages.set(convId, [
      {
        id: "fresh-message",
        convId,
        role: "assistant",
        content: "来自另一个入口的新消息",
        createdAt: now
      }
    ]);
    useChatStore.setState({
      currentId: convId,
      messagesByConv: {
        [convId]: [
          {
            id: "stale-message",
            convId,
            role: "assistant",
            content: "旧缓存",
            createdAt: now
          }
        ]
      }
    });

    await useChatStore.getState().selectConv(convId, { reload: true });

    expect(useChatStore.getState().messagesByConv[convId]).toEqual([
      expect.objectContaining({ id: "fresh-message", content: "来自另一个入口的新消息" })
    ]);
  });
});

describe("chatStore.sendMessage — 新会话同步时序", () => {
  it("首轮完成后只广播一次，避免空会话刷新与首条消息追加竞争", async () => {
    await useChatStore.getState().sendMessage("从这里开始聊");

    expect(emitSync).toHaveBeenCalledTimes(1);
    expect(emitSync).toHaveBeenCalledWith("conversations");
    const currentId = useChatStore.getState().currentId;
    expect(currentId).toBeTruthy();
    expect(useChatStore.getState().messagesByConv[currentId!]).toEqual([
      expect.objectContaining({ role: "user", content: "从这里开始聊" }),
      expect.objectContaining({ role: "assistant", content: "AI 回复" })
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1. dbLogProactiveSent — 写入一条日志
// ════════════════════════════════════════════════════════════════════════════
describe("dbLogProactiveSent — 投递成功记日志", () => {
  it("写入后 proactive_log 有一条记录,type/conv_id/preview 正确", async () => {
    await dbLogProactiveSent({
      type: "morning_briefing",
      convId: "conv_test_001",
      contentPreview: "早上好！今天有 2 个任务",
    });

    const logs = getAllLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe("morning_briefing");
    expect(logs[0].conv_id).toBe("conv_test_001");
    expect(logs[0].content_preview).toBe("早上好！今天有 2 个任务");
    expect(logs[0].sent_at).toBeTruthy();
    expect(logs[0].replied_at).toBeNull();
  });

  it("sent_at 是合法的 ISO 时间戳", async () => {
    await dbLogProactiveSent({
      type: "morning_briefing",
      convId: "conv_test_002",
      contentPreview: "早安",
    });

    const logs = getAllLogs();
    expect(new Date(logs[0].sent_at).getTime()).not.toBeNaN();
  });

  it("多次投递 → 多条日志(各自独立)", async () => {
    await dbLogProactiveSent({ type: "morning_briefing", convId: "conv_001", contentPreview: "简报 1" });
    await dbLogProactiveSent({ type: "morning_briefing", convId: "conv_002", contentPreview: "简报 2" });

    const logs = getAllLogs();
    expect(logs).toHaveLength(2);
    const convIds = logs.map((l) => l.conv_id).sort();
    expect(convIds).toEqual(["conv_001", "conv_002"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. dbMarkProactiveReplied — 标记已回复
// ════════════════════════════════════════════════════════════════════════════
describe("dbMarkProactiveReplied — 回复后打点", () => {
  it("用户回复后,对应 log 的 replied_at 被填上", async () => {
    await dbLogProactiveSent({ type: "morning_briefing", convId: "conv_test_abc", contentPreview: "早安" });

    const beforeReply = getAllLogs();
    expect(beforeReply[0].replied_at).toBeNull();

    const repliedAt = new Date().toISOString();
    await dbMarkProactiveReplied("conv_test_abc", repliedAt);

    const afterReply = getAllLogs();
    expect(afterReply[0].replied_at).toBe(repliedAt);
  });

  it("按 conv_id 精确匹配:只改命中的那条,不污染其他对话的日志", async () => {
    await dbLogProactiveSent({ type: "morning_briefing", convId: "conv_a", contentPreview: "A" });
    await dbLogProactiveSent({ type: "morning_briefing", convId: "conv_b", contentPreview: "B" });

    const repliedAt = new Date().toISOString();
    await dbMarkProactiveReplied("conv_a", repliedAt);

    const logs = getAllLogs();
    const logA = logs.find((l) => l.conv_id === "conv_a");
    const logB = logs.find((l) => l.conv_id === "conv_b");
    expect(logA?.replied_at).toBe(repliedAt);
    expect(logB?.replied_at).toBeNull();
  });

  it("已经 replied 的日志不被二次覆盖(保留首次回复时间)", async () => {
    await dbLogProactiveSent({ type: "morning_briefing", convId: "conv_x", contentPreview: "简报" });

    const firstReply = "2026-06-15T09:00:00.000Z";
    await dbMarkProactiveReplied("conv_x", firstReply);

    const secondReply = "2026-06-15T10:00:00.000Z";
    await dbMarkProactiveReplied("conv_x", secondReply);

    // replied_at 应该是 firstReply(不被二次覆盖)
    const logs = getAllLogs();
    expect(logs[0].replied_at).toBe(firstReply);
  });

  it("conv_id 无匹配时静默(不报错)", async () => {
    await expect(
      dbMarkProactiveReplied("conv_nonexistent", new Date().toISOString())
    ).resolves.not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. dbGetProactiveStats — 统计查询
// ════════════════════════════════════════════════════════════════════════════
describe("dbGetProactiveStats — 统计发送/回复/未回复", () => {
  it("3 条发送,2 条已回复 → total=3, replied=2, unreplied=1", async () => {
    await dbLogProactiveSent({ type: "morning_briefing", convId: "c1", contentPreview: "A" });
    await dbLogProactiveSent({ type: "morning_briefing", convId: "c2", contentPreview: "B" });
    await dbLogProactiveSent({ type: "morning_briefing", convId: "c3", contentPreview: "C" });

    await dbMarkProactiveReplied("c1", new Date().toISOString());
    await dbMarkProactiveReplied("c2", new Date().toISOString());

    const stats = await dbGetProactiveStats(7);
    expect(stats.total).toBe(3);
    expect(stats.replied).toBe(2);
    expect(stats.unreplied).toBe(1);
  });

  it("无记录时 total=0, replied=0, unreplied=0", async () => {
    const stats = await dbGetProactiveStats(7);
    expect(stats.total).toBe(0);
    expect(stats.replied).toBe(0);
    expect(stats.unreplied).toBe(0);
  });

  it("total = replied + unreplied(不变式)", async () => {
    await dbLogProactiveSent({ type: "morning_briefing", convId: "cx1", contentPreview: "A" });
    await dbLogProactiveSent({ type: "morning_briefing", convId: "cx2", contentPreview: "B" });

    const stats = await dbGetProactiveStats(7);
    expect(stats.total).toBe(stats.replied + stats.unreplied);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. composeMorningBriefing 与日志记录的集成
//    验收:投递成功 → 有日志;C6 失败 → 无日志
// ════════════════════════════════════════════════════════════════════════════
describe("composeMorningBriefing 与 proactiveLog 集成", () => {
  it("投递成功后 dbLogProactiveSent 被调用,conv_id 正确", async () => {
    engine.script = [{ content: "早上好！今天有 2 个任务。", model: "deepseek-chat" }];

    const convId = await composeMorningBriefing({
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
    });

    expect(convId).toBeTruthy();
    expect(vi.mocked(dbLogMock)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbLogMock)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "morning_briefing",
        convId,
      })
    );
  });

  it("C6 降级(generateOnce 失败)→ dbLogProactiveSent 不被调用", async () => {
    engine.chat = async () => {
      throw new Error("LLM error");
    };

    const convId = await composeMorningBriefing({
      dateKey: "2026-06-15",
      yesterdayKey: "2026-06-14",
      lang: "zh",
    });

    expect(convId).toBeUndefined();
    expect(vi.mocked(dbLogMock)).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. chatStore.sendMessage — 主动消息对话回复打点
// ════════════════════════════════════════════════════════════════════════════
describe("chatStore.sendMessage — 主动消息对话回复打点", () => {
  it("在有 proactive_log 记录的对话里发消息 → dbMarkProactiveReplied 被调用", async () => {
    // 建一个"主动消息对话"
    const proactiveConvId = "conv_proactive_111";
    const now = new Date().toISOString();
    _conversations.set(proactiveConvId, {
      id: proactiveConvId,
      title: "晨间简报 2026-06-15",
      createdAt: now,
      updatedAt: now,
    });
    _messages.set(proactiveConvId, [
      { id: "m_brief_1", convId: proactiveConvId, role: "assistant", content: "早上好！", createdAt: now },
    ]);

    // 写入 proactive_log 记录
    await dbLogProactiveSent({
      type: "morning_briefing",
      convId: proactiveConvId,
      contentPreview: "早上好！",
    });

    vi.mocked(dbMarkMock).mockClear();

    // 选中该对话并发消息
    const store = useChatStore.getState();
    await store.selectConv(proactiveConvId);
    await store.sendMessage("好的,谢谢!");

    // dbMarkProactiveReplied 应该被调用
    expect(vi.mocked(dbMarkMock)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbMarkMock)).toHaveBeenCalledWith(
      proactiveConvId,
      expect.any(String)
    );
  });

  it("在普通对话(无 proactive_log 记录)里发消息 → dbMarkProactiveReplied 不被调用", async () => {
    // 建一个普通对话
    const normalConvId = "conv_normal_222";
    const now = new Date().toISOString();
    _conversations.set(normalConvId, {
      id: normalConvId,
      title: "普通对话",
      createdAt: now,
      updatedAt: now,
    });
    _messages.set(normalConvId, []);

    vi.mocked(dbMarkMock).mockClear();

    const store = useChatStore.getState();
    await store.selectConv(normalConvId);
    await store.sendMessage("你好");

    // 不应该被调用
    expect(vi.mocked(dbMarkMock)).not.toHaveBeenCalled();
  });

  it("dbMarkProactiveReplied 失败时 sendMessage 仍然完成(不被拖垮)", async () => {
    const proactiveConvId = "conv_proactive_333";
    const now = new Date().toISOString();
    _conversations.set(proactiveConvId, {
      id: proactiveConvId,
      title: "晨间简报",
      createdAt: now,
      updatedAt: now,
    });
    _messages.set(proactiveConvId, [
      { id: "m_brief_2", convId: proactiveConvId, role: "assistant", content: "早上好！", createdAt: now },
    ]);

    await dbLogProactiveSent({
      type: "morning_briefing",
      convId: proactiveConvId,
      contentPreview: "早上好！",
    });

    // 让 dbMarkProactiveReplied 抛错
    vi.mocked(dbMarkMock).mockRejectedValueOnce(new Error("DB 写入失败"));

    // sendMessage 不应该抛出
    const store = useChatStore.getState();
    await store.selectConv(proactiveConvId);

    let threw = false;
    try {
      await store.sendMessage("没事");
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // loading 状态应该恢复
    expect(useChatStore.getState().loading).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. chatStore.deleteConv — 删未回复的主动消息对话 = 显式 dismiss(Task 3.5)
// ════════════════════════════════════════════════════════════════════════════
describe("chatStore.deleteConv — 删未回复主动消息对话 → 记 dismiss", () => {
  function seedProactiveConv(convId: string) {
    const now = new Date().toISOString();
    _conversations.set(convId, { id: convId, title: "晨间简报", createdAt: now, updatedAt: now });
    _messages.set(convId, [
      { id: `m_${convId}`, convId, role: "assistant", content: "早上好！", createdAt: now },
    ]);
  }

  it("删未回复的主动消息对话 → dbMarkProactiveDismissed 被调用(删库前)", async () => {
    const convId = "conv_dismiss_1";
    seedProactiveConv(convId);
    await dbLogProactiveSent({ type: "morning_briefing", convId, contentPreview: "早上好！" });
    vi.mocked(dbDismissMock).mockClear();

    // 设进 store 内存态(deleteConv 操作 conversations 列表)
    useChatStore.setState({
      conversations: [{ id: convId, title: "晨间简报", createdAt: "", updatedAt: "" }],
      messagesByConv: { [convId]: [] },
    });

    await useChatStore.getState().deleteConv(convId);

    expect(vi.mocked(dbDismissMock)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbDismissMock)).toHaveBeenCalledWith(convId, expect.any(String));
  });

  it("删普通对话(无 proactive_log)→ dbMarkProactiveDismissed 不被调用", async () => {
    const convId = "conv_normal_del";
    const now = new Date().toISOString();
    _conversations.set(convId, { id: convId, title: "普通", createdAt: now, updatedAt: now });
    _messages.set(convId, []);
    vi.mocked(dbDismissMock).mockClear();

    useChatStore.setState({
      conversations: [{ id: convId, title: "普通", createdAt: "", updatedAt: "" }],
      messagesByConv: { [convId]: [] },
    });

    await useChatStore.getState().deleteConv(convId);

    expect(vi.mocked(dbDismissMock)).not.toHaveBeenCalled();
  });

  it("删【已回复】的主动消息对话 → 不记 dismiss(已互动,无需降频信号)", async () => {
    const convId = "conv_replied_del";
    seedProactiveConv(convId);
    await dbLogProactiveSent({ type: "morning_briefing", convId, contentPreview: "早上好！" });
    await dbMarkProactiveReplied(convId, new Date().toISOString()); // 已回复 → 不再 unreplied
    vi.mocked(dbDismissMock).mockClear();

    useChatStore.setState({
      conversations: [{ id: convId, title: "晨间简报", createdAt: "", updatedAt: "" }],
      messagesByConv: { [convId]: [] },
    });

    await useChatStore.getState().deleteConv(convId);

    expect(vi.mocked(dbDismissMock)).not.toHaveBeenCalled();
  });

  it("dbMarkProactiveDismissed 失败时 deleteConv 仍完成(不被拖垮)", async () => {
    const convId = "conv_dismiss_fail";
    seedProactiveConv(convId);
    await dbLogProactiveSent({ type: "morning_briefing", convId, contentPreview: "早上好！" });
    vi.mocked(dbDismissMock).mockRejectedValueOnce(new Error("DB 写入失败"));

    useChatStore.setState({
      conversations: [{ id: convId, title: "晨间简报", createdAt: "", updatedAt: "" }],
      messagesByConv: { [convId]: [] },
    });

    let threw = false;
    try {
      await useChatStore.getState().deleteConv(convId);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // 对话仍被删除(降级不拦主流程)
    expect(useChatStore.getState().conversations.find((c) => c.id === convId)).toBeUndefined();
  });
});
