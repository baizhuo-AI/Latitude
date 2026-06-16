import { create } from "zustand";
import {
  dbDeleteConversation,
  dbInsertConversation,
  dbInsertMessage,
  dbListConversations,
  dbListMessages,
  dbTouchConversation,
  dbUpdateConversationTitle,
  dbUpdateMessageContent,
  dbHasUnrepliedProactive,
  dbMarkProactiveReplied,
  dbMarkProactiveDismissed,
  type ChatMessageRow,
  type ConversationRow
} from "./db";
import { chatAgentCall, buildChatSystemPrompt } from "./llm";
import { buildCliPrompt } from "./cliPrompt";
import { mcpUrlFrom, type McpConnInfo } from "./mcpConn";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "./settings";
import { emitSync } from "./syncBus";
import type { ChatMessage } from "./llm/types";

/** id 生成器 */
function newId(prefix: string): string {
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

interface ChatStore {
  conversations: ConversationRow[];
  /** 当前激活的会话 id;null 表示未选 */
  currentId: string | null;
  /** 各会话的消息(懒加载,select 时填) */
  messagesByConv: Record<string, ChatMessageRow[]>;
  /** 正在流式接收的 assistant 消息内容(实时刷新,完整后才入 db) */
  streaming: string;
  /** 正在流式接收的思考过程(reasoning_content) */
  streamingReasoning: string;
  /** 正在请求中(submit 中) */
  loading: boolean;
  /** 中止当前请求 */
  abort: AbortController | null;

  hydrate: () => Promise<void>;
  selectConv: (id: string | null) => Promise<void>;
  createConv: (title?: string) => Promise<string>;
  deleteConv: (id: string) => Promise<void>;
  renameConv: (id: string, title: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  stop: () => void;
}

interface CliHandlers {
  onText: (t: string) => void;
  onThinking: (t: string) => void;
  onToolCall: (name: string) => void;
}

type CliKind = "claude" | "codex" | "kiro";

/**
 * 走本地 CLI（Claude Code / Codex / Kiro）发一轮对话。
 * spawn 子进程在 Tauri 后端，事件流通过 Tauri event "cli-agent-event" 实时回到前端。
 * 工具能力靠 CLI 自己连本机 MCP server（端口 42800），复用已有的 16 个工具。
 *
 * 无状态约束（Phase 4 铁律①）：CLI 当哑引擎，不用 --resume / resume / --resume-id，
 * 不持有也不回传 session。每轮的完整上下文〔人设 + 记忆 + 历史 + 当前消息〕由调用方
 * （见下面 send 里的 buildCliPrompt）拼成单段 prompt 注入。app 是唯一的会话状态持有者，
 * 续接靠 app 注入历史，不靠引擎自身会话；记忆只走 MCP 记忆工具落 app 自有库。
 */
async function sendViaCli(
  kind: CliKind,
  prompt: string,
  handlers: CliHandlers
): Promise<{ content: string }> {
  // 拿 MCP 接入信息，让 CLI 启动时连进来管待办（拿不到就退化为纯聊天）。
  // 注意：mcp_connection_info 返回 {port, token, command}，**没有 url** —— url 必须从 port 拼
  // （见 ./mcpConn 的 mcpUrlFrom）。早先这里读 conn.url 会得 undefined，导致 MCP 从不注入、
  // CLI 静默退化纯聊天（4.3/4.4 复审 blocking bug）。
  const conn = await invoke<McpConnInfo>("mcp_connection_info").catch(() => null);
  const mcpUrl = mcpUrlFrom(conn);

  let content = "";
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const donePromise = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  // 事件载荷类型（与 Rust 端 ChatEvent 对齐：tag=type，snake_case）
  // 无状态后 done 不再带 session_id（铁律①）。
  type Ev =
    | { type: "thinking"; text: string }
    | { type: "text"; text: string }
    | { type: "tool_call_start"; name: string }
    | { type: "tool_call_end"; name: string; ok: boolean }
    | { type: "done" }
    | { type: "error"; message: string };

  const unlisten = await listen<Ev>("cli-agent-event", (e) => {
    const ev = e.payload;
    switch (ev.type) {
      case "text":
        content += ev.text;
        handlers.onText(ev.text);
        break;
      case "thinking":
        handlers.onThinking(ev.text);
        break;
      case "tool_call_start":
        handlers.onToolCall(ev.name);
        break;
      case "tool_call_end":
        // MVP 暂不单独显示结束（前端 UI 后续可加工具卡片）
        break;
      case "done":
        resolveDone();
        break;
      case "error":
        rejectDone(new Error(ev.message));
        break;
    }
  });

  try {
    await invoke("cli_agent_send", {
      kind,
      req: {
        prompt,
        mcpUrl,
        mcpToken: conn?.token,
      },
    });
    await donePromise;
  } finally {
    unlisten();
  }

  return { content };
}

export const useChatStore = create<ChatStore>((set, get) => ({
  conversations: [],
  currentId: null,
  messagesByConv: {},
  streaming: "",
  streamingReasoning: "",
  loading: false,
  abort: null,

  hydrate: async () => {
    try {
      const convs = await dbListConversations();
      set({ conversations: convs });
    } catch (err) {
      console.error("[chatStore] hydrate failed:", err);
    }
  },

  selectConv: async (id) => {
    if (!id) {
      set({ currentId: null });
      return;
    }
    set({ currentId: id });
    if (!get().messagesByConv[id]) {
      try {
        const msgs = await dbListMessages(id);
        set((s) => ({ messagesByConv: { ...s.messagesByConv, [id]: msgs } }));
      } catch (err) {
        console.error("[chatStore] load messages failed:", err);
      }
    }
  },

  createConv: async (title) => {
    const id = newId("c");
    const now = new Date().toISOString();
    const conv: ConversationRow = {
      id,
      title: title ?? "新对话",
      createdAt: now,
      updatedAt: now
    };
    await dbInsertConversation(conv);
    set((s) => ({
      conversations: [conv, ...s.conversations],
      currentId: id,
      messagesByConv: { ...s.messagesByConv, [id]: [] }
    }));
    emitSync("conversations");
    return id;
  },

  deleteConv: async (id) => {
    // Task 3.5(R1 降频):删一个【从未回复过】的主动消息对话 = 用户显式 dismiss。
    // 这是比"没回复(ignored)"更强的负反馈信号,记到 proactive_log.dismissed_at,
    // 供日终 dismissDowngrade 评估。删库前先标记(删后 has-unreplied 查不到了)。
    // 静默降级:打点失败不拦删除主流程(与回复打点一致)。
    try {
      const hasUnreplied = await dbHasUnrepliedProactive(id);
      if (hasUnreplied) {
        await dbMarkProactiveDismissed(id, new Date().toISOString());
      }
    } catch (err) {
      console.warn("[chatStore] 标记主动消息 dismiss 失败,忽略:", err);
    }

    await dbDeleteConversation(id);
    set((s) => {
      const next = { ...s.messagesByConv };
      delete next[id];
      return {
        conversations: s.conversations.filter((c) => c.id !== id),
        messagesByConv: next,
        currentId: s.currentId === id ? null : s.currentId
      };
    });
    emitSync("conversations");
  },

  renameConv: async (id, title) => {
    await dbUpdateConversationTitle(id, title);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, title } : c
      )
    }));
    emitSync("conversations");
  },

  sendMessage: async (content) => {
    const trimmed = content.trim();
    if (!trimmed || get().loading) return;

    let convId = get().currentId;
    if (!convId) {
      convId = await get().createConv(trimmed.slice(0, 24));
    }

    // 用户消息先入库 + 入 state
    const userMsg: ChatMessageRow = {
      id: newId("m"),
      convId,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString()
    };
    await dbInsertMessage(userMsg);
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        [convId!]: [...(s.messagesByConv[convId!] ?? []), userMsg]
      }
    }));

    // 主动消息回复打点(Task 1.7):
    // 若该对话有未回复的 proactive_log 记录,标记为已回复。
    // 用 await + try/catch:保证打点在 LLM 调用前完成,同时失败不拖垮 sendMessage。
    try {
      const hasUnreplied = await dbHasUnrepliedProactive(convId!);
      if (hasUnreplied) {
        await dbMarkProactiveReplied(convId!, userMsg.createdAt);
      }
    } catch (err) {
      console.warn("[chatStore] 标记主动消息已回复失败,忽略:", err);
    }

    // 占位 assistant 消息(content 后续覆写)
    const assistantId = newId("m");
    const assistantPlaceholder: ChatMessageRow = {
      id: assistantId,
      convId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString()
    };
    await dbInsertMessage(assistantPlaceholder);
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        [convId!]: [...(s.messagesByConv[convId!] ?? []), assistantPlaceholder]
      },
      loading: true,
      streaming: "",
      streamingReasoning: ""
    }));

    // 历史消息 → LLM(去掉空 assistant 占位)
    const history = (get().messagesByConv[convId] ?? [])
      .filter((m) => !(m.id === assistantId))
      .map((m): ChatMessage => ({ role: m.role, content: m.content }));

    const abort = new AbortController();
    set({ abort });

    let final = "";
    const backend = useSettingsStore.getState().chatBackend;
    try {
      if (backend === "deepseek-api") {
        // 路线 A：DeepSeek API + 内置 agent loop（chatTools.ts 那 16 个工具）
        const result = await chatAgentCall(history, {
          onStep: (info) => {
            set((s) => ({
              streaming:
                (s.streaming ? s.streaming + "\n" : "") + `⚙️ 调用工具 ${info.name}…`
            }));
          }
        });
        final = result.content;
      } else {
        // 路线 B：本地 CLI（claude/codex/kiro），走用户订阅；工具能力靠 CLI 连本机 MCP server。
        // 无状态（铁律①）：CLI 当哑引擎，不用 --resume。每轮都把〔人设 + 记忆 + 历史 +
        // 当前消息〕拼成完整 prompt 注入，续接靠 app 注入历史而非引擎自身会话。这样 CLI
        // 引擎拿到的上下文与 API 引擎（chatAgentCall 的 history）等价。
        const kind: CliKind =
          backend === "claude-cli" ? "claude" : backend === "codex-cli" ? "codex" : "kiro";
        const fullPrompt = buildCliPrompt(
          await buildChatSystemPrompt(),
          history,
          trimmed
        );
        const result = await sendViaCli(kind, fullPrompt, {
          onText: (t) => set((s) => ({ streaming: s.streaming + t })),
          onThinking: (t) => set((s) => ({ streamingReasoning: s.streamingReasoning + t })),
          onToolCall: (name) =>
            set((s) => ({
              streaming: (s.streaming ? s.streaming + "\n" : "") + `⚙️ 调用 ${name}…`
            })),
        });
        final = result.content;
      }
    } catch (err) {
      console.error("[chatStore] send failed:", err);
      final = "(请求失败,请稍后重试。错误已记录到 console)";
    } finally {
      // 写回 assistant 消息完整内容（agent 模式无独立推理链；usage 在 chatAgentCall 内已记）
      await dbUpdateMessageContent(
        assistantId,
        final,
        undefined,
        undefined
      ).catch((e) => console.error("[chatStore] update msg failed:", e));
      await dbTouchConversation(convId!).catch(() => undefined);

      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [convId!]: (s.messagesByConv[convId!] ?? []).map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: final,
                  reasoningContent: undefined,
                  usageJson: undefined
                }
              : m
          )
        },
        // 把会话顶到列表最上
        conversations: [
          ...s.conversations.filter((c) => c.id === convId).map((c) => ({
            ...c,
            updatedAt: new Date().toISOString()
          })),
          ...s.conversations.filter((c) => c.id !== convId)
        ],
        streaming: "",
        streamingReasoning: "",
        loading: false,
        abort: null
      }));
      emitSync("conversations");
    }
  },

  stop: () => {
    const a = get().abort;
    if (a) a.abort();
  }
}));
