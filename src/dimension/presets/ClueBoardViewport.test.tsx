import { createRef, useLayoutEffect, useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { ClueBoardViewport } from "./ClueBoardViewport";

beforeEach(() => localStorage.clear());

type Bounds = { left: number; top: number; width: number; height: number };
type ViewportGeometry = Bounds & { scaleX: number; scaleY: number };
function domRect({ left, top, width, height }: Bounds): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) };
}

/** Simulate CSS layout including ancestor scale and the current world translation. */
function mockGeometry(viewport: HTMLElement, world: HTMLElement, geometry: ViewportGeometry,
  papers: Array<{ element: HTMLElement; bounds: () => Bounds }>) {
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => geometry.width },
    clientHeight: { configurable: true, get: () => geometry.height },
  });
  viewport.getBoundingClientRect = () => domRect({ ...geometry,
    width: geometry.width * geometry.scaleX, height: geometry.height * geometry.scaleY });
  for (const { element, bounds } of papers) {
    element.getBoundingClientRect = () => {
      const pan = world.style.transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\)/);
      const box = bounds();
      return domRect({ left: geometry.left + (box.left + Number(pan?.[1] ?? 0) - viewport.scrollLeft) * geometry.scaleX,
        top: geometry.top + (box.top + Number(pan?.[2] ?? 0) - viewport.scrollTop) * geometry.scaleY,
        width: box.width * geometry.scaleX, height: box.height * geometry.scaleY });
    };
  }
}

