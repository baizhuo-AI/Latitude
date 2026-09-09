import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { clampCardTitleToBounds, cardViewportBounds, desktopZoomFor } from "./cardSpatialGeometry";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../../projections/desktop/browserUiComposition";

/**
 * 纸片拖拽（表现层）：拖动只改变纸片的视觉偏移，不动骨架、不落领域数据。
 *
 * - 鼠标 / 触控笔直接拖；触摸屏留给甲板手势（按住滑动是换层，不抢）；
 * - 从按钮 / 输入框 / 链接等交互元素上按下不启动拖拽（点字改名、裁决照常）；
 * - 拖动超过 4px 才算拿起，放下后那次点击被吞掉，不会误触卡片动作；
 * - Shift + 双击空白处把纸片放回槽位；普通双击留给卡片编辑；
 * - 偏移缓存在 localStorage——散铺是用户的长期桌面状态，刷新不丢；
 * - 不设置卡片之间的碰撞边界。纸片可以跨过默认槽位、相互覆盖，像真实桌面；
 * - 拿起一张纸时把它提到最上层，避免被别的纸片挡住。
 */

export interface DragOffset {
  x: number;
  y: number;
}

export interface DragBinding {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

const DRAG_THRESHOLD_PX = 4;

/** 交互元素上按下不拖拽；元素可用 data-no-drag 显式退出 */
function fromInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        'button, a, input, textarea, select, [contenteditable="true"], [data-no-drag]'
      )
    )
  );
}

/** 固定尺寸卡片的原生滚动条仍负责滚动，不把这次按下变成拿起整张纸。 */
function fromScrollbar(event: ReactPointerEvent<HTMLElement>): boolean {
  let target = event.target instanceof HTMLElement ? event.target : null;
  while (target && target !== event.currentTarget) {
    const rect = target.getBoundingClientRect();
    const zoom = desktopZoomFor(target);
    const vertical = target.scrollHeight > target.clientHeight &&
      event.clientX >= rect.left + target.clientWidth * zoom;
    const horizontal = target.scrollWidth > target.clientWidth &&
      event.clientY >= rect.top + target.clientHeight * zoom;
    if (vertical || horizontal) return true;
    target = target.parentElement;
  }
  return false;
}

function readOffsets(key: string): Record<string, DragOffset> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DragOffset>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, point]) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ));
  } catch {
    return {};
  }
}

function writeOffsets(key: string, offsets: Record<string, DragOffset>) {
  try {
    window.localStorage.setItem(key, JSON.stringify(offsets));
  } catch {
    /* 私密窗口写不进就只在本次会话生效 */
  }
}

interface DragSession {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  nextX: number;
  nextY: number;
  baseZ: number;
  nextZ: number;
  target: HTMLElement;
  moved: boolean;
  zoom: number;
}

function applyOffset(target: HTMLElement, x: number, y: number) {
  target.style.translate = x || y ? `${x}px ${y}px` : "";
}

function applyZOrder(target: HTMLElement, zIndex: number) {
  target.style.zIndex = String(zIndex);
  const slot = target.parentElement;
  if (slot?.hasAttribute("data-layout-card-id")) {
    slot.style.zIndex = String(zIndex);
  }
}

function releasePointer(active: DragSession) {
  try {
    if (active.target.hasPointerCapture(active.pointerId)) {
      active.target.releasePointerCapture(active.pointerId);
    }
  } catch {
    /* 系统取消或测试环境没有指针捕获时无需再释放 */
  }
}

