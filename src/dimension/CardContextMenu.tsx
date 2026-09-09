import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./cardContextMenu.css";

export interface CardContextMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  hint?: string;
}

/** A viewport-owned menu stays clear of the canvas scale and paper stacking. */
export function CardContextMenu({ title, anchor, onClose, items }: {
  title: string;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  items: CardContextMenuItem[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!anchor || !root.current) return;
    if (!root.current.contains(document.activeElement)) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = root.current.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(anchor.x, window.innerWidth - box.width - 8)),
      y: Math.max(8, Math.min(anchor.y, window.innerHeight - box.height - 8)) });
    root.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) closeRef.current();
    };
    const close = () => closeRef.current();
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("resize", close);
      if (document.activeElement === document.body || root.current?.contains(document.activeElement)) returnFocus.current?.focus({ preventScroll: true });
    };
  }, [anchor]);

  if (!anchor) return null;
  return createPortal(<div ref={root} className="dim-card-context-menu" role="menu" aria-label={`卡片设置：${title}`}
    style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault(); event.stopPropagation(); onClose(); return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    }}>
    <div className="dim-card-context-heading"><span>卡片设置</span><strong>{title}</strong></div>
    {items.map(item => <button key={item.id} type="button" role="menuitem" disabled={item.disabled}
      className={item.danger ? "is-danger" : undefined} onClick={() => { onClose(); item.onSelect(); }}>
      <span>{item.label}</span>{item.hint && <small>{item.hint}</small>}
    </button>)}
  </div>, document.body);
}
