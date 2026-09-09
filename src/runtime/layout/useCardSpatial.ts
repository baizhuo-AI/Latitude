import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { cardIsInView, cardViewportBounds, desktopZoomFor, locateCardCorrection } from "./cardSpatialGeometry";
import { DESKTOP_FOCUS_BOUNDS_EVENT } from "../../dimension/desktopCamera";
import type { useCardDrag } from "./useCardDrag";
import type { useCardResize } from "./useCardResize";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../../projections/desktop/browserUiComposition";
import { arrangementUndoKey, readArrangementUndo, writeArrangementUndo } from "./cardArrangementStorage";
import type { ArrangementSnapshot } from "./cardArrangementStorage";
import { arrangeDesktopCards, recommendedCardSize } from "./desktopArrangement";
import { readDesktopFrames, writeDesktopFrames, type DesktopCardFrames } from "./desktopFrameStorage";

export interface CardSpatialState {
  cards: Array<{ id: string; inView: boolean }>;
  canUndoArrangement: boolean;
}

const readArranged = (key: string, fallback = false) => {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  } catch { return fallback; }
};

export function useCardSpatial({
  storageKey, gridRef, ids, drag, resize, onChange, initiallyCompact = false, kinds = {}, initialFrames = {}, arrangementGroups = [], lockedIds = [],
}: {
  storageKey: string;
  gridRef: RefObject<HTMLDivElement>;
  ids: string[];
  drag: ReturnType<typeof useCardDrag>;
  resize: ReturnType<typeof useCardResize>;
  onChange?: (state: CardSpatialState) => void;
  initiallyCompact?: boolean;
  kinds?: Record<string, string>;
  initialFrames?: DesktopCardFrames;
  arrangementGroups?: string[][];
  lockedIds?: string[];
}) {
  const [arranged, setArranged] = useState(() => readArranged(storageKey, initiallyCompact));
  const initialMode = useRef(initiallyCompact);
  const undoStorageKey = arrangementUndoKey(storageKey);
  const [initialUndo] = useState(() => readArrangementUndo(undoStorageKey));
  const history = useRef<ArrangementSnapshot | null>(initialUndo);
  const [canUndoArrangement, setCanUndoArrangement] = useState(() => Boolean(history.current));
  const framesKey = storageKey.startsWith("dim-desk-arranged-")
    ? storageKey.replace("dim-desk-arranged-", "dim-desk-frames-") : `${storageKey}-frames`;
  const [frames, setFrames] = useState<DesktopCardFrames | null>(() => readDesktopFrames(framesKey));
  const extent = useRef({ width: 0, height: 0 });
  const callbackRef = useRef(onChange);
  callbackRef.current = onChange;
  const latestRef = useRef({ drag, resize, arranged, frames, kinds, arrangementGroups, lockedIds });
  latestRef.current = { drag, resize, arranged, frames, kinds, arrangementGroups, lockedIds };
  const frame = useRef<number>();
  const afterLayout = useRef<(() => void) | null>(null);
  const lastReport = useRef("");
  const idsKey = JSON.stringify(ids);
  const animationRefs = useRef<Animation[]>([]);
  const highlight = useRef<{ element: HTMLElement; timer: ReturnType<typeof setTimeout> }>();

  const cards = useCallback(() => Array.from(gridRef.current?.querySelectorAll<HTMLElement>("[data-spatial-card-id]") ?? []), [gridRef]);

  const report = useCallback(() => {
    const visibleCards = cards();
    const next: CardSpatialState = {
      cards: visibleCards.map((card) => {
        const bounds = cardViewportBounds(card);
        return { id: card.dataset.spatialCardId!, inView: bounds ? cardIsInView(card.getBoundingClientRect(), bounds) : true };
      }),
      canUndoArrangement: Boolean(history.current),
    };
    const signature = JSON.stringify(next);
    if (signature !== lastReport.current) {
      lastReport.current = signature;
      callbackRef.current?.(next);
    }
  }, [cards, gridRef]);

  const scheduleReport = useCallback(() => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      report();
    });
  }, [report]);

  const setArrangementMode = useCallback((next: boolean) => {
    setArranged(next);
    try { window.localStorage.setItem(storageKey, String(next)); } catch { /* session only */ }
  }, [storageKey]);

  const replaceFrames = useCallback((next: DesktopCardFrames | null) => {
    setFrames(next);
    writeDesktopFrames(framesKey, next);
  }, [framesKey]);

  // Measure the old grid once, then freeze each slot as an independent paper.
  // A card resized or removed afterwards can no longer move another card's base.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const papers = cards();
    if (!grid || !papers.length || papers.every((paper) => frames?.[paper.dataset.spatialCardId!])) return;
    const { drag: currentDrag, resize: currentResize, kinds: currentKinds, arranged: currentArranged } = latestRef.current;
    const offsets = currentDrag.getOffsets();
    const sizes = currentResize.getSizes();
    const zoom = desktopZoomFor(grid);
    const gridRect = grid.getBoundingClientRect();
    const width = grid.clientWidth || gridRect.width / zoom || 1180;
    const next: DesktopCardFrames = { ...frames };
    if (!frames && initiallyCompact && !Object.keys(offsets).length && !Object.keys(sizes).length) {
      const initial = arrangeDesktopCards(papers.map((paper) => ({ id: paper.dataset.spatialCardId!, kind: currentKinds[paper.dataset.spatialCardId!] ?? "note" })), width);
      for (const paper of papers) {
        const id = paper.dataset.spatialCardId!;
        next[id] = { ...initial.positions[id], ...initial.sizes[id] };
      }
    } else {
      // Older versions wrote a single uniform size to every arranged card. Those
      // repeated values are automatic defaults; distinct overrides stay manual.
      const repeated = new Map<string, number>();
      for (const paper of papers) {
        const saved = sizes[paper.dataset.spatialCardId!];
        if (saved) { const key = `${saved.width}:${saved.height}`; repeated.set(key, (repeated.get(key) ?? 0) + 1); }
      }
      let bottom = Math.max(0, ...Object.entries(next).map(([id, frame]) => frame.y + (offsets[id]?.y ?? 0) + (sizes[id]?.height ?? frame.height)));
      for (const paper of papers) {
        const id = paper.dataset.spatialCardId!;
        if (next[id]) continue;
        const recommended = recommendedCardSize(currentKinds[id] ?? "note", width);
        const saved = sizes[id];
        const automatic = currentArranged && saved && (repeated.get(`${saved.width}:${saved.height}`) ?? 0) >= 3;
        const rect = paper.getBoundingClientRect();
        const offset = offsets[id] ?? { x: 0, y: 0 };
        if (!frames) {
          next[id] = {
            x: (rect.left - gridRect.left) / zoom - offset.x,
            y: (rect.top - gridRect.top) / zoom - offset.y,
            width: saved && !automatic ? recommended.width : (saved?.width || paper.offsetWidth || rect.width / zoom || recommended.width),
            height: saved && !automatic ? recommended.height : Math.max(140, saved?.height || paper.offsetHeight || rect.height / zoom || recommended.height),
          };
        } else {
          next[id] = { x: 0, y: bottom + 22, ...recommended };
          bottom = next[id].y + recommended.height;
        }
      }
    }
    // Callers can seed a newly-created paper at a region or current camera.
    // Existing frame records remain authoritative on every subsequent render.
    for (const paper of papers) {
      const id = paper.dataset.spatialCardId!;
      const initial = initialFrames[id];
      if (!frames?.[id] && initial && [initial.x, initial.y, initial.width, initial.height].every(Number.isFinite)
        && initial.width > 0 && initial.height >= 140) next[id] = { ...initial };
    }
    replaceFrames(next);
  }, [cards, frames, gridRef, idsKey, initiallyCompact, initialFrames, replaceFrames]);

  useEffect(() => {
    const next = readArranged(storageKey, initialMode.current);
    setArranged(next);
    try { window.localStorage.setItem(storageKey, String(next)); } catch { /* session only */ }
    history.current = readArrangementUndo(undoStorageKey);
    setCanUndoArrangement(Boolean(history.current));
    setFrames(readDesktopFrames(framesKey));
    extent.current = { width: 0, height: 0 };
    lastReport.current = "";
  }, [storageKey, undoStorageKey, framesKey]);

  useEffect(() => {
    const reloadProfile = () => {
      animationRefs.current.forEach((animation) => animation.cancel());
      animationRefs.current = [];
      afterLayout.current = null;
      if (highlight.current) {
        clearTimeout(highlight.current.timer);
        highlight.current.element.classList.remove("is-located");
        highlight.current = undefined;
      }
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      history.current = null;
      writeArrangementUndo(undoStorageKey, null);
      setCanUndoArrangement(false);
      setArranged(readArranged(storageKey));
      setFrames(readDesktopFrames(framesKey));
      extent.current = { width: 0, height: 0 };
      lastReport.current = "";
      scheduleReport();
    };
    window.addEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reloadProfile);
    return () => window.removeEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reloadProfile);
  }, [storageKey, undoStorageKey, framesKey, scheduleReport]);

  useEffect(() => {
    const grid = gridRef.current;
    const viewport = grid?.closest<HTMLElement>(".dim-desk-scroll");
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleReport);
    const zoomSurface = grid?.closest<HTMLElement>("[data-desktop-zoom]");
    const zoomObserver = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(scheduleReport);
    if (zoomSurface) zoomObserver?.observe(zoomSurface, { attributes: true, attributeFilter: ["data-desktop-zoom"] });
    if (grid) observer?.observe(grid);
    if (viewport) observer?.observe(viewport);
    for (const card of cards()) observer?.observe(card);
    viewport?.addEventListener("scroll", scheduleReport, { passive: true });
    window.addEventListener("resize", scheduleReport);
    scheduleReport();
    return () => {
      observer?.disconnect();
      zoomObserver?.disconnect();
      viewport?.removeEventListener("scroll", scheduleReport);
      window.removeEventListener("resize", scheduleReport);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [gridRef, idsKey, cards, scheduleReport]);

  useLayoutEffect(() => {
    afterLayout.current?.();
    afterLayout.current = null;
    scheduleReport();
  }, [drag.offsets, resize.sizes, frames, arranged, canUndoArrangement, scheduleReport]);

  useEffect(() => () => {
    animationRefs.current.forEach((animation) => animation.cancel());
    if (highlight.current) {
      clearTimeout(highlight.current.timer);
      highlight.current.element.classList.remove("is-located");
    }
  }, []);

  const prepareMotion = useCallback(() => {
    animationRefs.current.forEach((animation) => animation.cancel());
    const before = new Map(cards().map((card) => [card.dataset.spatialCardId!, card.getBoundingClientRect()]));
    return () => {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      animationRefs.current = cards().flatMap((card) => {
        const previous = before.get(card.dataset.spatialCardId!);
        if (!previous || !card.animate) return [];
        const next = card.getBoundingClientRect();
        const zoom = desktopZoomFor(card);
        const animation = card.animate([
          { transform: `translate(${(previous.left - next.left) / zoom}px, ${(previous.top - next.top) / zoom}px)` },
          { transform: "translate(0, 0)" },
        ], { duration: 230, easing: "cubic-bezier(.2,.75,.25,1)" });
        animation.onfinish = scheduleReport;
        return [animation];
      });
    };
  }, [cards, scheduleReport]);

  const locateCard = useCallback((id: string) => {
    const card = cards().find((candidate) => candidate.dataset.spatialCardId === id);
    if (!card) return;
    const { drag: currentDrag } = latestRef.current;
    const surface = card.closest<HTMLElement>("[data-desktop-zoom]");
    const rect = card.getBoundingClientRect();
    const surfaceRect = surface?.getBoundingClientRect();
    const viewport = card.closest<HTMLElement>(".dim-desk-scroll");
    const outerZoom = viewport?.clientWidth ? viewport.getBoundingClientRect().width / viewport.clientWidth || 1 : 1;
    const zoom = desktopZoomFor(card) * outerZoom;
    const request = new CustomEvent(DESKTOP_FOCUS_BOUNDS_EVENT, { bubbles: true, cancelable: true, detail: {
      left: (rect.left - (surfaceRect?.left ?? 0)) / zoom,
      top: (rect.top - (surfaceRect?.top ?? 0)) / zoom,
      width: rect.width / zoom, height: rect.height / zoom,
    } });
    card.dispatchEvent(request);
    if (!request.defaultPrevented) {
      // Standalone renderer previews may omit a camera. They still scroll the
      // viewport to recover a paper and never rewrite the user's coordinates.
      const bounds = cardViewportBounds(card);
      const viewport = card.closest<HTMLElement>(".dim-desk-scroll");
      if (viewport && bounds && !cardIsInView(rect, bounds)) {
        const correction = locateCardCorrection(rect, bounds);
        viewport.scrollLeft = Math.max(0, viewport.scrollLeft - correction.x);
        viewport.scrollTop = Math.max(0, viewport.scrollTop - correction.y);
      }
    }
    currentDrag.bringToFront(id);
    if (highlight.current) {
      clearTimeout(highlight.current.timer);
      highlight.current.element.classList.remove("is-located");
    }
    card.classList.add("is-located");
    card.focus({ preventScroll: true });
    highlight.current = { element: card, timer: setTimeout(() => card.classList.remove("is-located"), 1400) };
    scheduleReport();
  }, [cards, scheduleReport]);

  const arrangeCards = useCallback((cardIds?: string[]) => {
    const grid = gridRef.current;
    const requested = Array.isArray(cardIds) ? new Set(cardIds) : null;
    const papers = cards().filter((card) => !requested || requested.has(card.dataset.spatialCardId!));
    if (!grid || !papers.length) return;
    const viewport = grid.closest<HTMLElement>(".dim-desk-scroll");
    const { drag: currentDrag, resize: currentResize, arranged: previousMode, frames: currentFrames, kinds: currentKinds } = latestRef.current;
    history.current = { offsets: currentDrag.getOffsets(), sizes: currentResize.getSizes(), arranged: previousMode, scrollLeft: viewport?.scrollLeft ?? 0, scrollTop: viewport?.scrollTop ?? 0, ...(currentFrames ? { frames: currentFrames } : {}) };
    writeArrangementUndo(undoStorageKey, history.current);
    const animate = prepareMotion();
    const zoom = desktopZoomFor(grid);
    const width = grid.clientWidth || grid.getBoundingClientRect().width / zoom || 1180;
    const nextOffsets = currentDrag.getOffsets();
    const nextSizes = currentResize.getSizes();
    const nextFrames: DesktopCardFrames = { ...currentFrames };
    const locked = new Set(latestRef.current.lockedIds);
    const selected = new Set(papers.map(card => card.dataset.spatialCardId!));
    const claimed = new Set<string>();
    const groups = latestRef.current.arrangementGroups.map(group => group.filter(id => {
      if (!selected.has(id) || claimed.has(id)) return false;
      claimed.add(id); return true;
    })).filter(group => group.length);
    const remaining = [...selected].filter(id => !claimed.has(id));
    if (remaining.length) groups.push(remaining);
    const geometry = (id: string) => {
      const saved = currentFrames?.[id];
      const size = nextSizes[id] ?? saved ?? recommendedCardSize(currentKinds[id] ?? "note", width);
      return { id, kind: currentKinds[id] ?? "note", x: (saved?.x ?? 0) + (nextOffsets[id]?.x ?? 0),
        y: (saved?.y ?? 0) + (nextOffsets[id]?.y ?? 0), width: size.width, height: size.height,
        manualSize: Boolean(nextSizes[id] && (!saved || nextSizes[id].width !== saved.width || nextSizes[id].height !== saved.height)) };
    };
    // Each board section keeps its own origin. Locked papers are obstacles,
    // including papers outside the requested selection; one undo restores all groups.
    for (const group of groups) {
      const members = group.map(geometry);
      const movable = members.filter(card => !locked.has(card.id));
      if (!movable.length) continue;
      const origin = { x: Math.min(...members.map(card => card.x)), y: Math.min(...members.map(card => card.y)) };
      const obstacles = cards().map(card => geometry(card.dataset.spatialCardId!))
        .filter(card => locked.has(card.id))
        .map(card => ({ ...card, x: card.x - origin.x, y: card.y - origin.y }));
      const arrangement = arrangeDesktopCards(movable, width, obstacles);
      for (const card of movable) {
        const id = card.id;
        delete nextOffsets[id];
        if (!card.manualSize) delete nextSizes[id];
        nextFrames[id] = { x: arrangement.positions[id].x + origin.x, y: arrangement.positions[id].y + origin.y,
          ...recommendedCardSize(currentKinds[id] ?? "note", width) };
      }
    }
    extent.current = { width: 0, height: 0 };
    afterLayout.current = animate;
    setArrangementMode(true);
    currentDrag.replaceOffsets(nextOffsets);
    currentResize.replaceSizes(nextSizes);
    replaceFrames(nextFrames);
    setCanUndoArrangement(true);
  }, [cards, gridRef, prepareMotion, setArrangementMode, undoStorageKey, replaceFrames]);

  const undoArrangement = useCallback(() => {
    const previous = history.current;
    if (!previous) return;
    history.current = null;
    writeArrangementUndo(undoStorageKey, null);
    const animate = prepareMotion();
    const { drag: currentDrag, resize: currentResize, frames: currentFrames, lockedIds: currentLocks } = latestRef.current;
    const offsets = { ...previous.offsets };
    const sizes = { ...previous.sizes };
    const frames: DesktopCardFrames = { ...previous.frames };
    const currentOffsets = currentDrag.getOffsets();
    const currentSizes = currentResize.getSizes();
    // A lock set after the arrangement still wins when undoing that arrangement.
    for (const id of currentLocks) {
      if (currentFrames?.[id]) frames[id] = currentFrames[id];
      if (currentOffsets[id]) offsets[id] = currentOffsets[id]; else delete offsets[id];
      if (currentSizes[id]) sizes[id] = currentSizes[id]; else delete sizes[id];
    }
    afterLayout.current = () => {
      const viewport = gridRef.current?.closest<HTMLElement>(".dim-desk-scroll");
      if (viewport) { viewport.scrollTop = previous.scrollTop; viewport.scrollLeft = previous.scrollLeft; }
      animate();
    };
    setArrangementMode(previous.arranged);
    currentDrag.replaceOffsets(offsets);
    currentResize.replaceSizes(sizes);
    replaceFrames(Object.keys(frames).length ? frames : null);
    setCanUndoArrangement(false);
  }, [gridRef, prepareMotion, setArrangementMode, undoStorageKey, replaceFrames]);

  for (const id of ids) {
    const frame = frames?.[id];
    if (!frame) continue;
    const size = resize.sizes[id] ?? frame;
    const offset = drag.offsets[id] ?? { x: 0, y: 0 };
    extent.current.width = Math.max(extent.current.width, frame.x + offset.x + size.width + 12);
    extent.current.height = Math.max(extent.current.height, frame.y + offset.y + size.height + 12);
  }
  return { arranged, frames, canvasHeight: extent.current.height, locateCard, arrangeCards, undoArrangement };
}
