/**
 * deliverProactive.test.ts — Task 3.4 主动消息「投递层」
 *
 * 投递层职责(与 composeMorningBriefing 平行,但服务事件触发候选 ProactiveCandidate):
 *   1. resolveDeliveryChannels(channel) — 纯函数:渠道枚举 → 三个布尔(chat/notification/float)
 *   2. applyLoadTone(systemPrompt, tonePhrase?) — 纯函数:把 3.3 负荷档措辞拼进 system prompt
 *   3. composeProactiveMessage(candidate, ctx) — 合成单条文案(generateOnce,注入人设+事实+负荷措辞)
 *   4. deliverProactive(candidate, opts) — 合成 + 按渠道投递(聊天冒泡必走;通知/弹窗可选)+ 打点
 *
 * 验收覆盖:
 *   A. resolveDeliveryChannels:四枚举 + "all" 全开;确定性
 *   B. applyLoadTone:有 tonePhrase 拼接、无则原样返回(纯)
 *   C. composeProactiveMessage:人设 + 候选事实 + 负荷措辞都喂进 generateOnce;C6 失败返回 undefined
 *   D. deliverProactive:chat 渠道投进新对话(assistant 消息持久化 + emitSync + 打点带 refId)
 *   E. deliverProactive:channel=notification 不投聊天时——本测试仍保证 chat 兜底(聊天冒泡已有,必投)
 *   F. C6:generateOnce 抛错 → 不投递、不打点、不抛到调用方
 *
 * 铁律:
 *   - 投递层不读 Date.now() 做判定逻辑(判定在 gate/triggers);投递只在被放行后执行。
 *   - 纯函数(resolveDeliveryChannels/applyLoadTone)体内不读 Date.now()/Math.random()。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeEngine, installFakeEngine } from "../llm/fakeEngine";

// ─── 注入共享假引擎 ───────────────────────────────────────────────────────────
const { setEngine } = installFakeEngine();
let engine: FakeEngine;

// ─── 内存 DB 状态 ─────────────────────────────────────────────────────────────
const _conversations = new Map<string, { id: string; title: string; createdAt: string; updatedAt: string }>();
const _messages = new Map<string, Array<{ id: string; convId: string; role: string; content: string; createdAt: string }>>();

// 跟踪 emitSync / 投递日志 / 渠道副作用
const emitSyncCalls: string[] = [];
const proactiveLogCalls: Array<{ type: string; convId: string; contentPreview: string; refId?: string }> = [];
const notifyCalls: Array<{ title: string; body: string }> = [];
const openTodoFloatCalls: number[] = [];
const openChatBarCalls: number[] = [];

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
    dbLogProactiveSent: vi.fn(async (entry: { type: string; convId: string; contentPreview: string; refId?: string }) => {
      proactiveLogCalls.push(entry);
    }),
  };
});

// ─── mock store + goalsStore(buildChatSystemPrompt 间接依赖,投递层不用但稳妥) ──
vi.mock("../store", () => ({
  useTodoStore: { getState: () => ({ todos: [] }) },
}));
vi.mock("../goalsStore", () => ({
  useGoalsStore: { getState: () => ({ goals: [] }) },
}));

// ─── mock settings(真相源读取器 + store 同值) ─────────────────────────────────
const DELIVER_SETTINGS = {
  lang: "zh" as const,
  persona: { presetKey: "seniorAdvisor" as const },
  llmProvider: "deepseek" as const,
  providers: {
    deepseek: { apiKey: "test-key", baseUrl: "https://example.test", model: "deepseek-chat" },
  },
};
vi.mock("../settings", () => ({
  onProviderConfigChange: () => () => undefined,
  useSettingsStore: { getState: () => DELIVER_SETTINGS },
  readSettingsSnapshot: () => DELIVER_SETTINGS,
}));

// ─── mock chatTools(buildChatSystemPrompt 间接依赖) ───────────────────────────
vi.mock("../chatTools", () => ({
  toolsForLLM: () => [],
  runChatTool: async () => "{}",
}));

// ─── mock windowLayout(弹窗渠道副作用) ────────────────────────────────────────
vi.mock("../windowLayout", () => ({
  openTodoFloat: vi.fn(async () => {
    openTodoFloatCalls.push(Date.now());
  }),
  openChatBar: vi.fn(async () => {
    openChatBarCalls.push(Date.now());
  }),
  WIN_MAIN: "main",
}));

// ─── mock plugin-notification(系统通知渠道) ──────────────────────────────────
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn((arg: { title: string; body: string }) => {
    notifyCalls.push(arg);
  }),
}));

// ─── 被测模块(所有 mock 之后 import) ─────────────────────────────────────────
import {
  resolveDeliveryChannels,
  applyLoadTone,
  composeProactiveMessage,
  deliverProactive,
  type DeliveryChannels,
} from "./deliverProactive";
import type { ProactiveCandidate } from "./triggers";
import { dbInsertMessage, dbInsertConversation } from "../db";

// ─── 辅助 ─────────────────────────────────────────────────────────────────────
function makeCandidate(over: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  return {
    kind: "meeting_soon",
    priority: 80,
    refId: "ev_1",
    title: "会议将至:周会(约 10 分钟后开始)",
    payload: { eventTitle: "周会", minutesUntil: 10 },
    ...over,
  };
}

beforeEach(() => {
  engine = setEngine(new FakeEngine());
  _conversations.clear();
  _messages.clear();
  emitSyncCalls.length = 0;
  proactiveLogCalls.length = 0;
  notifyCalls.length = 0;
  openTodoFloatCalls.length = 0;
  openChatBarCalls.length = 0;
  vi.mocked(dbInsertMessage).mockClear();
  vi.mocked(dbInsertConversation).mockClear();
});

// ════════════════════════════════════════════════════════════════════════════
// A. resolveDeliveryChannels — 纯函数
// ════════════════════════════════════════════════════════════════════════════
describe("resolveDeliveryChannels — 渠道枚举 → 布尔集合(纯)", () => {
  it("chat:只 chat=true(聊天冒泡)", () => {
    const r = resolveDeliveryChannels("chat");
    expect(r).toEqual<DeliveryChannels>({ chat: true, notification: false, float: false });
  });

  it("notification:chat 仍兜底为 true + notification=true", () => {
    // 聊天冒泡是「主动消息的落点」,任何渠道都要先落进对话(有可回复的载体),
    // notification/float 是「额外提醒方式」叠加。故 chat 恒为 true。
    const r = resolveDeliveryChannels("notification");
    expect(r.chat).toBe(true);
    expect(r.notification).toBe(true);
    expect(r.float).toBe(false);
  });

  it("float:chat 兜底 true + float=true", () => {
    const r = resolveDeliveryChannels("float");
    expect(r.chat).toBe(true);
    expect(r.float).toBe(true);
    expect(r.notification).toBe(false);
  });

  it("all:三个都 true", () => {
    expect(resolveDeliveryChannels("all")).toEqual<DeliveryChannels>({
      chat: true,
      notification: true,
      float: true,
    });
  });

  it("确定性:同输入多次调用结果相同", () => {
    expect(resolveDeliveryChannels("all")).toEqual(resolveDeliveryChannels("all"));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. applyLoadTone — 纯函数(负荷措辞拼接)
// ════════════════════════════════════════════════════════════════════════════
describe("applyLoadTone — 把负荷档措辞拼进 system prompt(纯)", () => {
  it("有 tonePhrase:拼到 prompt 末尾,原文仍在", () => {
    const base = "你是用户的秘书。";
    const phrase = "用户当前负荷偏高,措辞更简短克制。";
    const out = applyLoadTone(base, phrase);
    expect(out).toContain(base);
    expect(out).toContain(phrase);
    expect(out.length).toBeGreaterThan(base.length);
  });

  it("无 tonePhrase(undefined):原样返回", () => {
    const base = "你是用户的秘书。";
    expect(applyLoadTone(base, undefined)).toBe(base);
  });

  it("空字符串 tonePhrase:原样返回(不拼空段)", () => {
    const base = "你是用户的秘书。";
    expect(applyLoadTone(base, "")).toBe(base);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. composeProactiveMessage — 合成单条文案
// ════════════════════════════════════════════════════════════════════════════
describe("composeProactiveMessage — 合成文案喂 generateOnce", () => {
  it("人设 + 候选事实 + 负荷措辞 都喂进 generateOnce", async () => {
    engine.script = [{ content: "周会 10 分钟后开始,要不要先把材料过一遍?", model: "deepseek-chat" }];

    const candidate = makeCandidate({ title: "会议将至:周会(约 10 分钟后开始)" });
    const text = await composeProactiveMessage(candidate, {
      lang: "zh",
      tonePhrase: "用户当前负荷偏高,措辞更简短克制。",
    });

    expect(text).toBeTruthy();
    expect(engine.received).toHaveLength(1);

    const call = engine.received[0];
    const sysMsg = call.messages.find((m) => m.role === "system");
    // 人设
    expect(sysMsg?.content).toMatch(/幕僚|advisor|不替用户甩选项|不复读/);
    // 负荷措辞被注入 system prompt
    expect(sysMsg?.content).toContain("负荷偏高");

    // 候选事实(会议标题)进了 user 消息
    const userMsg = call.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("周会");
  });

  it("无 tonePhrase 时:system prompt 不含负荷措辞段,但仍正常合成", async () => {
    engine.script = [{ content: "提醒:周会快开始了。", model: "deepseek-chat" }];
    const text = await composeProactiveMessage(makeCandidate(), { lang: "zh" });
    expect(text).toBe("提醒:周会快开始了。");
  });

  it("C6:generateOnce 抛错 → 返回 undefined(不抛)", async () => {
    engine.chat = async () => {
      throw new Error("network down");
    };
    const text = await composeProactiveMessage(makeCandidate(), { lang: "zh" });
    expect(text).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. deliverProactive — 投递 chat 渠道
// ════════════════════════════════════════════════════════════════════════════
describe("deliverProactive — 聊天冒泡投递 + 打点", () => {
  it("chat 渠道:新建对话 + assistant 消息持久化 + emitSync + 打点带 refId/kind", async () => {
    engine.script = [{ content: "周会快开始了,材料过一遍?", model: "deepseek-chat" }];

    const candidate = makeCandidate({ kind: "meeting_soon", refId: "ev_42" });
    const result = await deliverProactive(candidate, { lang: "zh", channel: "chat" });

    expect(result?.convId).toBeTruthy();
    expect(dbInsertConversation).toHaveBeenCalledTimes(1);
    expect(dbInsertMessage).toHaveBeenCalledTimes(1);

    const msgCall = vi.mocked(dbInsertMessage).mock.calls[0][0];
    expect(msgCall.role).toBe("assistant");
    expect(msgCall.content).toContain("周会");

    expect(emitSyncCalls).toContain("conversations");

    // 打点:type = 候选 kind,refId 透传(给 gateProactive 跨重启去重)
    expect(proactiveLogCalls).toHaveLength(1);
    expect(proactiveLogCalls[0].type).toBe("meeting_soon");
    expect(proactiveLogCalls[0].refId).toBe("ev_42");
    expect(proactiveLogCalls[0].convId).toBe(result?.convId);

    // 仅 chat:不发通知、不弹窗
    expect(notifyCalls).toHaveLength(0);
    expect(openTodoFloatCalls).toHaveLength(0);
  });

  it("channel=notification:聊天冒泡仍投(chat 兜底)+ 额外发系统通知", async () => {
    engine.script = [{ content: "周会快开始了。", model: "deepseek-chat" }];

    const result = await deliverProactive(makeCandidate(), { lang: "zh", channel: "notification" });

    // chat 兜底:对话 + 消息仍落库
    expect(dbInsertMessage).toHaveBeenCalledTimes(1);
    expect(result?.convId).toBeTruthy();

    // 额外系统通知
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].body).toContain("周会");
  });

  it("channel=all:聊天 + 通知 + 弹窗 三渠道都触发", async () => {
    engine.script = [{ content: "周会快开始了。", model: "deepseek-chat" }];

    await deliverProactive(makeCandidate(), { lang: "zh", channel: "all" });

    expect(dbInsertMessage).toHaveBeenCalledTimes(1);
    expect(notifyCalls).toHaveLength(1);
    expect(openTodoFloatCalls).toHaveLength(1);
  });

  it("默认 channel(不传):温和——只聊天冒泡,不通知不弹窗", async () => {
    engine.script = [{ content: "周会快开始了。", model: "deepseek-chat" }];

    await deliverProactive(makeCandidate(), { lang: "zh" });

    expect(dbInsertMessage).toHaveBeenCalledTimes(1);
    expect(notifyCalls).toHaveLength(0);
    expect(openTodoFloatCalls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E. C6 错误降级
// ════════════════════════════════════════════════════════════════════════════
describe("deliverProactive — C6 错误降级(合成失败静默)", () => {
  it("generateOnce 抛错 → 不投递、不打点、不发通知/弹窗、不抛", async () => {
    engine.chat = async () => {
      throw new Error("LLM timeout");
    };

    let thrown = false;
    let result: { convId: string } | undefined;
    try {
      result = await deliverProactive(makeCandidate(), { lang: "zh", channel: "all" });
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(result).toBeUndefined();
    expect(dbInsertMessage).not.toHaveBeenCalled();
    expect(proactiveLogCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
    expect(openTodoFloatCalls).toHaveLength(0);
  });

  it("投递的对话里不含错误关键词", async () => {
    engine.chat = async () => {
      throw new Error("boom");
    };
    await deliverProactive(makeCandidate(), { lang: "zh" });
    const allMsgs = Array.from(_messages.values()).flat();
    for (const m of allMsgs) {
      expect(m.content).not.toMatch(/失败|error|Error|boom/i);
    }
  });
});
