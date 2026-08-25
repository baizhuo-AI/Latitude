import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";

/**
 * 纸片拖拽（表现层）：拖动只改变纸片的视觉偏移，不动骨架、不落领域数据。
 *
 * - 鼠标 / 触控笔直接拖；触摸屏留给甲板手势（按住滑动是换层，不抢）；
 * - 从按钮 / 输入框 / 链接等交互元素上按下不启动拖拽（点字改名、裁决照常）；
 * - 拖动超过 4px 才算拿起，放下后那次点击被吞掉，不会误触卡片动作；
 * - Shift + 双击空白处把纸片放回槽位；普通双击留给卡片编辑；
 * - 偏移缓存在 localStorage——散铺是用户的长期桌面状态，刷新不丢。
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
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

const DRAG_THRESHOLD_PX = 4;
const MAX_X = 320;
const MAX_Y = 220;

const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));

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

function readOffsets(key: string): Record<string, DragOffset> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DragOffset>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
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
  moved: boolean;
}

export function useCardDrag(storageKey: string) {
  const [offsets, setOffsets] = useState<Record<string, DragOffset>>(() =>
    readOffsets(storageKey)
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const session = useRef<DragSession | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      if (fromInteractive(event.target)) return;
      const base = offsets[id] ?? { x: 0, y: 0 };
      session.current = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: base.x,
        baseY: base.y,
        moved: false
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom 等环境没有指针捕获，拖动在本次按下内仍然成立 */
      }
    },
    [offsets]
  );

  const onPointerMove = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      const active = session.current;
      if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;
      if (!active.moved) {
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        active.moved = true;
        setDraggingId(id);
      }
      setOffsets((prev) => ({
        ...prev,
        [id]: {
          x: clamp(active.baseX + dx, MAX_X),
          y: clamp(active.baseY + dy, MAX_Y)
        }
      }));
    },
    []
  );

  const endSession = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      const active = session.current;
      if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      session.current = null;
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        /* 同上：没有捕获环境时无需释放 */
      }
      if (active.moved) {
        suppressClick.current = true;
        setDraggingId(null);
        setOffsets((prev) => {
          writeOffsets(storageKey, prev);
          return prev;
        });
      }
    },
    [storageKey]
  );

  const cancelSession = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      const active = session.current;
      if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
      session.current = null;
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        /* 指针已被系统取消时，捕获也可能已经自动释放 */
      }
      setDraggingId(null);
      if (!active.moved) return;
      // cancel 不是“放下”：恢复拖动前的位置，也不要留下吞下一次 click 的标记。
      setOffsets((prev) => {
        const next = { ...prev };
        if (active.baseX || active.baseY) {
          next[id] = { x: active.baseX, y: active.baseY };
        } else {
          delete next[id];
        }
        return next;
      });
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
      setOffsets((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        writeOffsets(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const bind = useCallback(
    (id: string): DragBinding => ({
      onPointerDown: onPointerDown(id),
      onPointerMove: onPointerMove(id),
      onPointerUp: endSession(id),
      onPointerCancel: cancelSession(id),
      onClickCapture: onClickCapture(),
      onDoubleClick: onDoubleClick(id)
    }),
    [onPointerDown, onPointerMove, endSession, cancelSession, onClickCapture, onDoubleClick]
  );

  const offsetFor = useCallback(
    (id: string): DragOffset => offsets[id] ?? { x: 0, y: 0 },
    [offsets]
  );

  return { bind, offsetFor, draggingId };
}
