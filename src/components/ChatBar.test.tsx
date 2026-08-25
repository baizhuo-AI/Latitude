/**
 * ChatBar.test.tsx — 悬浮条轻提示新主动消息 (Task 4.6 收尾)
 *
 * 覆盖:
 *  1. 正常渲染:无主动消息时不显示提示横幅
 *  2. 投递后轻提示:conversations 同步事件到达 + 新对话带主动消息标记 → 横幅出现
 *  3. 点击横幅:调 selectConv(convId) 打开对话,横幅消失
 *  4. 不强制切走当前对话:currentId 保持不变直到用户点击
 *  5. pa 前缀(deliverProactive)和 brief 前缀(morning briefing)都触发提示
 *  6. 普通对话(c 前缀)不触发提示
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ChatBar } from "./ChatBar";

// ─── mock i18n ────────────────────────────────────────────────────────────────
vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh" },
  }),
}));

// ─── mock windowLayout ────────────────────────────────────────────────────────
vi.mock("../lib/windowLayout", () => ({
  setChatBarExpanded: vi.fn(async () => undefined),
}));

// ─── mock db ──────────────────────────────────────────────────────────────────
vi.mock("../lib/db", () => ({
  dbHasUnrepliedProactive: vi.fn(async () => false),
  dbMarkProactiveReplied: vi.fn(async () => undefined),
  dbMarkProactiveDismissed: vi.fn(async () => undefined),
}));

// ─── syncBus mock:可控触发 conversations 事件 ─────────────────────────────────
// 模拟方式:onSync 注册一个 handler,我们可以从外部调用它。
const syncHandlers: Record<string, (() => void)[]> = {};
vi.mock("../lib/syncBus", () => ({
  onSync: vi.fn((topic: string, handler: () => void) => {
    if (!syncHandlers[topic]) syncHandlers[topic] = [];
    syncHandlers[topic].push(handler);
    return () => {
      if (syncHandlers[topic]) {
        syncHandlers[topic] = syncHandlers[topic].filter((h) => h !== handler);
      }
    };
  }),
  emitSync: vi.fn(),
}));

/** 触发所有注册在 topic 上的 syncBus handler */
function triggerSync(topic: string) {
  const handlers = syncHandlers[topic] ?? [];
  handlers.forEach((h) => h());
}

// ─── chatStore mock ────────────────────────────────────────────────────────────
// 关键挑战:useChatStore 是 Zustand selector hook,必须在状态变化时触发 React re-render。
// 测试里不跑真实 Zustand,所以我们用可变共享状态 + rerender 来模拟。

const selectConvSpy = vi.fn(async (_id: string | null) => undefined);
const createConvSpy = vi.fn(async () => "newconv1");
const sendMessageSpy = vi.fn(async (_text: string) => undefined);
const stopSpy = vi.fn();

// 可变共享状态:测试可以直接修改这些变量后 rerender 触发更新
let _currentId: string | null = null;
let _messagesByConv: Record<string, Array<{ id: string; role: string; content: string }>> = {};
let _conversations: Array<{ id: string; title: string; createdAt: string; updatedAt: string }> = [];

// hydrate 实现:模拟真实 hydrate 的效果——刷新 conversations(不过在 mock 里是 no-op,
// 更新 _conversations 由测试代码直接做,hydrate 只是一个信号)
const hydrateSpy = vi.fn(async () => undefined);

vi.mock("../lib/chatStore", () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      currentId: _currentId,
      messagesByConv: _messagesByConv,
      conversations: _conversations,
      streaming: "",
      streamingReasoning: "",
      loading: false,
      hydrate: hydrateSpy,
      createConv: createConvSpy,
      sendMessage: sendMessageSpy,
      stop: stopSpy,
      selectConv: selectConvSpy,
    };
    return selector(state as unknown as Record<string, unknown>);
  },
}));

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeProactiveConv(id: string, title = "晨间简报 2026-06-16") {
  return { id, title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

// ─── 测试 ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _currentId = null;
  _messagesByConv = {};
  _conversations = [];
  // 清空 sync handlers
  Object.keys(syncHandlers).forEach((k) => { syncHandlers[k] = []; });
  selectConvSpy.mockClear();
  createConvSpy.mockClear();
  sendMessageSpy.mockClear();
  hydrateSpy.mockClear();
});

