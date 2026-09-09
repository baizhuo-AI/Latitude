import { memo, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useSurfaceMotion } from "./SurfaceMotion";
import { createPortal } from "react-dom";
import type { ChatMessageRow, ConversationRow } from "../lib/db";
import { SafeMarkdown } from "./SafeMarkdown";
import "./deskThread.css";
import type { AgentProgressItem } from "../shared/agentExperience";
import { MessageComposer, type SendComposerMessage } from "./composer/MessageComposer";
import { displayComposerMessage } from "./composer/attachments";

export interface AssistantExplanation {
  summary: string;
  steps: string[];
  uncertainty?: string;
}

type ExplainableChatMessage = ChatMessageRow & {
  explanation?: AssistantExplanation;
};

/**
 * 桌面上的对话层：对话条发出去的话和秘书的回复都在这里。
 *
 * 它不是新页面，是桌面同一位置升起来的一张纸（下钻保留上下文，
 * 合上回到桌面原样 —— 前端体验 PRD §9.2）。
 */
export function DeskThread({
  messages,
  conversations,
  currentId,
  streaming,
  loading,
  onSelectConversation,
  onNewConversation,
  onClose,
  closeEnabled = true,
  newConversationEnabled = true,
  variant = "embedded",
  onSend,
  sendEnabled = true,
  onCancel,
  onReconnect,
  status,
  historyError,
  proactivePrompt,
  onProactivePromptAction,
  proactivePromptActionEnabled = true,
  zIndex,
  onActivate,
  progress = [],
  progressRunId,
  useComputerHistory,
  onComputerHistoryChange,
}: {
  messages: ExplainableChatMessage[];
  /** 最新会话在前；让飞书与主动秘书新建的会话在 Dimension 内可达。 */
  conversations: ConversationRow[];
  currentId: string | null;
  /** 正在流式接收的秘书回复（未落库的部分） */
  streaming: string;
  loading: boolean;
  onSelectConversation: (id: string) => void;
  onNewConversation?: () => void;
  onClose: () => void;
  closeEnabled?: boolean;
  newConversationEnabled?: boolean;
  variant?: "embedded" | "floating" | "native";
  onSend?: SendComposerMessage;
  sendEnabled?: boolean;
  onCancel?: () => void | Promise<void>;
  onReconnect?: () => void;
  status?: string | null;
  historyError?: string | null;
  /** 秘书主动发起的话题。它属于这段对话，不另开一个竞争入口。 */
  proactivePrompt?: string | null;
  onProactivePromptAction?: () => void;
  proactivePromptActionEnabled?: boolean;
  /** Browser workbench window stack: the most recently clicked window owns the top layer. */
  zIndex?: number;
  onActivate?: () => void;
  progress?: AgentProgressItem[];
  progressRunId?: string | null;
  useComputerHistory?: boolean;
  onComputerHistoryChange?: (enabled:boolean)=>void;
}) {
  const surfaceMotion = useSurfaceMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followingBottom = useRef(true);
  const promptStorageKey = `latitude.thread.hidden-prompt:${currentId ?? "new"}`;
  const [hiddenPrompt, setHiddenPrompt] = useState<string | null>(() => {
    try { return sessionStorage.getItem(promptStorageKey); } catch { return null; }
  });
  useEffect(() => {
    try { setHiddenPrompt(sessionStorage.getItem(promptStorageKey)); } catch { setHiddenPrompt(null); }
  }, [promptStorageKey]);
  const hasPrompt = Boolean(proactivePrompt?.trim());
  const promptHidden = hasPrompt && hiddenPrompt === proactivePrompt;
  const setPromptHidden = (hidden: boolean) => {
    const value = hidden ? proactivePrompt ?? null : null;
    setHiddenPrompt(value);
    try {
      if (value) sessionStorage.setItem(promptStorageKey, value);
      else sessionStorage.removeItem(promptStorageKey);
    } catch { /* Hiding still works for this open conversation when storage is unavailable. */ }
  };

  useEffect(() => {
    if (scrollRef.current && followingBottom.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streaming, loading, progress.length > 0]);

  useEffect(() => {
    if (variant === "floating" || variant === "native") composerRef.current?.focus();
  }, [variant]);

  const lastMessage = messages[messages.length - 1];
  const progressBeforeMessageId = !loading && lastMessage?.role === "assistant" ? lastMessage.id : null;
  const runProgress = (progress.length > 0 || loading)
    ? <RunProgress key={progressRunId} items={progress} running={loading} />
    : null;

  const thread = (
    <motion.section
      {...(variant === "floating" ? surfaceMotion : {})}
      aria-label="与秘书的对话"
      aria-modal={variant !== "embedded" ? "false" : undefined}
      role={variant !== "embedded" ? "dialog" : undefined}
      className={`dim-paper dim-thread${variant !== "embedded" ? ` dim-thread--${variant}` : ""}`}
      style={variant === "floating" && zIndex !== undefined ? { zIndex } : undefined}
      onPointerDown={() => onActivate?.()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && closeEnabled && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="dim-thread__header" data-tauri-drag-region={variant === "native" ? true : undefined}>
        <div className="dim-thread__identity" data-tauri-drag-region={variant === "native" ? true : undefined}>
          <span className="dim-eyebrow" data-tauri-drag-region={variant === "native" ? true : undefined}>
            {variant !== "embedded" ? "与秘书的对话" : "对话 · 同一页纸上"}
          </span>
          {conversations.length > 0 && (
            <select
              aria-label="切换对话"
              value={currentId ?? ""}
              onChange={(event) => onSelectConversation(event.target.value)}
              disabled={loading}
              className="dim-thread__select"
            >
              {!currentId && (
                <option value="" disabled>
                  选择会话
                </option>
              )}
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="dim-thread__header-actions">
          {promptHidden && <button type="button" className="dim-btn dim-btn--quiet"
            aria-label="重新显示秘书话题" onClick={() => setPromptHidden(false)}>显示话题</button>}
          {onComputerHistoryChange&&<label className="dim-meta" title="关闭后，本段对话不再读取电脑记录和相关认识；已显示的消息仍保留。"><input type="checkbox" checked={useComputerHistory!==false} disabled={loading} onChange={event=>onComputerHistoryChange(event.target.checked)}/>使用电脑记录</label>}
          {onNewConversation && (
            <button
              type="button"
              className="dim-btn dim-btn--quiet dim-thread__new"
              onClick={() => {
                onNewConversation();
                composerRef.current?.focus();
              }}
              disabled={!newConversationEnabled || loading}
              aria-disabled={!newConversationEnabled || loading}
              aria-label="新开对话"
              title={loading ? "当前回复完成后再新开对话" : "新开一段独立对话"}
            >
              ＋ 新对话
            </button>
          )}
          <button
            type="button"
            className="dim-btn dim-btn--quiet dim-thread__close"
            onClick={onClose}
            disabled={!closeEnabled}
            aria-disabled={!closeEnabled}
            title={closeEnabled ? undefined : "合上动作已在组件设置中关闭"}
          >
            {variant !== "embedded" ? "关闭" : "合上 ↓"}
          </button>
        </div>
      </div>

      {hasPrompt && !promptHidden && (
        <article className="dim-thread__proactive" aria-label="秘书主动发起的话题">
          <div className="dim-thread__proactive-heading">
            <span className="dim-eyebrow">秘书想和你聊件事</span>
            <button type="button" className="dim-btn dim-btn--quiet"
              aria-label="先隐藏秘书话题" onClick={() => setPromptHidden(true)}>先隐藏</button>
          </div>
          <p>{proactivePrompt}</p>
          {onProactivePromptAction && (
            <button
              type="button"
              className="dim-btn dim-btn--quiet dim-thread__proactive-action"
              onClick={onProactivePromptAction}
              disabled={!proactivePromptActionEnabled}
            >
              处理这件事
            </button>
          )}
        </article>
      )}

      <div
        ref={scrollRef}
        className="dim-thread__scroll"
        data-deck-scroll="contain"
        tabIndex={0}
        aria-label="对话消息"
        onScroll={(event) => {
          const element = event.currentTarget;
          followingBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
        }}
      >
        <div className="dim-thread__messages" aria-live="polite">
          {messages.length === 0 && !loading && (!hasPrompt || promptHidden) && (
            <p className="dim-thread__empty">还没有对话，直接在下面说点什么。</p>
          )}
          {messages.flatMap((m) => [
            ...(m.id === progressBeforeMessageId ? [runProgress] : []),
            <ThreadMessage key={m.id} m={m} pending={loading && m.role === "assistant" && !m.content} />,
          ])}
          {!progressBeforeMessageId && runProgress}
          {loading && streaming && (
            <article className="dim-thread__message" data-role="assistant">
              <SafeMarkdown content={streaming} />
            </article>
          )}
          {loading && (
            <span className="dim-meta dim-thread__thinking">
              {status || "秘书在想…"}
            </span>
          )}
          {historyError && (
            <p className="dim-thread__history-error" role="status">{historyError}
              {onReconnect && <button className="dim-btn dim-btn--quiet" onClick={onReconnect}>重新连接</button>}
            </p>
          )}
        </div>
      </div>

      {onSend && <MessageComposer ref={composerRef} sessionId={currentId ?? "new"} onSend={onSend} loading={loading} sendEnabled={sendEnabled} onCancel={onCancel} autoFocus={variant !== "embedded"} />}
    </motion.section>
  );

  const portalHost = variant === "floating" && typeof document !== "undefined"
    ? document.querySelector<HTMLElement>(".dim-preset-shell")
    : null;
  return portalHost ? createPortal(thread, portalHost) : thread;
}

function RunProgress({ items, running }: { items: AgentProgressItem[]; running: boolean }) {
  const [open, setOpen] = useState(running);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingBottom = useRef(true);
  useEffect(() => { if (!running) setOpen(false); }, [running]);
  useEffect(() => {
    if (running && contentRef.current && followingBottom.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [items, running, open]);
  return <details className="dim-thread__progress" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{running ? "正在处理 · 查看过程" : "查看本轮处理过程"}</summary>
    <div className="dim-thread__progress-content" ref={contentRef} aria-label="本轮处理过程" onScroll={(event) => {
      const element = event.currentTarget;
      followingBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    }}>
      {items.length === 0 && <p className="dim-meta">等待模型返回过程…</p>}
      {items.map((item) => item.kind === "reasoning"
        ? <div key={item.seq} className="dim-thread__reasoning"><span className="dim-eyebrow">思考</span><p>{item.text}</p></div>
        : <p key={item.seq} className="dim-thread__progress-step">{item.text}{item.kind === "tool" ? item.state === "running" ? "…" : item.state === "failed" ? " · 未成功" : " · 已完成" : ""}</p>)}
    </div>
  </details>;
}

// Streaming progress must not reparse every completed Markdown reply.
const ThreadMessage = memo(function ThreadMessage({ m, pending }: { m: ExplainableChatMessage; pending: boolean }) {
  return (
    <article
      className="dim-thread__message"
      data-role={m.role}
    >
      {m.role === "user" ? (
        <p className="dim-thread__plain">{displayComposerMessage(m.content)}</p>
      ) : (
        <>
          <SafeMarkdown
            content={m.content || (pending ? "…" : "")}
          />
          {m.explanation && (
            <details className="dim-thread__explanation">
              <summary>为什么这样回答</summary>
              <p>{m.explanation.summary}</p>
              <ol>
                {m.explanation.steps.map((step, index) => (
                  <li key={`${m.id}-explanation-${index}`}>{step}</li>
                ))}
              </ol>
              {m.explanation.uncertainty && (
                <p className="dim-thread__uncertainty">
                  还不确定：{m.explanation.uncertainty}
                </p>
              )}
            </details>
          )}
        </>
      )}
    </article>
  );
});
