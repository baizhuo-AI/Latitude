import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { MotionSurface } from "./SurfaceMotion";

export interface DesktopCardInventoryItem {
  id: string;
  title: string;
  hidden: boolean;
  inView: boolean;
  custom?: boolean;
}

export function DesktopCardToolbar({
  cards, canUndoArrangement, onCreate, onLocate, onRestore,
  onArrange, onUndoArrangement, onAdjust,
  areas = [], onLocateArea, onArrangeAll,
}: {
  cards: DesktopCardInventoryItem[];
  canUndoArrangement: boolean;
  onCreate: () => void;
  onLocate: (id: string) => void;
  onRestore: (id: string) => void;
  onArrange: () => void;
  onUndoArrangement: () => void;
  onAdjust?: () => void;
  onReview?: () => void;
  scale?: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onResetZoom?: () => void;
  onFitWindow?: () => void;
  areas?: Array<{ id: string; title: string }>;
  onLocateArea?: (id: string) => void;
  onSetHome?: () => void;
  onArrangeAll?: () => void;
}) {
  const [panel, setPanel] = useState<"inventory" | "more" | null>(null);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const inventoryButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const offscreen = cards.filter((card) => !card.hidden && !card.inView).length;
  const removed = cards.filter((card) => card.hidden).length;
  const matching = cards.filter((card) => card.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  useEffect(() => {
    if (!panel) return;
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setPanel(null);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPanel(null);
      (panel === "inventory" ? inventoryButton : moreButton).current?.focus();
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [panel]);

  return (
    <div className="dim-desktop-tools" role="group" aria-label="桌面工具" ref={root}>
      <button type="button" className="dim-btn dim-desktop-add"
        onClick={() => { setPanel(null); onCreate(); }}>＋ 新建</button>
      <button type="button" className="dim-btn dim-btn--quiet" ref={inventoryButton}
        aria-expanded={panel === "inventory"} aria-controls="desktop-card-inventory"
        onClick={() => { setQuery(""); setPanel((current) => current === "inventory" ? null : "inventory"); }}>
        卡片总览 <span className="dim-desktop-count">{cards.length}</span>
      </button>
      {<button type="button" ref={moreButton}
        className="dim-btn dim-btn--quiet dim-desk-more" aria-label="更多桌面操作"
        aria-expanded={panel === "more"} onClick={() => setPanel((current) => current === "more" ? null : "more")}>
        •••
      </button>}
      <AnimatePresence initial={false}>
        {panel === "inventory" && <MotionSurface key="inventory" lift
          className="dim-desktop-inventory" role="region" aria-label="卡片总览" id="desktop-card-inventory">
          <div className="dim-desktop-inventory-heading">
            <div><strong>所有卡片</strong><p>{cards.length - removed} 张在桌面 · {offscreen} 张在视野外 · {removed} 张已移出</p></div>
            <button type="button" className="dim-btn dim-btn--quiet" aria-label="关闭卡片总览"
              onClick={() => { setPanel(null); inventoryButton.current?.focus(); }}>×</button>
          </div>
          {cards.length > 6 && <input className="dim-desktop-card-search" aria-label="查找卡片"
            placeholder="按名称找卡片…" value={query} onChange={(event) => setQuery(event.target.value)} />}
          {areas.length > 0 && <div className="dim-desktop-area-choices" role="group" aria-label="桌面板块">
            {areas.map(area => <button key={area.id} type="button" className="dim-btn dim-btn--quiet"
              onClick={() => { setPanel(null); onLocateArea?.(area.id); }}>{area.title} ↗</button>)}
          </div>}
          <div className="dim-desktop-inventory-list">
            {matching.map((card) => <div className="dim-desktop-inventory-row" key={card.id}>
              <span className={`dim-desktop-card-swatch${card.custom ? " is-note" : ""}`} aria-hidden="true" />
              <div className="dim-desktop-inventory-copy"><strong title={card.title}>{card.title}</strong>
                <small>{card.hidden ? "已移出桌面" : card.inView ? "在当前视野内" : "在视野外"}</small></div>
              <button type="button" className="dim-btn dim-btn--quiet"
                aria-label={`${card.hidden ? "放回桌面" : "定位卡片"}：${card.title}`}
                onClick={() => {
                  setPanel(null);
                  if (card.hidden) onRestore(card.id); else onLocate(card.id);
                }}>{card.hidden ? "放回" : "定位"} <span aria-hidden="true">↗</span></button>
            </div>)}
            {matching.length === 0 && <p className="dim-desktop-inventory-empty">没有找到这张卡片。</p>}
          </div>
        </MotionSurface>}
        {panel === "more" && <MotionSurface key="more" lift className="dim-desktop-more-panel" role="region" aria-label="更多桌面操作">
          <div className="dim-desktop-arrange-group" role="group" aria-label="整理卡片">
            <button type="button" className="dim-btn dim-btn--quiet" onClick={() => { setPanel(null); onArrange(); }}
              disabled={cards.every(card => card.hidden)}>整理当前板块</button>
            {onArrangeAll && <button type="button" className="dim-btn dim-btn--quiet"
              onClick={() => { setPanel(null); onArrangeAll(); }}>整理所有板块</button>}
            {canUndoArrangement && <button type="button" className="dim-btn dim-btn--quiet dim-desktop-undo-arrange"
              onClick={() => { setPanel(null); onUndoArrangement(); }}>撤销整理</button>}
          </div>
          {onAdjust && <button type="button" className="dim-btn dim-btn--quiet" aria-label="调整桌面"
            onClick={() => { setPanel(null); onAdjust(); }}>桌面设置</button>}
        </MotionSurface>}
      </AnimatePresence>
    </div>
  );
}


export function DesktopZoomControls({ scale, onZoomIn, onZoomOut, onResetZoom, locationTools }: {
  locationTools?: ReactNode;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFitWindow?: () => void;
  cards?: DesktopCardInventoryItem[];
}) {
  return <aside className="dim-desktop-camera-controls" aria-label="桌面视野控制">
      {typeof scale === "number" && Number.isFinite(scale) && <div className="dim-desktop-zoom-tools">
        <div className="dim-desktop-zoom" role="group" aria-label="桌面缩放"
          title="可用触控板捏合，或按住 ⌘ / Ctrl 滚动来缩放桌面">
          <button type="button" className="dim-btn dim-btn--quiet" aria-label="缩小桌面"
            disabled={scale <= 0.25 || !onZoomOut} onClick={onZoomOut}>−</button>
          <button type="button" className="dim-btn dim-btn--quiet dim-desktop-zoom-value"
            aria-label="恢复桌面缩放为 100%" title="恢复为 100%" disabled={!onResetZoom}
            onClick={onResetZoom}>{Math.round(scale * 100)}%</button>
          <button type="button" className="dim-btn dim-btn--quiet" aria-label="放大桌面"
            disabled={scale >= 2 || !onZoomIn} onClick={onZoomIn}>＋</button>
        </div>
      </div>}
    {locationTools}
  </aside>;
}

/** Saving and returning use the same camera bookmark, so their controls stay together. */
export function DesktopHomeControls({ onGoHome, onSetHome, disabled, recordingDisabled, className = "" }: {
  onGoHome: () => void;
  onSetHome?: () => void;
  disabled?: boolean;
  recordingDisabled?: boolean;
  className?: string;
}) {
  return <div className={`dim-desktop-home-controls ${className}`} role="group" aria-label="常用区">
    {onSetHome && <button type="button" className="dim-home-remember" disabled={disabled || recordingDisabled}
      title="记住当前视野的位置和缩放，随时回到这里" onClick={onSetHome}>记录常用区</button>}
    <button type="button" className="dim-deck-home" disabled={disabled} onClick={onGoHome}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 10 8-6 8 6v10H4Z" /><path d="M9 20v-7h6v7" /></svg>
      回常用区
    </button>
  </div>;
}
