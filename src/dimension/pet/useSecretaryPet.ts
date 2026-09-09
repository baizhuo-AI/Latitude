import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { fitPosition, inside } from "./geometry";
import { nativePetAvailable, petCommand, subscribePetState } from "./nativePet";
import { INITIAL_PET_STATE, type PetState } from "./types";

const POSITION_KEY = "latitude.pet-placement.v1";
const SIZE = { width: 180, height: 220 };
const bounds = () => ({ x: 8, y: 8, width: window.innerWidth - 16, height: window.innerHeight - 16 });

type DockRect = { x: number; y: number; width: number; height: number };
type DragSession = {
  source: "dock" | "pet";
  pointerId: number;
  captureTarget: HTMLButtonElement;
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  started: boolean;
  before: PetState;
};

function sameRect(previous: DockRect | null | undefined, next: DockRect | null): boolean {
  if (previous === undefined) return false;
  if (previous === null || next === null) return previous === next;
  return previous.x === next.x && previous.y === next.y &&
    previous.width === next.width && previous.height === next.height;
}

function positionTransform(position: Pick<PetState, "x" | "y">): string {
  return `translate3d(${position.x}px, ${position.y}px, 0)`;
}

function releaseCapture(session: DragSession | null): void {
  if (!session) return;
  const target = session.captureTarget;
  try {
    if (typeof target.releasePointerCapture === "function" &&
      (typeof target.hasPointerCapture !== "function" || target.hasPointerCapture(session.pointerId))) {
      target.releasePointerCapture(session.pointerId);
    }
  } catch {
    // The element may have been detached while Escape or pointercancel was handled.
  }
}

function readPosition(): PetState {
  const stored = localStorage.getItem(POSITION_KEY);
  if (!stored) return INITIAL_PET_STATE;
  try {
    const saved = JSON.parse(stored) as PetState;
    if (saved.mode !== "floating") return INITIAL_PET_STATE;
    return { ...saved, ...fitPosition(saved, bounds(), SIZE), dragging: false, overDock: false };
  } catch { return INITIAL_PET_STATE; }
}

