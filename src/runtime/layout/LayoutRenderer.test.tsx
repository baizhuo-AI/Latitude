import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CardPresentation } from "../../dimension/types";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import {
  BROWSER_PRODUCT_LAYOUT_DOCUMENT,
  createBrowserCompositionRegistry,
  layoutV1ToUiSurfaceV2,
} from "../composition/browserProduction";
import { LayoutRenderer } from "./LayoutRenderer";
import { SEED_LAYOUT_DOCUMENT } from "./seedLayout";
import type { LayoutDocumentV1 } from "./types";

function openContent(title: string) {
  const close = screen.queryByRole("button", { name: "关闭卡片内容" });
  if (close) fireEvent.click(close);
  fireEvent.contextMenu(screen.getByRole("group", { name: `卡片：${title}` }), { clientX: 100, clientY: 100 });
  fireEvent.click(screen.getByRole("menuitem", { name: /^(编辑|查看)内容$/ }));
}

function cloneLayout(): LayoutDocumentV1<string, CardPresentation> {
  return {
    ...SEED_LAYOUT_DOCUMENT,
    background: { ...SEED_LAYOUT_DOCUMENT.background },
    cards: SEED_LAYOUT_DOCUMENT.cards.map((card) => ({
      ...card,
      presentation: { ...card.presentation }
    })),
    arrangement: {
      ...SEED_LAYOUT_DOCUMENT.arrangement,
      orderedCardIds: [...SEED_LAYOUT_DOCUMENT.arrangement.orderedCardIds],
      rationale: [...SEED_LAYOUT_DOCUMENT.arrangement.rationale]
    }
  };
}

