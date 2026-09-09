import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCardDrag } from "./useCardDrag";
import { useCardResize } from "./useCardResize";
import { DESKTOP_FOCUS_BOUNDS_EVENT } from "../../dimension/desktopCamera";
import { useCardSpatial } from "./useCardSpatial";
import type { CardSpatialState } from "./useCardSpatial";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../../projections/desktop/browserUiComposition";
import type { DesktopCardFrames } from "./desktopFrameStorage";

const CARD_IDS = ["one", "two", "three", "four", "five", "six"];
const FRAMES_KEY = "spatial-test-arranged-frames";
const readFrames = () => JSON.parse(localStorage.getItem(FRAMES_KEY)!).frames as DesktopCardFrames;

function SpatialDesk({ onChange, zoom, initiallyCompact = false, count = 2, kinds, initialFrames, arrangementGroups, lockedIds }: { onChange: (state: CardSpatialState) => void; zoom?: number; initiallyCompact?: boolean; count?: number; kinds?: Record<string, string>; initialFrames?: DesktopCardFrames; arrangementGroups?: string[][]; lockedIds?: string[] }) {
  const drag = useCardDrag("spatial-test-offsets");
  const resize = useCardResize("spatial-test-sizes");
  const gridRef = useRef<HTMLDivElement>(null);
  const ids = CARD_IDS.slice(0, count);
  const spatial = useCardSpatial({ storageKey: "spatial-test-arranged", gridRef, ids, drag, resize, onChange, initiallyCompact, kinds, initialFrames, arrangementGroups, lockedIds });
  return <>
    <button onClick={() => spatial.locateCard("one")}>locate</button>
    <button onClick={() => spatial.arrangeCards()}>arrange</button>
    <button onClick={() => spatial.arrangeCards(["one"])}>arrange one</button>
    <button onClick={spatial.undoArrangement}>undo</button>
    <div className="dim-desk-scroll" data-testid="viewport">
      <div className={zoom === undefined ? undefined : "dim-desktop-canvas"}><div data-desktop-zoom={zoom} data-testid="zoom-surface">
      <div className="dim-grid-wrap"><div ref={gridRef} className="dim-grid" data-arranged={spatial.arranged || undefined}
        style={spatial.frames ? { height: spatial.canvasHeight } : undefined}>
        {ids.map((id) => {
          const offset = drag.offsetFor(id);
          const size = resize.sizeFor(id);
          const frame = spatial.frames?.[id];
          return <div key={id} data-layout-card-id={id} data-testid={`frame-${id}`}
            style={frame ? { left: frame.x, top: frame.y, width: frame.width } : undefined}>
            <div data-card-resizable data-spatial-card-id={id} data-testid={id} tabIndex={-1}
              style={{ translate: `${offset.x}px ${offset.y}px`, width: size?.width ?? frame?.width, height: size?.height ?? frame?.height, zIndex: drag.zIndexFor(id) }}
              {...drag.bind(id)}><button data-testid={`resize-${id}`} {...resize.bind(id, "corner")} /></div>
          </div>;
        })}
      </div></div>
      </div></div>
    </div>
  </>;
}

