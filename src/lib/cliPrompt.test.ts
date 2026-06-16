/**
 * cliPrompt.test.ts — buildCliPrompt 纯函数（Phase 4 无状态 CLI 引擎上下文注入）
 *
 * 验收覆盖（铁律①：每轮 app 注入完整上下文，CLI 当哑引擎，不靠引擎自身会话续接）：
 *  1. systemPrompt 一定出现在 prompt 开头（人设 + 记忆 + 上下文随每轮注入）
 *  2. 多轮历史按「角色：内容」平铺序列化，顺序保持
 *  3. 末尾追加空的「助手：」占位行，提示模型续写本轮
 *  4. history 末条恰为本轮 user 消息时不重复追加（去重）
 *  5. history 未含本轮 user 消息时兜底追加 currentUserMessage
 *  6. 空 content 的占位消息（如空 assistant 占位）被跳过
 */

import { describe, it, expect } from "vitest";
import { buildCliPrompt } from "./cliPrompt";
import type { ChatMessage } from "./llm/types";

describe("buildCliPrompt — 无状态 CLI 引擎上下文注入", () => {
  it("1. systemPrompt 出现在开头", () => {
    const out = buildCliPrompt("SYS-PROMPT", [], "你好");
    expect(out.startsWith("SYS-PROMPT")).toBe(true);
  });

  it("2. 多轮历史按角色平铺，顺序保持", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "第一句" },
      { role: "assistant", content: "回复一" },
      { role: "user", content: "第二句" },
    ];
    const out = buildCliPrompt("SYS", history, "第二句");
    const iUser1 = out.indexOf("用户：第一句");
    const iAsst1 = out.indexOf("助手：回复一");
    const iUser2 = out.indexOf("用户：第二句");
    expect(iUser1).toBeGreaterThan(-1);
    expect(iAsst1).toBeGreaterThan(iUser1);
    expect(iUser2).toBeGreaterThan(iAsst1);
  });

  it("3. 末尾留空的助手占位行提示续写", () => {
    const out = buildCliPrompt("SYS", [{ role: "user", content: "嗨" }], "嗨");
    expect(out.endsWith("助手：")).toBe(true);
  });

  it("4. history 末条即本轮 user 消息时不重复追加", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "上轮回复" },
      { role: "user", content: "本轮提问" },
    ];
    const out = buildCliPrompt("SYS", history, "本轮提问");
    // 「用户：本轮提问」只应出现一次
    const matches = out.match(/用户：本轮提问/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("5. history 未含本轮 user 消息时兜底追加", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "上轮回复" },
    ];
    const out = buildCliPrompt("SYS", history, "新提问");
    expect(out).toContain("用户：新提问");
  });

  it("6. 空 content 的占位消息被跳过", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "有内容" },
      { role: "assistant", content: "" }, // 空 assistant 占位
    ];
    const out = buildCliPrompt("SYS", history, "有内容");
    // 不应出现孤立的「助手：」后面紧跟换行而内容为空的历史行
    // 仅末尾占位行允许是「助手：」，正文里不该有空助手历史
    const bodyBeforeTail = out.slice(0, out.lastIndexOf("助手："));
    expect(bodyBeforeTail).not.toContain("助手：\n");
    expect(out).toContain("用户：有内容");
  });
});