describe("LayoutRenderer", () => {
  it("右键锁定后禁止移动和缩放并跨刷新保留，帮助只回传所选卡片上下文", () => {
    const layout = { ...cloneLayout(), id: "card-context-lock-test" };
    const onRequestCardHelp = vi.fn();
    const first = render(<LayoutRenderer document={layout} bindings={SEED_DESKTOP_PROJECTION.bindings} onRequestCardHelp={onRequestCardHelp} />);
    const card = screen.getByRole("group", { name: "卡片：今日早报" });
    fireEvent.contextMenu(card);
    fireEvent.click(screen.getByRole("menuitem", { name: "锁定位置" }));
    expect(card).toHaveAttribute("data-card-locked", "true");
    fireEvent.pointerDown(card, { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(card, { pointerId: 3, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(card, { pointerId: 3 });
    expect(card.style.translate).toBe("");
    fireEvent.contextMenu(card);
    expect(screen.getByRole("menuitem", { name: /调整大小/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /让维度帮我改/ }));
    expect(onRequestCardHelp).toHaveBeenCalledWith(expect.objectContaining({ cardId: "seed-feed", title: "今日早报", content: expect.stringContaining("客户 1 的日报模板") }));
    expect(onRequestCardHelp).toHaveBeenCalledOnce();
    first.unmount();
    const second = render(<LayoutRenderer document={layout} bindings={SEED_DESKTOP_PROJECTION.bindings} />);
    const restored = screen.getByRole("group", { name: "卡片：今日早报" });
    expect(restored).toHaveAttribute("data-card-locked", "true");
    fireEvent.keyDown(restored, { key: "ContextMenu" });
    fireEvent.click(screen.getByRole("menuitem", { name: "解锁位置" }));
    expect(restored).not.toHaveAttribute("data-card-locked");
    second.unmount();
    for (const key of Object.keys(localStorage)) if (key.includes(layout.id)) localStorage.removeItem(key);
  });

  it("无直接编辑能力的派生卡提供查看与对话调整，不伪造保存", () => {
    const help = vi.fn();
    render(<LayoutRenderer document={SEED_LAYOUT_DOCUMENT} bindings={SEED_DESKTOP_PROJECTION.bindings} onRequestCardHelp={help} />);
    fireEvent.contextMenu(screen.getByRole("group", { name: "卡片：核心记忆点" }));
    expect(screen.queryByRole("menuitem", { name: "编辑内容" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "查看内容" }));
    expect(screen.getByRole("dialog", { name: "卡片内容：核心记忆点" })).toHaveTextContent("内容随真实记录更新，可以让维度帮你调整。");
    expect(screen.queryByRole("button", { name: "修改标题与内容" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "让维度帮我改" }));
    expect(help).toHaveBeenCalledWith(expect.objectContaining({ cardId: "seed-flex", title: "核心记忆点" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("按布局文档渲染五区和稳定的 5+7 / 4+4+4 slot", () => {
    const { container } = render(
      <LayoutRenderer
        document={SEED_LAYOUT_DOCUMENT}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
      />
    );

    expect(screen.getByRole("heading", { name: "今日早报" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "今天的锚点" })).toBeVisible();
    expect(screen.getByText("这周有一个新判断")).toBeVisible();
    expect(screen.getByText("核心记忆点")).toBeVisible();

    const slots = [...container.querySelectorAll<HTMLElement>("[data-layout-card-id]")];
    expect(slots.map((slot) => slot.dataset.region)).toEqual([
      "feed",
      "schedule",
      "review-plan",
      "rhythm",
      "flex"
    ]);
    expect(slots.map((slot) => slot.dataset.span)).toEqual(["5", "7", "4", "4", "4"]);
  });

  it("组合桌面隐藏卡片时保留文档身份但不渲染", () => {
    const layout = cloneLayout();
    layout.composition = {
      mode: "user-customized",
      changeSetId: "ui-hide-feed"
    };
    layout.cards = layout.cards.map((card) =>
      card.id === "seed-feed" ? { ...card, hidden: true } : card
    );

    const { container } = render(
      <LayoutRenderer
        document={layout}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
      />
    );

    expect(container.querySelector("[data-layout-card-id='seed-feed']")).toBeNull();
    expect(container.querySelectorAll("[data-layout-card-id]")).toHaveLength(4);
  });

  it("把资讯反馈、血缘和提案动作透传给桌面 handler", () => {
    const onFeedFeedback = vi.fn();
    const onLineage = vi.fn();
    const onAccept = vi.fn();

    const layout = cloneLayout();
    // 种子弹性格现在是记忆点便签；提案动作用一张显式注入的提案卡验证
    layout.cards = layout.cards.map((card) =>
      card.id === "seed-flex" ? { ...card, kind: "proposal" } : card
    );

    render(
      <LayoutRenderer
        document={layout}
        bindings={{
          ...SEED_DESKTOP_PROJECTION.bindings,
          "desktop.flex": {
            kind: "proposal",
            quote: "用 25 分钟把核心路径走一遍。",
            accept: "先这样试",
            reject: "晚点再说"
          }
        }}
        handlers={{ onFeedFeedback, onLineage, onAccept }}
      />
    );

    openContent("今日早报");
    fireEvent.click(screen.getAllByRole("button", { name: "有新角度" })[0]);
    expect(onFeedFeedback).toHaveBeenCalledWith(
      "feed-daily-report-format",
      "new-angle"
    );

    fireEvent.click(screen.getByRole("button", { name: "查看来源：关联今天的日报" }));
    expect(onLineage).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "seed-todo-daily-report" })
    );

    openContent("核心记忆点");
    fireEvent.click(screen.getByRole("button", { name: "先这样试" }));
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ id: "seed-flex", kind: "proposal" })
    );
  });

  it("Browser V2 只分发 registry 已绑定命令；解绑后按钮明确禁用", () => {
    const onFeedFeedback = vi.fn();
    const onAnchorComplete = vi.fn();
    const onLineage = vi.fn();
    const layout = structuredClone(BROWSER_PRODUCT_LAYOUT_DOCUMENT);
    const document = layoutV1ToUiSurfaceV2(layout);
    const registry = createBrowserCompositionRegistry();
    const { rerender } = render(
      <LayoutRenderer
        document={layout}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
        handlers={{ onFeedFeedback, onAnchorComplete, onLineage }}
        composition={{ document, registry }}
      />,
    );

    openContent("今日早报");
    fireEvent.click(screen.getAllByRole("button", { name: "有新角度" })[0]);
    expect(onFeedFeedback).toHaveBeenCalledOnce();

    const unbound = structuredClone(document);
    delete unbound.components.find((component) => component.id === "seed-feed")!.actions.feedback;
    const schedule = unbound.components.find((component) => component.id === "seed-schedule")!;
    delete schedule.actions.complete;
    delete schedule.actions.lineage;
    rerender(
      <LayoutRenderer
        document={layout}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
        handlers={{ onFeedFeedback, onAnchorComplete, onLineage }}
        composition={{ document: unbound, registry }}
      />,
    );
    const disabledFeedback = screen.getAllByRole("button", { name: "有新角度" })[0];
    expect(disabledFeedback).toBeDisabled();
    expect(disabledFeedback).toHaveAttribute(
      "title",
      "资讯反馈已在组件设置中关闭",
    );
    fireEvent.click(disabledFeedback);
    expect(onFeedFeedback).toHaveBeenCalledOnce();

    openContent("今天的锚点");
    const disabledComplete = screen.getByRole("button", {
      name: "完成：给客户 1 准备日报",
    });
    expect(disabledComplete).toBeDisabled();
    expect(disabledComplete).toHaveAttribute(
      "title",
      "结果回收已在组件设置中关闭",
    );
    const disabledLineage = screen.getAllByRole("button", {
      name: "查看来源：来自你的待办",
    })[0];
    for (const lineageButton of screen.getAllByRole("button", {
      name: "查看来源：来自你的待办",
    })) {
      expect(lineageButton).toBeDisabled();
      expect(lineageButton).toHaveAttribute(
        "title",
        "查看来源已在组件设置中关闭",
      );
    }
    fireEvent.click(disabledComplete);
    fireEvent.click(disabledLineage);
    expect(onAnchorComplete).not.toHaveBeenCalled();
    expect(onLineage).not.toHaveBeenCalled();
  });

  it("卡面点击不编辑，键盘右键能打开设置并进入内容编辑", () => {
    const onCardEdit = vi.fn();
    render(<LayoutRenderer document={SEED_LAYOUT_DOCUMENT} bindings={SEED_DESKTOP_PROJECTION.bindings} handlers={{ onCardEdit }} />);
    const card = screen.getByRole("group", { name: "卡片：核心记忆点" });
    fireEvent.click(card);
    fireEvent.doubleClick(card);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onCardEdit).not.toHaveBeenCalled();
    expect(card).toHaveAttribute("aria-keyshortcuts", "Shift+F10 ContextMenu");
    card.focus();
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "卡片设置：核心记忆点" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "编辑内容" }));
    fireEvent.click(screen.getByRole("button", { name: "修改标题与内容" }));
    expect(onCardEdit).toHaveBeenCalledWith(expect.objectContaining({ cardId: "seed-flex", binding: "desktop.flex" }));
  });

  it("内部按钮的双击不会冒泡成整卡编辑", () => {
    const onCardEdit = vi.fn();
    const onFeedFeedback = vi.fn();
    render(
      <LayoutRenderer
        document={SEED_LAYOUT_DOCUMENT}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
        handlers={{ onCardEdit, onFeedFeedback }}
      />
    );

    openContent("今日早报");
    const feedback = screen.getAllByRole("button", { name: "有新角度" })[0];
    // 浏览器真实序列是 click(detail=1) → click(detail=2) → dblclick。
    fireEvent.click(feedback, { detail: 1 });
    fireEvent.click(feedback, { detail: 2 });
    fireEvent.doubleClick(feedback, { detail: 2 });
    expect(onCardEdit).not.toHaveBeenCalled();
    expect(onFeedFeedback).toHaveBeenCalledTimes(1);
  });

  it("认知卡在内容弹窗中仍可翻开手帐，主页只呈现内容", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onCardEdit = vi.fn();
    const layout = cloneLayout();
    layout.cards = layout.cards.map((card) =>
      card.id === "seed-flex" ? { ...card, kind: "cognition" } : card
    );
    const { container, unmount } = render(
      <LayoutRenderer
        document={layout}
        bindings={{
          ...SEED_DESKTOP_PROJECTION.bindings,
          "desktop.flex": {
            kind: "cognition",
            blindSpot: "真正的判断需要被反证照亮。",
            claim: "只要信息更多，判断自然会更好。",
            claimKind: "假设",
            alternativeHint: "先找一个最可能推翻它的证据。",
            density: { support: 2, contradict: 1 }
          }
        }}
        handlers={{ onOpen, onCardEdit }}
      />
    );
    const outer = container.querySelector<HTMLElement>(
      "[data-layout-card-id='seed-flex'] .dim-drag"
    );
    expect(container.querySelector("[data-card-primary-action]")).not.toBeInTheDocument();
    if (!outer) throw new Error("missing cognition card");
    fireEvent.click(outer);
    expect(onOpen).not.toHaveBeenCalled();
    openContent("核心记忆点");
    const cognition = screen.getByRole("dialog").querySelector<HTMLElement>("[data-card-primary-action]")!;
    fireEvent.click(cognition, { detail: 1 });
    act(() => vi.advanceTimersByTime(231));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onCardEdit).not.toHaveBeenCalled();

    unmount();
    vi.useRealTimers();
  });

  it("拖拽被系统取消会归位，也不会吞掉下一次按钮点击", () => {
    const onFeedFeedback = vi.fn();
    const { container } = render(
      <LayoutRenderer
        document={SEED_LAYOUT_DOCUMENT}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
        handlers={{ onFeedFeedback }}
      />
    );
    const card = container.querySelector<HTMLElement>(
      "[data-layout-card-id='seed-feed'] .dim-drag"
    );
    if (!card) throw new Error("missing feed card");

    fireEvent.pointerDown(card, {
      button: 0,
      pointerId: 7,
      clientX: 20,
      clientY: 20
    });
    fireEvent.pointerMove(card, { pointerId: 7, clientX: 80, clientY: 60 });
    expect(card.style.translate).not.toBe("");
    fireEvent.pointerCancel(card, { pointerId: 7, clientX: 80, clientY: 60 });
    expect(card.style.translate).toBe("");

    openContent("今日早报");
    fireEvent.click(screen.getAllByRole("button", { name: "有新角度" })[0], {
      detail: 1
    });
    expect(onFeedFeedback).toHaveBeenCalledOnce();
  });

  it.each(["html", "declarative"] as const)(
    "对未启用的 %s renderer 显示降级且不渲染绑定内容",
    (renderer) => {
      const layout = cloneLayout();
      layout.cards[0] = { ...layout.cards[0], renderer };

      render(
        <LayoutRenderer
          document={layout}
          bindings={SEED_DESKTOP_PROJECTION.bindings}
        />
      );

      expect(screen.getByRole("alert")).toHaveTextContent(
        renderer === "html" ? "自由 HTML 渲染器尚未启用" : "声明式渲染器尚未启用"
      );
      expect(screen.queryByText("先做可评审版本，再补完整版本")).not.toBeInTheDocument();
    }
  );

  it("对未知 native key 和缺失 binding 显示可见错误，不静默为空", () => {
    const unknown = cloneLayout();
    unknown.cards[0] = { ...unknown.cards[0], kind: "not-registered" };

    const { rerender } = render(
      <LayoutRenderer
        document={unknown}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("未知的原生卡片类型");

    rerender(
      <LayoutRenderer
        document={SEED_LAYOUT_DOCUMENT}
        bindings={{ ...SEED_DESKTOP_PROJECTION.bindings, "desktop.feed": undefined }}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "找不到数据绑定：desktop.feed"
    );
  });

  it("非法文档显示结构化错误而不是尝试渲染", () => {
    const layout = cloneLayout();
    layout.arrangement.orderedCardIds[0] = "missing-card";

    render(
      <LayoutRenderer
        document={layout}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("桌面布局文档有问题");
    expect(screen.getByRole("alert")).toHaveTextContent("不存在的 card");
  });

  it("右键进入尺寸调整后才出现手柄，拉伸保持其他卡片与业务操作", () => {
    const onCardEdit = vi.fn();
    const onFeedFeedback = vi.fn();
    const layout = { ...cloneLayout(), id: "resize-interaction-test" };
    const { container, unmount } = render(
      <LayoutRenderer
        document={layout}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
        handlers={{ onCardEdit, onFeedFeedback }}
      />
    );
    expect(screen.queryByRole("button", { name: /^调整大小：/ })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole("group", { name: "卡片：今日早报" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /调整大小/ }));
    expect(screen.getAllByRole("button", { name: /^调整大小：/ })).toHaveLength(1);
    const corner = screen.getByRole("button", { name: "调整大小：今日早报" });
    const card = container.querySelector<HTMLElement>("[data-layout-card-id='seed-feed'] .dim-drag")!;
    const slot = card.parentElement!;
    const otherSlot = container.querySelector<HTMLElement>("[data-layout-card-id='seed-schedule']")!;
    fireEvent.pointerDown(corner, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(corner, { pointerId: 1, clientX: 80, clientY: 60 });
    fireEvent.pointerUp(corner, { pointerId: 1 });
    fireEvent.click(corner);
    expect(card).toHaveClass("is-sized");
    expect(card.style.translate).toBe("");
    // 放手后仍压在后一个槽位之上，避免入场动画的层叠上下文遮住重叠的手柄。
    expect(Number(slot.style.zIndex)).toBeGreaterThan(Number(otherSlot.style.zIndex));
    expect(slot.style.zIndex).toBe(card.style.zIndex);
    expect(onCardEdit).not.toHaveBeenCalled();
    openContent("今日早报");
    fireEvent.click(screen.getAllByRole("button", { name: "有新角度" })[0]);
    expect(onFeedFeedback).toHaveBeenCalledOnce();
    fireEvent.doubleClick(corner);
    expect(card).not.toHaveClass("is-sized");
    expect(onCardEdit).not.toHaveBeenCalled();
    unmount();
    localStorage.removeItem("dim-desk-sizes-resize-interaction-test");
  });
});
