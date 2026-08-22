//! 飞书对话桥（前端，主窗）——把 Rust 入站消费端收到的飞书消息接进秘书核心。
//!
//! 数据流：Rust `feishu::inbound` 收到飞书 IM 消息 → emit "feishu://incoming" 到主窗
//!   → 本桥监听 → 映射 chat_id↔conversation → `submitAgentRound` 跑一轮（复用前端秘书核心，
//!   人设/工具/记忆/历史全一致）→ 调 Tauri 命令 `feishu_send_reply` 把回复发回飞书。
//!
//! 只在主窗（MainWindow）挂一份：主窗「关闭=隐藏」始终存活，是可靠的执行器；且主窗的 settings
//! store 是真相源（非主窗内存态可能过期，见多窗口 store 隔离）。

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { submitAgentRound } from "./chatStore";
import {
  dbFindConversationByExternal,
  dbInsertConversation,
  type ConversationRow
} from "./db";
import { useSettingsStore } from "./settings";
import { emitSync } from "./syncBus";

/** Rust 入站消费端 emit 过来的飞书消息载荷（字段为 snake_case，与 Rust 结构对齐）。 */
interface FeishuIncoming {
  chat_id: string;
  chat_type: string;
  sender_id: string;
  message_id: string;
  event_id: string;
  /** content：lark-cli 已渲染成人类可读文本（text/post/image 等）。 */
  text: string;
}

function newConvId(): string {
  return `c${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 找到（或新建）某个飞书会话对应的 Latitude conversation，返回 conversationId。 */
async function resolveFeishuConv(chatId: string): Promise<string> {
  const existing = await dbFindConversationByExternal("feishu", chatId);
  if (existing) return existing.id;
  const now = new Date().toISOString();
  const conv: ConversationRow = {
    id: newConvId(),
    title: `飞书 · ${chatId.slice(0, 12)}`,
    createdAt: now,
    updatedAt: now,
    channel: "feishu",
    externalId: chatId
  };
  await dbInsertConversation(conv);
  emitSync("conversations"); // 让对话列表（悬浮条等）刷出这条飞书会话
  return conv.id;
}

/** 处理一条飞书入站消息：映射会话 → 跑秘书核心 → 把回复发回飞书。 */
async function handleFeishuIncoming(p: FeishuIncoming): Promise<void> {
  if (!p.text.trim() || !p.chat_id) return;
  const convId = await resolveFeishuConv(p.chat_id);
  // 复用前端秘书核心；显式传 backend（主窗 settings 是真相源）。不传 hooks（飞书侧无 UI 投影）。
  const result = await submitAgentRound(convId, p.text, {
    backend: useSettingsStore.getState().chatBackend
  });
  // 回复发回飞书（Rust 命令 feishu_send_reply 转 lark-cli im +messages-send）。
  await invoke("feishu_send_reply", { chatId: p.chat_id, text: result.content });
  emitSync("conversations");
}

/**
 * 在主窗挂飞书对话桥：监听 Rust 的 "feishu://incoming"，**串行**处理
 * （v1 不并发：一条处理完再下一条，避免同会话历史交错）。返回反注册函数。
 */
export function setupFeishuChatBridge(): () => void {
  let queue: Promise<void> = Promise.resolve();
  let unlisten: (() => void) | undefined;
  let disposed = false;

  void (async () => {
    const off = await listen<FeishuIncoming>("feishu://incoming", (e) => {
      const payload = e.payload;
      queue = queue
        .then(() => handleFeishuIncoming(payload))
        .catch((err) => console.error("[feishuChat] 处理飞书消息失败:", err));
    });
    // 极少数竞态：注册完成前就 dispose 了，立刻反注册。
    if (disposed) off();
    else unlisten = off;
  })();

  return () => {
    disposed = true;
    unlisten?.();
  };
}
