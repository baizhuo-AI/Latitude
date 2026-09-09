import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCardResize } from "./useCardResize";

function ResizeDesk({
  storageKey = "test-resize-a",
  onRender,
  zoom = 1,
  freeDesktop = false,
  withShell = false,
  frameDefault,
}: {
  storageKey?: string;
  onRender?: () => void;
  zoom?: number;
  freeDesktop?: boolean;
  withShell?: boolean;
  frameDefault?: { width: number; height: number };
}) {
  onRender?.();
  const resize = useCardResize(storageKey);
  return (
    <div data-desktop-zoom={zoom}><div className="dim-grid-wrap">
      <div className="dim-grid" data-free-desktop={freeDesktop ? "true" : undefined}>
        {["feed", "note"].map((id) => (
          <div
            key={id}
            data-testid={id}
            data-card-resizable
            data-resizing={resize.resizingId === id}
            data-default-width={id === "feed" ? frameDefault?.width : undefined}
            data-default-height={id === "feed" ? frameDefault?.height : undefined}
            style={resize.sizeFor(id) ?? (id === "feed" ? frameDefault : undefined)}
          >
            {withShell && id === "feed" && (
              <section
                className="dim-card-shell"
                style={{
                  paddingTop: 20,
                  paddingBottom: 18,
                  borderTop: "1px solid",
                  borderBottom: "1px solid",
                }}
              >
                <header className="dim-card-header" data-testid="feed-header" />
                <div className="dim-card-body" />
                <footer className="dim-card-footer" data-testid="feed-footer" />
              </section>
            )}
            {["corner", "right", "bottom"].map((direction) => (
              <button
                key={direction}
                aria-label={`${id}-${direction}`}
                {...resize.bind(id, direction as "corner" | "right" | "bottom")}
              />
            ))}
          </div>
        ))}
      </div>
    </div></div>
  );
}

