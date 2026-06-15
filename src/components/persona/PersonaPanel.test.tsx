/**
 * PersonaPanel.test.tsx — 人设配置面板单测 (Task 1.2)
 *
 * 覆盖:
 *  1. 基础渲染:框可见,默认选中资深幕僚
 *  2. 交互:填名字 / 切预设 / 加删习惯chip / 填自由补充,改动落到 store
 *  3. 试一句:假引擎返回脚本化文本 → 就地显示,不产生对话/不写消息库
 *  4. 节流:快速连点 → generateOnce 调用次数 < 点击次数
 *  5. 无 key:模拟未配模型 → 显示引导文案,不调 generateOnce
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { PersonaPanel } from "./PersonaPanel";

// ─── mock i18n (让 useTranslation 直接返回 key) ─────────────────────────────
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      // 对插值替换做简单处理
      if (!opts) return key;
      return Object.entries(opts).reduce(
        (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
        key
      );
    },
    i18n: { language: "zh" },
  }),
}));

// ─── Settings store mock ─────────────────────────────────────────────────────
// setPersona spy 供断言
const setPersonaSpy = vi.fn();

// 可动态替换的 store 状态
let _mockSettings = {
  lang: "zh" as const,
  llmProvider: "deepseek" as const,
  providers: {
    deepseek: { apiKey: "test-key", model: "deepseek-chat" },
    anthropic: {},
    openai: {},
  },
  persona: { presetKey: "seniorAdvisor" as const },
};

vi.mock("../../lib/settings", () => ({
  useSettingsStore: (selector?: (s: unknown) => unknown) => {
    const state = { ..._mockSettings, setPersona: setPersonaSpy };
    return selector ? selector(state) : state;
  },
}));

// ─── generateOnce mock ───────────────────────────────────────────────────────
const generateOnceSpy = vi.fn(async (_sys: string, _msgs: unknown[]) =>
  "【今日简报】项目进展顺利\n【催办】记得回邮件"
);

vi.mock("../../lib/llm/index", () => ({
  generateOnce: (...args: unknown[]) => generateOnceSpy(...args),
}));

// ─── composePersonaPrompt mock(仅返回固定串,不测prompt合成) ─────────────────
vi.mock("../../lib/persona/personaSpec", async () => {
  const actual = await vi.importActual<typeof import("../../lib/persona/personaSpec")>(
    "../../lib/persona/personaSpec"
  );
  return {
    ...actual,
    composePersonaPrompt: vi.fn(() => "fake-system-prompt"),
  };
});

// ─── chatStore mock:断言没调投递/sendMessage ────────────────────────────────
const sendMessageSpy = vi.fn();
vi.mock("../../lib/chatStore", () => ({
  useChatStore: () => ({ sendMessage: sendMessageSpy }),
}));

describe("PersonaPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateOnceSpy.mockResolvedValue(
      "【今日简报】项目进展顺利\n【催办】记得回邮件"
    );
    // 重置为有 key 的默认 settings
    _mockSettings = {
      lang: "zh",
      llmProvider: "deepseek",
      providers: {
        deepseek: { apiKey: "test-key", model: "deepseek-chat" },
        anthropic: {},
        openai: {},
      },
      persona: { presetKey: "seniorAdvisor" },
    };
  });

  // ── 1. 基础渲染 ──────────────────────────────────────────────────────────

  it("渲染出框,默认预设为资深幕僚", () => {
    render(<PersonaPanel />);
    // 检查名字输入框存在
    expect(screen.getByRole("textbox", { name: /persona\.name/i })).toBeInTheDocument();
    // 找到「资深幕僚」预设按钮且已选中(aria-pressed 或带特殊 class 的 chip)
    const seniorBtn = screen.getByRole("button", { name: /persona\.preset\.seniorAdvisor/i });
    expect(seniorBtn).toHaveAttribute("data-selected", "true");
  });

  it("渲染所有三个预设 chips", () => {
    render(<PersonaPanel />);
    expect(
      screen.getByRole("button", { name: /persona\.preset\.seniorAdvisor/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /persona\.preset\.wittyPartner/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /persona\.preset\.gentleCompanion/i })
    ).toBeInTheDocument();
  });

  // ── 2. 交互:填名字 ─────────────────────────────────────────────────────

  it("填名字 → 失焦后 setPersona 被调用", () => {
    render(<PersonaPanel />);
    const nameInput = screen.getByRole("textbox", { name: /persona\.name/i });
    fireEvent.change(nameInput, { target: { value: "星助" } });
    fireEvent.blur(nameInput);
    expect(setPersonaSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "星助" })
    );
  });

  // ── 3. 切预设 ───────────────────────────────────────────────────────────

  it("点机灵搭档 → 选中高亮,基调描述更新,setPersona 被调用", () => {
    render(<PersonaPanel />);
    const wittyBtn = screen.getByRole("button", { name: /persona\.preset\.wittyPartner/i });
    fireEvent.click(wittyBtn);

    expect(wittyBtn).toHaveAttribute("data-selected", "true");
    // 基调描述区域应显示机灵搭档的 tone 描述内容
    expect(screen.getByTestId("tone-description")).toBeInTheDocument();
    expect(setPersonaSpy).toHaveBeenCalledWith(
      expect.objectContaining({ presetKey: "wittyPartner" })
    );
  });

  it("切换预设后基调描述可编辑覆盖", () => {
    render(<PersonaPanel />);
    const toneArea = screen.getByTestId("tone-description");
    fireEvent.change(toneArea, { target: { value: "我的自定义基调" } });
    // 应调 setPersona 写入 toneDescription
    expect(setPersonaSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toneDescription: "我的自定义基调" })
    );
  });

  // ── 4. 怎么称呼 & 关系 ──────────────────────────────────────────────────

  it("填怎么称呼 → 失焦后 setPersona 被调用", () => {
    render(<PersonaPanel />);
    const aliasInput = screen.getByRole("textbox", { name: /persona\.userAlias/i });
    fireEvent.change(aliasInput, { target: { value: "Boss" } });
    fireEvent.blur(aliasInput);
    expect(setPersonaSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userAlias: "Boss" })
    );
  });

  it("点关系 chip → setPersona 被调用", () => {
    render(<PersonaPanel />);
    // 至少能找到一个关系 chip 按钮
    const relationBtn = screen.getAllByTestId("relation-chip")[0];
    fireEvent.click(relationBtn);
    expect(setPersonaSpy).toHaveBeenCalled();
  });

  // ── 5. 习惯/雷区 chips ───────────────────────────────────────────────────

  it("输入新习惯并回车 → chips 区新增,setPersona 被调用", () => {
    render(<PersonaPanel />);
    const habitInput = screen.getByRole("textbox", { name: /persona\.habitInput/i });
    fireEvent.change(habitInput, { target: { value: 'habit A' } });
    fireEvent.keyDown(habitInput, { key: "Enter" });
    expect(setPersonaSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        habits: expect.arrayContaining(['habit A']),
      })
    );
  });

  it("点删除习惯 chip → setPersona 更新 habits 列表", () => {
    // 模拟 store 里已有习惯
    _mockSettings.persona = {
      presetKey: "seniorAdvisor",
      habits: ["习惯1", "习惯2"],
    } as typeof _mockSettings.persona;

    render(<PersonaPanel />);
    // 找到第一个习惯 chip 的删除按钮
    const deleteBtn = screen.getAllByTestId("habit-delete")[0];
    fireEvent.click(deleteBtn);
    expect(setPersonaSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        habits: expect.not.arrayContaining(["习惯1"]),
      })
    );
  });

  // ── 6. 自由补充 ─────────────────────────────────────────────────────────

  it("填自由补充 → 失焦后 setPersona 被调用", () => {
    render(<PersonaPanel />);
    const freeNote = screen.getByRole("textbox", { name: /persona\.freeNote/i });
    fireEvent.change(freeNote, { target: { value: 'extra note' } });
    fireEvent.blur(freeNote);
    expect(setPersonaSpy).toHaveBeenCalledWith(
      expect.objectContaining({ freeNote: 'extra note' })
    );
  });

  // ── 7. 试一句:正常路径 ──────────────────────────────────────────────────

  it("点「试一句」→ generateOnce 被调用,结果就地显示", async () => {
    render(<PersonaPanel />);
    const trialBtn = screen.getByRole("button", { name: /persona\.trySample/i });
    fireEvent.click(trialBtn);

    await waitFor(() => {
      expect(generateOnceSpy).toHaveBeenCalledTimes(1);
    });

    // 样例简报/催办内容出现在页面
    await waitFor(() => {
      expect(screen.getByTestId("trial-result")).toBeInTheDocument();
    });
    expect(screen.getByTestId("trial-result").textContent).toContain("项目进展顺利");
  });

  it("点「试一句」→ 不产生对话,不调 sendMessage", async () => {
    render(<PersonaPanel />);
    fireEvent.click(screen.getByRole("button", { name: /persona\.trySample/i }));

    await waitFor(() => {
      expect(generateOnceSpy).toHaveBeenCalledTimes(1);
    });
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  // ── 8. 节流:连点 ────────────────────────────────────────────────────────

  it("快速连点「试一句」→ generateOnce 调用次数 < 点击次数", async () => {
    // 让 generateOnce 慢一点(确保 pending 状态能被检测到)
    generateOnceSpy.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("结果"), 200))
    );

    render(<PersonaPanel />);
    const trialBtn = screen.getByRole("button", { name: /persona\.trySample/i });

    // 快速连点 5 次
    for (let i = 0; i < 5; i++) {
      fireEvent.click(trialBtn);
    }

    await waitFor(
      () => {
        // 至少等到第一次调用完成
        expect(generateOnceSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000 }
    );

    // 调用次数必须小于点击次数(5)
    expect(generateOnceSpy).toHaveBeenCalledTimes(1);
  });

  // ── 9. 无 key:引导文案,不调 generateOnce ───────────────────────────────

  it("未配模型 key → 显示引导文案,不调 generateOnce", async () => {
    // 覆盖 store:llmProvider=deepseek 但 apiKey 未配
    _mockSettings = {
      ..._mockSettings,
      llmProvider: "deepseek",
      providers: {
        deepseek: { apiKey: "", model: "deepseek-chat" },
        anthropic: {},
        openai: {},
      },
    };

    render(<PersonaPanel />);
    const trialBtn = screen.getByRole("button", { name: /persona\.trySample/i });
    fireEvent.click(trialBtn);

    // 引导文案出现
    await waitFor(() => {
      expect(screen.getByTestId("trial-no-key")).toBeInTheDocument();
    });

    // 绝不调 generateOnce
    expect(generateOnceSpy).not.toHaveBeenCalled();
  });

  it("mock provider → 显示引导文案,不调 generateOnce", async () => {
    _mockSettings = {
      ..._mockSettings,
      llmProvider: "mock" as "deepseek", // mock provider
      providers: {
        deepseek: { apiKey: "", model: "" },
        anthropic: {},
        openai: {},
      },
    };

    render(<PersonaPanel />);
    fireEvent.click(screen.getByRole("button", { name: /persona\.trySample/i }));

    await waitFor(() => {
      expect(screen.getByTestId("trial-no-key")).toBeInTheDocument();
    });
    expect(generateOnceSpy).not.toHaveBeenCalled();
  });

  // ── 10. 底部说明文案(C5 i18n) ────────────────────────────────────────────

  it("底部「底层反机械规则」说明文案存在", () => {
    render(<PersonaPanel />);
    expect(screen.getByTestId("locked-rules-note")).toBeInTheDocument();
  });
});
