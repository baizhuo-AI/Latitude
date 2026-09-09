import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import type { DesktopProjection } from "../../projections/desktop/types";
import { ClueBoardPreset, SIZE_STORAGE_KEY } from "./ClueBoardPreset";

const goalProjection: DesktopProjection = {
  ...SEED_DESKTOP_PROJECTION,
  clueBoard: { title: "当前方向", subtitle: "目标", themes: [{
    id: "goal:delivery", title: "完成客户交付", detail: "完成验收并留下真实反馈", rows: [], pending: 0, done: 0,
    lineage: { label: "中期目标", entityId: "delivery", entityType: "goal" },
  }] },
};

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
});
afterEach(() => vi.restoreAllMocks());

function openSettings(container: HTMLElement) {
  const paper = container.querySelector<HTMLElement>(".clue-thread-paper")!;
  fireEvent.contextMenu(paper, { clientX: 240, clientY: 180 });
  return paper;
}

describe("clue paper settings", () => {
  it("right-click and keyboard settings edit the real goal, while a single click stays on the board", () => {
    const onEnterThread = vi.fn();
    const { container } = render(<ClueBoardPreset projection={goalProjection} onEnterThread={onEnterThread} onSaveGoal={vi.fn()} />);
    const hit = screen.getByRole("button", { name: /中期目标 1：完成客户交付.*双击进入主页板块/ });
    fireEvent.click(hit, { detail: 1 });
    expect(onEnterThread).not.toHaveBeenCalled();
    expect(container.querySelector(".clue-goal-edit, .clue-paper-hit-label, .clue-paper-detail")).toBeNull();
    fireEvent.keyDown(hit, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "卡片设置：完成客户交付" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));
    expect(screen.getByRole("textbox", { name: "目标名称" })).toHaveValue("完成客户交付");
    fireEvent.click(screen.getByRole("button", { name: "关闭目标编辑" }));
    fireEvent.doubleClick(hit);
    expect(onEnterThread).toHaveBeenCalledWith(expect.objectContaining({ id: "goal:delivery" }));
  });

  it("deleting enters the existing confirmation and retries a failed real save", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("暂时无法删除，请重试")).mockResolvedValueOnce(undefined);
    const { container } = render(<ClueBoardPreset projection={goalProjection} onSaveGoal={onSave} />);
    openSettings(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(screen.getByRole("dialog", { name: "删除中期目标" })).toBeInTheDocument();
    expect(screen.getByText(/关联的行动和记录会保留/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("暂时无法删除"));
    expect(onSave).toHaveBeenCalledWith({ id: "delivery", title: "完成客户交付", detail: "完成验收并留下真实反馈", remove: true });
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("resizing commits on release, survives remount, and cancelling the next gesture preserves that size", () => {
    const props = { projection: goalProjection };
    const first = render(<ClueBoardPreset {...props} />);
    const paper = openSettings(first.container);
    fireEvent.click(screen.getByRole("menuitem", { name: /调整大小/ }));
    const handle = screen.getByRole("button", { name: "拖拽调整大小：完成客户交付" });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 150, clientY: 160 });
    expect(paper).toHaveStyle({ width: "330px", height: "240px" });
    expect(localStorage.getItem(SIZE_STORAGE_KEY)).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(JSON.parse(localStorage.getItem(SIZE_STORAGE_KEY)!)["goal:delivery"]).toEqual({ width: 330, height: 240 });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 150, clientY: 160 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 180, clientY: 210 });
    fireEvent.pointerCancel(handle, { pointerId: 2 });
    expect(paper).toHaveStyle({ width: "330px", height: "240px" });
    fireEvent.click(screen.getByRole("button", { name: "完成调整" }));
    expect(screen.queryByRole("button", { name: /拖拽调整大小/ })).not.toBeInTheDocument();
    first.unmount();
    const second = render(<ClueBoardPreset {...props} />);
    expect(second.container.querySelector(".clue-thread-paper")).toHaveStyle({ width: "330px", height: "240px" });
  });

  it("invalid saved sizes are ignored and keyboard resizing stays within usable bounds", () => {
    localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify({ "goal:delivery": { width: -40, height: 999999 } }));
    const { container } = render(<ClueBoardPreset projection={goalProjection} />);
    const paper = openSettings(container);
    expect(paper.style.width).toBe("");
    fireEvent.click(screen.getByRole("menuitem", { name: /调整大小/ }));
    const handle = screen.getByRole("button", { name: /拖拽调整大小/ });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(paper).toHaveStyle({ width: "208px", height: "180px" });
    fireEvent.keyDown(handle, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /拖拽调整大小/ })).not.toBeInTheDocument();
  });
});
