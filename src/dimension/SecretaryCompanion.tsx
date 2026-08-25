import { useEffect, useRef, useState } from "react";
import { SecretaryPortrait } from "./SecretaryPortrait";
import type { Secretary, SecretaryIntent } from "./types";
import "./secretaryCompanion.css";

const STORAGE_KEY = "latitude.secretary-companion.v1";
// Composite Browser profile restore fires this after allowlisted local storage
// has been replaced. Reloading here preserves restored x/y instead of letting
// the already-mounted overlay overwrite them with its pre-restore position.
const PROFILE_RESTORED_EVENT = "latitude:ui-profile-restored";

interface CompanionPosition {
  x: number;
  y: number;
  hidden: boolean;
}

function initialPosition(): CompanionPosition {
  const fallback = {
    x: typeof window === "undefined" ? 24 : Math.max(16, window.innerWidth - 226),
    // Keep the first-run position above the persistent control strip and
    // command bar. She may overlap paper like a real desk companion, but must
    // not cover the controls that let the user search, review, or talk to her.
    y: typeof window === "undefined" ? 120 : Math.max(72, window.innerHeight - 390),
    hidden: false,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as
      | Partial<CompanionPosition>
      | null;
    if (!parsed) return fallback;
    return clampPosition({
      x: typeof parsed.x === "number" ? parsed.x : fallback.x,
      y: typeof parsed.y === "number" ? parsed.y : fallback.y,
      hidden: parsed.hidden === true,
    });
  } catch {
    return fallback;
  }
}

function clampPosition(position: CompanionPosition): CompanionPosition {
  if (typeof window === "undefined") return position;
  return {
    ...position,
    x: Math.min(Math.max(8, position.x), Math.max(8, window.innerWidth - 188)),
    y: Math.min(Math.max(52, position.y), Math.max(52, window.innerHeight - 214)),
  };
}

function savePosition(position: CompanionPosition): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Private browsing can keep the position session-local without breaking her.
  }
}

export interface SecretaryCompanionProps {
  secretary: Secretary;
  /** Durable scheduler / reality-loop delivery shown without changing her art. */
  notice?: string | null;
  onInteract?: (intent: SecretaryIntent) => void;
  onReview?: () => void;
  onSettings?: () => void;
  /** UiSurfaceV2 is authoritative when provided; legacy local hidden only seeds migration. */
  visible?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
  /** Event-level trusted bindings resolved by the host-owned production registry. */
  actionAvailability?: {
    chat: boolean;
    review: boolean;
    outcome: boolean;
  };
}

/**
 * Root-level browser companion. It reuses the existing portraits and paper
 * language, but owns its position independently from any navigation rail.
 */
export function SecretaryCompanion({
  secretary,
  notice,
  onInteract,
  onReview,
  onSettings,
  visible,
  onVisibilityChange,
  actionAvailability,
}: SecretaryCompanionProps) {
  const [position, setPosition] = useState(initialPosition);
  const [open, setOpen] = useState(false);
  const drag = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
  } | null>(null);

  useEffect(() => {
    const onResize = () => {
      setPosition((current) => {
        const next = clampPosition(current);
        savePosition(next);
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const reload = () => setPosition(initialPosition());
    window.addEventListener(PROFILE_RESTORED_EVENT, reload);
    return () => window.removeEventListener(PROFILE_RESTORED_EVENT, reload);
  }, []);

  useEffect(() => {
    if (notice?.trim()) setOpen(true);
  }, [notice]);

  useEffect(() => {
    if (visible === undefined) return;
    setPosition((current) => {
      const hidden = !visible;
      if (current.hidden === hidden) return current;
      const next = { ...current, hidden };
      savePosition(next);
      return next;
    });
  }, [visible]);

  function beginDrag(event: React.PointerEvent<HTMLButtonElement>) {
    drag.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: position.x,
      startY: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setPosition(
      clampPosition({
        ...position,
        x: current.startX + event.clientX - current.originX,
        y: current.startY + event.clientY - current.originY,
      }),
    );
  }

  function endDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setPosition((current) => {
      const next = clampPosition(current);
      savePosition(next);
      return next;
    });
  }

  function setHidden(hidden: boolean) {
    if (visible !== undefined) onVisibilityChange?.(!hidden);
    setOpen(false);
    setPosition((current) => {
      const next = { ...current, hidden };
      savePosition(next);
      return next;
    });
  }

  const hidden = visible === undefined ? position.hidden : !visible;
  const chatEnabled = actionAvailability?.chat ?? Boolean(onInteract);
  const reviewEnabled = actionAvailability?.review ?? Boolean(onReview);
  const outcomeEnabled = actionAvailability?.outcome ?? Boolean(onInteract);

  if (hidden) {
    return (
      <button
        type="button"
        className={`dim-companion-return dim-companion-state-${secretary.state}`}
        onClick={() => setHidden(false)}
        aria-label="唤回秘书"
      >
        <span aria-hidden="true" />
        她在
      </button>
    );
  }

  return (
    <aside
      className="dim-companion"
      style={{ left: position.x, top: position.y }}
      aria-label="独立秘书桌宠"
      data-state={secretary.state}
    >
      <div className="dim-companion-paper">
        <button
          type="button"
          className="dim-companion-drag"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-label="拖动秘书"
          title="拖到顺手的位置"
        >
          <span aria-hidden="true">···</span>
          {secretary.stateCn}
        </button>
        <button
          type="button"
          className="dim-companion-avatar"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-label={open ? "收起秘书对话" : "和秘书说话"}
        >
          <SecretaryPortrait secretary={secretary} />
        </button>
        <button
          type="button"
          className="dim-companion-hide"
          onClick={() => setHidden(true)}
          aria-label="暂时隐藏秘书"
          title="暂时隐藏"
        >
          —
        </button>
      </div>

      {open && (
        <section className="dim-companion-bubble" aria-label="秘书面板">
          <p className="dim-eyebrow">{secretary.eyebrow}</p>
          <h2>{secretary.headline}</h2>
          <p role={notice ? "status" : undefined}>{notice || secretary.note}</p>
          <div className="dim-companion-actions">
            <button
              type="button"
              disabled={!chatEnabled}
              aria-disabled={!chatEnabled}
              title={chatEnabled ? undefined : "秘书对话已在组件设置中关闭"}
              onClick={() => {
                setOpen(false);
                onInteract?.("chat");
              }}
            >
              聊聊
            </button>
            <button
              type="button"
              disabled={!outcomeEnabled}
              aria-disabled={!outcomeEnabled}
              title={outcomeEnabled ? undefined : "结果回收已在组件设置中关闭"}
              onClick={() => {
                setOpen(false);
                onInteract?.("decide");
              }}
            >
              看看有什么要定
            </button>
            <button
              type="button"
              disabled={!reviewEnabled}
              aria-disabled={!reviewEnabled}
              title={reviewEnabled ? undefined : "真实周回顾已在组件设置中关闭"}
              onClick={() => {
                setOpen(false);
                onReview?.();
              }}
            >
              一起回顾
            </button>
            {onSettings && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSettings();
                }}
              >
                设置
              </button>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}
