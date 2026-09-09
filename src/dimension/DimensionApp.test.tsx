import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_DESKTOP_PROJECTION } from "../projections/desktop/seedProjection";
import { SEED_LAYOUT_DOCUMENT } from "../runtime/layout/seedLayout";
import { DimensionApp } from "./DimensionApp";

function menuAction(title: string, action: string) {
  fireEvent.contextMenu(screen.getByRole("group", { name: `卡片：${title}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: action === "移除卡片" ? /移除卡片/ : action }));
}

describe("DimensionApp seed runtime", () => {
  beforeEach(() => window.localStorage.clear());

  it("诚实展示演示模式，渲染五区且不外显内部关系说明", () => {
    const { container } = render(<DimensionApp />);

    expect(screen.getByText("演示模式")).toBeVisible();
    expect(container.querySelectorAll("[data-layout-card-id]")).toHaveLength(4);
    expect(screen.queryByText("78")).not.toBeInTheDocument();
    expect(screen.queryByText("71")).not.toBeInTheDocument();
    expect(screen.queryByText("46")).not.toBeInTheDocument();
    expect(screen.queryByText("关系 · 脱敏演示")).not.toBeInTheDocument();
    expect(screen.queryByText(/typed|receipt/i)).not.toBeInTheDocument();
  });

  it("所有未接线动作都给出演示模式提示", () => {
    render(<DimensionApp />);

    menuAction("今日早报", "编辑内容");
    fireEvent.click(screen.getAllByRole("button", { name: "有新角度" })[0]);
    expect(screen.getByRole("status")).toHaveTextContent("演示模式");
    expect(screen.getByRole("status")).toHaveTextContent("本次不会保存");
  });

  it("初始隐藏的本子层通过 inert 退出键盘可达树", () => {
    const { container } = render(<DimensionApp />);

    expect(container.querySelector(".dim-layer--book")).toHaveAttribute("inert");
    expect(container.querySelector(".dim-layer--desk")).not.toHaveAttribute("inert");
  });

  it("设置从顶部移到秘书栏左下角，并保留原回调", () => {
    const onOpenSettings = vi.fn();
    const { container } = render(<DimensionApp onOpenSettings={onOpenSettings} />);

    const header = container.querySelector("header");
    const railFooter = container.querySelector(".dim-rail-footer");
    if (!(header instanceof HTMLElement) || !(railFooter instanceof HTMLElement)) {
      throw new Error("missing header or secretary footer");
    }

    expect(within(header).queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    const settings = within(railFooter).getByRole("button", { name: "设置" });
    settings.focus();
    expect(settings).toHaveFocus();
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("桌面保留轻量工具与回常用区，回去只清理板块选择", () => {
    const onAdjustDesktop = vi.fn();
    const onActiveAreaChange = vi.fn();
    const onOpenReview = vi.fn();
    render(
      <DimensionApp
        projection={{
          ...SEED_DESKTOP_PROJECTION,
          header: {
            breadcrumb: "今天",
            title: "先记下一件已经做过的事",
            subtitle: "不必完整，一句话就够"
          }
        }}
        activeAreaId="research"
        onAdjustDesktop={onAdjustDesktop}
        onActiveAreaChange={onActiveAreaChange}
        onOpenReview={onOpenReview}
      />
    );

    expect(screen.queryByText("先记下一件已经做过的事")).not.toBeInTheDocument();
    expect(screen.queryByText("不必完整，一句话就够")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多桌面操作" }));
    fireEvent.click(screen.getByRole("button", { name: "调整桌面" }));
    fireEvent.click(screen.getByRole("button", { name: "回常用区" }));
    fireEvent.click(screen.getByRole("button", { name: "更多桌面操作" }));
    expect(screen.queryByRole("button", { name: "周回顾" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回上一位置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "适合窗口" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "记录常用区" }));
    expect(onAdjustDesktop).toHaveBeenCalledOnce();
    expect(onActiveAreaChange).toHaveBeenCalledWith(null);
    expect(onOpenReview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /卡片总览/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("周回顾退出主页与总览但保留源数据", () => {
    render(<DimensionApp />);
    expect(screen.queryByRole("heading", { name: "这周有一个新判断" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /卡片总览/ }));
    expect(screen.queryByText("这周有一个新判断")).not.toBeInTheDocument();
    expect(SEED_DESKTOP_PROJECTION.bindings["desktop.reviewPlan"]).toBeDefined();
  });

  it("连续移除可以依次撤销，并保留卡片原来的位置和内容", () => {
    window.localStorage.setItem(`dim-desk-offsets-${SEED_LAYOUT_DOCUMENT.id}`, JSON.stringify({
      "seed-feed": { x: 63, y: 29 }
    }));
    const { container } = render(<DimensionApp />);
    const feedBefore = container.querySelector('[data-layout-card-id="seed-feed"] .dim-drag');
    expect(feedBefore).toHaveStyle({ translate: "63px 29px" });
    const originalFeedText = feedBefore?.querySelector(".dim-paper")?.textContent;

    menuAction("今日早报", "移除卡片");
    menuAction("核心记忆点", "移除卡片");
    expect(container.querySelectorAll("[data-layout-card-id]")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("另 1 张可撤销");

    fireEvent.click(screen.getByRole("button", { name: "撤销移除：核心记忆点" }));
    expect(container.querySelector('[data-layout-card-id="seed-flex"]')).toBeInTheDocument();
    expect(container.querySelector('[data-layout-card-id="seed-feed"]')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销移除：今日早报" }));

    const feedAfter = container.querySelector('[data-layout-card-id="seed-feed"] .dim-drag');
    expect(container.querySelectorAll("[data-layout-card-id]")).toHaveLength(4);
    expect(feedAfter).toHaveStyle({ translate: "63px 29px" });
    expect(feedAfter?.querySelector(".dim-paper")?.textContent).toBe(originalFeedText);
    expect(screen.queryByRole("button", { name: /撤销移除/ })).not.toBeInTheDocument();
  });

  it("关闭移除提示之后，仍能从总览中放回", async () => {
    const { container } = render(<DimensionApp />);
    menuAction("今日早报", "移除卡片");
    fireEvent.click(screen.getByRole("button", { name: "关闭移除提示" }));
    expect(screen.queryByRole("button", { name: /撤销移除/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /卡片总览/ }));
    const picker = screen.getByRole("region", { name: "卡片总览" });
    fireEvent.click(within(picker).getByRole("button", { name: "放回桌面：今日早报" }));
    expect(container.querySelector('[data-layout-card-id="seed-feed"]')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "卡片总览" })).not.toBeInTheDocument());
  });

  it("受控卡片在宿主确认移除后可撤销，恢复只改变这张卡的可见性", () => {
    const onCardVisibilityChange = vi.fn();
    const { rerender } = render(<DimensionApp onCardVisibilityChange={onCardVisibilityChange} />);
    menuAction("今日早报", "移除卡片");
    expect(onCardVisibilityChange).toHaveBeenLastCalledWith("seed-feed", false);
    expect(screen.queryByRole("button", { name: /撤销移除/ })).not.toBeInTheDocument();

    const updatedLayout = {
      ...SEED_LAYOUT_DOCUMENT,
      revision: SEED_LAYOUT_DOCUMENT.revision + 1,
      cards: SEED_LAYOUT_DOCUMENT.cards.map((card) => ({
        ...card,
        hidden: card.id === "seed-feed",
        presentation: {
          ...card.presentation,
          title: card.id === "seed-flex" ? "宿主刚更新的记忆" : card.presentation.title
        }
      }))
    };
    rerender(<DimensionApp layout={updatedLayout} onCardVisibilityChange={onCardVisibilityChange} />);
    fireEvent.click(screen.getByRole("button", { name: "撤销移除：今日早报" }));
    expect(onCardVisibilityChange.mock.calls).toEqual([["seed-feed", false], ["seed-feed", true]]);
    expect(screen.getByText("宿主刚更新的记忆")).toBeVisible();
  });
});