it("pans papers and lines together, persists the camera and resets without changing papers", () => {
  const ref = createRef<HTMLDivElement>();
  const content = <><article className="clue-paper" style={{ left: "150%" }}>纸片</article><svg className="clue-threads" /></>;
  const first = render(<ClueBoardViewport viewportRef={ref}>{content}</ClueBoardViewport>);
  fireEvent.pointerDown(ref.current!, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(ref.current!, { pointerId: 1, clientX: -490, clientY: 210 });
  fireEvent.pointerUp(ref.current!, { pointerId: 1 });
  expect(first.container.querySelector(".clue-world")).toHaveStyle({ transform: "translate(-500px, 200px)" });
  expect(first.container.querySelector(".clue-paper")).toHaveStyle({ left: "150%" });
  first.unmount();
  const next = render(<ClueBoardViewport viewportRef={ref}>{content}</ClueBoardViewport>);
  expect(next.container.querySelector(".clue-world")).toHaveStyle({ transform: "translate(-500px, 200px)" });
  mockGeometry(ref.current!, next.container.querySelector<HTMLElement>(".clue-world")!,
    { left: 120, top: 80, width: 1000, height: 680, scaleX: 1, scaleY: 1 },
    [{ element: next.container.querySelector<HTMLElement>(".clue-paper")!, bounds: () => ({ left: 1500, top: 120, width: 200, height: 100 }) }]);
  fireEvent.click(screen.getByRole("button", { name: "回到中心" }));
  expect(next.container.querySelector(".clue-world")).toHaveStyle({ transform: "translate(-1100px, 170px)" });
  expect(next.container.querySelector(".clue-paper")).toHaveStyle({ left: "150%" });
  expect(JSON.parse(localStorage.getItem("dim-clue-camera-v1")!)).toEqual({ x: -1100, y: 170 });
});

it("does not pan when dragging a card or using a fixed editor", () => {
  const ref = createRef<HTMLDivElement>();
  const { container } = render(<ClueBoardViewport viewportRef={ref} overlay={<aside>编辑器</aside>}><article className="clue-paper">纸片</article></ClueBoardViewport>);
  fireEvent.pointerDown(screen.getByText("纸片"), { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(ref.current!, { pointerId: 2, clientX: 500, clientY: 400 });
  fireEvent.wheel(screen.getByText("编辑器"), { deltaY: 300 });
  expect(container.querySelector(".clue-world")).toHaveStyle({ transform: "translate(0px, 0px)" });
  fireEvent.wheel(ref.current!, { deltaX: 40, deltaY: 80 });
  expect(container.querySelector(".clue-world")).toHaveStyle({ transform: "translate(-40px, -80px)" });
});


it("centers the full current paper bounds after papers move or resize, preserving their saved geometry", () => {
  localStorage.setItem("dim-clue-camera-v1", JSON.stringify({ x: -450, y: 220 }));
  const positions = JSON.stringify({ a: { x: -75, y: -50 }, b: { x: 125, y: 66 } });
  const sizes = JSON.stringify({ b: { width: 360, height: 240 } });
  localStorage.setItem("dim-clue-positions-v1", positions);
  localStorage.setItem("dim-clue-sizes-v1", sizes);
  const ref = createRef<HTMLDivElement>();
  const { container } = render(<ClueBoardViewport viewportRef={ref} overlay={<aside>固定编辑器</aside>}>
    <article className="clue-paper" data-testid="a" style={{ left: "-600px", top: "-300px", width: "200px", height: "180px" }}>纸签一</article>
    <article className="clue-paper" data-testid="b" style={{ left: "1000px", top: "400px", width: "360px", height: "240px" }}>纸签二</article>
    <button className="clue-thesis" style={{ left: "350px", top: "-80px", width: "300px", height: "100px" }}>当前方向</button>
    <svg className="clue-threads" />
    <p className="clue-margin-note">装饰文字</p>
  </ClueBoardViewport>);
  const world = container.querySelector<HTMLElement>(".clue-world")!;
  const papers = Array.from(container.querySelectorAll<HTMLElement>(".clue-paper, .clue-thesis"));
  mockGeometry(ref.current!, world, { left: 180, top: 96, width: 800, height: 600, scaleX: 1, scaleY: 1 }, papers.map(element => ({
    element, bounds: () => ({ left: parseFloat(element.style.left), top: parseFloat(element.style.top),
      width: parseFloat(element.style.width), height: parseFloat(element.style.height) }),
  })));
  // A fixed editor and SVG span are not paper content, even when their bounds are huge.
  screen.getByText("固定编辑器").getBoundingClientRect = () => domRect({ left: -5000, top: -5000, width: 10000, height: 10000 });
  container.querySelector<SVGElement>("svg")!.getBoundingClientRect = () => domRect({ left: -5000, top: -5000, width: 10000, height: 10000 });
  fireEvent.click(screen.getByRole("button", { name: "回到中心" }));
  expect(world).toHaveStyle({ transform: "translate(20px, 130px)" });
  const moved = screen.getByTestId("b");
  Object.assign(moved.style, { left: "1800px", top: "1000px", width: "480px", height: "400px" });
  fireEvent.click(screen.getByRole("button", { name: "回到中心" }));
  expect(world).toHaveStyle({ transform: "translate(-440px, -250px)" });
  expect(moved).toHaveStyle({ left: "1800px", top: "1000px", width: "480px", height: "400px" });
  expect(localStorage.getItem("dim-clue-positions-v1")).toBe(positions);
  expect(localStorage.getItem("dim-clue-sizes-v1")).toBe(sizes);
  expect(JSON.parse(localStorage.getItem("dim-clue-camera-v1")!)).toEqual({ x: -440, y: -250 });
});

it("uses the current viewport center under scaling and resizing, and repeated centering does not drift", () => {
  const ref = createRef<HTMLDivElement>();
  const { container } = render(<ClueBoardViewport viewportRef={ref}>
    <article className="clue-paper">远处的纸签</article>
    <button className="clue-thesis">当前方向</button>
  </ClueBoardViewport>);
  const world = container.querySelector<HTMLElement>(".clue-world")!;
  const geometry = { left: 95, top: 82, width: 1200, height: 800, scaleX: 0.65, scaleY: 0.8 };
  mockGeometry(ref.current!, world, geometry, [
    { element: screen.getByText("远处的纸签"), bounds: () => ({ left: 1500, top: 200, width: 200, height: 100 }) },
    { element: screen.getByText("当前方向"), bounds: () => ({ left: 1800, top: 500, width: 400, height: 300 }) },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "回到中心" }));
  expect(world).toHaveStyle({ transform: "translate(-1250px, -100px)" });
  geometry.width = 900;
  geometry.height = 600;
  fireEvent.click(screen.getByRole("button", { name: "回到中心" }));
  expect(world).toHaveStyle({ transform: "translate(-1400px, -200px)" });
  fireEvent.click(screen.getByRole("button", { name: "回到中心" }));
  expect(world).toHaveStyle({ transform: "translate(-1400px, -200px)" });
});

it("keeps the saved camera when the viewport is hidden and clears an empty visible board safely", () => {
  localStorage.setItem("dim-clue-camera-v1", JSON.stringify({ x: 240, y: -130 }));
  const ref = createRef<HTMLDivElement>();
  const { container } = render(<ClueBoardViewport viewportRef={ref}>{null}</ClueBoardViewport>);
  const world = container.querySelector<HTMLElement>(".clue-world")!;
  fireEvent.click(screen.getByRole("button", { name: "回到中心" }));
  expect(world).toHaveStyle({ transform: "translate(240px, -130px)" });
  mockGeometry(ref.current!, world, { left: 40, top: 40, width: 900, height: 600, scaleX: 1, scaleY: 1 }, []);
  fireEvent.click(screen.getByRole("button", { name: "回到中心" }));
  expect(world).toHaveStyle({ transform: "translate(0px, 0px)" });
});


it("clears restored native scroll on first paint without changing the saved camera", () => {
  localStorage.setItem("dim-clue-camera-v1", JSON.stringify({ x: 80, y: 244 }));
  function RestoredBoard() {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      ref.current!.scrollLeft = 70;
      ref.current!.scrollTop = 245;
    }, []);
    return <ClueBoardViewport viewportRef={ref}><article className="clue-paper">纸签</article></ClueBoardViewport>;
  }
  const { container } = render(<RestoredBoard />);
  const viewport = container.querySelector<HTMLElement>(".clue-surface")!;
  expect(viewport.scrollLeft).toBe(0);
  expect(viewport.scrollTop).toBe(0);
  expect(container.querySelector(".clue-world")).toHaveStyle({ transform: "translate(80px, 244px)" });
  expect(JSON.parse(localStorage.getItem("dim-clue-camera-v1")!)).toEqual({ x: 80, y: 244 });
});

