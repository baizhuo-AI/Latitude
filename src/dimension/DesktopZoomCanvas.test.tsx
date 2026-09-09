import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopZoomCanvas, type DesktopZoomHandle } from "./DesktopZoomCanvas";
import { DimensionApp } from "./DimensionApp";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../projections/desktop/browserUiComposition";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

interface TestPaper { id: string; left: number; top: number; width: number; height: number; resizing?: boolean }

/** Model native scroll limits as well as transformed rectangles: jsdom itself
 * has no layout and would accept an impossible compensating scroll at 50%. */
function cameraGeometryHarness(initial: TestPaper[], zoom = 1, surfaceHeight = 200) {
  window.localStorage.setItem("dim-desk-zoom-geometry", String(zoom));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(976);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(surfaceHeight);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const viewport = this.closest<HTMLElement>(".dim-desk-scroll");
    const scrollLeft = viewport?.scrollLeft ?? 0;
    const scrollTop = viewport?.scrollTop ?? 0;
    if (this.classList.contains("dim-desk-scroll")) return new DOMRect(0, 0, 1000, 700);
    if (this.classList.contains("dim-desktop-canvas")) return new DOMRect(-scrollLeft, 80 - scrollTop, 1000, surfaceHeight);
    const surface = this.closest<HTMLElement>("[data-desktop-zoom]");
    if (surface) {
      const scale = Number(surface.dataset.desktopZoom);
      const originLeft = Number.parseFloat(surface.style.left) - scrollLeft;
      const originTop = 80 + Number.parseFloat(surface.style.top) - scrollTop;
      if (this.hasAttribute("data-spatial-card-id")) return new DOMRect(
        originLeft + Number.parseFloat(this.style.left) * scale,
        originTop + Number.parseFloat(this.style.top) * scale,
        Number.parseFloat(this.style.width) * scale,
        Number.parseFloat(this.style.height) * scale,
      );
      return new DOMRect(originLeft, originTop, 976 * scale, surfaceHeight * scale);
    }
    return new DOMRect(0, 0, 1000, surfaceHeight);
  });
  const camera = createRef<DesktopZoomHandle>();
  const changed = vi.fn();
  const renderCanvas = (papers: TestPaper[]) => <div className="dim-desk-scroll">
    <DesktopZoomCanvas ref={camera} layoutId="geometry" onScaleChange={vi.fn()} onCameraChange={changed}>
      {papers.map(({ id, resizing, ...box }) => <div key={id} data-spatial-card-id={id}
        className={resizing ? "is-resizing" : undefined} style={box} />)}
    </DesktopZoomCanvas>
  </div>;
  const view = render(renderCanvas(initial));
  const viewport = view.container.firstElementChild as HTMLElement;
  const space = view.container.querySelector<HTMLElement>(".dim-desktop-zoom-space")!;
  let scrollLeft = viewport.scrollLeft;
  let scrollTop = viewport.scrollTop;
  const clampLeft = (value: number) => Math.min(Math.max(0, value), Math.max(0, Number.parseFloat(space.style.width) - 1000));
  const clampTop = (value: number) => Math.min(Math.max(0, value), Math.max(0, 80 + Number.parseFloat(space.style.height) - 700));
  Object.defineProperties(viewport, {
    scrollLeft: { configurable: true, get: () => (scrollLeft = clampLeft(scrollLeft)), set: (value: number) => { scrollLeft = clampLeft(value); } },
    scrollTop: { configurable: true, get: () => (scrollTop = clampTop(scrollTop)), set: (value: number) => { scrollTop = clampTop(value); } },
  });
  return {
    ...view, camera, viewport, space, changed,
    surface: view.container.querySelector<HTMLElement>("[data-desktop-zoom]")!,
    update: (papers: TestPaper[]) => view.rerender(renderCanvas(papers)),
    rect: (id: string) => view.container.querySelector<HTMLElement>(`[data-spatial-card-id="${id}"]`)!.getBoundingClientRect(),
  };
}