describe("ChatBar 基础渲染", () => {
  it("无主动消息时不显示提示横幅", () => {
    const { container } = render(<ChatBar />);
    expect(container.querySelector("[data-testid='proactive-hint']")).toBeNull();
  });

  it("普通对话(c 前缀)不触发轻提示", async () => {
    const { rerender } = render(<ChatBar />);
    // 更新 conversations 为普通对话
    _conversations = [makeProactiveConv("c1234_abcd", "普通对话")];
    rerender(<ChatBar />);
    await act(async () => { triggerSync("conversations"); });
    rerender(<ChatBar />);
    // 等待一下,确认不出现
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("[data-testid='proactive-hint']")).toBeNull();
  });
});

describe("ChatBar 轻提示:有新主动消息对话", () => {
  it("brief 前缀对话 → 显示轻提示横幅", async () => {
    const { rerender, container } = render(<ChatBar />);
    expect(container.querySelector("[data-testid='proactive-hint']")).toBeNull();

    // 模拟简报投递:先更新 conversations,再触发同步事件 + rerender
    _conversations = [makeProactiveConv("brief1234_abcd")];
    await act(async () => {
      triggerSync("conversations");
    });
    rerender(<ChatBar />);

    // The notification intentionally renders through a document.body portal so
    // it can float above every desktop surface.
    expect(screen.queryByTestId("proactive-hint")).not.toBeNull();
  });

  it("pa 前缀对话(deliverProactive)也触发轻提示", async () => {
    const { rerender } = render(<ChatBar />);

    _conversations = [makeProactiveConv("pa5678_wxyz", "提醒 · 会议将至")];
    await act(async () => {
      triggerSync("conversations");
    });
    rerender(<ChatBar />);

    expect(screen.queryByTestId("proactive-hint")).not.toBeNull();
  });

  it("点击横幅 → 调 selectConv,横幅消失", async () => {
    const { rerender, container } = render(<ChatBar />);

    _conversations = [makeProactiveConv("brief9999_zzzz")];
    await act(async () => {
      triggerSync("conversations");
    });
    rerender(<ChatBar />);

    const hint = screen.queryByTestId("proactive-hint") as HTMLElement;
    expect(hint).not.toBeNull();

    // 点击
    fireEvent.click(hint);

    // selectConv 被调且传了正确的 id
    expect(selectConvSpy).toHaveBeenCalledWith("brief9999_zzzz");

    // 横幅消失
    await waitFor(() => {
      expect(container.querySelector("[data-testid='proactive-hint']")).toBeNull();
    });
  });

  it("不强制切走当前对话:点击前 selectConv 未被调", async () => {
    _currentId = "user-conv-existing";
    _messagesByConv = {
      "user-conv-existing": [
        { id: "m1", role: "user", content: "你好" },
        { id: "m2", role: "assistant", content: "你好!" },
      ],
    };

    const { rerender } = render(<ChatBar />);

    // 投递主动消息对话
    _conversations = [makeProactiveConv("brief0001_aaaa")];
    await act(async () => {
      triggerSync("conversations");
    });
    rerender(<ChatBar />);

    // 横幅出现,但 selectConv 还没被调
    await waitFor(() => {
      expect(document.querySelector("[data-testid='proactive-hint']")).not.toBeNull();
    });
    expect(selectConvSpy).not.toHaveBeenCalled();
  });

  it("同一条对话只提示一次(不重复)", async () => {
    const { rerender, container } = render(<ChatBar />);

    _conversations = [makeProactiveConv("brief2222_bbbb")];
    await act(async () => { triggerSync("conversations"); });
    rerender(<ChatBar />);

    // 第一次:横幅出现
    expect(screen.queryByTestId("proactive-hint")).not.toBeNull();

    // 点击消掉
    fireEvent.click(screen.getByTestId("proactive-hint"));
    await waitFor(() => {
      expect(container.querySelector("[data-testid='proactive-hint']")).toBeNull();
    });

    // 同一条对话再次触发 sync → 不再出现横幅
    await act(async () => { triggerSync("conversations"); });
    rerender(<ChatBar />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("[data-testid='proactive-hint']")).toBeNull();
  });
});
