import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CardPresentation } from "../../dimension/types";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import {
  createBrowserCompositionRegistry,
  layoutV1ToUiSurfaceV2,
} from "../composition/browserProduction";
import { LayoutRenderer } from "./LayoutRenderer";
import { SEED_LAYOUT_DOCUMENT } from "./seedLayout";
import type { LayoutDocumentV1 } from "./types";

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

    fireEvent.click(screen.getAllByRole("button", { name: "有新角度" })[0]);
    expect(onFeedFeedback).toHaveBeenCalledWith(
      "feed-daily-report-format",
      "new-angle"
    );

    fireEvent.click(screen.getByRole("button", { name: "查看来源：关联今天的日报" }));
    expect(onLineage).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "seed-todo-daily-report" })
    );

    fireEvent.click(screen.getByRole("button", { name: "先这样试" }));
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ id: "seed-flex", kind: "proposal" })
    );
  });

  it("Browser V2 只分发 registry 已绑定命令；解绑后按钮明确禁用", () => {
    const onFeedFeedback = vi.fn();
    const onAnchorComplete = vi.fn();
    const onLineage = vi.fn();
    const layout = cloneLayout();
    layout.id = "latitude-browser-live";
    layout.revision = 3;
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

  it("单击与拖拽不编辑，正文双击或卡片聚焦后 Enter/F2 才打开编辑器", () => {
    const onCardEdit = vi.fn();
    const { container } = render(
      <LayoutRenderer
        document={SEED_LAYOUT_DOCUMENT}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
        handlers={{ onCardEdit }}
      />
    );
    const card = container.querySelector<HTMLElement>(
      "[data-layout-card-id='seed-flex'] .dim-drag"
    );
    if (!card) throw new Error("missing editable card");

    expect(container.querySelector(".dim-card-edit-trigger")).not.toBeInTheDocument();
    expect(card).toHaveAttribute("tabindex", "0");
    expect(card).toHaveAttribute("aria-keyshortcuts", "Enter F2");

    fireEvent.click(card);
    expect(onCardEdit).not.toHaveBeenCalled();

    fireEvent.pointerDown(card, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100
    });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 150, clientY: 130 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 150, clientY: 130 });
    fireEvent.click(card);
    expect(onCardEdit).not.toHaveBeenCalled();

    fireEvent.doubleClick(card);
    expect(onCardEdit).toHaveBeenCalledTimes(1);
    expect(onCardEdit).toHaveBeenLastCalledWith(
      expect.objectContaining({ cardId: "seed-flex", binding: "desktop.flex" })
    );

    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: "F2" });
    expect(onCardEdit).toHaveBeenCalledTimes(3);
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

    const feedback = screen.getAllByRole("button", { name: "有新角度" })[0];
    // 浏览器真实序列是 click(detail=1) → click(detail=2) → dblclick。
    fireEvent.click(feedback, { detail: 1 });
    fireEvent.click(feedback, { detail: 2 });
    fireEvent.doubleClick(feedback, { detail: 2 });
    expect(onCardEdit).not.toHaveBeenCalled();
    expect(onFeedFeedback).toHaveBeenCalledTimes(1);
  });

  it("认知卡单击仍翻开手帐，双击只进入整卡编辑", () => {
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
    const cognition = container.querySelector<HTMLElement>(
      "[data-layout-card-id='seed-flex'] [data-card-primary-action]"
    );
    if (!outer || !cognition) throw new Error("missing cognition card");

    fireEvent.click(cognition, { detail: 1 });
    expect(onOpen).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(231));
    expect(onOpen).toHaveBeenCalledOnce();

    fireEvent.click(cognition, { detail: 1 });
    fireEvent.click(cognition, { detail: 2 });
    fireEvent.doubleClick(cognition, { detail: 2 });
    act(() => vi.advanceTimersByTime(231));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onCardEdit).toHaveBeenCalledOnce();
    expect(onCardEdit).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "seed-flex", binding: "desktop.flex" })
    );

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
});
