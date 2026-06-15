/**
 * buildChatSystemPrompt.test.ts — 跨窗口人设/语言新鲜度测试
 *
 * 验收场景:
 *   Daybreak 多窗口架构下,对话悬浮条(chatbar)窗口的 Zustand store 是陈旧快照——
 *   主窗口(设置页)改了人设/语言后,只更新了主窗口 store + localStorage;
 *   对话窗口的 store 内存态仍是旧值。
 *
 *   buildChatSystemPrompt 必须直读 localStorage 真相源(readSettingsSnapshot),
 *   而不是读 useSettingsStore.getState()，才能让改了人设的效果跨窗口即时生效。
 *
 * 测试策略:
 *   - useSettingsStore.getState() → 返回「旧人设」(模拟陈旧 store)
 *   - readSettingsSnapshot()      → 返回「新人设」(模拟 localStorage 最新值)
 *   - 断言 buildChatSystemPrompt 输出的系统提示词使用「新人设」
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeEngine, installFakeEngine } from "./fakeEngine";

// ─── 注入假引擎(绕开 getProvider 单例缓存)─────────────────────────────────
const { setEngine } = installFakeEngine();

// ─── mock 依赖 ────────────────────────────────────────────────────────────────

vi.mock("../db", () => ({
  dbInsertUsage: async () => undefined,
  dbGetRecentDigests: async () => [],
}));

vi.mock("../chatTools", () => ({
  toolsForLLM: () => [],
  runChatTool: async () => "{}",
}));

vi.mock("../store", () => ({
  useTodoStore: { getState: () => ({ todos: [] }) },
}));

vi.mock("../goalsStore", () => ({
  useGoalsStore: { getState: () => ({ goals: [] }) },
}));

/**
 * 关键 mock:
 *  - useSettingsStore.getState() → 旧人设(wittyPartner),模拟陈旧窗口 store
 *  - readSettingsSnapshot()      → 新人设(gentleCompanion),模拟 localStorage 最新值
 *
 * 修复后 buildChatSystemPrompt 应走 readSettingsSnapshot,输出新人设对应的文案；
 * 修复前走 useSettingsStore.getState(),会错误地用旧人设。
 */
vi.mock("../settings", () => ({
  onProviderConfigChange: () => () => undefined,
  // 陈旧 store 快照:人设是 wittyPartner(旧)
  useSettingsStore: {
    getState: () => ({
      lang: "en",                          // 旧语言
      persona: { presetKey: "wittyPartner" }, // 旧人设
      llmProvider: "deepseek",
      providers: {
        deepseek: {
          apiKey: "test-key",
          baseUrl: "https://example.test",
          model: "deepseek-chat",
        },
      },
    }),
  },
  // localStorage 真相源:人设已被用户更新为 gentleCompanion(新)
  readSettingsSnapshot: () => ({
    lang: "zh",                              // 新语言
    persona: { presetKey: "gentleCompanion" }, // 新人设
    llmProvider: "deepseek",
    providers: {
      deepseek: {
        apiKey: "test-key",
        baseUrl: "https://example.test",
        model: "deepseek-chat",
      },
    },
  }),
}));

// 被测函数(mock 设置好之后再 import)
import { buildChatSystemPrompt, chatAgentCall } from "./index";

let engine: FakeEngine;
beforeEach(() => {
  engine = setEngine(new FakeEngine());
  engine.script = [{ content: "ok", model: "deepseek-chat" }];
});

// ─── 测试 ─────────────────────────────────────────────────────────────────────

describe("buildChatSystemPrompt — 跨窗口新鲜度(直读 localStorage 真相源)", () => {
  it(
    "人设:store 有旧人设(wittyPartner),localStorage 有新人设(gentleCompanion)" +
    " → 系统提示词应反映新人设,不用旧人设",
    async () => {
      const prompt = await buildChatSystemPrompt();

      // 新人设「温和陪伴」的关键词(来自 personaSpec.ts 的 gentleCompanion.toneZh)
      // 修复后 readSettingsSnapshot 返回 zh + gentleCompanion → 中文温和陪伴描述
      expect(prompt).toContain("温和");

      // 旧人设「机灵搭档」的关键词不应出现(wittyPartner.toneZh 里的"机灵")
      expect(prompt).not.toContain("机灵");
    }
  );

  it(
    "语言:store 有旧语言(en),localStorage 有新语言(zh)" +
    " → 系统提示词应用新语言(zh)",
    async () => {
      const prompt = await buildChatSystemPrompt();

      // zh 模式下当前时间格式是 "当前时间:"(中文)
      expect(prompt).toContain("当前时间:");

      // en 模式下的关键词 "Current time:" 不应出现
      expect(prompt).not.toContain("Current time:");
    }
  );

  it(
    "chatAgentCall 的系统提示词也走真相源:agent 调用时 system message 反映新人设",
    async () => {
      engine.script = [{ content: "回答", model: "deepseek-chat" }];

      await chatAgentCall([{ role: "user", content: "你好" }]);

      const systemMsg = engine.received[0].messages[0];
      expect(systemMsg.role).toBe("system");
      // 新人设(gentleCompanion / zh)含「温和」,不含「机灵」
      expect(systemMsg.content).toContain("温和");
      expect(systemMsg.content).not.toContain("机灵");
    }
  );
});