export function useCardDrag(storageKey: string) {
  const [offsets, setOffsets] = useState<Record<string, DragOffset>>(() =>
    readOffsets(storageKey)
  );
  const [zOrder, setZOrder] = useState<Record<string, number>>({});
  const zOrderRef = useRef(zOrder);
  zOrderRef.current = zOrder;
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const topZ = useRef(10);
  const session = useRef<DragSession | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const reload = () => {
      const next = readOffsets(storageKey);
      const active = session.current;
      session.current = null;
      suppressClick.current = false;
      if (active) {
        releasePointer(active);
        active.target.classList.remove("is-dragging");
        const offset = next[active.id] ?? { x: 0, y: 0 };
        applyOffset(active.target, offset.x, offset.y);
        applyZOrder(active.target, 1);
      }
      offsetsRef.current = next;
      setOffsets(next);
      zOrderRef.current = {};
      setZOrder({});
    };
    reload();
    window.addEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
    return () => {
      window.removeEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
      const active = session.current;
      session.current = null;
      if (active) releasePointer(active);
    };
  }, [storageKey]);

  const replaceOffsets = useCallback((next: Record<string, DragOffset>) => {
    offsetsRef.current = next;
    setOffsets(next);
    writeOffsets(storageKey, next);
  }, [storageKey]);

  const bringToFront = useCallback((id: string) => {
    const zIndex = ++topZ.current;
    const next = { ...zOrderRef.current, [id]: zIndex };
    zOrderRef.current = next;
    setZOrder(next);
  }, []);

  const onPointerDown = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      if (fromInteractive(event.target) || fromScrollbar(event)) return;
      const base = offsetsRef.current[id] ?? { x: 0, y: 0 };
      session.current = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: base.x,
        baseY: base.y,
        nextX: base.x,
        nextY: base.y,
        baseZ: zOrderRef.current[id] ?? 1,
        nextZ: zOrderRef.current[id] ?? 1,
        target: event.currentTarget,
        moved: false,
        zoom: desktopZoomFor(event.currentTarget),
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom 等环境没有指针捕获，拖动在本次按下内仍然成立 */
      }
    },
    []
  );

  const onPointerMove = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      const active = session.current;
      if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;
      active.nextX = active.baseX + dx / active.zoom;
      active.nextY = active.baseY + dy / active.zoom;
      if (!active.moved) {
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        active.moved = true;
        active.target.classList.add("is-dragging");
        active.nextZ = ++topZ.current;
        applyZOrder(active.target, active.nextZ);
      }
      // 直接操作只改当前纸片的合成属性；整棵桌面在放手前不重渲染。
      applyOffset(active.target, active.nextX, active.nextY);
    },
    []
  );

  const endSession = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      const active = session.current;
      if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      session.current = null;
      releasePointer(active);
      if (active.moved) {
        active.target.classList.remove("is-dragging");
        suppressClick.current = true;
        const bounds = cardViewportBounds(active.target);
        if (bounds) {
          const correction = clampCardTitleToBounds(active.target.getBoundingClientRect(), bounds);
          const zoom = desktopZoomFor(active.target);
          active.nextX += correction.x / zoom;
          active.nextY += correction.y / zoom;
          applyOffset(active.target, active.nextX, active.nextY);
        }
        const next = {
          ...offsetsRef.current,
          [id]: { x: active.nextX, y: active.nextY }
        };
        offsetsRef.current = next;
        setOffsets(next);
        const nextZOrder = { ...zOrderRef.current, [id]: active.nextZ };
        zOrderRef.current = nextZOrder;
        setZOrder(nextZOrder);
        writeOffsets(storageKey, next);
      }
    },
    [storageKey]
  );

  const cancelSession = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      const active = session.current;
      if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      session.current = null;
      releasePointer(active);
      if (!active.moved) return;
      // cancel 不是“放下”：恢复拖动前的位置，也不要留下吞下一次 click 的标记。
      active.target.classList.remove("is-dragging");
      applyOffset(active.target, active.baseX, active.baseY);
      applyZOrder(active.target, active.baseZ);
    },
    []
  );

  const onLostPointerCapture = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      const active = session.current;
      if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      session.current = null;
      if (!active.moved) return;
      active.target.classList.remove("is-dragging");
      applyOffset(active.target, active.baseX, active.baseY);
      applyZOrder(active.target, active.baseZ);
    },
    []
  );

  const onClickCapture = useCallback(
    () => (event: ReactMouseEvent<HTMLElement>) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    []
  );

  const onDoubleClick = useCallback(
    (id: string) => (event: ReactMouseEvent<HTMLElement>) => {
      if (!event.shiftKey || fromInteractive(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!offsetsRef.current[id]) return;
      const next = { ...offsetsRef.current };
      delete next[id];
      offsetsRef.current = next;
      applyOffset(event.currentTarget, 0, 0);
      setOffsets(next);
      writeOffsets(storageKey, next);
    },
    [storageKey]
  );

  const bind = useCallback(
    (id: string): DragBinding => ({
      onPointerDown: onPointerDown(id),
      onPointerMove: onPointerMove(id),
      onPointerUp: endSession(id),
      onPointerCancel: cancelSession(id),
      onLostPointerCapture: onLostPointerCapture(id),
      onClickCapture: onClickCapture(),
      onDoubleClick: onDoubleClick(id)
    }),
    [onPointerDown, onPointerMove, endSession, cancelSession, onLostPointerCapture, onClickCapture, onDoubleClick]
  );

  const offsetFor = useCallback(
    (id: string): DragOffset => {
      const active = session.current;
      return active?.id === id
        ? { x: active.nextX, y: active.nextY }
        : offsets[id] ?? { x: 0, y: 0 };
    },
    [offsets]
  );

  const zIndexFor = useCallback(
    (id: string): number => {
      const active = session.current;
      return active?.id === id ? active.nextZ : zOrder[id] ?? 1;
    },
    [zOrder]
  );

  return {
    bind,
    offsetFor,
    zIndexFor,
    draggingId: session.current?.moved ? session.current.id : null,
    bringToFront,
    replaceOffsets,
    getOffsets: () => ({ ...offsetsRef.current }),
    offsets,
  };
}
