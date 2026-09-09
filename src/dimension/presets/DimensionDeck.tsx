import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { DesktopHomeControls } from "../DesktopCardToolbar";
import type { DimensionPresetId } from "./presetQuery";
import { createDeckMotion, DEPTH_MS, STAR_GATHER_MS } from "./PassageTransition";
import "./deck.css";

const useDeckLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Views stay mounted; navigation changes the view, while canvas gestures stay local. */
const LAYERS: readonly { id: DimensionPresetId; label: string; ariaLabel: string }[] = [
  { id: "constellation", label: "星图", ariaLabel: "星图桌面" },
  { id: "clue-board", label: "线索版", ariaLabel: "线索板桌面" },
  { id: "paper", label: "主页", ariaLabel: "纸面桌面" }
];
type DeckTransition = { from: number; to: number; kind: "passage" | "depth"; direction: "up" | "down" };

export interface DimensionDeckProps {
  active: DimensionPresetId;
  onChange: (next: DimensionPresetId) => void;
  desk: ReactNode;
  clueBoard: ReactNode;
  constellation: ReactNode;
  /** Restore the default camera position on the shared desktop. */
  onGoHome?: () => void;
  onSetHome?: () => void;
  navigationVisible?: boolean;
  actionAvailability?: { paper: boolean; clue: boolean; constellation: boolean };
}
function layerIndex(id: DimensionPresetId): number {
  const index = LAYERS.findIndex(layer => layer.id === id);
  return index >= 0 ? index : LAYERS.length - 1;
}
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
const KEYBOARD_OWNING_SELECTOR = [
  "input", "textarea", "select", "button", "a[href]",
  '[contenteditable]:not([contenteditable="false"])', '[data-deck-scroll="contain"]',
  '[role="button"]', '[role="textbox"]', '[role="combobox"]', '[role="listbox"]',
  '[role="menuitem"]', '[role="slider"]', '[role="spinbutton"]', '[role="switch"]', '[role="tab"]'
].join(",");
function ownsPageKey(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(KEYBOARD_OWNING_SELECTOR) !== null;
}
function hasOpenModalDialog(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], dialog[open]')]
    .some(dialog => !dialog.hidden && dialog.getAttribute("aria-hidden") !== "true");
}