export function useSecretaryPet(onOpen: () => void) {
  const native = nativePetAvailable();
  const [state, setState] = useState<PetState>(() => native ? INITIAL_PET_STATE : readPosition());
  const [error, setError] = useState<string | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const visualPosition = useRef({ x: state.x, y: state.y });
  const drag = useRef<DragSession | null>(null);
  const dragFrame = useRef<number | null>(null);
  const pendingDrag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const dockPublisher = useRef<{
    observe: (node: HTMLDivElement | null) => void;
    schedule: () => void;
  } | null>(null);
  const reportError = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);

  const setDockRef = useCallback((node: HTMLDivElement | null) => {
    dockRef.current = node;
    dockPublisher.current?.observe(node);
    dockPublisher.current?.schedule();
  }, []);

  const setFloatingRef = useCallback((node: HTMLDivElement | null) => {
    floatingRef.current = node;
    if (node) node.style.transform = positionTransform(visualPosition.current);
  }, []);

  const clearDragFrame = useCallback(() => {
    pendingDrag.current = null;
    if (dragFrame.current === null) return;
    window.cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
  }, []);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let dispose: (() => void) | undefined;
    void subscribePetState((next) => { if (!disposed) setState(next); })
      .then((unlisten) => { if (disposed) unlisten(); else dispose = unlisten; })
      .catch(reportError);
    return () => { disposed = true; dispose?.(); };
  }, [native, reportError]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let frame: number | null = null;
    let lastMeasured: DockRect | null | undefined;
    let activeCommand: DockRect | null | undefined;
    let pendingCommand: DockRect | null | undefined;
    let sending = false;

    const send = (rect: DockRect | null) => {
      if (sending) {
        pendingCommand = rect;
        return;
      }
      sending = true;
      activeCommand = rect;
      void petCommand("pet_set_dock_rect", { rect })
        .catch((error) => { if (!disposed) reportError(error); })
        .finally(() => {
          sending = false;
          if (disposed || pendingCommand === undefined) return;
          const next = pendingCommand;
          pendingCommand = undefined;
          if (!sameRect(activeCommand, next)) send(next);
        });
    };

    const publish = () => {
      frame = null;
      const box = dockRef.current?.getBoundingClientRect();
      const rect = box && box.width > 0 && box.height > 0
        ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      if (sameRect(lastMeasured, rect)) return;
      lastMeasured = rect;
      send(rect);
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(publish);
    };
    const handleScroll = (event: Event) => {
      const node = dockRef.current;
      const target = event.target;
      if (!node || !(target instanceof Node) || target === document || target.contains(node)) schedule();
    };

    const resizeObserver = new ResizeObserver(schedule);
    const mutationObserver = new MutationObserver(schedule);
    const observe = (node: HTMLDivElement | null) => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (!node) return;
      resizeObserver.observe(node);
      const layoutRoot = node.closest<HTMLElement>(".dim-rail") ?? node.parentElement;
      if (layoutRoot && layoutRoot !== node) resizeObserver.observe(layoutRoot);
      mutationObserver.observe(layoutRoot ?? node, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    };
    const publisher = { observe, schedule };
    dockPublisher.current = publisher;
    observe(dockRef.current);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", handleScroll, true);
    schedule();
    return () => {
      disposed = true;
      if (dockPublisher.current === publisher) dockPublisher.current = null;
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", handleScroll, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [native, reportError]);

  const commit = useCallback((next: PetState) => {
    visualPosition.current = { x: next.x, y: next.y };
    if (floatingRef.current) floatingRef.current.style.transform = positionTransform(next);
    setState(next);
    localStorage.setItem(POSITION_KEY, JSON.stringify(next));
  }, []);

  useEffect(() => {
    if (native) return;
    const resize = () => setState((current) => {
      if (current.mode === "docked" || current.dragging) return current;
      const position = fitPosition(current, bounds(), SIZE);
      const next = { ...current, ...position };
      visualPosition.current = position;
      if (floatingRef.current) floatingRef.current.style.transform = positionTransform(position);
      localStorage.setItem(POSITION_KEY, JSON.stringify(next));
      return next;
    });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [native]);

  const recall = useCallback(() => {
    if (native) void petCommand("pet_dock").catch(reportError);
    else commit(INITIAL_PET_STATE);
  }, [native, commit, reportError]);

  const cancel = useCallback(() => {
    const current = drag.current;
    clearDragFrame();
    drag.current = null;
    releaseCapture(current);
    if (native) void petCommand("pet_cancel_drag").catch(reportError);
    else if (current) {
      visualPosition.current = { x: current.before.x, y: current.before.y };
      if (floatingRef.current) floatingRef.current.style.transform = positionTransform(current.before);
      setState(current.before);
    }
  }, [clearDragFrame, native, reportError]);

  useEffect(() => () => {
    clearDragFrame();
    releaseCapture(drag.current);
    drag.current = null;
  }, [clearDragFrame]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && (drag.current || state.dragging)) { event.preventDefault(); cancel(); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [cancel, state.dragging]);

  const handlers = (source: "dock" | "pet", open = onOpen) => ({
    onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
      if (event.button !== 0 || drag.current) return;
      const box = event.currentTarget.getBoundingClientRect();
      drag.current = { source, pointerId: event.pointerId, captureTarget: event.currentTarget,
        x: event.clientX, y: event.clientY,
        grabX: (event.clientX - box.x) / box.width, grabY: (event.clientY - box.y) / box.height,
        started: false, before: state };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.started && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
      if (!current.started) {
        current.started = true;
        if (native) {
          void petCommand("pet_begin_drag", { source, grabX: current.grabX * 220, grabY: current.grabY * 260 }).catch(reportError);
          return;
        }
      }
      if (native) return;
      pendingDrag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      if (dragFrame.current === null) {
        dragFrame.current = window.requestAnimationFrame(() => {
          dragFrame.current = null;
          const pending = pendingDrag.current;
          pendingDrag.current = null;
          const active = drag.current;
          if (!pending || !active || active.pointerId !== pending.pointerId) return;
          const dock = dockRef.current?.getBoundingClientRect();
          const overDock = Boolean(dock && inside({ x: pending.x, y: pending.y }, dock));
          const position = {
            x: pending.x - SIZE.width * active.grabX,
            y: pending.y - SIZE.height * active.grabY,
          };
          visualPosition.current = position;
          if (floatingRef.current) floatingRef.current.style.transform = positionTransform(position);
          setState((visible) => visible.dragging && visible.overDock === overDock
            ? visible
            : { ...active.before, ...position, dragging: true, overDock });
        });
      }
    },
    onPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      clearDragFrame();
      drag.current = null;
      releaseCapture(current);
      if (!current.started) { open(); return; }
      if (native) return;
      const dock = dockRef.current?.getBoundingClientRect();
      const overDock = Boolean(dock && inside({ x: event.clientX, y: event.clientY }, dock));
      commit(overDock ? INITIAL_PET_STATE : {
        mode: "floating", dragging: false, overDock: false,
        ...fitPosition({ x: event.clientX - SIZE.width * current.grabX, y: event.clientY - SIZE.height * current.grabY }, bounds(), SIZE),
      });
    },
    onPointerCancel: cancel,
    onClick(event: React.MouseEvent<HTMLButtonElement>) { if (event.detail === 0) open(); },
  });

  return {
    state,
    native,
    dockRef,
    setDockRef,
    setFloatingRef,
    floatingTransform: positionTransform(visualPosition.current),
    handlers,
    recall,
    error,
    clearError: () => setError(null),
  };
}
