import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageRow } from "./db";
import { serializeDesktopViewContext } from "../dimension/desktopViewContext";

const state = vi.hoisted(() => ({
  messages: [] as ChatMessageRow[],
  cliListener: null as null | ((event: { payload: { type: string; text?: string } }) => void),
}));
vi.mock("./db", () => ({
  dbInsertMessage: vi.fn(async (message: ChatMessageRow) => { state.messages.push({ ...message }); }),
  dbListMessages: vi.fn(async () => state.messages.map(message => ({ ...message }))),
  dbHasUnrepliedProactive: vi.fn(async () => false),
  dbUpdateMessageContent: vi.fn(async (id: string, content: string) => {
    state.messages = state.messages.map(message => message.id === id ? { ...message, content } : message);
  }),
  dbTouchConversation: vi.fn(async () => undefined),
  dbInsertMemoryFact: vi.fn(async () => undefined),
}));
vi.mock("./activityStore", () => ({ newActivityId: () => "activity-test" }));
vi.mock("./settings", () => ({ useSettingsStore: { getState: () => ({ chatBackend: "deepseek-api" }) } }));
vi.mock("./syncBus", () => ({ emitSync: vi.fn() }));
vi.mock("./llm", () => ({
  chatAgentCall: vi.fn(async () => ({ content: "完成回复" })),
  buildAgentSystemPrompt: vi.fn(async (context?: string) => `基础系统提示${context ? `\n\n${context}` : ""}`),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, callback: NonNullable<typeof state.cliListener>) => { state.cliListener = callback; return () => { state.cliListener = null; }; }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "mcp_connection_info") return { port: 42800, token: "test-token", command: "test" };
    if (command === "cli_agent_send") {
      state.cliListener?.({ payload: { type: "text", text: "CLI 回复" } });
      state.cliListener?.({ payload: { type: "done" } });
    }
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { chatAgentCall } from "./llm";
import { dbInsertMemoryFact } from "./db";
import { submitAgentRound, useChatStore } from "./chatStore";

beforeEach(() => {
  state.messages = [];
  state.cliListener = null;
  vi.clearAllMocks();
  useChatStore.setState({ currentId: "conv-test", loading: false, messagesByConv: {}, conversations: [], abort: null });
});

const transientContext = serializeDesktopViewContext({ view: "paper", area: { id: "delivery", title: "客户交付" }, visibleCardIds: ["card-1"] });

describe("native transient desktop context", () => {
  it("passes UI context to the API while storing only the original user text and never retains it for an unrelated turn", async () => {
    await useChatStore.getState().sendMessage("帮我看这里", { transientContext });
    expect(chatAgentCall).toHaveBeenCalledWith([{ role: "user", content: "帮我看这里" }], expect.objectContaining({ transientContext }));
    expect(state.messages.find(message => message.role === "user")?.content).toBe("帮我看这里");
    expect(useChatStore.getState().messagesByConv["conv-test"][0].content).toBe("帮我看这里");
    expect(dbInsertMemoryFact).not.toHaveBeenCalled();
    await submitAgentRound("conv-test", "其他渠道的原始消息");
    expect(vi.mocked(chatAgentCall).mock.calls[1][1]).not.toHaveProperty("transientContext");
    expect(state.messages.every(message => !message.content.includes("latitude_ui_context"))).toBe(true);
  });

  it.each(["claude-cli", "codex-cli", "kiro-cli"] as const)("places UI context in the %s system section without changing database history", async (backend) => {
    await submitAgentRound("conv-test", "原始当前消息", { backend, transientContext });
    const call = vi.mocked(invoke).mock.calls.find(([command]) => command === "cli_agent_send");
    const prompt = (call?.[1] as { req: { prompt: string } }).req.prompt;
    expect(prompt.split("\n\n---\n\n")[0]).toContain(transientContext);
    expect(prompt.split("\n\n---\n\n")[1]).toContain("用户：原始当前消息");
    expect(prompt.split("\n\n---\n\n")[1]).not.toContain("latitude_ui_context");
    expect(state.messages.map(message => message.content)).toEqual(["原始当前消息", "CLI 回复"]);
    expect(dbInsertMemoryFact).not.toHaveBeenCalled();
  });
});
