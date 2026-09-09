import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PRODUCT_LAYOUT_DOCUMENT as SEED_LAYOUT_DOCUMENT,
  createBrowserCompositionRegistry,
  layoutV1ToUiSurfaceV2,
} from "../../runtime/composition/browserProduction";
import type { AppliedUiChange } from "../../runtime/composition/types";
import { BrowserCompositionDialog } from "./BrowserCompositionDialog";
import { useBrowserUiComposition } from "./browserUiComposition";
import { CompositionRegistry } from "../../runtime/composition/registry";

describe("BrowserCompositionDialog V2 control plane", () => {
  beforeEach(() => localStorage.clear());
  it("lets a user adjust available cards, secretary rail and fixed system modules", async () => {
    const user = userEvent.setup();
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 3;
    const document = layoutV1ToUiSurfaceV2(layout);
    const onApply = vi.fn();
    render(
      <BrowserCompositionDialog
        layout={layout}
        document={document}
        registry={createBrowserCompositionRegistry()}
        history={[]}
        onApply={onApply}
        onRollback={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // The modal stays above the workspace, including the global secretary rail.
    expect(screen.getByRole("dialog", { name: "桌面设置" })).toHaveClass("dimension-root");
    expect(screen.getByRole("dialog", { name: "桌面设置" })).toHaveStyle({
      zIndex: "100",
    });

    await user.clear(screen.getByRole("textbox", { name: "今日资讯 标题" }));
    await user.type(screen.getByRole("textbox", { name: "今日资讯 标题" }), "我的证据雷达");
    expect(screen.queryByRole("combobox", { name: /宽度/ })).not.toBeInTheDocument();
    expect(screen.queryByText("高级动作")).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "今日资讯 显示" }));
    await user.click(screen.getByLabelText("今日资讯 卡片功能"));
    await user.click(screen.getByRole("switch", { name: "今日资讯 资讯反馈" }));
    await user.click(screen.getByText("秘书与其他功能"));
    await user.click(screen.getByRole("switch", { name: "秘书栏 显示" }));
    await user.click(screen.getByLabelText("秘书栏 功能开关"));
    await user.click(screen.getByRole("switch", { name: "秘书栏 打开对话" }));
    await user.click(screen.getByRole("switch", { name: "搜索与任务操作 显示" }));
    await user.click(screen.getByLabelText("与你有关的想法 功能开关"));
    await user.click(screen.getByRole("switch", { name: "与你有关的想法 先搁置" }));
    await user.click(screen.getByRole("button", { name: "下移 今日资讯" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "user",
        cards: expect.objectContaining({
          "seed-feed": expect.objectContaining({
            hidden: true,
            span: layout.cards.find((card) => card.id === "seed-feed")!.span,
            title: "我的证据雷达",
            actions: expect.objectContaining({ feedback: null }),
          }),
          "secretary-companion": expect.objectContaining({
            hidden: true,
            actions: expect.objectContaining({ chat: null }),
          }),
          "browser-control-strip": expect.objectContaining({ hidden: true }),
          "candidate-intervention-strip": expect.objectContaining({
            actions: expect.objectContaining({ park: null }),
          }),
        }),
        orderedCardIds: [
          "seed-activity",
          "seed-schedule",
          "seed-feed",
          "seed-review-plan",
          "seed-rhythm",
          "seed-flex",
        ],
      }),
    );
  });

  it("persists disabled functions and preserves existing card width when reopened", async () => {
    const user = userEvent.setup();
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.cards.find((card) => card.id === "seed-feed")!.span = 5;
    function SettingsHarness() {
      const composition = useBrowserUiComposition(layout);
      const [open, setOpen] = useState(true);
      return open ? (
        <BrowserCompositionDialog
          {...composition}
          onApply={composition.applyChangeSet}
          onRollback={composition.rollbackChangeSet}
          onReset={composition.resetToProductLayout}
          onClose={() => setOpen(false)}
        />
      ) : <button onClick={() => setOpen(true)}>重新打开设置</button>;
    }
    const first = render(<SettingsHarness />);
    await user.click(screen.getByLabelText("今日资讯 卡片功能"));
    await user.click(screen.getByRole("switch", { name: "今日资讯 资讯反馈" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    first.unmount();
    render(<SettingsHarness />);
    await user.click(screen.getByLabelText("今日资讯 卡片功能"));
    expect(screen.getByRole("switch", { name: "今日资讯 资讯反馈" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "今日资讯 查看来源" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "今日资讯 资讯反馈" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("button", { name: "重新打开设置" }));
    await user.click(screen.getByLabelText("今日资讯 卡片功能"));
    expect(screen.getByRole("switch", { name: "今日资讯 资讯反馈" })).toBeChecked();
    const stored = JSON.parse(localStorage.getItem("latitude.browser-ui-composition.v2:latitude-browser-live")!);
    const feed = stored.document.components.find((component: { id: string }) => component.id === "seed-feed");
    expect(feed.grid.columnSpan).toBe(5);
    expect(feed.actions.feedback).toBe("latitude.feed.feedback");
  });

  it("omits weekly review settings while saving its source and reordering visible cards across its slot", async () => {
    const user = userEvent.setup();
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    const review = layout.cards.find((card) => card.id === "seed-review-plan")!;
    review.hidden = true;
    review.span = 5;
    review.presentation!.title = "已保存的周回顾";
    const reviewIndex = layout.arrangement.orderedCardIds.indexOf(review.id);
    function SettingsHarness() {
      const composition = useBrowserUiComposition(layout);
      return <BrowserCompositionDialog
        {...composition}
        onApply={composition.applyChangeSet}
        onRollback={composition.rollbackChangeSet}
        onReset={composition.resetToProductLayout}
        onClose={vi.fn()}
      />;
    }
    render(<SettingsHarness />);
    expect(screen.queryByRole("article", { name: "周回顾设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "周回顾 标题" })).not.toBeInTheDocument();
    await user.click(screen.getByText("秘书与其他功能"));
    await user.click(screen.getByLabelText("秘书栏 功能开关"));
    await user.click(screen.getByLabelText("搜索与任务操作 功能开关"));
    expect(screen.queryByRole("switch", { name: /周回顾/ })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "秘书栏 打开对话" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "下移 今天的锚点" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    const stored = JSON.parse(localStorage.getItem("latitude.browser-ui-composition.v2:latitude-browser-live")!);
    const components = stored.document.components as Array<{ id: string; order: number; visible: boolean; grid: { columnSpan: number }; props: Record<string, unknown>; actions: Record<string, string> }>;
    const originalReview = layoutV1ToUiSurfaceV2(layout).components.find((component) => component.id === review.id)!;
    expect(components.find((component) => component.id === review.id)).toEqual(originalReview);
    const cards = components.filter((component) => layout.cards.some((card) => card.id === component.id)).sort((a, b) => a.order - b.order);
    expect(cards.map((card) => card.id)).toEqual([
      "seed-activity", "seed-feed", "seed-rhythm", "seed-review-plan", "seed-schedule", "seed-flex",
    ]);
    expect(cards[reviewIndex].id).toBe(review.id);
    expect(components.find((component) => component.id === "secretary-companion")!.actions.review).toBe("latitude.companion.review");
    expect(components.find((component) => component.id === "browser-control-strip")!.actions.review).toBe("latitude.companion.review");
  });

  it("restores the chosen authorized binding after switching a function off and on", async () => {
    const user = userEvent.setup();
    const baseRegistry = createBrowserCompositionRegistry();
    const registry = new CompositionRegistry();
    baseRegistry.listModules().forEach((module) => registry.registerModule(module));
    baseRegistry.listCommands().forEach((command) => registry.registerCommand(command));
    const alternateCommand = {
      ...baseRegistry.command("latitude.feed.feedback")!,
      id: "test.feedback-alternate",
      description: "保存反馈并提醒我",
    };
    registry.registerCommand(alternateCommand);
    baseRegistry.listComponents().forEach((component) => registry.registerComponent(
      component.type === "latitude.feed" ? {
        ...component,
        eventCommands: { ...component.eventCommands, feedback: ["latitude.feed.feedback", alternateCommand.id] },
      } : component,
    ));
    const onApply = vi.fn();
    render(<BrowserCompositionDialog
      layout={SEED_LAYOUT_DOCUMENT}
      document={layoutV1ToUiSurfaceV2(SEED_LAYOUT_DOCUMENT)}
      registry={registry}
      history={[]}
      onApply={onApply}
      onRollback={vi.fn()}
      onReset={vi.fn()}
      onClose={vi.fn()}
    />);
    await user.click(screen.getByLabelText("今日资讯 卡片功能"));
    await user.click(screen.getByRole("radio", { name: "保存反馈并提醒我" }));
    await user.click(screen.getByRole("switch", { name: "今日资讯 资讯反馈" }));
    expect(screen.queryByRole("radio", { name: "保存反馈并提醒我" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "今日资讯 资讯反馈" }));
    expect(screen.getByRole("radio", { name: "保存反馈并提醒我" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onApply.mock.calls[0][0].cards["seed-feed"].actions.feedback).toBe(alternateCommand.id);
  });

  it("多层反转只陈述历史事实，不把奇偶层误写成固定的重做", async () => {
    const user = userEvent.setup();
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 6;
    const document = layoutV1ToUiSurfaceV2(layout);
    const operation = {
      op: "setVisibility" as const,
      componentId: "seed-feed",
      visible: false,
    };
    const inverse = { ...operation, visible: true };
    const history: AppliedUiChange[] = [
      {
        id: "apply-1",
        actor: "user",
        authorization: "direct_user",
        reason: "隐藏资讯",
        beforeRevision: 3,
        afterRevision: 4,
        operations: [operation],
        inverse: [inverse],
        appliedAt: "2026-08-24T12:00:00Z",
        rolledBackBy: "reverse-1",
      },
      {
        id: "reverse-1",
        actor: "user",
        authorization: "direct_user",
        reason: "反转 apply-1",
        beforeRevision: 4,
        afterRevision: 5,
        operations: [inverse],
        inverse: [operation],
        appliedAt: "2026-08-24T12:01:00Z",
        rollbackOf: "apply-1",
        rolledBackBy: "reverse-2",
      },
      {
        id: "reverse-2",
        actor: "user",
        authorization: "direct_user",
        reason: "反转 reverse-1",
        beforeRevision: 5,
        afterRevision: 6,
        operations: [operation],
        inverse: [inverse],
        appliedAt: "2026-08-24T12:02:00Z",
        rollbackOf: "reverse-1",
      },
    ];
    const onRollback = vi.fn();
    render(
      <BrowserCompositionDialog
        layout={layout}
        document={document}
        registry={createBrowserCompositionRegistry()}
        history={history}
        onApply={vi.fn()}
        onRollback={onRollback}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByText("变更记录"));
    expect(screen.getAllByText(/曾被反转/)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "已被反转" })).toHaveLength(2);
    expect(screen.queryByText(/重做/)).not.toBeInTheDocument();
    const available = screen.getByRole("button", { name: "反转这条操作" });
    await user.click(available);
    expect(onRollback).toHaveBeenCalledWith("reverse-2");
  });
});
