import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCardDrag } from "./useCardDrag";

const STORAGE_KEY = "test-card-drag-performance";

function DragDesk({ onRender, zoom = 1 }: { onRender: () => void; zoom?: number }) {
  onRender();
  const drag = useCardDrag(STORAGE_KEY);
  const offset = drag.offsetFor("paper");
  return (
    <div data-desktop-zoom={zoom}><div
      data-testid="paper"
      className="dim-drag"
      style={{
        translate: offset.x || offset.y ? `${offset.x}px ${offset.y}px` : undefined,
        zIndex: drag.zIndexFor("paper"),
      }}
      {...drag.bind("paper")}
    ><div data-testid="scroll-content" /></div></div>
  );
}

describe("useCardDrag direct manipulation", () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    vi.restoreAllMocks();
  });

  it("连续移动只更新当前纸片，放手时才提交并保存最终位置", () => {
    const onRender = vi.fn();
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    render(<DragDesk onRender={onRender} />);
    const paper = screen.getByTestId("paper");
    fireEvent.pointerDown(paper, {
      button: 0,
      pointerId: 3,
      pointerType: "mouse",
      clientX: 20,
      clientY: 30,
    });
    const rendersBeforeMoves = onRender.mock.calls.length;
    for (let step = 1; step <= 12; step += 1) {
      fireEvent.pointerMove(paper, {
        pointerId: 3,
        clientX: 20 + step * 4,
        clientY: 30 + step * 2,
      });
    }
    expect(onRender).toHaveBeenCalledTimes(rendersBeforeMoves);
    expect(paper).toHaveClass("is-dragging");
    expect(paper.style.translate).toBe("48px 24px");
    expect(storageSet).not.toHaveBeenCalled();

    fireEvent.pointerUp(paper, { pointerId: 3 });
    expect(onRender).toHaveBeenCalledTimes(rendersBeforeMoves + 1);
    expect(paper).not.toHaveClass("is-dragging");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      paper: { x: 48, y: 24 },
    });
    expect(storageSet).toHaveBeenCalledTimes(1);
  });

  it("指针取消或捕获丢失立即恢复原位置，不污染持久状态", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ paper: { x: 12, y: 8 } }));
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    render(<DragDesk onRender={vi.fn()} />);
    const paper = screen.getByTestId("paper");
    expect(paper.style.translate).toBe("12px 8px");

    fireEvent.pointerDown(paper, { button: 0, pointerId: 4, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(paper, { pointerId: 4, clientX: 60, clientY: 50 });
    fireEvent.lostPointerCapture(paper, { pointerId: 4 });
    expect(paper.style.translate).toBe("12px 8px");
    expect(paper).not.toHaveClass("is-dragging");

    fireEvent.pointerDown(paper, { button: 0, pointerId: 5, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(paper, { pointerId: 5, clientX: 80, clientY: 50 });
    fireEvent.pointerCancel(paper, { pointerId: 5 });
    expect(paper.style.translate).toBe("12px 8px");
    expect(storageSet).not.toHaveBeenCalled();
  });

  it.each([0.5, 1.5])("在 %s 倍桌面下拖动跟随屏幕指针，保存逻辑偏移并可取消下一次拖动", (zoom) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ paper: { x: 12, y: 8 } }));
    const { unmount } = render(<DragDesk zoom={zoom} onRender={vi.fn()} />);
    const paper = screen.getByTestId("paper");
    fireEvent.pointerDown(paper, { button: 0, pointerId: 6, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(paper, { pointerId: 6, clientX: 20 + 60 * zoom, clientY: 30 + 40 * zoom });
    expect(paper.style.translate).toBe("72px 48px");
    fireEvent.pointerUp(paper, { pointerId: 6 });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ paper: { x: 72, y: 48 } });
    fireEvent.pointerDown(paper, { button: 0, pointerId: 7, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(paper, { pointerId: 7, clientX: 100, clientY: 150 });
    fireEvent.pointerCancel(paper, { pointerId: 7 });
    expect(paper.style.translate).toBe("72px 48px");
    unmount();
    render(<DragDesk zoom={1} onRender={vi.fn()} />);
    expect(screen.getByTestId("paper").style.translate).toBe("72px 48px");
  });

  it.each([0.5, 1.5])("缩放 %s 后滚动条命中区随纸片缩放，正文区域仍可拖动", (zoom) => {
    render(<DragDesk zoom={zoom} onRender={vi.fn()} />);
    const content = screen.getByTestId("scroll-content");
    const paper = screen.getByTestId("paper");
    Object.defineProperties(content, {
      clientWidth: { value: 280 }, clientHeight: { value: 200 }, scrollHeight: { value: 400 },
    });
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 30, 300 * zoom, 200 * zoom));
    const scrollbarX = 20 + 290 * zoom;
    fireEvent.pointerDown(content, { button: 0, pointerId: 8, clientX: scrollbarX, clientY: 60 });
    fireEvent.pointerMove(paper, { pointerId: 8, clientX: scrollbarX + 30, clientY: 90 });
    expect(paper).not.toHaveClass("is-dragging");
    const contentX = 20 + 260 * zoom;
    fireEvent.pointerDown(content, { button: 0, pointerId: 9, clientX: contentX, clientY: 60 });
    fireEvent.pointerMove(paper, { pointerId: 9, clientX: contentX + 30, clientY: 90 });
    expect(paper).toHaveClass("is-dragging");
    fireEvent.pointerCancel(paper, { pointerId: 9 });
  });
});