function gesture(handle: HTMLElement, dx: number, dy: number, pointerType = "mouse") {
  fireEvent.pointerDown(handle, { button: 0, pointerId: 8, pointerType, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(handle, { pointerId: 8, pointerType, clientX: 100 + dx, clientY: 100 + dy });
}

describe("useCardResize", () => {
  beforeEach(() => {
    localStorage.removeItem("test-resize-a");
    localStorage.removeItem("test-resize-b");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const zoom = Number(this.closest<HTMLElement>("[data-desktop-zoom]")?.dataset.desktopZoom) || 1;
      if (this.classList.contains("dim-grid-wrap")) return new DOMRect(0, 0, 640 * zoom, 800 * zoom);
      return new DOMRect(10 * zoom, 30 * zoom, (parseFloat(this.style.width) || 300) * zoom, (parseFloat(this.style.height) || 220) * zoom);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("test-resize-a");
    localStorage.removeItem("test-resize-b");
  });

  it("触摸拉伸只调整目标卡片，放手保存，切换桌面和重新挂载分别读取自己的尺寸", () => {
    const { rerender, unmount } = render(<ResizeDesk />);
    const handle = screen.getByRole("button", { name: "feed-corner" });
    gesture(handle, 80, 60, "touch");
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "380px", height: "280px" });
    expect(screen.getByTestId("note").style.width).toBe("");
    expect(localStorage.getItem("test-resize-a")).toBeNull();

    fireEvent.pointerUp(handle, { pointerId: 8 });
    expect(JSON.parse(localStorage.getItem("test-resize-a")!)).toEqual({ feed: { width: 380, height: 280 } });
    rerender(<ResizeDesk storageKey="test-resize-b" />);
    expect(screen.getByTestId("feed").style.width).toBe("");
    rerender(<ResizeDesk storageKey="test-resize-a" />);
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "380px", height: "280px" });
    unmount();
    render(<ResizeDesk />);
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "380px", height: "280px" });
  });

  it("取消、Escape 或丢失捕获会恢复手势之前的尺寸，也不落盘半次手势", () => {
    render(<ResizeDesk />);
    const handle = screen.getByRole("button", { name: "feed-corner" });
    gesture(handle, 40, 30);
    fireEvent.pointerCancel(handle, { pointerId: 8 });
    expect(screen.getByTestId("feed").style.width).toBe("");
    expect(screen.getByTestId("feed")).toHaveAttribute("data-resizing", "false");
    expect(localStorage.getItem("test-resize-a")).toBeNull();

    gesture(handle, 60, 20);
    fireEvent.pointerUp(handle, { pointerId: 8 });
    const saved = localStorage.getItem("test-resize-a");
    gesture(handle, 80, 90);
    fireEvent.keyDown(handle, { key: "Escape" });
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "360px", height: "240px" });
    gesture(handle, 80, 90);
    fireEvent.lostPointerCapture(handle, { pointerId: 8 });
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "360px", height: "240px" });
    expect(localStorage.getItem("test-resize-a")).toBe(saved);
  });

  it("边缘手柄只改一个方向；键盘支持微调、最小尺寸、桌面右边界和恢复默认", () => {
    render(<ResizeDesk />);
    const right = screen.getByRole("button", { name: "feed-right" });
    const bottom = screen.getByRole("button", { name: "feed-bottom" });
    const corner = screen.getByRole("button", { name: "feed-corner" });
    gesture(right, 900, 900);
    fireEvent.pointerUp(right, { pointerId: 8 });
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "630px", height: "220px" });

    gesture(bottom, -900, -900);
    fireEvent.pointerUp(bottom, { pointerId: 8 });
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "630px", height: "140px" });
    fireEvent.keyDown(corner, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(corner, { key: "ArrowDown" });
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "590px", height: "150px" });
    expect(JSON.parse(localStorage.getItem("test-resize-a")!).feed).toEqual({ width: 590, height: 150 });
    gesture(corner, -900, -900);
    fireEvent.pointerUp(corner, { pointerId: 8 });
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "200px", height: "140px" });
    fireEvent.keyDown(corner, { key: "Home" });
    expect(screen.getByTestId("feed").style.width).toBe("");
    expect(JSON.parse(localStorage.getItem("test-resize-a")!)).toEqual({});
  });

  it("CardShell 为固定头尾、纸张边距和 48px 正文保留动态最小高度", () => {
    render(<ResizeDesk withShell />);
    Object.defineProperty(screen.getByTestId("feed-header"), "offsetHeight", {
      configurable: true,
      get: () => 68,
    });
    Object.defineProperty(screen.getByTestId("feed-footer"), "offsetHeight", {
      configurable: true,
      get: () => 36,
    });
    const bottom = screen.getByRole("button", { name: "feed-bottom" });
    const corner = screen.getByRole("button", { name: "feed-corner" });

    // 68 + 36 + 20 + 18 + 1 + 1 + 48 = 192。
    gesture(bottom, 0, -900);
    fireEvent.pointerUp(bottom, { pointerId: 8 });
    expect(screen.getByTestId("feed")).toHaveStyle({ height: "192px" });

    fireEvent.keyDown(corner, { key: "Home" });
    fireEvent.keyDown(corner, { key: "ArrowUp", shiftKey: true });
    expect(screen.getByTestId("feed")).toHaveStyle({ height: "192px" });
    expect(screen.getByTestId("note").style.height).toBe("");
  });

  it("无尺寸 override 时连续 Home 与双击都会明确恢复 free desktop 的 frame 默认尺寸", () => {
    render(<ResizeDesk freeDesktop frameDefault={{ width: 360, height: 248 }} />);
    const feed = screen.getByTestId("feed");
    const handle = screen.getByRole("button", { name: "feed-corner" });
    expect(feed).toHaveStyle({ width: "360px", height: "248px" });

    fireEvent.keyDown(handle, { key: "Home" });
    expect(feed).toHaveStyle({ width: "360px", height: "248px" });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.doubleClick(handle);
    expect(feed).toHaveStyle({ width: "360px", height: "248px" });

    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(feed).toHaveStyle({ width: "360px", height: "258px" });
    fireEvent.doubleClick(handle);
    expect(feed).toHaveStyle({ width: "360px", height: "248px" });
    expect(JSON.parse(localStorage.getItem("test-resize-a")!)).toEqual({});
  });

  it("损坏或非数值的本地尺寸不进入页面；点一下手柄不改变默认布局", () => {
    localStorage.setItem("test-resize-a", JSON.stringify({ feed: { width: "100%", height: 300 }, note: { width: -10, height: 200 } }));
    render(<ResizeDesk />);
    expect(screen.getByTestId("feed").style.width).toBe("");
    expect(screen.getByTestId("note").style.width).toBe("");
    const handle = screen.getByRole("button", { name: "feed-corner" });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 8, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 8 });
    expect(screen.getByTestId("feed").style.width).toBe("");
  });

  it("连续移动只直接更新当前纸片，放手时才重渲染并写一次尺寸", () => {
    const onRender = vi.fn();
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    render(<ResizeDesk onRender={onRender} />);
    const handle = screen.getByRole("button", { name: "feed-corner" });
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 8,
      clientX: 100,
      clientY: 100,
    });
    const rendersBeforeMoves = onRender.mock.calls.length;
    for (let step = 1; step <= 12; step += 1) {
      fireEvent.pointerMove(handle, {
        pointerId: 8,
        clientX: 100 + step * 5,
        clientY: 100 + step * 3,
      });
    }
    expect(onRender).toHaveBeenCalledTimes(rendersBeforeMoves);
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "360px", height: "256px" });
    expect(storageSet).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 8 });
    expect(onRender).toHaveBeenCalledTimes(rendersBeforeMoves + 1);
    expect(storageSet).toHaveBeenCalledTimes(1);
  });

  it.each([0.5, 1.5])("在 %s 倍桌面下按指针拉伸且保持逻辑尺寸，取消和刷新能恢复", (zoom) => {
    const { unmount } = render(<ResizeDesk zoom={zoom} />);
    const card = screen.getByTestId("feed");
    Object.defineProperties(card, { offsetWidth: { configurable: true, get: () => parseFloat(card.style.width) || 300 }, offsetHeight: { configurable: true, get: () => parseFloat(card.style.height) || 220 } });
    const handle = screen.getByRole("button", { name: "feed-corner" });
    gesture(handle, 80 * zoom, 60 * zoom);
    expect(card).toHaveStyle({ width: "380px", height: "280px" });
    fireEvent.pointerUp(handle, { pointerId: 8 });
    gesture(handle, 80 * zoom, 60 * zoom);
    fireEvent.pointerCancel(handle, { pointerId: 8 });
    expect(card).toHaveStyle({ width: "380px", height: "280px" });
    gesture(handle, 900 * zoom, 0);
    fireEvent.pointerUp(handle, { pointerId: 8 });
    expect(card.style.width).toBe("630px");
    unmount();
    render(<ResizeDesk zoom={1} />);
    expect(screen.getByTestId("feed")).toHaveStyle({ width: "630px", height: "280px" });
  });

  it.each([0.5, 1.5])("free desktop 在 %s 倍缩放下只调整当前卡片并保留 4096 逻辑宽度边界", (zoom) => {
    render(<ResizeDesk zoom={zoom} freeDesktop />);
    const feed = screen.getByTestId("feed");
    const note = screen.getByTestId("note");
    const handle = screen.getByRole("button", { name: "feed-corner" });

    gesture(handle, 80 * zoom, 60 * zoom);
    fireEvent.pointerUp(handle, { pointerId: 8 });
    expect(feed).toHaveStyle({ width: "380px", height: "280px" });
    expect(note.style.width).toBe("");
    expect(note.style.height).toBe("");

    gesture(handle, 5000 * zoom, 0);
    fireEvent.pointerUp(handle, { pointerId: 8 });
    expect(feed).toHaveStyle({ width: "4096px", height: "280px" });
    expect(note.style.width).toBe("");
    expect(note.style.height).toBe("");
    expect(JSON.parse(localStorage.getItem("test-resize-a")!)).toEqual({
      feed: { width: 4096, height: 280 },
    });
  });
});
