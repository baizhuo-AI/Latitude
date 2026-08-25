import { useEffect, useRef } from "react";
import type { ChatMessageRow, ConversationRow } from "../lib/db";
import { SafeMarkdown } from "./SafeMarkdown";
import "./deskThread.css";

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
  onClose,
  closeEnabled = true,
}: {
  messages: ChatMessageRow[];
  /** 最新会话在前；让飞书与主动秘书新建的会话在 Dimension 内可达。 */
  conversations: ConversationRow[];
  currentId: string | null;
  /** 正在流式接收的秘书回复（未落库的部分） */
  streaming: string;
  loading: boolean;
  onSelectConversation: (id: string) => void;
  onClose: () => void;
  closeEnabled?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streaming]);

  return (
    <section
      aria-label="与秘书的对话"
      className="dim-paper dim-thread"
    >
      <div className="dim-thread__header">
        {/* Keep the exit in the stable left safe area beside the secretary rail. */}
        <button
          type="button"
          className="dim-btn dim-btn--quiet dim-thread__close"
          onClick={onClose}
          disabled={!closeEnabled}
          aria-disabled={!closeEnabled}
          title={closeEnabled ? undefined : "合上动作已在组件设置中关闭"}
        >
          合上 ↓
        </button>
        <div className="dim-thread__identity">
          <span className="dim-eyebrow">对话 · 同一页纸上</span>
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
      </div>

      <div
        ref={scrollRef}
        className="dim-thread__scroll"
        data-deck-scroll="contain"
        tabIndex={0}
        aria-label="对话消息"
      >
        <div className="dim-thread__messages" aria-live="polite">
          {messages.map((m) => (
            <article
              key={m.id}
              className="dim-thread__message"
              data-role={m.role}
            >
              {m.role === "user" ? (
                <p className="dim-thread__plain">{m.content}</p>
              ) : (
                <SafeMarkdown
                  content={m.content || (loading && m.role === "assistant" ? "…" : "")}
                />
              )}
            </article>
          ))}
          {loading && streaming && (
            <article className="dim-thread__message" data-role="assistant">
              <SafeMarkdown content={streaming} />
            </article>
          )}
          {loading && (
            <span className="dim-meta dim-thread__thinking">
              秘书在想…
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