describe("desktop spatial recovery", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      const zoom = Number(this.closest<HTMLElement>("[data-desktop-zoom]")?.dataset.desktopZoom) || 1;
      if (this.dataset.spatialCardId) {
        const [x, y] = this.style.translate.split(" ").map(Number.parseFloat);
        const index = CARD_IDS.indexOf(this.dataset.spatialCardId);
        const frame = this.closest<HTMLElement>("[data-layout-card-id]");
        const baseX = frame?.style.left ? Number.parseFloat(frame.style.left) : (index % 3) * 400;
        const baseY = frame?.style.top ? Number.parseFloat(frame.style.top) : Math.floor(index / 3) * 280;
        return new DOMRect(20 + (baseX + (x || 0)) * zoom, 30 + (baseY + (y || 0)) * zoom, (Number.parseFloat(this.style.width) || 320) * zoom, (Number.parseFloat(this.style.height) || 240) * zoom);
      }
      if (this.classList.contains("dim-desktop-canvas")) return new DOMRect(20, 30, 1100, 600);
      if (this.hasAttribute("data-desktop-zoom") || this.classList.contains("dim-grid-wrap") || this.classList.contains("dim-grid")) return new DOMRect(20, 30, 1100 * zoom, 600 * zoom);
      return new DOMRect(0, 0, 1140, 700);
    });
  });
  afterEach(() => {
    for (const key of ["spatial-test-offsets", "spatial-test-sizes", "spatial-test-arranged", "spatial-test-arranged-undo", FRAMES_KEY]) localStorage.removeItem(key);
    vi.restoreAllMocks();
  });

  it("locating a saved card requests the camera and preserves all stored paper coordinates", async () => {
    localStorage.setItem("spatial-test-offsets", JSON.stringify({ one: { x: -1800, y: -900 } }));
    const onChange = vi.fn();
    render(<SpatialDesk onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ cards: [{ id: "one", inView: false }, { id: "two", inView: true }] })));
    const request = vi.fn((event: Event) => event.preventDefault());
    screen.getByTestId("viewport").addEventListener(DESKTOP_FOCUS_BOUNDS_EVENT, request);
    const frames = readFrames();
    fireEvent.click(screen.getByText("locate"));
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual({ one: { x: -1800, y: -900 } });
    expect(readFrames()).toEqual(frames);
    expect(screen.getByTestId("one")).toHaveFocus();
    expect(screen.getByTestId("one")).toHaveClass("is-located");
    expect(Number(screen.getByTestId("one").style.zIndex)).toBeGreaterThan(1);
  });

  it("arrange can restore exact saved positions, dimensions, scroll and layout mode", async () => {
    const offsets = { one: { x: 47, y: 120 }, two: { x: -18, y: 70 } };
    const sizes = { one: { width: 440, height: 390 } };
    localStorage.setItem("spatial-test-offsets", JSON.stringify(offsets));
    localStorage.setItem("spatial-test-sizes", JSON.stringify(sizes));
    const onChange = vi.fn();
    render(<SpatialDesk onChange={onChange} />);
    const originalFrames = readFrames();
    const viewport = screen.getByTestId("viewport");
    act(() => { viewport.scrollTop = 184; viewport.scrollLeft = 12; });
    fireEvent.click(screen.getByText("arrange"));
    expect(localStorage.getItem("spatial-test-offsets")).toBe("{}");
    expect(localStorage.getItem("spatial-test-arranged")).toBe("true");
    expect(viewport.scrollTop).toBe(184);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ canUndoArrangement: true })));
    fireEvent.click(screen.getByText("undo"));
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual(offsets);
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!)).toEqual(sizes);
    expect(readFrames()).toEqual(originalFrames);
    expect(localStorage.getItem("spatial-test-arranged")).toBe("false");
    expect(viewport.scrollTop).toBe(184);
    expect(viewport.scrollLeft).toBe(12);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ canUndoArrangement: false })));
  });

  it("整理所有板块保持各组原位，避开锁定卡，一次撤销恢复全部", () => {
    const frames = {
      one: { x: 80, y: 100, width: 300, height: 210 },
      two: { x: 180, y: 140, width: 300, height: 210 },
      three: { x: 2500, y: 80, width: 300, height: 210 },
      four: { x: 2600, y: 100, width: 300, height: 210 },
    };
    render(<SpatialDesk onChange={vi.fn()} count={4} initialFrames={frames} arrangementGroups={[["three", "four"]]} lockedIds={["one"]} />);
    const before = readFrames();
    fireEvent.click(screen.getByText("arrange"));
    const after = readFrames();
    expect(after.one).toEqual(before.one);
    expect(after.three.x).toBeGreaterThanOrEqual(2500);
    expect(after.four.x).toBeGreaterThanOrEqual(2500);
    expect(after.two.x >= after.one.x + after.one.width + 22 || after.two.y >= after.one.y + after.one.height + 22).toBe(true);
    fireEvent.click(screen.getByText("undo"));
    expect(readFrames()).toEqual(before);
  });

  it("整理后才锁定的卡片也不会被撤销整理移动或改尺寸", () => {
    localStorage.setItem("spatial-test-offsets", JSON.stringify({ one: { x: 90, y: 120 } }));
    const onChange = vi.fn();
    const view = render(<SpatialDesk onChange={onChange} />);
    const before = readFrames();
    fireEvent.click(screen.getByText("arrange"));
    fireEvent.keyDown(screen.getByTestId("resize-one"), { key: "ArrowDown" });
    const lockedFrame = readFrames().one;
    const lockedSizes = JSON.parse(localStorage.getItem("spatial-test-sizes")!).one;
    view.rerender(<SpatialDesk onChange={onChange} lockedIds={["one"]} />);
    fireEvent.click(screen.getByText("undo"));
    expect(readFrames().one).toEqual(lockedFrame);
    expect(readFrames().two).toEqual(before.two);
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!).one).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!).one).toEqual(lockedSizes);
  });

  it("drop constrains the title without rendering the desk on every move", () => {
    const onChange = vi.fn();
    render(<SpatialDesk onChange={onChange} />);
    const card = screen.getByTestId("one");
    fireEvent.pointerDown(card, { button: 0, pointerId: 3, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(card, { pointerId: 3, clientX: -1500, clientY: -1000 });
    fireEvent.pointerUp(card, { pointerId: 3 });
    const rect = card.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(20);
    expect(rect.top).toBeGreaterThanOrEqual(12);
  });

  it("reload retains the last arrangement undo and consumes it only once", async () => {
    const offsets = { one: { x: 90, y: 120 } };
    const sizes = { one: { width: 450, height: 390 } };
    localStorage.setItem("spatial-test-offsets", JSON.stringify(offsets));
    localStorage.setItem("spatial-test-sizes", JSON.stringify(sizes));
    const first = render(<SpatialDesk onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("arrange"));
    expect(localStorage.getItem("spatial-test-arranged-undo")).not.toBeNull();
    first.unmount();
    const onChange = vi.fn();
    render(<SpatialDesk onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ canUndoArrangement: true })));
    fireEvent.click(screen.getByText("undo"));
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual(offsets);
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!)).toEqual(sizes);
    expect(localStorage.getItem("spatial-test-arranged-undo")).toBeNull();
    fireEvent.click(screen.getByText("undo"));
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual(offsets);
  });

  it("profile restore cancels active drag and drops stale arrangement history", async () => {
    const onChange = vi.fn();
    render(<SpatialDesk onChange={onChange} />);
    fireEvent.click(screen.getByText("arrange"));
    const card = screen.getByTestId("one");
    fireEvent.pointerDown(card, { button: 0, pointerId: 7, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(card, { pointerId: 7, clientX: 200, clientY: 190 });
    const restored = { one: { x: 12, y: 24 } };
    localStorage.setItem("spatial-test-offsets", JSON.stringify(restored));
    localStorage.setItem("spatial-test-sizes", JSON.stringify({ one: { width: 300, height: 900 } }));
    localStorage.setItem("spatial-test-arranged", "false");
    act(() => window.dispatchEvent(new Event(BROWSER_UI_PROFILE_RESTORED_EVENT)));
    expect(card).not.toHaveClass("is-dragging");
    expect(card.style.translate).toBe("12px 24px");
    expect(card.style.height).toBe("900px");
    expect(card.closest("[data-arranged]")).toBeNull();
    fireEvent.pointerUp(card, { pointerId: 7 });
    fireEvent.click(screen.getByText("undo"));
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual(restored);
    expect(localStorage.getItem("spatial-test-arranged-undo")).toBeNull();
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ canUndoArrangement: false, cards: [{ id: "one", inView: true }, { id: "two", inView: true }] }));
  });

  it("profile restore cancels an in-flight resize without later overwriting imported dimensions", () => {
    render(<SpatialDesk onChange={vi.fn()} />);
    const handle = screen.getByTestId("resize-one");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 8, clientX: 340, clientY: 270 });
    fireEvent.pointerMove(handle, { pointerId: 8, clientX: 480, clientY: 420 });
    const restored = { one: { width: 310, height: 910 } };
    localStorage.setItem("spatial-test-sizes", JSON.stringify(restored));
    act(() => window.dispatchEvent(new Event(BROWSER_UI_PROFILE_RESTORED_EVENT)));
    expect(screen.getByTestId("one")).not.toHaveClass("is-resizing");
    expect(screen.getByTestId("one").style.height).toBe("910px");
    fireEvent.pointerUp(handle, { pointerId: 8 });
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!)).toEqual(restored);
  });

  it("profile restore cancels a location highlight without starting a paper movement", () => {
    const cancel = vi.fn();
    const previousAnimate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = vi.fn(() => ({ cancel }) as unknown as Animation);
    try {
      localStorage.setItem("spatial-test-offsets", JSON.stringify({ one: { x: -900, y: -900 } }));
      render(<SpatialDesk onChange={vi.fn()} />);
      fireEvent.click(screen.getByText("locate"));
      expect(screen.getByTestId("one")).toHaveClass("is-located");
      act(() => window.dispatchEvent(new Event(BROWSER_UI_PROFILE_RESTORED_EVENT)));
      expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
      expect(screen.getByTestId("one")).not.toHaveClass("is-located");
    } finally {
      HTMLElement.prototype.animate = previousAnimate;
    }
  });

  it.each([0.5, 1.5])("at %s zoom locating reports logical bounds without rewriting offsets", (zoom) => {
    const initialOffset = { x: -1800, y: -900 };
    localStorage.setItem("spatial-test-offsets", JSON.stringify({ one: initialOffset }));
    render(<SpatialDesk zoom={zoom} onChange={vi.fn()} />);
    const request = vi.fn((event: Event) => event.preventDefault());
    screen.getByTestId("viewport").addEventListener(DESKTOP_FOCUS_BOUNDS_EVENT, request);
    fireEvent.click(screen.getByText("locate"));
    const event = request.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ left: -1800, top: -900, width: 320, height: 240 });
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual({ one: initialOffset });
    const card = screen.getByTestId("one");
    fireEvent.pointerDown(card, { button: 0, pointerId: 3, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(card, { pointerId: 3, clientX: -1500, clientY: -1000 });
    fireEvent.pointerUp(card, { pointerId: 3 });
    expect(card.getBoundingClientRect().left).toBeCloseTo(12);
    expect(card.getBoundingClientRect().top).toBeCloseTo(30 + 12 * zoom);
  });

  it("seeds only new papers and preserves later manual frames", () => {
    const first = { one: { x: 2400, y: -600, width: 340, height: 260 } };
    const view = render(<SpatialDesk zoom={1} onChange={vi.fn()} initialFrames={first} />);
    expect(readFrames().one).toEqual(first.one);
    view.rerender(<SpatialDesk zoom={1} onChange={vi.fn()} initialFrames={{ one: { ...first.one, x: 7000 } }} />);
    expect(readFrames().one).toEqual(first.one);
  });

  it("arranges a selected region in place and leaves unrelated cards and viewport untouched", () => {
    const offsets = { one: { x: 2400, y: -600 }, two: { x: 40, y: 60 } };
    localStorage.setItem("spatial-test-offsets", JSON.stringify(offsets));
    render(<SpatialDesk zoom={1} onChange={vi.fn()} />);
    const before = readFrames();
    const viewport = screen.getByTestId("viewport");
    viewport.scrollTop = 360;
    fireEvent.click(screen.getByText("arrange one"));
    expect(readFrames().one).toMatchObject({ x: 2400, y: -600 });
    expect(readFrames().two).toEqual(before.two);
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual({ two: offsets.two });
    expect(viewport.scrollTop).toBe(360);
    fireEvent.click(screen.getByText("undo"));
    expect(readFrames()).toEqual(before);
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual(offsets);
  });

  it("freezes legacy bases separately from saved offsets and restores the same paper position on reload", () => {
    const offsets = { one: { x: 60, y: 40 }, two: { x: -30, y: 16 } };
    const sizes = { one: { width: 410, height: 330 } };
    localStorage.setItem("spatial-test-offsets", JSON.stringify(offsets));
    localStorage.setItem("spatial-test-sizes", JSON.stringify(sizes));
    const first = render(<SpatialDesk onChange={vi.fn()} zoom={0.5} />);
    const frames = readFrames();
    expect(frames.one).toMatchObject({ x: 0, y: 0 });
    expect(frames.two).toMatchObject({ x: 400, y: 0 });
    expect(screen.getByTestId("one").getBoundingClientRect().left).toBe(50);
    expect(screen.getByTestId("one").getBoundingClientRect().top).toBe(50);
    expect(screen.getByTestId("one").style.width).toBe("410px");
    first.unmount();
    render(<SpatialDesk onChange={vi.fn()} zoom={0.5} />);
    expect(readFrames()).toEqual(frames);
    expect(screen.getByTestId("one").getBoundingClientRect().left).toBe(50);
    expect(screen.getByTestId("one").getBoundingClientRect().top).toBe(50);
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual(offsets);
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!)).toEqual(sizes);
  });

  it.each([1, 2])("migration with %s visible legacy papers does not mistake equal manual sizes for an old bulk arrangement", (count) => {
    const ids = CARD_IDS.slice(0, count);
    const sizes = Object.fromEntries(ids.map((id) => [id, { width: 440, height: 390 }]));
    localStorage.setItem("spatial-test-arranged", "true");
    localStorage.setItem("spatial-test-sizes", JSON.stringify(sizes));
    expect(localStorage.getItem(FRAMES_KEY)).toBeNull();
    render(<SpatialDesk onChange={vi.fn()} count={count} />);
    const migratedFrames = readFrames();
    fireEvent.click(screen.getByText("arrange"));
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!)).toEqual(sizes);
    for (const id of ids) {
      expect(screen.getByTestId(id)).toHaveStyle({ width: "440px", height: "390px" });
    }
    fireEvent.click(screen.getByText("undo"));
    expect(readFrames()).toEqual(migratedFrames);
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!)).toEqual(sizes);
    expect(localStorage.getItem("spatial-test-arranged")).toBe("true");
  });

  it.each([0.5, 1.5])("at %s zoom arranging preserves manual sizes and undo restores the complete base at 100%", (zoom) => {
    const offsets = { one: { x: 47, y: 120 } };
    const sizes = { one: { width: 440, height: 390 } };
    localStorage.setItem("spatial-test-offsets", JSON.stringify(offsets));
    localStorage.setItem("spatial-test-sizes", JSON.stringify(sizes));
    const kinds = { one: "feed", two: "activity", three: "anchors", four: "progress", five: "chart", six: "note" };
    const { rerender } = render(<SpatialDesk zoom={zoom} onChange={vi.fn()} count={6} kinds={kinds} />);
    const originalFrames = readFrames();
    fireEvent.click(screen.getByText("arrange"));
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!)).toEqual(sizes);
    expect(screen.getByTestId("one")).toHaveStyle({ width: "440px", height: "390px" });
    const arrangedFrames = readFrames();
    expect(arrangedFrames.one.height).toBeGreaterThan(arrangedFrames.six.height);
    expect(arrangedFrames.five.width).toBeGreaterThan(arrangedFrames.six.width);
    rerender(<SpatialDesk zoom={1} onChange={vi.fn()} count={6} kinds={kinds} />);
    expect(readFrames()).toEqual(arrangedFrames);
    fireEvent.click(screen.getByText("undo"));
    expect(JSON.parse(localStorage.getItem("spatial-test-offsets")!)).toEqual(offsets);
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!)).toEqual(sizes);
    expect(readFrames()).toEqual(originalFrames);
    expect(screen.getByTestId("one").style.translate).toBe("47px 120px");
    expect(screen.getByTestId("one").style.width).toBe("440px");
  });

  it("default papers have content-specific proportions that stay fixed through zoom, viewport resize and scroll", async () => {
    const onChange = vi.fn();
    const kinds = { one: "feed", two: "activity", three: "anchors", four: "progress", five: "chart", six: "note" };
    const { rerender } = render(<SpatialDesk zoom={1} onChange={onChange} initiallyCompact count={6} kinds={kinds} />);
    const frames = readFrames();
    expect(new Set(Object.values(frames).map(({ width, height }) => `${width}:${height}`)).size).toBeGreaterThanOrEqual(5);
    expect(frames.one.height).toBeGreaterThan(frames.six.height * 1.5);
    expect(frames.five.width).toBeGreaterThan(frames.five.height);
    const logicalDimensions = CARD_IDS.map((id) => ({ width: screen.getByTestId(id).style.width, height: screen.getByTestId(id).style.height }));
    const viewport = screen.getByTestId("viewport");
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1140, 500));
    fireEvent(window, new Event("resize"));
    for (const zoom of [0.5, 1.5]) {
      rerender(<SpatialDesk zoom={zoom} onChange={onChange} initiallyCompact count={6} kinds={kinds} />);
      fireEvent.scroll(viewport, { target: { scrollTop: 120 } });
      expect(readFrames()).toEqual(frames);
      expect(CARD_IDS.map((id) => ({ width: screen.getByTestId(id).style.width, height: screen.getByTestId(id).style.height }))).toEqual(logicalDimensions);
      expect(localStorage.getItem("spatial-test-sizes")).toBeNull();
    }
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it("resizing one arranged paper leaves every other base and screen position unchanged, including Home reset", () => {
    render(<SpatialDesk onChange={vi.fn()} initiallyCompact count={6}
      kinds={{ one: "feed", two: "activity", three: "anchors", four: "progress", five: "chart", six: "note" }} />);
    const frames = readFrames();
    const unaffected = CARD_IDS.slice(1).map((id) => ({ id, rect: screen.getByTestId(id).getBoundingClientRect() }));
    const card = screen.getByTestId("one");
    const handle = screen.getByTestId("resize-one");
    const initial = card.getBoundingClientRect();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 9, clientX: initial.right, clientY: initial.bottom });
    fireEvent.pointerMove(handle, { pointerId: 9, clientX: initial.right + 120, clientY: initial.bottom + 170 });
    fireEvent.pointerUp(handle, { pointerId: 9 });
    expect(card.getBoundingClientRect().width).toBe(initial.width + 120);
    expect(card.getBoundingClientRect().height).toBe(initial.height + 170);
    expect(readFrames()).toEqual(frames);
    for (const { id, rect } of unaffected) {
      const after = screen.getByTestId(id).getBoundingClientRect();
      expect({ left: after.left, top: after.top, width: after.width, height: after.height }).toEqual({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
    fireEvent.keyDown(handle, { key: "Home" });
    expect(readFrames()).toEqual(frames);
    expect(card).toHaveStyle({ width: `${frames.one.width}px`, height: `${frames.one.height}px` });
    expect(JSON.parse(localStorage.getItem("spatial-test-sizes")!)).toEqual({});
    for (const { id, rect } of unaffected) {
      const after = screen.getByTestId(id).getBoundingClientRect();
      expect(after.left).toBe(rect.left);
      expect(after.top).toBe(rect.top);
    }
  });
});