describe("桌面整体缩放", () => {
  it("缩小边缘卡片不会收缩画布并夹断滚动位置，其他卡片保持原屏幕坐标", () => {
    const fixed = { id: "fixed", left: 100, top: 100, width: 300, height: 200 };
    const edited = { id: "edited", left: 900, top: 900, width: 500, height: 500 };
    const desk = cameraGeometryHarness([fixed, edited]);
    desk.viewport.scrollLeft = 350;
    desk.viewport.scrollTop = 750;
    const before = desk.rect("fixed");
    const width = desk.space.style.width;
    const height = desk.space.style.height;
    desk.update([fixed, { ...edited, width: 200, height: 200, resizing: true }]);
    desk.update([fixed, { ...edited, width: 200, height: 200 }]);
    expect(desk.space.style.width).toBe(width);
    expect(desk.space.style.height).toBe(height);
    expect(desk.viewport.scrollLeft).toBe(350);
    expect(desk.viewport.scrollTop).toBe(750);
    expect(desk.rect("fixed").left).toBe(before.left);
    expect(desk.rect("fixed").top).toBe(before.top);
  });

  it("50%时向负坐标扩边会补偿滚动；卡片拖回来也不会拉动其余卡片", () => {
    const fixed = { id: "fixed", left: 300, top: 50, width: 200, height: 100 };
    const moved = { id: "moved", left: 20, top: 20, width: 150, height: 150 };
    const desk = cameraGeometryHarness([fixed, moved], 0.5);
    const before = desk.rect("fixed");
    desk.update([fixed, { ...moved, left: -180, top: -120 }]);
    expect(desk.viewport.scrollLeft).toBe(90);
    expect(desk.viewport.scrollTop).toBe(60);
    expect(desk.rect("fixed").left).toBe(before.left);
    expect(desk.rect("fixed").top).toBe(before.top);
    desk.update([fixed, moved]);
    expect(desk.viewport.scrollLeft).toBe(90);
    expect(desk.viewport.scrollTop).toBe(60);
    expect(desk.rect("fixed").left).toBe(before.left);
    expect(desk.rect("fixed").top).toBe(before.top);
  });

  it("缩放提交前发生扩边不会抢先消费锚点，缩放仍围绕原视口中心", async () => {
    const fixed = { id: "fixed", left: 1600, top: 1200, width: 300, height: 200 };
    const moved = { id: "moved", left: 20, top: 20, width: 150, height: 150 };
    const desk = cameraGeometryHarness([fixed, moved]);
    desk.viewport.scrollLeft = 200;
    desk.viewport.scrollTop = 300;
    const before = desk.surface.getBoundingClientRect();
    const anchorX = 500 - before.left;
    const anchorY = 350 - before.top;
    act(() => {
      desk.camera.current?.zoomIn();
      desk.update([fixed, { ...moved, left: -100, top: -80 }]);
    });
    expect(desk.viewport.scrollLeft).toBe(300);
    expect(desk.viewport.scrollTop).toBe(380);
    await waitFor(() => expect(desk.surface).toHaveAttribute("data-desktop-zoom", "1.1"));
    const after = desk.surface.getBoundingClientRect();
    expect(after.left + anchorX * 1.1).toBeCloseTo(500);
    expect(after.top + anchorY * 1.1).toBeCloseTo(350);
  });

  it("捏合由纸面接管，不冒泡换层；保存比例并在恢复profile时重读", async () => {
    const switchLayer = vi.fn();
    const view = render(<div onWheel={switchLayer}><DimensionApp /></div>);
    const viewport = view.container.querySelector(".dim-desk-scroll")!;
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: 36, clientX: 300, clientY: 300 });
    await waitFor(() => expect(screen.getByRole("button", { name: "恢复桌面缩放为 100%" })).toHaveTextContent("75%"));
    expect(switchLayer).not.toHaveBeenCalled();
    fireEvent.wheel(viewport, { deltaY: 4 });
    expect(switchLayer).not.toHaveBeenCalled();
    fireEvent(window, new Event("pagehide"));
    const key = `dim-desk-zoom-${view.container.querySelector("[data-layout-document]")!.getAttribute("data-layout-document")}`;
    expect(Number(window.localStorage.getItem(key))).toBeCloseTo(Math.exp(-36 * 0.008));
    view.unmount();
    const restored = render(<DimensionApp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "恢复桌面缩放为 100%" })).toHaveTextContent("75%"));
    act(() => {
      window.localStorage.setItem(key, "0.5");
      window.dispatchEvent(new Event(BROWSER_UI_PROFILE_RESTORED_EVENT));
    });
    expect(screen.getByRole("button", { name: "恢复桌面缩放为 100%" })).toHaveTextContent("50%");
    expect(restored.container.querySelector("[data-desktop-zoom]")).toHaveAttribute("data-desktop-zoom", "0.5");
  });

  it("适合窗口保留卡片布局；相同比例再次点击也会找回滚走的桌面", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(976);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const zoom = this.closest<HTMLElement>("[data-desktop-zoom]");
      const scale = Number(zoom?.dataset.desktopZoom) || 1;
      const viewport = this.closest<HTMLElement>(".dim-desk-scroll");
      const scroll = viewport?.scrollTop ?? 0;
      if (this.classList.contains("dim-desk-scroll")) return new DOMRect(0, 0, 1000, 700);
      if (this.classList.contains("dim-desktop-canvas")) return new DOMRect(0, 80 - scroll, 1000, 1000);
      if (zoom) return new DOMRect(12 * scale, 80 - scroll + 12 * scale, (this.hasAttribute("data-spatial-card-id") ? 800 : 976) * scale, 1000 * scale);
      return new DOMRect(0, 0, 1000, 1000);
    });
    const camera = createRef<DesktopZoomHandle>();
    const changed = vi.fn();
    const view = render(<div className="dim-desk-scroll"><DesktopZoomCanvas ref={camera} layoutId="fit-test" onScaleChange={changed}>
      <div data-spatial-card-id="original" style={{ width: 800, height: 1000, translate: "0px 0px" }} />
    </DesktopZoomCanvas></div>);
    const viewport = view.container.firstElementChild as HTMLElement;
    act(() => camera.current?.fitWindow());
    await waitFor(() => expect(view.container.querySelector("[data-desktop-zoom]")).toHaveAttribute("data-desktop-zoom", "0.59"));
    expect(view.container.querySelector("[data-spatial-card-id]")).toHaveStyle({ width: "800px", height: "1000px", translate: "0px 0px" });
    viewport.scrollTop = 150;
    act(() => camera.current?.fitWindow());
    await waitFor(() => expect(viewport.scrollTop).toBe(0));
    expect(view.container.querySelector("[data-desktop-zoom]")).toHaveAttribute("data-desktop-zoom", "0.59");
  });

  it("按钮缩放遵守上下限，恢复100%不改变卡片内容", async () => {
    window.localStorage.setItem("dim-desk-zoom-bounds", "2");
    const camera = createRef<DesktopZoomHandle>();
    const view = render(<div className="dim-desk-scroll"><DesktopZoomCanvas ref={camera} layoutId="bounds" onScaleChange={vi.fn()}>
      <p>保留的卡片内容</p>
    </DesktopZoomCanvas></div>);
    act(() => camera.current?.zoomIn());
    await waitFor(() => expect(view.container.querySelector("[data-desktop-zoom]")).toHaveAttribute("data-desktop-zoom", "2"));
    act(() => camera.current?.resetZoom());
    await waitFor(() => expect(view.container.querySelector("[data-desktop-zoom]")).toHaveAttribute("data-desktop-zoom", "1"));
    expect(screen.getByText("保留的卡片内容")).toBeInTheDocument();
  });
});


