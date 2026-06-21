import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { Sparkles, ArrowUp, Plus, Square, ChevronDown, MessageCircle, X } from "lucide-react";
import { useChatStore } from "../lib/chatStore";
import { useSettingsStore } from "../lib/settings";
import { cn } from "../lib/utils";
import { setChatBarExpanded } from "../lib/windowLayout";
import { onSync } from "../lib/syncBus";

/**
 * 判断一个对话 id 是否来自主动消息投递(晨间简报或事件触发)。
 *
 * 识别规则(按 id 前缀):
 *   - "brief" → composeMorningBriefing 投递的晨间简报对话
 *   - "pa"    → deliverProactive 投递的事件触发主动消息对话
 *   - "ac"    → activity_capture 投递的活动捕获对话(M3 新增)
 *
 * 不查 DB:前缀是唯一确定性标记,避免异步 DB 查询带来的竞态。
 */
function isProactiveConvId(id: string): boolean {
  return id.startsWith("brief") || id.startsWith("pa") || id.startsWith("ac");
}

/**
 * 对话悬浮条 ChatBar — Hermes 式细长输入条 + 回车在条上方就地展开会话。
 *
 * 窗口(label "chatbar")透明、无边框、置顶。收起只剩底部输入条;展开时窗口向上长高(底边固定),
 * 会话面板浮在条上方。复用 chatStore(流式 + 多后端,与设置里选的后端一致)。
 *
 * 展开条件:输入聚焦 / 当前会话有消息 / 正在请求;Esc 或点收起按钮强制收起。
 *
 * 轻提示:订阅 conversations 同步事件,检测新投递的主动消息对话,在底条上方显示一行
 * 轻提示横幅。点击即 selectConv 打开那条对话续聊,不强制切走用户当前正在打的对话。
 */