it("removes native scroll before measuring paper bounds so recentering does not count it as pan", () => {
  localStorage.setItem("dim-clue-camera-v1", JSON.stringify({ x: 80, y: 244 }));
  const ref = createRef<HTMLDivElement>();
  const { container } = render(<ClueBoardViewport viewportRef={ref}>
    <article className="clue-paper" style={{ left: "250px", top: "0px" }}>纸签</article>
  </ClueBoardViewport>);
  const viewport = ref.current!;
  const world = container.querySelector<HTMLElement>(".clue-world")!;
  const paper = screen.getByText("纸签");
  mockGeometry(viewport, world, { left: 120, top: 80, width: 1000, height: 680, scaleX: 1, scaleY: 1 }, [{
    element: paper,
    bounds: () => {
      expect(viewport.scrollLeft).toBe(0);
      expect(viewport.scrollTop).toBe(0);
      return { left: 250, top: 0, width: 300, height: 100 };
    },
  }]);
  viewport.scrollLeft = 70;
  viewport.scrollTop = 245;
  fireEvent.click(screen.getByRole("button", { name: "回到中心" }));
  expect(world).toHaveStyle({ transform: "translate(100px, 290px)" });
  expect(viewport.scrollTop).toBe(0);
  expect(viewport.scrollLeft).toBe(0);
  expect(paper).toHaveStyle({ left: "250px", top: "0px" });
  // Subsequent hand panning still uses the camera, while native scrolling stays zero.
  fireEvent.wheel(viewport, { deltaX: 20, deltaY: 30 });
  expect(world).toHaveStyle({ transform: "translate(80px, 260px)" });
  expect(viewport.scrollTop).toBe(0);
  expect(JSON.parse(localStorage.getItem("dim-clue-camera-v1")!)).toEqual({ x: 80, y: 260 });
});
