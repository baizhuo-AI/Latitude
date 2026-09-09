import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const CAMERA_KEY = "dim-clue-camera-v1";
function readCamera() {
  try {
    const value = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? "null");
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return { x: value.x, y: value.y };
  } catch { /* 保存不可用时从中心开始。 */ }
  return { x: 0, y: 0 };
}

/** 木框内的视口：只平移纸和连线，固定工具不进入世界坐标。 */
export function ClueBoardViewport({ viewportRef, children, overlay }: {
  viewportRef: RefObject<HTMLDivElement>;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  const world = useRef<HTMLDivElement>(null);
  const camera = useRef(readCamera());
  const reset = useRef<() => void>(() => {});
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let drag: { id: number; x: number; y: number; start: { x: number; y: number } } | null = null;
    const isControl = (target: EventTarget | null) => target instanceof Element &&
      Boolean(target.closest("button, input, textarea, select, aside, .clue-paper, .clue-thesis, [role='button']"));
    // The camera owns movement. Browser focus restoration must not introduce a
    // second scroll offset that also shifts the fixed tools inside this viewport.
    const clearNativeScroll = () => {
      if (viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
      if (viewport.scrollTop !== 0) viewport.scrollTop = 0;
    };
    const paint = () => {
      clearNativeScroll();
      if (world.current) world.current.style.transform = `translate(${camera.current.x}px, ${camera.current.y}px)`;
      viewport.style.backgroundPosition = `center, ${camera.current.x}px ${camera.current.y}px, ${camera.current.x}px ${camera.current.y}px, ${camera.current.x}px ${camera.current.y}px, center`;
    };
    const save = () => { try { localStorage.setItem(CAMERA_KEY, JSON.stringify(camera.current)); } catch { /* 会话内仍可平移。 */ } };
    reset.current = () => {
      // Clear legacy scroll before measuring so it cannot be added to camera pan.
      clearNativeScroll();
      const viewportBounds = viewport.getBoundingClientRect();
      // A hidden deck layer has no measurable viewport; keep its saved camera.
      if (viewportBounds.width <= 0 || viewportBounds.height <= 0) return;
      const papers = Array.from(world.current?.querySelectorAll<HTMLElement>(".clue-paper, .clue-thesis") ?? [])
        .map(paper => paper.getBoundingClientRect())
        .filter(bounds => bounds.width > 0 && bounds.height > 0);
      if (papers.length === 0) {
        camera.current = { x: 0, y: 0 };
      } else {
        const centerX = (Math.min(...papers.map(bounds => bounds.left)) + Math.max(...papers.map(bounds => bounds.right))) / 2;
        const centerY = (Math.min(...papers.map(bounds => bounds.top)) + Math.max(...papers.map(bounds => bounds.bottom))) / 2;
        // Screen bounds already include the current pan, paper rotation and size.
        // Convert only the remaining displacement back to the board's CSS pixels.
        const scaleX = viewportBounds.width / (viewport.clientWidth || viewportBounds.width);
        const scaleY = viewportBounds.height / (viewport.clientHeight || viewportBounds.height);
        camera.current = {
          x: camera.current.x + (viewportBounds.left + viewportBounds.width / 2 - centerX) / scaleX,
          y: camera.current.y + (viewportBounds.top + viewportBounds.height / 2 - centerY) / scaleY,
        };
      }
      if (drag) {
        if (viewport.hasPointerCapture?.(drag.id)) viewport.releasePointerCapture(drag.id);
        drag = null;
        viewport.classList.remove("is-panning");
      }
      paint();
      save();
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || isControl(event.target)) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: { ...camera.current } };
      viewport.setPointerCapture?.(event.pointerId);
      viewport.classList.add("is-panning");
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const scale = viewport.getBoundingClientRect().width / viewport.clientWidth || 1;
      camera.current = { x: drag.start.x + (event.clientX - drag.x) / scale, y: drag.start.y + (event.clientY - drag.y) / scale };
      paint();
    };
    const finish = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (event.type === "pointercancel") { camera.current = drag.start; paint(); }
      drag = null;
      viewport.classList.remove("is-panning");
      if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      save();
    };
    const wheel = (event: WheelEvent) => {
      if (isControl(event.target) || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      camera.current = { x: camera.current.x - event.deltaX * unit, y: camera.current.y - event.deltaY * unit };
      paint(); save();
    };
    paint();
    viewport.addEventListener("pointerdown", down);
    viewport.addEventListener("pointermove", move);
    viewport.addEventListener("pointerup", finish);
    viewport.addEventListener("pointercancel", finish);
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => {
      viewport.removeEventListener("pointerdown", down);
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("pointerup", finish);
      viewport.removeEventListener("pointercancel", finish);
      viewport.removeEventListener("wheel", wheel);
    };
  }, [viewportRef]);
  return <div className="clue-surface" ref={viewportRef} aria-label="线索版画布，拖动空白处平移">
    <div className="clue-world" ref={world}>{children}</div>
    {overlay}
    <button type="button" className="clue-camera-reset" onClick={() => reset.current()}>回到中心</button>
  </div>;
}
