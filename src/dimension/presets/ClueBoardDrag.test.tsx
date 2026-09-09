import { Profiler } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import { ClueBoardPreset } from "./ClueBoardPreset";

const POSITION_KEY = "dim-clue-positions-v1";

function setupBoard(onEnterThread = vi.fn(), onEditThread?: () => void) {
  const onRender = vi.fn();
  const result = render(
    <Profiler id="clue-board" onRender={onRender}>
      <ClueBoardPreset
        projection={SEED_DESKTOP_PROJECTION}
        onEnterThread={onEnterThread}
        onEditThread={onEditThread}
      />
    </Profiler>
  );
  const surface = result.container.querySelector<HTMLElement>(".clue-surface");
  const paper = result.container.querySelector<HTMLElement>(".clue-thread-paper");
  const line = result.container.querySelector<SVGPathElement>(".clue-thread-hit");
  if (!surface || !paper || !line) throw new Error("clue drag fixture missing");
  surface.getBoundingClientRect = () =>
    ({ width: 1000, height: 680, left: 0, top: 0 }) as DOMRect;
  return { ...result, line, onRender, paper };
}

describe("ClueBoardPreset direct paper drag", () => {
  afterEach(() => {
    localStorage.removeItem(POSITION_KEY);
    vi.restoreAllMocks();
  });

  it("连续移动只更新当前纸和对应墨线，放手才提交、持久化并吞掉伴随点击", () => {
    const onEnterThread = vi.fn();
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    const { line, onRender, paper } = setupBoard(onEnterThread);
    const hit = screen.getByRole("button", { name: /线索 1：工作现状.*双击进入主页板块/ });
    const beforePath = line.getAttribute("d");

    fireEvent.pointerDown(paper, {
      button: 0,
      pointerId: 6,
      pointerType: "mouse",
      clientX: 200,
      clientY: 200,
    });
    expect(paper).toHaveClass("is-pressed");
    expect(paper.hasPointerCapture(6)).toBe(false);
    const rendersBeforeMoves = onRender.mock.calls.length;
    for (let step = 1; step <= 10; step += 1) {
      fireEvent.pointerMove(paper, {
        pointerId: 6,
        clientX: 200 + step * 10,
        clientY: 200 + step * 6.8,
      });
    }

    expect(onRender).toHaveBeenCalledTimes(rendersBeforeMoves);
    expect(storageSet).not.toHaveBeenCalled();
    expect(paper).toHaveClass("is-dragging");
    expect(paper.hasPointerCapture(6)).toBe(true);
    expect(paper).toHaveStyle({ left: "32%", top: "36%" });
    expect(line.getAttribute("d")).not.toBe(beforePath);

    fireEvent.pointerUp(paper, { pointerId: 6 });
    expect(onRender).toHaveBeenCalledTimes(rendersBeforeMoves + 1);
    expect(storageSet).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(POSITION_KEY)!)["thread-工作现状"])
      .toEqual({ x: 32, y: 36 });
    fireEvent.click(hit, { detail: 1 });
    expect(onEnterThread).not.toHaveBeenCalled();
    fireEvent.doubleClick(hit);
    expect(onEnterThread).not.toHaveBeenCalled();
  });

  it("未越过阈值不会误跳转；双击才进入，取消或捕获丢失恢复拖动", () => {
    const onEnterThread = vi.fn();
    const { line, paper } = setupBoard(onEnterThread);
    const hit = screen.getByRole("button", { name: /线索 1：工作现状.*双击进入主页板块/ });
    const originalPath = line.getAttribute("d");

    fireEvent.pointerDown(paper, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    expect(paper.hasPointerCapture(1)).toBe(false);
    fireEvent.pointerMove(paper, { pointerId: 1, clientX: 102, clientY: 101 });
    expect(paper.hasPointerCapture(1)).toBe(false);
    fireEvent.pointerUp(paper, { pointerId: 1 });
    fireEvent.click(hit, { detail: 1 });
    expect(onEnterThread).not.toHaveBeenCalled();
    fireEvent.doubleClick(hit);
    expect(onEnterThread).toHaveBeenCalledOnce();

    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.pointerDown(paper, { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(paper, { pointerId: 2, clientX: 180, clientY: 168 });
    expect(line.getAttribute("d")).not.toBe(originalPath);
    fireEvent.pointerCancel(paper, { pointerId: 2 });
    expect(paper).toHaveStyle({ left: "22%", top: "26%" });
    expect(line.getAttribute("d")).toBe(originalPath);
    expect(paper).not.toHaveClass("is-pressed", "is-dragging");

    fireEvent.pointerDown(paper, { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(paper, { pointerId: 3, clientX: 200, clientY: 168 });
    fireEvent.lostPointerCapture(paper, { pointerId: 3 });
    expect(paper).toHaveStyle({ left: "22%", top: "26%" });
    expect(storageSet).not.toHaveBeenCalled();
  });
});
