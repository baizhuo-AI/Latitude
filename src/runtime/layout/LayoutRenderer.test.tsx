import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CardPresentation } from "../../dimension/types";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
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

    expect(screen.getByRole("heading", { name: "一个值得带走的角度" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "今天的三个锚点" })).toBeVisible();
    expect(screen.getByText("这周有一个新判断")).toBeVisible();
    expect(screen.getByText("要不要先做一个小版本？")).toBeVisible();

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

  it("把资讯反馈、血缘和提案动作透传给桌面 handler", () => {
    const onFeedFeedback = vi.fn();
    const onLineage = vi.fn();
    const onAccept = vi.fn();

    render(
      <LayoutRenderer
        document={SEED_LAYOUT_DOCUMENT}
        bindings={SEED_DESKTOP_PROJECTION.bindings}
        handlers={{ onFeedFeedback, onLineage, onAccept }}
      />
    );

    fireEvent.click(screen.getAllByRole("button", { name: "有新角度" })[0]);
    expect(onFeedFeedback).toHaveBeenCalledWith(
      "feed-reviewable-first",
      "new-angle"
    );

    fireEvent.click(screen.getByRole("button", { name: "查看来源：关联今天的评审" }));
    expect(onLineage).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "seed-plan-review" })
    );

    fireEvent.click(screen.getByRole("button", { name: "先这样试" }));
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ id: "seed-flex", kind: "proposal" })
    );
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
