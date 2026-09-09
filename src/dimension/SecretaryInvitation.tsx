import { useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { MotionSurface } from "./SurfaceMotion";
import "./secretaryInvitation.css";

/** A quiet invitation stays with the secretary; its paper opens beside her. */
export function SecretaryInvitation({
  children,
  count,
}: {
  children: ReactNode;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 188, top: 50 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    let frame: number | undefined;
    const place = () => {
      frame = undefined;
      const anchor = button.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(panel.current?.offsetWidth || 460, window.innerWidth - 24);
      const next = {
        left: Math.max(12, Math.min(anchor.right + 22, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(anchor.top, window.innerHeight - 280)),
      };
      setPosition((current) => current.left === next.left && current.top === next.top ? current : next);
    };
    const schedulePlace = (event: Event) => {
      // Reading inside the paper must not reposition or rerender the paper.
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      if (frame === undefined) frame = window.requestAnimationFrame(place);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node &&
        !button.current?.contains(event.target) && !panel.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    place();
    panel.current?.focus();
    window.addEventListener("resize", schedulePlace);
    window.addEventListener("scroll", schedulePlace, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedulePlace);
      window.removeEventListener("scroll", schedulePlace, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="dim-secretary-invitation">
      <button
        ref={button}
        type="button"
        className="dim-secretary-invitation__trigger"
        aria-label="秘书找你共创"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="dim-secretary-invitation__dot" aria-hidden="true" />
        <span>{count > 0 ? "有个想法，想和你聊聊" : "看看我们聊过的想法"}</span>
        {count > 1 && <small aria-label={`${count} 个共创候选`}>{count}</small>}
      </button>
      {createPortal(
        <div className="dimension-root dim-secretary-paper-host">
          <AnimatePresence initial={false}>
            {open && <MotionSurface
              key="secretary-paper"
              lift
              ref={panel}
              id={panelId}
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              tabIndex={-1}
              className="dim-secretary-paper"
              style={{
                left: position.left,
                top: position.top,
                maxWidth: `calc(100vw - ${position.left + 12}px)`,
                maxHeight: `min(680px, calc(100dvh - ${position.top + 12}px))`,
              }}
            >
              <header className="dim-secretary-paper__header">
                <div>
                  <p className="dim-eyebrow">秘书想和你聊聊</p>
                  <h2 id={titleId}>一起想想</h2>
                  <p>这里有一些想法，想听听你的看法。</p>
                </div>
                <button type="button" className="dim-secretary-paper__close"
                  aria-label="收起共创卡片" onClick={close}>×</button>
              </header>
              {children}
            </MotionSurface>}
          </AnimatePresence>
        </div>, document.body,
      )}
    </div>
  );
}