export function DimensionDeck({
  active, onChange, desk, clueBoard, constellation, onGoHome, onSetHome,
  navigationVisible = true,
  actionAvailability = { paper: true, clue: true, constellation: true }
}: DimensionDeckProps) {
  const index = layerIndex(active);
  const navigationReady = navigationVisible && actionAvailability.paper && actionAvailability.clue && actionAvailability.constellation;
  const rootRef = useRef<HTMLDivElement>(null);
  const motion = useRef<ReturnType<typeof createDeckMotion> | null>(null);
  const previousIndex = useRef(index);
  const [transition, setTransition] = useState<DeckTransition | null>(null);
  const [starPhase, setStarPhase] = useState<"gathering" | "dispersing" | null>(null);
  const starTimer = useRef<number | undefined>(undefined);

  useDeckLayoutEffect(() => {
    if (!rootRef.current) return;
    motion.current = createDeckMotion(rootRef.current, LAYERS[previousIndex.current].id);
    return () => { motion.current?.dispose(); motion.current = null; window.clearTimeout(starTimer.current); };
  }, []);

  // Controlled changes (clue entries, history, rail, keyboard) share one timeline.
  useDeckLayoutEffect(() => {
    const from = previousIndex.current;
    if (from === index) return;
    previousIndex.current = index;
    const fromId = LAYERS[from].id;
    const toId = LAYERS[index].id;
    const reduced = prefersReducedMotion();
    const kind = fromId === "constellation" || toId === "constellation" ? "depth" : "passage";
    setTransition(reduced ? null : { from, to: index, kind, direction: index < from ? "up" : "down" });
    window.clearTimeout(starTimer.current);
    if (kind === "depth" && !reduced) {
      const phase = toId === "constellation" ? "gathering" : "dispersing";
      setStarPhase(phase);
      starTimer.current = window.setTimeout(() => setStarPhase(null), phase === "gathering" ? STAR_GATHER_MS : DEPTH_MS);
    } else setStarPhase(null);
    motion.current?.go(fromId, toId, reduced, () => setTransition(null));
  }, [index]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const reduce = () => {
      if (!media?.matches) return;
      motion.current?.finish();
      window.clearTimeout(starTimer.current);
      setStarPhase(null);
    };
    media?.addEventListener?.("change", reduce);
    return () => media?.removeEventListener?.("change", reduce);
  }, []);

  const go = useCallback((nextIndex: number) => {
    if (!navigationReady) return;
    const next = Math.max(0, Math.min(LAYERS.length - 1, nextIndex));
    if (next !== index) onChange(LAYERS[next].id);
  }, [index, navigationReady, onChange]);

  useEffect(() => {
    if (!navigationReady && active !== "paper") onChange("paper");
  }, [active, navigationReady, onChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!navigationReady || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (hasOpenModalDialog() || ownsPageKey(event.target)) return;
      if (event.key === "PageUp" || event.key === "PageDown") {
        const next = index + (event.key === "PageUp" ? -1 : 1);
        if (next < 0 || next >= LAYERS.length) return;
        event.preventDefault(); go(next);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, index, navigationReady]);

  // Outgoing content remains visible during travel but cannot retain focus or receive input.
  useDeckLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const layers = root.querySelectorAll<HTMLElement>("[data-deck-layer]");
    const focused = document.activeElement;
    layers.forEach((layer, i) => {
      if (i !== index && focused && layer.contains(focused)) {
        root.querySelector<HTMLButtonElement>(`[data-view-target="${active}"]`)?.focus({ preventScroll: true });
      }
      layer.toggleAttribute("inert", i !== index);
    });
  }, [active, index]);

  const contents: ReactNode[] = [constellation, clueBoard, desk];
  return (
    <div ref={rootRef} className="dim-deck" data-active={active}
      data-moving={transition ? true : undefined} data-transition={transition?.kind}
      data-direction={transition?.direction} data-star-gather={starPhase ?? undefined}
      data-navigation-visible={navigationVisible ? "true" : "false"}>
      <div className="dim-deck-backdrop dim-deck-backdrop-board" aria-hidden="true" />
      <div className="dim-deck-backdrop dim-deck-backdrop-desk" aria-hidden="true" />
      <div className="dim-deck-track">
        {LAYERS.map((layer, i) => (
          <section key={layer.id} className="dim-deck-layer" data-deck-layer={layer.id}
            data-pos={i === index ? "active" : i < index ? "above" : "below"}
            data-motion={transition && i === transition.from ? "leaving" : transition && i === transition.to ? "entering" : undefined}
            data-star-gather={layer.id === "constellation" ? starPhase ?? undefined : undefined}
            aria-hidden={i !== index} aria-label={layer.ariaLabel}>
            <div className="dim-deck-layer-inner">{contents[i]}</div>
          </section>
        ))}
      </div>
      <canvas className="dim-deck-passage" aria-hidden="true" />
      {navigationVisible && <nav className="dim-deck-rail" aria-label="桌面视图">
        {LAYERS.map((layer, i) => (
          <button key={layer.id} type="button" className="dim-deck-rail-stop"
            aria-label={layer.ariaLabel} aria-pressed={i === index} data-view-target={layer.id}
            data-on={i === index ? "true" : undefined} disabled={!navigationReady}
            aria-disabled={!navigationReady} title={navigationReady ? undefined : "视图导航已在组件设置中关闭"}
            onClick={() => go(i)}>
            <span className="dim-deck-rail-dot" aria-hidden="true" />
            <span className="dim-deck-rail-label">{layer.label}</span>
          </button>
        ))}
      </nav>}
      {navigationVisible && onGoHome && <DesktopHomeControls className="dim-deck-home-controls"
        disabled={!actionAvailability.paper} recordingDisabled={Boolean(transition)}
        onSetHome={active === "paper" ? onSetHome : undefined}
        onGoHome={() => { onGoHome(); if (active !== "paper") onChange("paper"); }} />}
    </div>
  );
}
