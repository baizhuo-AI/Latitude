import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { History, Trash2, MessageSquare, Sparkles } from "lucide-react";
import { useChatStore } from "../lib/chatStore";
import { onSync } from "../lib/syncBus";
import { cn } from "../lib/utils";
import { useConfirm } from "../components/ConfirmDialog";

/**
 * 对话记录页(工作台)— 只读浏览对话条产生的会话:左侧会话列表,右侧完整往来,可删除。
 *
 * 对话发生在对话悬浮条(chatbar 窗,独立 JS context),这里靠 syncBus "conversations" 广播
 * 在每次新建/删除/发消息后重新 hydrate,保持列表最新。输入 / 继续聊在对话条做,这里专注"看记录"。
 */
export function ChatHistoryPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const conversations = useChatStore((s) => s.conversations);
  const currentId = useChatStore((s) => s.currentId);
  const messagesByConv = useChatStore((s) => s.messagesByConv);
  const hydrate = useChatStore((s) => s.hydrate);
  const selectConv = useChatStore((s) => s.selectConv);
  const deleteConv = useChatStore((s) => s.deleteConv);

  useEffect(() => {
    void hydrate();
    const off = onSync("conversations", () => void hydrate());
    return off;
  }, [hydrate]);

  const messages = currentId
    ? (messagesByConv[currentId] ?? []).filter((m) => m.role !== "system")
    : [];

  async function handleDelete(id: string, title: string) {
    const ok = await confirm({
      title: t("chat.deleteConv"),
      message: t("common.deleteConfirm", { title }),
      destructive: true,
      confirmLabel: t("chat.deleteConv")
    });
    if (ok) void deleteConv(id);
  }

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 px-6 flex items-center gap-3 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
        <History className="w-4 h-4 text-zinc-400 dark:text-zinc-500" />
        <h1 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {t("history.title")}
        </h1>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-72 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 overflow-y-auto scrollbar-thin">
          {conversations.length === 0 ? (
            <div className="px-4 py-12 text-center text-xs text-zinc-400 dark:text-zinc-500">
              {t("history.empty")}
            </div>
          ) : (
            <div className="p-2 space-y-0.5">
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => void selectConv(conv.id)}
                  className={cn(
                    "group w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-start gap-2",
                    currentId === conv.id
                      ? "bg-zinc-200/60 dark:bg-zinc-800/60 text-zinc-900 dark:text-zinc-100"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/40"
                  )}
                >
                  <MessageSquare className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-medium">{conv.title}</span>
                    <span className="block truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                      {fmtDate(conv.updatedAt)}
                    </span>
                  </span>
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(conv.id, conv.title);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-400 hover:text-red-500 transition-all"
                    aria-label={t("chat.deleteConv")}
                  >
                    <Trash2 className="w-3 h-3" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {!currentId ? (
            <div className="h-full flex items-center justify-center text-sm text-zinc-400 dark:text-zinc-500">
              {t("history.pick")}
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-zinc-400 dark:text-zinc-500">
              {t("history.noMessages")}
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">
              {messages.map((m) => (
                <Bubble
                  key={m.id}
                  role={m.role}
                  content={m.content}
                  reasoning={m.reasoningContent}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "";
  }
}

function Bubble({
  role,
  content,
  reasoning
}: {
  role: string;
  content: string;
  reasoning?: string;
}) {
  const isUser = role === "user";
  return (
    <div className={cn("flex gap-3", isUser && "justify-end")}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-4 h-4" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[80%] rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words px-4 py-2.5",
          isUser
            ? "bg-indigo-500 text-white rounded-br-sm"
            : "bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 rounded-bl-sm border border-zinc-200 dark:border-zinc-800"
        )}
      >
        {reasoning && !isUser && (
          <div className="mb-2 pb-2 border-b border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap font-mono">
            {reasoning}
          </div>
        )}
        {content || <span className="opacity-50">…</span>}
      </div>
    </div>
  );
}
