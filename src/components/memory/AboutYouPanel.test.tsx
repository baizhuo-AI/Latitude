/**
 * AboutYouPanel.test.tsx — 关于你面板单测 (Task 2.3)
 *
 * 覆盖:
 *  1. 基础渲染:按 category 分组显示事实,分组标题存在
 *  2. told / inferred 标签正确显示
 *  3. pinned 标记显示
 *  4. 编辑事实:点编辑 → 改 content → 确认 → dbUpdateMemoryFact + emitSync('memory')
 *  5. 删除事实:点删除 → dbDeleteMemoryFact + emitSync('memory')
 *  6. 新增事实:选 category + 填 content → 提交 → dbInsertMemoryFact + emitSync('memory')
 *  7. 不污染聊天:不调 sendMessage / 不写对话
 *  8. 订阅 'memory' 同步:onSync 被调用,收到事件后重新从 DB 读取
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AboutYouPanel } from "./AboutYouPanel";
import type { MemoryFact } from "../../lib/db";

// ─── mock i18n ────────────────────────────────────────────────────────────────
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh" },
  }),
}));

// ─── mock DB 函数 ─────────────────────────────────────────────────────────────
const dbListSpy = vi.fn();
const dbInsertSpy = vi.fn();
const dbUpdateSpy = vi.fn();
const dbDeleteSpy = vi.fn();

vi.mock("../../lib/db", () => ({
  dbListMemoryFacts: (...args: unknown[]) => dbListSpy(...args),
  dbInsertMemoryFact: (...args: unknown[]) => dbInsertSpy(...args),
  dbUpdateMemoryFact: (...args: unknown[]) => dbUpdateSpy(...args),
  dbDeleteMemoryFact: (...args: unknown[]) => dbDeleteSpy(...args),
  MEMORY_CATEGORIES: ["identity", "ongoing", "habit", "people", "preference"],
}));

// ─── mock syncBus ─────────────────────────────────────────────────────────────
const emitSyncSpy = vi.fn();
let onSyncHandler: (() => void) | null = null;
const onSyncSpy = vi.fn((topic: string, handler: () => void) => {
  if (topic === "memory") onSyncHandler = handler;
  return () => { onSyncHandler = null; };
});

vi.mock("../../lib/syncBus", () => ({
  emitSync: (...args: unknown[]) => emitSyncSpy(...args),
  onSync: (...args: unknown[]) => onSyncSpy(...(args as [string, () => void])),
}));

// ─── mock chatStore:断言不调 sendMessage ─────────────────────────────────────
const sendMessageSpy = vi.fn();
vi.mock("../../lib/chatStore", () => ({
  useChatStore: () => ({ sendMessage: sendMessageSpy }),
}));

// ─── 测试数据 ─────────────────────────────────────────────────────────────────
const makeFact = (overrides: Partial<MemoryFact>): MemoryFact => ({
  id: "mf1",
  category: "identity",
  content: "产品经理",
  source: "told",
  durability: "durable",
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const SAMPLE_FACTS: MemoryFact[] = [
  makeFact({ id: "mf1", category: "identity", content: "产品经理", source: "told" }),
  makeFact({ id: "mf2", category: "identity", content: "常驻上海", source: "inferred" }),
  makeFact({ id: "mf3", category: "habit", content: "早 9 晚 6", source: "told", pinned: true }),
  makeFact({ id: "mf4", category: "preference", content: "偏好简短回复", source: "inferred" }),
];

// ─── 测试 ─────────────────────────────────────────────────────────────────────

describe("AboutYouPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onSyncHandler = null;
    dbListSpy.mockResolvedValue(SAMPLE_FACTS);
    dbInsertSpy.mockResolvedValue("mf_new");
    dbUpdateSpy.mockResolvedValue(undefined);
    dbDeleteSpy.mockResolvedValue(undefined);
  });

  // ── 1. 基础渲染:按 category 分组 ──────────────────────────────────────────

  it("渲染分组标题和事实内容", async () => {
    render(<AboutYouPanel />);

    // 等待异步加载完成
    await waitFor(() => {
      expect(screen.getByText("产品经理")).toBeInTheDocument();
    });

    // 分组标题(i18n key 直接返回 key);select 里的 option 同名,用 getAllByText 取首个
    const identityEls = screen.getAllByText("memory.category.identity");
    expect(identityEls.length).toBeGreaterThan(0);
    const habitEls = screen.getAllByText("memory.category.habit");
    expect(habitEls.length).toBeGreaterThan(0);
    const prefEls = screen.getAllByText("memory.category.preference");
    expect(prefEls.length).toBeGreaterThan(0);

    // 所有事实 content
    expect(screen.getByText("常驻上海")).toBeInTheDocument();
    expect(screen.getByText("早 9 晚 6")).toBeInTheDocument();
    expect(screen.getByText("偏好简短回复")).toBeInTheDocument();
  });

  it("挂载后调用 dbListMemoryFacts", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => {
      expect(dbListSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── 2. told / inferred 标签 ────────────────────────────────────────────────

  it("told 事实显示 told 标签(memory.source.told)", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    // told 标签
    const toldTags = screen.getAllByTestId("source-tag-told");
    expect(toldTags.length).toBeGreaterThan(0);
  });

  it("inferred 事实显示 inferred 标签(memory.source.inferred)", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    const inferredTags = screen.getAllByTestId("source-tag-inferred");
    expect(inferredTags.length).toBeGreaterThan(0);
  });

  // ── 3. pinned 标记 ─────────────────────────────────────────────────────────

  it("pinned 事实显示 pinned 标记", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("早 9 晚 6"));

    // pinned 标记存在(data-testid="pinned-badge")
    const pinnedBadge = screen.getAllByTestId("pinned-badge");
    expect(pinnedBadge.length).toBe(1);
  });

  // ── 4. 编辑事实 ────────────────────────────────────────────────────────────

  it("点编辑按钮 → 输入框出现,修改内容 → 确认 → dbUpdateMemoryFact + emitSync", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    // 找到第一条事实的编辑按钮
    const editBtns = screen.getAllByTestId("fact-edit-btn");
    fireEvent.click(editBtns[0]);

    // 编辑 input 应该出现
    const editInput = screen.getByTestId("fact-edit-input");
    expect(editInput).toBeInTheDocument();

    // 修改内容
    fireEvent.change(editInput, { target: { value: "高级产品经理" } });

    // 点确认
    const confirmBtn = screen.getByTestId("fact-edit-confirm");
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(dbUpdateSpy).toHaveBeenCalledWith("mf1", expect.objectContaining({ content: "高级产品经理" }));
    });
    expect(emitSyncSpy).toHaveBeenCalledWith("memory");
  });

  it("编辑中点取消 → 不调 dbUpdate", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    const editBtns = screen.getAllByTestId("fact-edit-btn");
    fireEvent.click(editBtns[0]);

    const cancelBtn = screen.getByTestId("fact-edit-cancel");
    fireEvent.click(cancelBtn);

    expect(dbUpdateSpy).not.toHaveBeenCalled();
    expect(emitSyncSpy).not.toHaveBeenCalled();
  });

  // ── 5. 删除事实 ────────────────────────────────────────────────────────────

  it("点删除 → dbDeleteMemoryFact + emitSync('memory')", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    const deleteBtns = screen.getAllByTestId("fact-delete-btn");
    fireEvent.click(deleteBtns[0]);

    await waitFor(() => {
      expect(dbDeleteSpy).toHaveBeenCalledWith("mf1");
    });
    expect(emitSyncSpy).toHaveBeenCalledWith("memory");
  });

  // ── 6. 新增事实 ────────────────────────────────────────────────────────────

  it("填 content + 选 category + 提交 → dbInsertMemoryFact + emitSync('memory')", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    // 填写 content
    const addInput = screen.getByTestId("add-fact-content");
    fireEvent.change(addInput, { target: { value: "喜欢用 Markdown" } });

    // 选 category(应有 select 或下拉)
    const catSelect = screen.getByTestId("add-fact-category");
    fireEvent.change(catSelect, { target: { value: "preference" } });

    // 提交
    const submitBtn = screen.getByTestId("add-fact-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(dbInsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "喜欢用 Markdown",
          category: "preference",
          source: "told",
        })
      );
    });
    expect(emitSyncSpy).toHaveBeenCalledWith("memory");
  });

  it("content 为空时不提交", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    const submitBtn = screen.getByTestId("add-fact-submit");
    fireEvent.click(submitBtn);

    expect(dbInsertSpy).not.toHaveBeenCalled();
  });

  // ── 7. 不污染聊天 ─────────────────────────────────────────────────────────

  it("任何操作都不调 sendMessage", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    // 删除
    const deleteBtns = screen.getAllByTestId("fact-delete-btn");
    fireEvent.click(deleteBtns[0]);
    await waitFor(() => expect(dbDeleteSpy).toHaveBeenCalled());

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  // ── 8. 订阅 'memory' 同步,别的窗口写后刷新 ───────────────────────────────

  it("挂载时调用 onSync('memory', ...) 注册订阅", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    expect(onSyncSpy).toHaveBeenCalledWith("memory", expect.any(Function));
  });

  it("收到 memory sync 事件后重新 dbListMemoryFacts", async () => {
    render(<AboutYouPanel />);
    await waitFor(() => screen.getByText("产品经理"));

    const callsBefore = dbListSpy.mock.calls.length;

    // 模拟另一个窗口写了记忆
    dbListSpy.mockResolvedValueOnce([
      ...SAMPLE_FACTS,
      makeFact({ id: "mf5", category: "ongoing", content: "新事实", source: "told" }),
    ]);

    // 触发 sync handler
    expect(onSyncHandler).not.toBeNull();
    onSyncHandler?.();

    await waitFor(() => {
      expect(dbListSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    // 新事实应该显示
    await waitFor(() => {
      expect(screen.getByText("新事实")).toBeInTheDocument();
    });
  });
});
