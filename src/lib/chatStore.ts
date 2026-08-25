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
  dbGetProactiveTypeForConv,
  dbInsertActivity,
  dbInsertMemoryFact,
  type ChatMessageRow,
  type ConversationRow
} from "./db";
import type { ActivityRecord } from "./db";
import { newActivityId } from "./activityStore";
import { chatAgentCall, buildAgentSystemPrompt } from "./llm";
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
  selectConv: (id: string | null, opts?: { reload?: boolean }) => Promise<void>;
  createConv: (title?: string, opts?: { deferSync?: boolean }) => Promise<string>;
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
  if (!mcpUrl) {
    // MCP 没连上 → 本轮 CLI 大脑拿不到任何 app 工具(记录/待办/日历都调不了),退化为纯聊天。
    // 历史上这里静默退化,用户无从知晓大脑"没牙"。留一条醒目日志,便于排查"为什么不会记录/建待办"。
    console.warn(
      "[chatStore] MCP 未连接(mcp_connection_info 无效),CLI 大脑本轮无工具可用,退化为纯聊天。"
    );
  }

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

/** backend 类型取自 settings store，避免硬编码联合常量漂移。 */
type ChatBackend = ReturnType<typeof useSettingsStore.getState>["chatBackend"];

/**
 * 一轮对话的可选配置与生命周期回调。
 * 对话窗通过 hooks 把每一步投影到 Zustand（即时渲染流式 / loading）；
 * 飞书等无 UI 的入口可全部不传，只取 Promise 返回的最终回复。
 */
export interface AgentRoundOptions {
  /**
   * 覆盖大脑后端；默认读 settings。
   * 注意：非主窗（如未来的飞书执行 webview）settings store 内存态可能不是真相源，
   * 这类入口应显式传入从真相源（localStorage / db）读到的 backend。
   */
  backend?: ChatBackend;
  hooks?: {
    /** 用户消息已落库 */
    onUserPersisted?: (msg: ChatMessageRow) => void;
    /** assistant 占位已落库，开始等大脑 */
    onAssistantStart?: (assistantId: string) => void;
    /** API 路线：agent loop 调用了一个工具 */
    onApiToolStep?: (toolName: string) => void;
    /** CLI 路线：正文增量 */
    onCliText?: (delta: string) => void;
    /** CLI 路线：思考增量 */
    onCliThinking?: (delta: string) => void;
    /** CLI 路线：调用工具 */
    onCliToolCall?: (toolName: string) => void;
    /** 本轮结束（成功或失败兜底均触发），finalContent 为最终落库内容 */
    onComplete?: (finalContent: string) => void;
  };
}

export interface AgentRoundResult {
  convId: string;
  userMsg: ChatMessageRow;
  assistantId: string;
  /** 最终 assistant 回复；失败时为兜底错误串 */
  content: string;
}

/**
 * 跑完整的一轮秘书对话 —— 入口无关的核心编排。
 *
 * 从 sendMessage 抽出的「大脑」部分：对话窗、飞书入口、未来任何渠道都调它，
 * 确保人设 / 工具 / 记忆 / 历史完全一致（系统提示词统一收口在 buildAgentSystemPrompt）。
 *
 * 全程只碰 DB + 大脑，不碰任何 Zustand / 窗口状态；UI 表现（流式、loading、列表排序）
 * 由调用方通过 hooks 自行投影。职责：
 *   1. 用户消息落库
 *   2. 主动消息「首次回复」打点 + activity_capture 回写（与原 sendMessage 等价；
 *      用户主动发起的对话 has-unreplied 恒为 false，自然跳过）
 *   3. assistant 占位落库
 *   4. 从 DB 组装历史（真相源，跨窗口 / 跨入口一致）
 *   5. 按 backend 路由大脑（DeepSeek API 内置 agent loop / 本地 CLI 走 MCP）
 *   6. 回复落库 + touch 会话
 *
 * 约定：convId 必须已存在。会话创建留在调用方，因为各入口「会话从哪来」不同
 *（对话窗用 currentId，飞书用 chat_id → conv 映射）。
 */
