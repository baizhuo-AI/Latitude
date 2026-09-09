import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../../projections/desktop/browserUiComposition";
import { desktopZoomFor } from "./cardSpatialGeometry";

export interface CardSize {
  width: number;
  height: number;
}

export type ResizeDirection = "right" | "bottom" | "corner";
export type CardSizes = Record<string, CardSize>;

const MIN_WIDTH = 200;
const MIN_HEIGHT = 140;
const KEYBOARD_STEP = 10;
const EMPTY_SIZES: CardSizes = {};

function readSizes(key: string): CardSizes {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, size]) =>
      size && typeof size === "object" &&
      Number.isFinite(size.width) && size.width > 0 &&
      Number.isFinite(size.height) && size.height >= MIN_HEIGHT
    ));
  } catch {
    return {};
  }
}

interface ResizeSession {
  id: string;
  direction: ResizeDirection;
  pointerId: number;
  target: HTMLElement;
  card: HTMLElement;
  startX: number;
  startY: number;
  base: CardSize;
  before: CardSize | undefined;
  next: CardSize;
  maxWidth: number;
  minHeight: number;
  moved: boolean;
  zoom: number;
}

function releasePointer(active: ResizeSession) {
  try {
    if (active.target.hasPointerCapture(active.pointerId)) {
      active.target.releasePointerCapture(active.pointerId);
    }
  } catch {
    // 系统取消手势时可能已经释放捕获；测试环境也可能没有这个 API。
  }
}

function applySize(card: HTMLElement, size: CardSize) {
  card.style.width = `${size.width}px`;
  card.style.height = `${size.height}px`;
  card.classList.add("is-sized");
}