describe("single desktop camera", () => {
  it.each([0.5, 1])("at %s zoom focuses a far negative area before paint without moving papers", (zoom) => {
    const paper = { id: "far", left: -3400, top: -1800, width: 300, height: 200 };
    const desk = cameraGeometryHarness([paper], zoom);
    const element = desk.container.querySelector<HTMLElement>("[data-spatial-card-id]")!;
    const style = element.getAttribute("style");
    act(() => desk.camera.current?.focusBounds(paper, { instant: true }));
    const rect = desk.rect("far");
    expect(rect.left + rect.width / 2).toBeCloseTo(500);
    expect(rect.top + rect.height / 2).toBeCloseTo(350);
    expect(element.getAttribute("style")).toBe(style);
    expect(desk.changed).toHaveBeenLastCalledWith({ x: -3250, y: -1700, zoom }, "focus");
  });

  it("keeps a home and one explicit previous position, including after profile restore", async () => {
    const desk = cameraGeometryHarness([{ id: "one", left: 0, top: 0, width: 300, height: 200 }]);
    const home = desk.changed.mock.calls.slice(-1)[0]![0];
    const far = { left: 5000, top: 3500, width: 300, height: 200 };
    act(() => desk.camera.current?.focusBounds(far, { instant: true }));
    expect(desk.changed).toHaveBeenLastCalledWith({ x: 5150, y: 3600, zoom: 1 }, "focus");
    act(() => desk.camera.current?.goHome());
    expect(desk.changed).toHaveBeenLastCalledWith(home, "home");
    act(() => desk.camera.current?.goBack());
    expect(desk.changed).toHaveBeenLastCalledWith({ x: 5150, y: 3600, zoom: 1 }, "back");
    act(() => desk.camera.current?.setHome());
    fireEvent(window, new Event("pagehide"));
    const snapshot = JSON.parse(localStorage.getItem("dim-desk-camera-geometry")!);
    expect(snapshot.camera).toEqual(snapshot.home);
    const imported = { version: 1, camera: { x: -1400, y: 2300, zoom: 0.75 }, home: { x: 100, y: 200, zoom: 1 } };
    act(() => {
      localStorage.setItem("dim-desk-camera-geometry", JSON.stringify(imported));
      window.dispatchEvent(new Event(BROWSER_UI_PROFILE_RESTORED_EVENT));
    });
    expect(desk.surface).toHaveAttribute("data-desktop-zoom", "0.75");
    expect(desk.changed).toHaveBeenLastCalledWith(imported.camera, "restore");
    expect(desk.surface.getBoundingClientRect().left + imported.camera.x * 0.75).toBeCloseTo(500);
    expect(desk.surface.getBoundingClientRect().top + imported.camera.y * 0.75).toBeCloseTo(350);
  });

  it("blank dragging expands the camera toward negative coordinates without changing a paper", () => {
    const desk = cameraGeometryHarness([{ id: "one", left: 0, top: 0, width: 300, height: 200 }]);
    const root = desk.container.querySelector(".dim-desktop-canvas")!;
    const first = desk.changed.mock.calls.slice(-1)[0]![0];
    fireEvent.pointerDown(root, { button: 0, pointerId: 4, clientX: 700, clientY: 500 });
    fireEvent.pointerMove(desk.viewport, { pointerId: 4, clientX: 1400, clientY: 1000 });
    fireEvent.pointerUp(desk.viewport, { pointerId: 4 });
    expect(desk.changed).toHaveBeenLastCalledWith({ x: first.x - 700, y: first.y - 500, zoom: 1 }, "pan");
    expect(desk.container.querySelector("[data-spatial-card-id]")).toHaveStyle({ left: "0px", top: "0px" });
    expect(desk.viewport).not.toHaveClass("is-panning");
  });

  it("wheel interrupts a near location glide and nested paper scrolling keeps priority", async () => {
    const desk = cameraGeometryHarness([{ id: "one", left: 0, top: 0, width: 300, height: 200 }]);
    const first = desk.changed.mock.calls.slice(-1)[0]![0];
    act(() => desk.camera.current?.focusBounds({ left: first.x + 100, top: first.y, width: 40, height: 40 }));
    fireEvent.wheel(desk.viewport, { deltaX: 60, deltaY: 100 });
    const afterPan = desk.changed.mock.calls.slice(-1)[0]![0];
    await new Promise((resolve) => setTimeout(resolve, 330));
    fireEvent(window, new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem("dim-desk-camera-geometry")!).camera).toEqual(afterPan);
    const body = document.createElement("div");
    body.style.overflowY = "auto";
    Object.defineProperties(body, { scrollHeight: { value: 900 }, clientHeight: { value: 100 } });
    desk.container.querySelector("[data-spatial-card-id]")!.append(body);
    const wheel = new WheelEvent("wheel", { deltaY: 80, bubbles: true, cancelable: true });
    act(() => { body.dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(false);
    expect(desk.changed.mock.calls.slice(-1)[0]![0]).toEqual(afterPan);
  });
});