export async function submitAgentRound(
  convId: string,
  content: string,
  opts: AgentRoundOptions = {}
): Promise<AgentRoundResult> {
  const trimmed = content.trim();
  const hooks = opts.hooks ?? {};

  // 1. 用户消息落库
  const userMsg: ChatMessageRow = {
    id: newId("m"),
    convId,
    role: "user",
    content: trimmed,
    createdAt: new Date().toISOString()
  };
  await dbInsertMessage(userMsg);
  hooks.onUserPersisted?.(userMsg);

  // 2. 主动消息「首次回复」处理（打点 + M3 回写，M4 去重）。整段沿用原 sendMessage 逻辑：
  //    一条主动消息只应被回写一次，靠 dbHasUnrepliedProactive 这道门去重；首次进门后立即
  //    dbMarkProactiveReplied，后续回复 has-unreplied=false → 整段跳过。
  //    await + try/catch：保证打点在大脑调用前完成，且任何失败都不拖垮本轮。
  try {
    const hasUnreplied = await dbHasUnrepliedProactive(convId);
    if (hasUnreplied) {
      await dbMarkProactiveReplied(convId, userMsg.createdAt);
      const proactiveType = await dbGetProactiveTypeForConv(convId);
      if (proactiveType === "activity_capture") {
        const now = new Date().toISOString();
        const actRec: ActivityRecord = {
          id: newActivityId(),
          content: trimmed,
          occurredAt: now, // 用当前时刻作为活动发生时间(用户刚回答"最近在忙啥")
          createdAt: now
        };
        await dbInsertActivity(actRec);
        emitSync("activities");
        // 顺带提炼一条 ongoing 记忆事实（7 天过期，阶段性信息不永久保留）
        await dbInsertMemoryFact({
          category: "ongoing",
          content: trimmed,
          source: "told",
          durability: "transient",
          pinned: false,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
        emitSync("memory");
      }
    }
  } catch (err) {
    console.warn("[chatStore] 主动消息首次回复处理(打点/回写)失败,忽略:", err);
  }

  // 3. assistant 占位落库(content 后续覆写)
  const assistantId = newId("m");
  const assistantPlaceholder: ChatMessageRow = {
    id: assistantId,
    convId,
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString()
  };
  await dbInsertMessage(assistantPlaceholder);
  hooks.onAssistantStart?.(assistantId);

  // 4. 历史 → 大脑：从 DB 取真相源。此刻占位已入库，故过滤掉它
  //    （等价于原 sendMessage 从 store 取并 filter 掉空占位）。
  const history = (await dbListMessages(convId))
    .filter((m) => m.id !== assistantId)
    .map((m): ChatMessage => ({ role: m.role, content: m.content }));

  // 5. 路由大脑
  let final = "";
  const backend = opts.backend ?? useSettingsStore.getState().chatBackend;
  try {
    if (backend === "deepseek-api") {
      // 路线 A：DeepSeek API + 内置 agent loop（chatTools.ts 的工具）
      const result = await chatAgentCall(history, {
        onStep: (info) => hooks.onApiToolStep?.(info.name)
      });
      final = result.content;
    } else {
      // 路线 B：本地 CLI（claude/codex/kiro），工具靠 CLI 连本机 MCP。无状态：每轮把
      //（人设 + 记忆 + 历史 + 当前消息）拼成完整 prompt 注入，与 API 路线上下文等价。
      const kind: CliKind =
        backend === "claude-cli" ? "claude" : backend === "codex-cli" ? "codex" : "kiro";
      const fullPrompt = buildCliPrompt(await buildAgentSystemPrompt(), history, trimmed);
      const result = await sendViaCli(kind, fullPrompt, {
        onText: (t) => hooks.onCliText?.(t),
        onThinking: (t) => hooks.onCliThinking?.(t),
        onToolCall: (name) => hooks.onCliToolCall?.(name)
      });
      final = result.content;
    }
  } catch (err) {
    console.error("[chatStore] send failed:", err);
    final = "(请求失败,请稍后重试。错误已记录到 console)";
  } finally {
    // 6. 回复落库 + touch 会话（失败也写兜底串，与原行为一致）
    await dbUpdateMessageContent(assistantId, final, undefined, undefined).catch((e) =>
      console.error("[chatStore] update msg failed:", e)
    );
    await dbTouchConversation(convId).catch(() => undefined);
    hooks.onComplete?.(final);
  }

  return { convId, userMsg, assistantId, content: final };
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

  selectConv: async (id, opts) => {
    if (!id) {
      set({ currentId: null });
      return;
    }
    set({ currentId: id });
    if (opts?.reload || !get().messagesByConv[id]) {
      try {
        const msgs = await dbListMessages(id);
        set((s) => ({ messagesByConv: { ...s.messagesByConv, [id]: msgs } }));
      } catch (err) {
        console.error("[chatStore] load messages failed:", err);
      }
    }
  },

  createConv: async (title, opts) => {
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
    // sendMessage 新建会话时，首条消息还没有落库。此时过早广播会让同窗口的
    // 强制 reload 与消息追加竞争；该路径把广播延后到整轮提交的 finally。
    if (!opts?.deferSync) emitSync("conversations");
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
      convId = await get().createConv(trimmed.slice(0, 24), { deferSync: true });
    }
    const cid = convId; // 收窄为非空，供下面的闭包使用

    const abort = new AbortController();
    set({ abort });

    // assistantId 由 submitAgentRound 在 onAssistantStart 时给出，onComplete 时用它定位占位消息
    let assistantId = "";

    try {
      // 大脑编排全部交给入口无关的 submitAgentRound；这里只负责把每一步投影到 Zustand，
      // 保持悬浮条的流式 / loading / 列表排序行为与重构前完全一致。
      await submitAgentRound(cid, trimmed, {
        hooks: {
          onUserPersisted: (msg) =>
            set((s) => {
              const current = s.messagesByConv[cid] ?? [];
              const existingIndex = current.findIndex((item) => item.id === msg.id);
              const next =
                existingIndex < 0
                  ? [...current, msg]
                  : current.map((item, index) => (index === existingIndex ? msg : item));
              return {
                messagesByConv: {
                  ...s.messagesByConv,
                  [cid]: next
                }
              };
            }),
          onAssistantStart: (id) => {
            assistantId = id;
            set((s) => ({
              messagesByConv: {
                ...s.messagesByConv,
                [cid]: [
                  ...(s.messagesByConv[cid] ?? []),
                  {
                    id,
                    convId: cid,
                    role: "assistant",
                    content: "",
                    createdAt: new Date().toISOString()
                  }
                ]
              },
              loading: true,
              streaming: "",
              streamingReasoning: ""
            }));
          },
          onApiToolStep: (name) =>
            set((s) => ({
              streaming: (s.streaming ? s.streaming + "\n" : "") + `⚙️ 调用工具 ${name}…`
            })),
          onCliText: (t) => set((s) => ({ streaming: s.streaming + t })),
          onCliThinking: (t) =>
            set((s) => ({ streamingReasoning: s.streamingReasoning + t })),
          onCliToolCall: (name) =>
            set((s) => ({
              streaming: (s.streaming ? s.streaming + "\n" : "") + `⚙️ 调用 ${name}…`
            })),
          onComplete: (final) =>
            set((s) => ({
              messagesByConv: {
                ...s.messagesByConv,
                [cid]: (s.messagesByConv[cid] ?? []).map((m) =>
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
                ...s.conversations
                  .filter((c) => c.id === cid)
                  .map((c) => ({ ...c, updatedAt: new Date().toISOString() })),
                ...s.conversations.filter((c) => c.id !== cid)
              ],
              streaming: "",
              streamingReasoning: "",
              loading: false,
              abort: null
            }))
        }
      });
    } finally {
      // 安全兜底：即便异常未触达 onComplete，也解除 loading / abort，避免 UI 卡死。
      if (get().loading || get().abort) {
        set({ loading: false, abort: null, streaming: "", streamingReasoning: "" });
      }
      emitSync("conversations");
    }
  },

  stop: () => {
    const a = get().abort;
    if (a) a.abort();
  }
}));