function frameDefault(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function restoreSize(card: HTMLElement, size: CardSize | undefined) {
  if (size) {
    applySize(card, size);
    return;
  }
  const width = frameDefault(card.dataset.defaultWidth);
  const height = frameDefault(card.dataset.defaultHeight);
  card.style.width = width === undefined ? "" : `${width}px`;
  card.style.height = height === undefined ? "" : `${height}px`;
  card.classList.remove("is-sized");
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cardMinimumHeight(card: HTMLElement): number {
  const shell = card.querySelector<HTMLElement>(".dim-card-shell");
  if (!shell) return MIN_HEIGHT;
  const style = window.getComputedStyle(shell);
  const header = shell.querySelector<HTMLElement>(":scope > .dim-card-header");
  const footer = shell.querySelector<HTMLElement>(":scope > .dim-card-footer");
  const fixedHeight =
    (header?.offsetHeight ?? 0) +
    (footer?.offsetHeight ?? 0) +
    cssPixels(style.paddingTop) +
    cssPixels(style.paddingBottom) +
    cssPixels(style.borderTopWidth) +
    cssPixels(style.borderBottomWidth);
  return Math.max(MIN_HEIGHT, Math.ceil(fixedHeight + 48));
}

function measureCard(handle: HTMLElement) {
  const card = handle.closest<HTMLElement>("[data-card-resizable]");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const zoom = desktopZoomFor(card);
  const canvas = card.closest<HTMLElement>(".dim-grid-wrap")?.getBoundingClientRect();
  // Free desktop coordinates can extend beyond the viewport; its camera scrolls.
  const available = canvas && canvas.width > 0
    ? canvas.right - Math.max(canvas.left, rect.left)
    : window.innerWidth - rect.left;
  const canvasWidth = (canvas?.width || window.innerWidth || MIN_WIDTH) / zoom;
  const maxWidth = card.closest("[data-free-desktop]")
    ? Math.max(4096, card.offsetWidth || rect.width / zoom)
    : Math.max(Math.min(MIN_WIDTH, canvasWidth), available / zoom || canvasWidth);
  return {
    card,
    base: {
      width: card.offsetWidth || rect.width / zoom || MIN_WIDTH,
      height: card.offsetHeight || rect.height / zoom || MIN_HEIGHT,
    },
    maxWidth,
    minHeight: cardMinimumHeight(card),
    zoom,
  };
}

function resizedSize(
  base: CardSize,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  maxWidth: number,
  minHeight: number,
): CardSize {
  return {
    width: direction === "bottom" ? base.width : Math.round(Math.min(maxWidth, Math.max(Math.min(MIN_WIDTH, maxWidth), base.width + dx))),
    height: Math.round(Math.max(minHeight, base.height + (direction === "right" ? 0 : dy))),
  };
}

/** 尺寸与桌面位置一样只属于本机布局；放手后保存，取消时回到拿起前。 */
export function useCardResize(storageKey: string) {
  const [stored, setStored] = useState(() => ({ storageKey, sizes: readSizes(storageKey) }));
  const session = useRef<ResizeSession | null>(null);
  const activeStorageKey = useRef(storageKey);
  const sizes = stored.storageKey === storageKey ? stored.sizes : EMPTY_SIZES;
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  useEffect(() => {
    const reload = () => {
      const next = readSizes(storageKey);
      const active = session.current;
      session.current = null;
      if (active) {
        releasePointer(active);
        active.card.classList.remove("is-resizing");
        restoreSize(active.card, next[active.id]);
      }
      sizesRef.current = next;
      setStored({ storageKey, sizes: next });
    };
    if (activeStorageKey.current !== storageKey) {
      activeStorageKey.current = storageKey;
      reload();
    }
    window.addEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
    return () => {
      window.removeEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
      const active = session.current;
      session.current = null;
      if (active) {
        releasePointer(active);
        active.card.classList.remove("is-resizing");
        restoreSize(active.card, active.before);
      }
    };
  }, [storageKey]);

  const commitSize = useCallback((id: string, size: CardSize | undefined, persist = false) => {
    const next = { ...sizesRef.current };
    if (size) next[id] = size;
    else delete next[id];
    sizesRef.current = next;
    setStored({ storageKey, sizes: next });
    if (!persist) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // 存储不可用时，当前会话仍可调整。
    }
  }, [storageKey]);

  const replaceSizes = useCallback((next: CardSizes) => {
    sizesRef.current = next;
    setStored({ storageKey, sizes: next });
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // 整理与撤销仍能在当前会话中生效。
    }
  }, [storageKey]);

  const cancel = useCallback(() => {
    const active = session.current;
    if (!active) return;
    session.current = null;
    releasePointer(active);
    active.card.classList.remove("is-resizing");
    restoreSize(active.card, active.before);
  }, []);

  const bind = (id: string, direction: ResizeDirection) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || session.current) return;
      const measured = measureCard(event.currentTarget);
      if (!measured) return;
      event.preventDefault();
      event.stopPropagation();
      session.current = {
        id, direction, pointerId: event.pointerId, target: event.currentTarget,
        card: measured.card,
        startX: event.clientX, startY: event.clientY,
        before: sizesRef.current[id], base: measured.base, next: measured.base,
        maxWidth: measured.maxWidth, minHeight: measured.minHeight,
        moved: false, zoom: measured.zoom,
      };
      measured.card.classList.add("is-resizing");
      event.currentTarget.focus({ preventScroll: true });
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 没有指针捕获的测试环境仍可执行同一组事件。
      }
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const active = session.current;
      if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      event.stopPropagation();
      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;
      if (!active.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      active.moved = true;
      active.next = resizedSize(
        active.base,
        active.direction,
        dx / active.zoom,
        dy / active.zoom,
        active.maxWidth,
        active.minHeight,
      );
      // 手势中只更新正在操作的元素，避免整张桌面与所有卡片逐帧重渲染。
      applySize(active.card, active.next);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const active = session.current;
      if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      event.stopPropagation();
      session.current = null;
      releasePointer(active);
      active.card.classList.remove("is-resizing");
      if (active.moved) commitSize(id, active.next, true);
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (session.current?.id !== id || session.current.pointerId !== event.pointerId) return;
      event.stopPropagation();
      cancel();
    },
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => {
      if (session.current?.id === id && session.current.pointerId === event.pointerId) cancel();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && session.current?.id === id) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        const card = event.currentTarget.closest<HTMLElement>("[data-card-resizable]");
        if (card) restoreSize(card, undefined);
        commitSize(id, undefined, true);
        return;
      }
      const step = event.shiftKey ? KEYBOARD_STEP * 4 : KEYBOARD_STEP;
      const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
      const dy = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
      if ((!dx && !dy) || (direction === "right" && !dx) || (direction === "bottom" && !dy)) return;
      const measured = measureCard(event.currentTarget);
      if (!measured) return;
      event.preventDefault();
      event.stopPropagation();
      const next = resizedSize(
        measured.base,
        direction,
        dx,
        dy,
        measured.maxWidth,
        measured.minHeight,
      );
      applySize(measured.card, next);
      commitSize(id, next, true);
    },
    onClick: (event: MouseEvent<HTMLElement>) => event.stopPropagation(),
    onDoubleClick: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const card = event.currentTarget.closest<HTMLElement>("[data-card-resizable]");
      if (card) restoreSize(card, undefined);
      commitSize(id, undefined, true);
    },
  });

  return {
    bind,
    resizingId: session.current?.id ?? null,
    sizeFor: (id: string) => sizes[id],
    replaceSizes,
    getSizes: () => ({ ...sizesRef.current }),
    sizes,
  };
}