export function ChatBar() {
  const { t } = useTranslation();
  const currentId = useChatStore((s) => s.currentId);
  const messagesByConv = useChatStore((s) => s.messagesByConv);
  const conversations = useChatStore((s) => s.conversations);
  const streaming = useChatStore((s) => s.streaming);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const loading = useChatStore((s) => s.loading);
  const hydrate = useChatStore((s) => s.hydrate);
  const createConv = useChatStore((s) => s.createConv);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const selectConv = useChatStore((s) => s.selectConv);
  const stop = useChatStore((s) => s.stop);

  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // 轻提示状态:null = 无提示;string = 待查看的主动消息对话 id
  const [proactiveHintConvId, setProactiveHintConvId] = useState<string | null>(null);
  // 已经显示过提示的 conv id 集合(避免重复提示同一条)
  const shownProactiveIds = useRef<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = currentId ? (messagesByConv[currentId] ?? []) : [];
  const hasConversation = messages.some((m) => m.role !== "system");
  const expanded = !collapsed && (focused || hasConversation || loading);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // 订阅 conversations 同步事件:检测新的主动消息对话,给出轻提示。
  // 轻提示原则:
  //   - 只提示用户当前不在看的那条对话(currentId !== convId)
  //   - 同一条对话只提示一次(shownProactiveIds 追踪)
  //   - 不强制切 currentId(那是用户点击后才发生的事)
  useEffect(() => {
    const unsubscribe = onSync("conversations", () => {
      // hydrate 刷新 conversations 列表(真相源在 store,这里复用 conversations 快照)
      // 注:此 effect 内 conversations 会是闭包值,但 onSync 每次触发都会重新执行这个回调,
      // 而 React 每次 state 变化都会重新注册 effect(依赖 conversations)——
      // 所以取消订阅/重新订阅在 conversations 变化时也会发生。
      // 轻量做法:在同步事件后直接检查最新 conversations(state 里已是最新的)。
      // 但 conversations 是闭包的旧值;改用 ref 持有最新 conversations。
      // 实际上:onSync 后 hydrate 会更新 store → React re-render → 新 conversations → effect 重跑
      // 但 onSync 的 handler 是 stale closure。所以改为:订阅后直接调 hydrate,再在下次渲染时检测。
      // 更简单的做法:在 conversations 的 useEffect 里做检测,而非在 onSync handler 里。
      void hydrate();
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrate]);

  // 每次 conversations 更新后,检查是否有新的主动消息对话需要提示
  useEffect(() => {
    for (const conv of conversations) {
      // 跳过:已提示过的 / 用户当前正在看的 / 非主动消息前缀
      if (
        shownProactiveIds.current.has(conv.id) ||
        conv.id === currentId ||
        !isProactiveConvId(conv.id)
      ) {
        continue;
      }
      // 发现新的主动消息对话:标记已处理 + 设置轻提示
      shownProactiveIds.current.add(conv.id);
      setProactiveHintConvId(conv.id);
      break; // 一次只提示一条(最新的那条),多条下次 render 继续
    }
  }, [conversations, currentId]);

  // 透明窗口:给 <html> 挂 .is-floating 让背景透明,四角圆角透出桌面
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("is-floating");
    return () => html.classList.remove("is-floating");
  }, []);

  // 展开/收起 → 调窗口高度(底边固定)
  useEffect(() => {
    void setChatBarExpanded(expanded);
  }, [expanded]);

  // 新消息 / 流式更新时滚到底
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, streaming]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || loading) return;
    setDraft("");
    setCollapsed(false);
    await sendMessage(text);
    inputRef.current?.focus();
  }

  /** 用户点击轻提示横幅:打开主动消息对话,消掉提示 */
  function handleProactiveHintClick() {
    if (!proactiveHintConvId) return;
    void selectConv(proactiveHintConvId);
    setProactiveHintConvId(null);
  }

  return (
    <div className="flex h-screen w-screen flex-col justify-end gap-2 overflow-hidden p-2">
      {expanded && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-bg-elevated text-text">
          <div
            data-tauri-drag-region
            className="flex flex-shrink-0 items-center justify-between border-b border-border/50 px-3 py-1.5"
          >
            <span className="select-none text-[11px] font-semibold uppercase tracking-wider text-text-faint">
              {t("chatbar.title")}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-tauri-drag-region="false"
                onClick={() => void createConv()}
                title={t("chat.newConv")}
                aria-label={t("chat.newConv")}
                className="rounded p-1 text-text-faint transition-colors hover:bg-bg-muted hover:text-text"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-tauri-drag-region="false"
                onClick={() => setCollapsed(true)}
                title={t("chatbar.collapse")}
                aria-label={t("chatbar.collapse")}
                className="rounded p-1 text-text-faint transition-colors hover:bg-bg-muted hover:text-text"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div ref={scrollRef} className="scrollbar-thin flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {!hasConversation && !loading ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-xs text-text-faint">
                {t("chatbar.empty")}
              </div>
            ) : (
              messages
                .filter((m) => m.role !== "system")
                .map((m, idx) => {
                  const isAssistant = m.role === "assistant";
                  const isLast = idx === messages.length - 1;
                  const isStreamingThis = isAssistant && loading && isLast;
                  return (
                    <Bubble
                      key={m.id}
                      role={m.role}
                      content={isStreamingThis ? streaming : m.content}
                      reasoning={isStreamingThis ? streamingReasoning : m.reasoningContent}
                      streaming={isStreamingThis}
                    />
                  );
                })
            )}
          </div>
        </div>
      )}

      {/* 主动消息悬浮通知卡片 */}
      <ProactiveToast
        convId={proactiveHintConvId}
        onOpen={handleProactiveHintClick}
        onDismiss={() => setProactiveHintConvId(null)}
      />

      <div
        data-tauri-drag-region
        className="flex flex-shrink-0 items-center gap-2 rounded-full border border-border/70 bg-bg-elevated px-3 py-2 text-text"
      >
        <Sparkles
          className={cn("h-4 w-4 flex-shrink-0", draft ? "text-accent" : "text-text-faint")}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          data-tauri-drag-region="false"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            } else if (e.key === "Escape") {
              setCollapsed(true);
              inputRef.current?.blur();
            }
          }}
          placeholder={t("chatbar.placeholder")}
          className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-faint"
        />
        {loading ? (
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={stop}
            title={t("chat.stop")}
            aria-label={t("chat.stop")}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={() => void handleSend()}
            disabled={!draft.trim()}
            title={t("chat.send")}
            aria-label={t("chat.send")}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function Bubble({
  role,
  content,
  reasoning,
  streaming
}: {
  role: string;
  content: string;
  reasoning?: string;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className={cn("flex", isUser && "justify-end")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed",
          isUser
            ? "rounded-br-sm bg-accent text-white"
            : "rounded-bl-sm border border-border/60 bg-bg-muted text-text"
        )}
      >
        {reasoning && !isUser && (
          <div className="mb-1.5 border-l-2 border-accent/40 pl-2 text-xs text-text-faint">
            {reasoning}
          </div>
        )}
        {content || (streaming ? "" : <span className="opacity-50">…</span>)}
        {streaming && content && (
          <span className="ml-0.5 inline-block h-3.5 w-1.5 -mb-0.5 animate-pulse bg-current align-baseline" />
        )}
      </div>
    </div>
  );
}

const TOAST_AUTO_DISMISS_MS = 5000;

function ProactiveToast({
  convId,
  onOpen,
  onDismiss,
}: {
  convId: string | null;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const personaName = useSettingsStore((s) => s.persona.name);
  const [hovered, setHovered] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!convId) return;
    if (hovered) return;
    timerRef.current = setTimeout(onDismiss, TOAST_AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [convId, hovered, onDismiss]);

  const hintText = personaName
    ? t("chatbar.proactiveHint", { name: personaName })
    : t("chatbar.proactiveHintAnon");

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {convId && (
        <motion.div
          key="proactive-toast"
          initial={{ opacity: 0, y: -40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ type: "spring", damping: 25, stiffness: 350 }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="fixed top-4 left-1/2 z-[80] -translate-x-1/2"
        >
          <button
            type="button"
            data-testid="proactive-hint"
            onClick={onOpen}
            className={cn(
              "flex items-center gap-2.5 rounded-xl px-4 py-2.5",
              "border border-border/60 bg-bg-elevated/95 backdrop-blur-md shadow-lg",
              "text-sm text-text transition-all",
              "hover:shadow-xl hover:border-accent/50"
            )}
          >
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
              <MessageCircle className="h-3.5 w-3.5" />
            </span>
            <span className="flex-1 truncate max-w-[240px]">{hintText}</span>
            <span
              role="button"
              tabIndex={0}
              aria-label="dismiss"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  onDismiss();
                }
              }}
              className="flex-shrink-0 rounded p-0.5 text-text-faint transition-colors hover:text-text hover:bg-bg-muted"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
