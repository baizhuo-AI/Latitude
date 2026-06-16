/**
 * cliPrompt.ts — 把多轮对话上下文序列化成单段 prompt，喂给无状态 CLI 引擎。
 *
 * 背景（Phase 4 铁律①，无状态适配器）：
 *   本地 CLI 引擎（Claude Code / Codex / Kiro）当哑引擎使用 —— 不用 --resume，
 *   不依赖引擎自身 session 续接上下文。每一轮都由 app 把〔人设 + 记忆 + 历史 +
 *   当前消息〕完整注入。但 CLI 引擎只吃单段文本 prompt，无法接收结构化的 messages
 *   数组，所以这里把多轮对话平铺序列化进一段 prompt。
 *
 *   这样 CLI 引擎拿到的上下文与 API 引擎（chatAgentCall 的 history messages）等价，
 *   续接靠 app 注入历史而非引擎会话，记忆只走 MCP 记忆工具落 app 自有库。
 *
 * 纯函数：systemPrompt / history 由调用方算好传入，便于就近单测。
 */

import type { ChatMessage } from "./llm/types";

/** 把消息角色映射成中文标签，供平铺成可读对话文本。 */
function roleLabel(role: ChatMessage["role"]): string {
  switch (role) {
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    case "system":
      return "系统";
    case "tool":
      return "工具结果";
  }
}

/**
 * 拼装喂给无状态 CLI 引擎的完整 prompt。
 *
 * @param systemPrompt        系统提示词（来自 buildChatSystemPrompt，已含人设/记忆/todos/Telos）
 * @param history             本会话历史消息（通常已含本轮 user 消息，调用方从 messagesByConv 取）
 * @param currentUserMessage  本轮用户消息原文（用于在 history 未含时兜底追加 + 去重）
 * @returns                   单段纯文本 prompt：系统提示词 + 分隔 + 平铺对话 + 末尾助手占位行
 *
 * 末尾留一个空的「助手：」行，提示模型接着这一行续写本轮回答。
 * 去重：history 末条若恰为本轮 user 消息，则不再重复追加 currentUserMessage。
 */
export function buildCliPrompt(
  systemPrompt: string,
  history: ChatMessage[],
  currentUserMessage: string
): string {
  const lines: string[] = [];
  for (const m of history) {
    if (!m.content) continue; // 跳过空占位（如空 assistant 占位行）
    lines.push(`${roleLabel(m.role)}：${m.content}`);
  }
  const tail = `${roleLabel("user")}：${currentUserMessage}`;
  if (lines[lines.length - 1] !== tail) {
    lines.push(tail);
  }
  return `${systemPrompt}\n\n---\n\n以下是对话历史，请作为助手续写本轮回答：\n\n${lines.join(
    "\n"
  )}\n\n${roleLabel("assistant")}：`;
}
