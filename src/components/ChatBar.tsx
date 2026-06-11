import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, ArrowUp, Plus, Square, ChevronDown } from "lucide-react";
import { useChatStore } from "../lib/chatStore";
import { cn } from "../lib/utils";
import { setChatBarExpanded } from "../lib/windowLayout";

/**
 * 对话悬浮条 ChatBar — Hermes 式细长输入条 + 回车在条上方就地展开会话。
 *
 * 窗口(label "chatbar")透明、无边框、置顶。收起只剩底部输入条;展开时窗口向上长高(底边固定),
 * 会话面板浮在条上方。复用 chatStore(流式 + 多后端,与设置里选的后端一致)。
 *
 * 展开条件:输入聚焦 / 当前会话有消息 / 正在请求;Esc 或点收起按钮强制收起。
 */
export function ChatBar() {
  const { t } = useTranslation();
  const currentId = useChatStore((s) => s.currentId);
  const messagesByConv = useChatStore((s) => s.messagesByConv);
  const streaming = useChatStore((s) => s.streaming);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const loading = useChatStore((s) => s.loading);
  const hydrate = useChatStore((s) => s.hydrate);
  const createConv = useChatStore((s) => s.createConv);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stop = useChatStore((s) => s.stop);

  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = currentId ? (messagesByConv[currentId] ?? []) : [];
  const hasConversation = messages.some((m) => m.role !== "system");
  const expanded = !collapsed && (focused || hasConversation || loading);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

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
