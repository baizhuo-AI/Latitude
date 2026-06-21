//! 飞书主动推送（轻量）—— 把秘书的「主动消息」也发到飞书单聊（选项 A）。
//!
//! 单独成一个轻模块，只依赖 db + Tauri invoke，**不 import chatStore**，避免把对话核心
//! 拖进 secretary 层的测试图（测试套件较脆弱，缩小波及面）。
//!
//! 语义：电脑开着时，秘书每投递一条主动消息（晨间简报 / 提醒 / 活动记录），顺手也推一份到
//! 你和 bot 的飞书单聊。目标会话 = 最近的飞书会话 chat_id（你 DM 过 bot 才有）；没有则静默跳过。
//! fire-and-forget：失败只记日志，绝不影响 app 内已投递的主动消息。

import { invoke } from "@tauri-apps/api/core";
import { dbGetLatestFeishuChatId } from "./db";

export async function pushProactiveToFeishu(text: string): Promise<void> {
  if (!text.trim()) return;
  try {
    const chatId = await dbGetLatestFeishuChatId();
    if (!chatId) return; // 还没 DM 过 bot，不知道往哪推
    await invoke("feishu_send_reply", { chatId, text });
  } catch (err) {
    console.warn("[feishuPush] 主动消息推送飞书失败，忽略:", err);
  }
}
