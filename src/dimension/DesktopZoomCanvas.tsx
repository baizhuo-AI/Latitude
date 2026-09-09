import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../projections/desktop/browserUiComposition";
import { DESKTOP_CANVAS_PADDING as PAPER_PADDING } from "../runtime/layout/cardSpatialGeometry";
import { clampDesktopZoom as clampZoom, DESKTOP_FOCUS_BOUNDS_EVENT, MIN_DESKTOP_ZOOM as MIN_ZOOM, MAX_DESKTOP_ZOOM as MAX_ZOOM, readDesktopCamera, validDesktopBounds } from "./desktopCamera";
import type { DesktopBounds, DesktopCameraPosition, DesktopCameraReason } from "./desktopCamera";
export type { DesktopBounds, DesktopCameraPosition, DesktopCameraReason } from "./desktopCamera";
import "./desktopZoom.css";

/** Deck depth transitions can temporarily scale the entire viewport. Camera
 * state is kept in untransformed desk coordinates even during those frames. */
function viewportScreenScale(viewport: HTMLElement): number {
  return viewport.clientWidth ? viewport.getBoundingClientRect().width / viewport.clientWidth || 1 : 1;
}

function readZoom(key: string) {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? 1 : Number(raw);
    return Number.isFinite(value) && value >= MIN_ZOOM && value <= MAX_ZOOM ? value : 1;
  } catch { return 1; }
}

export interface DesktopZoomHandle {
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  fitWindow(): void;
  focusBounds(bounds: DesktopBounds, options?: { instant?: boolean; remember?: boolean }): void;
  goHome(): void;
  setHome(): void;
  goBack(): void;
}

interface CanvasGeometry {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  originX: number;
  originY: number;
  right: number;
  bottom: number;
  cards: { left: number; top: number; width: number; height: number } | null;
}

/** A camera around the existing layout. Card offsets and sizes stay in paper coordinates. */
export const DesktopZoomCanvas = forwardRef<DesktopZoomHandle, {
  layoutId: string;
  children: ReactNode;
  onScaleChange: (scale: number) => void;
  onNotice?: (message: string) => void;
  includeBounds?: DesktopBounds[];
  onCameraChange?: (camera: DesktopCameraPosition, reason: DesktopCameraReason) => void;
}>(function DesktopZoomCanvas({ layoutId, children, onScaleChange, onNotice, includeBounds = [], onCameraChange }, ref) {
  const storageKey = `dim-desk-zoom-${layoutId}`;
  const cameraKey = `dim-desk-camera-${layoutId}`;
  const [saved] = useState(() => readDesktopCamera(cameraKey));
  const [scale, setScale] = useState(() => saved?.camera.zoom ?? readZoom(storageKey));
  const [cameraRevision, setCameraRevision] = useState(0);
  const [geometry, setGeometry] = useState<CanvasGeometry>({ width: 0, height: 1, viewportWidth: 0, viewportHeight: 0, originX: PAPER_PADDING, originY: PAPER_PADDING, right: 0, bottom: 1, cards: null });
  const canvas = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const scaleRef = useRef(scale);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  const frame = useRef<number>();
  const measureFrame = useRef<number>();
  const onChangeRef = useRef(onScaleChange);
  onChangeRef.current = onScaleChange;
  const cameraRequest = useRef(0);
  const pendingAnchor = useRef<{ x: number; y: number; clientX: number; clientY: number; revision: number } | null>(null);
  const pendingFit = useRef<number | null>(null);
  const committedGeometry = useRef(geometry);
  const mounted = useRef(true);
  const waitingAnimations = useRef(new WeakSet<Animation>());
  const boundsRef = useRef(includeBounds);
  boundsRef.current = includeBounds;
  const cameraCallback = useRef(onCameraChange);
  cameraCallback.current = onCameraChange;
  const position = useRef<DesktopCameraPosition | null>(saved?.camera ?? null);
  const home = useRef<DesktopCameraPosition | null>(saved?.home ?? null);
  const previousPosition = useRef<DesktopCameraPosition | undefined>(saved?.previous);
  const pendingPosition = useRef<{ camera: DesktopCameraPosition; instant: boolean; reason: DesktopCameraReason } | null>(
    saved ? { camera: saved.camera, instant: true, reason: "restore" } : null,
  );
  const travelFrame = useRef<number>();
  const travelAnimation = useRef<Animation>();
  const programmaticTravel = useRef(false);
  const scaleReason = useRef<DesktopCameraReason>("restore");
  const pan = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const persist = useCallback(() => {
    try {
      window.localStorage.setItem(storageKey, String(scaleRef.current));
      if (position.current && home.current) window.localStorage.setItem(cameraKey, JSON.stringify({
        version: 1, camera: position.current, home: home.current,
        ...(previousPosition.current ? { previous: previousPosition.current } : {}),
      }));
    } catch { /* The session remains usable if storage is full or disabled. */ }
  }, [cameraKey, storageKey]);

  const viewCenter = useCallback(() => {
    const viewport = canvas.current?.closest<HTMLElement>(".dim-desk-scroll");
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    const toolbar = viewport.querySelector<HTMLElement>(".dim-desktop-toolbar")?.getBoundingClientRect();
    const usableTop = toolbar?.height ? Math.min(rect.bottom - 40, Math.max(rect.top, toolbar.bottom)) : rect.top;
    return { viewport, x: rect.left + rect.width / 2, y: (usableTop + rect.bottom) / 2 };
  }, []);

  const readPosition = useCallback((): DesktopCameraPosition | null => {
    const center = viewCenter();
    const node = surface.current;
    if (!center || !node || !center.viewport.clientWidth) return position.current;
    const rect = node.getBoundingClientRect();
    const zoom = Number(node.dataset.desktopZoom) || 1;
    const screenZoom = zoom * viewportScreenScale(center.viewport);
    return { x: (center.x - rect.left) / screenZoom, y: (center.y - rect.top) / screenZoom, zoom };
  }, [viewCenter]);

  const reportPosition = useCallback((reason: DesktopCameraReason, force = false) => {
    const next = readPosition();
    if (!next) return;
    const old = position.current;
    if (!force && old && Math.abs(old.x - next.x) < 0.05 && Math.abs(old.y - next.y) < 0.05 && old.zoom === next.zoom) return;
    position.current = next;
    home.current ??= next;
    cameraCallback.current?.(next, reason);
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(persist, 150);
  }, [persist, readPosition]);

  const stopTravel = useCallback(() => {
    if (travelFrame.current !== undefined) cancelAnimationFrame(travelFrame.current);
    travelFrame.current = undefined;
    travelAnimation.current?.cancel();
    travelAnimation.current = undefined;
    programmaticTravel.current = false;
  }, []);

  const ensureCameraRoom = useCallback((target: DesktopCameraPosition) => {
    const viewport = canvas.current?.closest<HTMLElement>(".dim-desk-scroll");
    if (!viewport) return;
    // Make the requested center reachable even for an empty area or negative
    // coordinates. Expansion never writes a paper offset or changes its base.
    const halfWidth = viewport.clientWidth / (2 * target.zoom);
    const halfHeight = viewport.clientHeight / (2 * target.zoom);
    setGeometry((current) => ({ ...current,
      originX: Math.max(current.originX, halfWidth - target.x + PAPER_PADDING),
      originY: Math.max(current.originY, halfHeight - target.y + PAPER_PADDING),
      right: Math.max(current.right, target.x + halfWidth + PAPER_PADDING),
      bottom: Math.max(current.bottom, target.y + halfHeight + PAPER_PADDING),
    }));
  }, []);

  const moveCamera = useCallback((target: DesktopCameraPosition, reason: DesktopCameraReason, instant = false, remember = true) => {
    stopTravel();
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    pendingAnchor.current = null;
    pendingFit.current = null;
    const current = readPosition();
    if (current) {
      home.current ??= current;
      if (remember) previousPosition.current = current;
    }
    pendingPosition.current = { camera: target, instant: instant || Boolean(canvas.current?.closest('[aria-hidden="true"], [inert]')), reason };
    scaleReason.current = reason;
    scaleRef.current = target.zoom;
    ensureCameraRoom(target);
    setScale(target.zoom);
    setCameraRevision(++cameraRequest.current);
  }, [ensureCameraRoom, readPosition, stopTravel]);

  const measure = useCallback(() => {
    const node = surface.current;
    const root = canvas.current;
    if (!node || !root || !root.clientWidth) return;
    // Rebase old negative offsets only after a gesture. Moving the camera while
    // the pointer is captured would make an otherwise correct drag feel slippery.
    if (node.querySelector(".is-dragging, .is-resizing")) return;
    const moving = (node.getAnimations?.({ subtree: true }) ?? []).filter((animation) =>
      animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity,
    );
    if (moving.length) {
      for (const animation of moving) {
        if (waitingAnimations.current.has(animation)) continue;
        waitingAnimations.current.add(animation);
        animation.finished.catch(() => {}).then(() => { if (mounted.current) measure(); });
      }
      return;
    }
    const viewport = root.closest<HTMLElement>(".dim-desk-scroll");
    const outerZoom = viewport ? viewportScreenScale(viewport) : 1;
    const zoom = (Number(node.dataset.desktopZoom) || 1) * outerZoom;
    const rect = node.getBoundingClientRect();
    const papers = Array.from(node.querySelectorAll<HTMLElement>("[data-spatial-card-id], [data-desktop-anchor]"));
    const boxes = papers.map((paper) => {
      const box = paper.getBoundingClientRect();
      return { left: (box.left - rect.left) / zoom, top: (box.top - rect.top) / zoom, right: (box.right - rect.left) / zoom, bottom: (box.bottom - rect.top) / zoom };
    });
    for (const box of boundsRef.current.filter(validDesktopBounds)) boxes.push({ left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height });
    const left = boxes.length ? Math.min(...boxes.map((box) => box.left)) : 0;
    const top = boxes.length ? Math.min(...boxes.map((box) => box.top)) : 0;
    const right = boxes.length ? Math.max(...boxes.map((box) => box.right)) : 0;
    const bottom = boxes.length ? Math.max(...boxes.map((box) => box.bottom)) : 0;
    const viewRect = viewport?.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const canvasLeft = viewRect ? (rootRect.left - viewRect.left) / outerZoom + (viewport?.scrollLeft ?? 0) : 0;
    const canvasTop = viewRect ? (rootRect.top - viewRect.top) / outerZoom + (viewport?.scrollTop ?? 0) : 0;
    setGeometry((current) => {
      const next: CanvasGeometry = {
        width: Math.max(1, root.clientWidth - PAPER_PADDING * 2),
        height: node.offsetHeight,
        viewportWidth: Math.max(1, (viewport?.clientWidth ?? root.clientWidth) - canvasLeft),
        viewportHeight: Math.max(1, (viewport?.clientHeight ?? node.offsetHeight) - canvasTop),
        // Keep used canvas space after an ordinary move/resize. Shrinking an
        // edge would clamp scroll offsets and move every untouched paper.
        originX: Math.max(current.originX, PAPER_PADDING - Math.min(0, left)),
        originY: Math.max(current.originY, PAPER_PADDING - Math.min(0, top)),
        right: Math.max(current.right, node.offsetWidth, right),
        bottom: Math.max(current.bottom, node.offsetHeight, bottom),
        cards: boxes.length ? { left, top, width: right - left, height: bottom - top } : null,
      };
      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (measureFrame.current !== undefined) return;
    measureFrame.current = requestAnimationFrame(() => { measureFrame.current = undefined; measure(); });
  }, [measure]);

  useLayoutEffect(() => { measure(); }, [measure, children, includeBounds]);

  useEffect(() => {
    const node = surface.current;
    const root = canvas.current;
    if (!node || !root) return;
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleMeasure);
    resize?.observe(root);
    resize?.observe(node);
    const observePapers = () => node.querySelectorAll<HTMLElement>("[data-spatial-card-id]").forEach((paper) => resize?.observe(paper));
    observePapers();
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList")) observePapers();
      scheduleMeasure();
    });
    mutations.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
    node.addEventListener("transitionend", scheduleMeasure);
    node.addEventListener("animationend", scheduleMeasure);
    // WAAPI card placement finishes after 230 ms; read final bounds as well.
    const settled = () => {
      scheduleMeasure();
    };
    node.addEventListener("pointerup", settled);
    root.closest(".dim-desk-scroll")?.addEventListener("click", settled);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      resize?.disconnect(); mutations.disconnect();
      node.removeEventListener("transitionend", scheduleMeasure);
      node.removeEventListener("animationend", scheduleMeasure);
      node.removeEventListener("pointerup", settled);
      root.closest(".dim-desk-scroll")?.removeEventListener("click", settled);
      window.removeEventListener("resize", scheduleMeasure);
      if (measureFrame.current !== undefined) cancelAnimationFrame(measureFrame.current);
    };
  }, [scheduleMeasure]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const changeScale = useCallback((requested: number, anchor?: { clientX: number; clientY: number }, fit = false) => {
    const node = surface.current;
    const viewport = canvas.current?.closest<HTMLElement>(".dim-desk-scroll");
    if (!node || !viewport || !Number.isFinite(requested)) return;
    stopTravel();
    pendingPosition.current = null;
    scaleReason.current = "zoom";
    if (node.querySelector(".is-dragging, .is-resizing")) return;
    const rect = node.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    const point = anchor ?? { clientX: view.left + view.width / 2, clientY: view.top + view.height / 2 };
    const previous = (Number(node.dataset.desktopZoom) || 1) * viewportScreenScale(viewport);
    const revision = ++cameraRequest.current;
    pendingAnchor.current = { x: (point.clientX - rect.left) / previous, y: (point.clientY - rect.top) / previous, ...point, revision };
    pendingFit.current = fit ? revision : null;
    const next = clampZoom(requested);
    scaleRef.current = next;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      setScale(next);
      setCameraRevision(revision);
    });
  }, [stopTravel]);

  const resetZoom = useCallback(() => { changeScale(1); }, [changeScale]);
  const fitWindow = useCallback(() => {
    const root = canvas.current;
    const viewport = root?.closest<HTMLElement>(".dim-desk-scroll");
    const bounds = geometryRef.current.cards;
    const current = readPosition();
    if (current) previousPosition.current = current;
    if (!root || !viewport || !bounds) { resetZoom(); return; }
    const initialTop = (root.getBoundingClientRect().top - viewport.getBoundingClientRect().top) / viewportScreenScale(viewport) + viewport.scrollTop;
    const width = root.clientWidth;
    const height = Math.max(1, viewport.clientHeight - initialTop - PAPER_PADDING);
    const fit = Math.min(1, width / (bounds.width + PAPER_PADDING * 2), height / (bounds.height + PAPER_PADDING * 2));
    changeScale(Math.floor(clampZoom(fit) * 100) / 100, undefined, true);
    if (fit < MIN_ZOOM) onNotice?.("已缩到最小 25%，其余卡片可以滚动查看或从总览定位。");
  }, [changeScale, onNotice, readPosition, resetZoom]);

  const focusBounds = useCallback((bounds: DesktopBounds, options: { instant?: boolean; remember?: boolean } = {}) => {
    if (!validDesktopBounds(bounds)) return;
    const viewport = canvas.current?.closest<HTMLElement>(".dim-desk-scroll");
    if (!viewport) return;
    const available = geometryRef.current;
    const fit = Math.min(1, (available.viewportWidth || viewport.clientWidth || 1000) / (bounds.width + 72),
      (available.viewportHeight || viewport.clientHeight || 700) / (bounds.height + 72));
    moveCamera({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2, zoom: clampZoom(Math.min(scaleRef.current, fit)) },
      "focus", options.instant ?? false, options.remember ?? true);
  }, [moveCamera]);
  const goHome = useCallback(() => {
    const target = home.current;
    if (target) moveCamera(target, "home");
  }, [moveCamera]);
  const setHome = useCallback(() => {
    home.current = readPosition();
    reportPosition("home", true);
    persist();
    onNotice?.("已将这里设为常用区。");
  }, [onNotice, persist, readPosition, reportPosition]);
  const goBack = useCallback(() => {
    const target = previousPosition.current;
    if (target) moveCamera(target, "back");
  }, [moveCamera]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => changeScale(Math.round((scaleRef.current + 0.1) * 100) / 100),
    zoomOut: () => changeScale(Math.round((scaleRef.current - 0.1) * 100) / 100),
    resetZoom, fitWindow, focusBounds, goHome, setHome, goBack,
  }), [changeScale, resetZoom, fitWindow, focusBounds, goHome, setHome, goBack]);

  useLayoutEffect(() => {
    const viewport = canvas.current?.closest<HTMLElement>(".dim-desk-scroll");
    const node = surface.current;
    if (!viewport || !node) return;
    if (pendingPosition.current && geometry.width > 0) {
      const request = pendingPosition.current;
      const target = request.camera;
      const neededX = viewport.clientWidth / (2 * target.zoom) - target.x + PAPER_PADDING;
      const neededY = viewport.clientHeight / (2 * target.zoom) - target.y + PAPER_PADDING;
      if (geometry.originX < neededX || geometry.originY < neededY || geometry.right < target.x + viewport.clientWidth / (2 * target.zoom) || geometry.bottom < target.y + viewport.clientHeight / (2 * target.zoom)) {
        ensureCameraRoom(target);
        return;
      }
      pendingPosition.current = null;
      const center = viewCenter();
      if (!center) return;
      const oldGeometry = committedGeometry.current;
      if (oldGeometry.width > 0) {
        viewport.scrollLeft += (geometry.originX - oldGeometry.originX) * scale;
        viewport.scrollTop += (geometry.originY - oldGeometry.originY) * scale;
      }
      const rect = node.getBoundingClientRect();
      const fromX = viewport.scrollLeft;
      const fromY = viewport.scrollTop;
      const outerZoom = viewportScreenScale(viewport);
      const toX = Math.max(0, fromX + (rect.left + target.x * scale * outerZoom - center.x) / outerZoom);
      const toY = Math.max(0, fromY + (rect.top + target.y * scale * outerZoom - center.y) / outerZoom);
      const distance = Math.hypot(toX - fromX, toY - fromY);
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const finish = () => {
        viewport.scrollLeft = toX;
        viewport.scrollTop = toY;
        programmaticTravel.current = false;
        reportPosition(request.reason, true);
      };
      // A far area is revealed in place; a near jump glides briefly. The deck
      // supplies the separate high-speed passage when switching whole views.
      if (request.instant || reduced || distance > Math.max(viewport.clientWidth, viewport.clientHeight) * 1.4) {
        finish();
        if (!request.instant && !reduced && node.animate) travelAnimation.current = node.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
      } else {
        const start = performance.now();
        programmaticTravel.current = true;
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / 280);
          const eased = 1 - Math.pow(1 - t, 3);
          viewport.scrollLeft = fromX + (toX - fromX) * eased;
          viewport.scrollTop = fromY + (toY - fromY) * eased;
          if (t < 1) travelFrame.current = requestAnimationFrame(tick);
          else { travelFrame.current = undefined; finish(); }
        };
        travelFrame.current = requestAnimationFrame(tick);
      }
      committedGeometry.current = geometry;
      onChangeRef.current(scale);
      return;
    }
    const previous = committedGeometry.current;
    // Keep the same desk center when the window is resized. A percentage of
    // scrollable space would drift as neighboring regions grow or disappear.
    if (!pendingAnchor.current && position.current && previous.width > 0
      && (geometry.viewportWidth !== previous.viewportWidth || geometry.viewportHeight !== previous.viewportHeight)) {
      pendingPosition.current = { camera: position.current, instant: true, reason: "restore" };
      ensureCameraRoom(position.current);
      return;
    }
    committedGeometry.current = geometry;
    // A geometry read can commit before the requested zoom animation frame.
    // It must not consume that future zoom's anchor or compensate it twice.
    const anchor = pendingAnchor.current?.revision === cameraRevision ? pendingAnchor.current : null;
    if (anchor) pendingAnchor.current = null;
    const fitting = pendingFit.current === cameraRevision;
    if (fitting) pendingFit.current = null;
    if (fitting && geometry.cards) {
      viewport.scrollLeft = Math.max(0, (geometry.cards.left + geometry.originX) * scale - PAPER_PADDING);
      viewport.scrollTop = Math.max(0, (geometry.cards.top + geometry.originY) * scale - PAPER_PADDING);
    } else if (anchor) {
      const rect = node.getBoundingClientRect();
      const outerZoom = viewportScreenScale(viewport);
      viewport.scrollLeft += (rect.left + anchor.x * scale * outerZoom - anchor.clientX) / outerZoom;
      viewport.scrollTop += (rect.top + anchor.y * scale * outerZoom - anchor.clientY) / outerZoom;
    } else if (previous.width > 0 || geometry.originX !== PAPER_PADDING || geometry.originY !== PAPER_PADDING) {
      // Expanding toward negative paper coordinates changes the surface's
      // origin. Advance the scroll by the same pixels so other cards stay put.
      viewport.scrollLeft += (geometry.originX - previous.originX) * scale;
      viewport.scrollTop += (geometry.originY - previous.originY) * scale;
    }
    onChangeRef.current(scale);
    if (!pendingPosition.current && !programmaticTravel.current && geometry.width > 0) reportPosition(scaleReason.current);
  }, [scale, geometry, cameraRevision, ensureCameraRoom, reportPosition, viewCenter]);

  useEffect(() => {
    const reload = () => {
      stopTravel();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      clearTimeout(persistTimer.current);
      pendingAnchor.current = null; pendingFit.current = null;
      pan.current = null;
      canvas.current?.closest(".dim-desk-scroll")?.classList.remove("is-panning", "is-pan-ready");
      const snapshot = readDesktopCamera(cameraKey);
      home.current = snapshot?.home ?? null;
      previousPosition.current = snapshot?.previous;
      position.current = snapshot?.camera ?? null;
      scaleRef.current = snapshot?.camera.zoom ?? readZoom(storageKey);
      setScale(scaleRef.current);
      pendingPosition.current = snapshot ? { camera: snapshot.camera, reason: "restore", instant: true } : null;
      if (snapshot) ensureCameraRoom(snapshot.camera);
      setCameraRevision(++cameraRequest.current);
      scheduleMeasure();
    };
    window.addEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
    const storage = (event: StorageEvent) => { if ([storageKey, cameraKey, null].includes(event.key)) reload(); };
    window.addEventListener("storage", storage);
    const flush = () => { if (!programmaticTravel.current) position.current = readPosition(); persist(); };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
      window.removeEventListener("storage", storage);
      window.removeEventListener("pagehide", flush);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      clearTimeout(persistTimer.current);
      stopTravel();
      // Refs may already be detached during unmount; the last reported camera
      // remains the canonical point to persist then.
      persist();
    };
  }, [storageKey, cameraKey, scheduleMeasure, ensureCameraRoom, persist, readPosition, stopTravel]);

  useEffect(() => {
    const viewport = canvas.current?.closest<HTMLElement>(".dim-desk-scroll");
    if (!viewport) return;
    let gestureBase: number | null = null;
    let spaceHeld = false;
    const editable = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    const panBy = (dx: number, dy: number) => {
      const current = pendingPosition.current?.camera ?? readPosition();
      if (!current) return;
      moveCamera({ ...current, x: current.x + dx / current.zoom, y: current.y + dy / current.zoom }, "pan", true, false);
    };
    const wheel = (event: WheelEvent) => {
      // Wheel gestures always stay in this desk; a scrollable card body gets
      // first use of ordinary scrolling, including at its own scroll boundary.
      event.stopPropagation();
      if (!event.ctrlKey && !event.metaKey) {
        let target = event.target instanceof HTMLElement ? event.target : null;
        while (target && target !== viewport) {
          const style = getComputedStyle(target);
          if ((/(auto|scroll)/.test(style.overflowY) && target.scrollHeight > target.clientHeight)
            || (/(auto|scroll)/.test(style.overflowX) && target.scrollWidth > target.clientWidth)) return;
          target = target.parentElement;
        }
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
        panBy((event.shiftKey ? event.deltaY : event.deltaX) * unit, (event.shiftKey ? 0 : event.deltaY) * unit);
        return;
      }
      event.preventDefault(); event.stopPropagation();
      if (gestureBase !== null) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      changeScale(scaleRef.current * Math.exp(-delta * 0.008), event);
    };
    const key = (event: KeyboardEvent) => {
      if (event.code === "Space" && !editable(event.target)
        && !(event.target instanceof Element && event.target.closest('button, a[href], [role="button"]'))) {
        spaceHeld = true;
        viewport.classList.add("is-pan-ready");
        event.preventDefault();
        return;
      }
      if ((!event.ctrlKey && !event.metaKey) || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      if (!["+", "=", "-", "0"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "0") resetZoom();
      else changeScale(scaleRef.current + (event.key === "-" ? -0.1 : 0.1));
    };
    const releaseSpace = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceHeld = false;
      viewport.classList.remove("is-pan-ready");
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || editable(event.target) || !(event.target instanceof Element)) return;
      const target = event.target;
      const isPaper = Boolean(target.closest("[data-spatial-card-id]"));
      if ((!spaceHeld && (isPaper || target.closest("button, a, [role=button], [data-no-drag]")))
        || (!spaceHeld && !target.closest(".dim-desktop-canvas"))) return;
      stopTravel();
      canvas.current?.focus({ preventScroll: true });
      pendingPosition.current = null;
      pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      viewport.classList.add("is-panning");
      viewport.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };
    const pointerMove = (event: PointerEvent) => {
      const current = pan.current;
      if (!current || current.pointerId !== event.pointerId) return;
      panBy(current.x - event.clientX, current.y - event.clientY);
      current.x = event.clientX;
      current.y = event.clientY;
      event.preventDefault();
      event.stopPropagation();
    };
    const pointerUp = (event: PointerEvent) => {
      if (pan.current?.pointerId !== event.pointerId) return;
      pan.current = null;
      viewport.classList.remove("is-panning");
      if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };
    const blur = () => {
      spaceHeld = false;
      pan.current = null;
      viewport.classList.remove("is-pan-ready", "is-panning");
    };
    const scroll = () => { if (!programmaticTravel.current && !pendingPosition.current) reportPosition("pan"); };
    const focus = (event: Event) => {
      const bounds = (event as CustomEvent<DesktopBounds>).detail;
      if (!bounds || !(event.target instanceof Element) || !canvas.current?.contains(event.target)) return;
      event.stopPropagation();
      event.preventDefault();
      focusBounds(bounds);
    };
    const gestureStart = (event: Event) => { event.preventDefault(); event.stopPropagation(); gestureBase = scaleRef.current; };
    const gestureChange = (event: Event) => {
      event.preventDefault(); event.stopPropagation();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      if (gestureBase === null || typeof gesture.scale !== "number") return;
      const anchor = typeof gesture.clientX === "number" && typeof gesture.clientY === "number" ? { clientX: gesture.clientX, clientY: gesture.clientY } : undefined;
      changeScale(gestureBase * gesture.scale, anchor);
    };
    const gestureEnd = (event: Event) => { event.preventDefault(); event.stopPropagation(); gestureBase = null; };
    viewport.addEventListener("wheel", wheel, { passive: false });
    viewport.addEventListener("pointerdown", pointerDown, true);
    viewport.addEventListener("pointermove", pointerMove, true);
    viewport.addEventListener("pointerup", pointerUp, true);
    viewport.addEventListener("pointercancel", pointerUp, true);
    viewport.addEventListener("scroll", scroll, { passive: true });
    viewport.addEventListener(DESKTOP_FOCUS_BOUNDS_EVENT, focus);
    window.addEventListener("keyup", releaseSpace);
    window.addEventListener("blur", blur);
    viewport.addEventListener("keydown", key);
    viewport.addEventListener("gesturestart", gestureStart, { passive: false });
    viewport.addEventListener("gesturechange", gestureChange, { passive: false });
    viewport.addEventListener("gestureend", gestureEnd, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("pointerdown", pointerDown, true);
      viewport.removeEventListener("pointermove", pointerMove, true);
      viewport.removeEventListener("pointerup", pointerUp, true);
      viewport.removeEventListener("pointercancel", pointerUp, true);
      viewport.removeEventListener("scroll", scroll);
      viewport.removeEventListener(DESKTOP_FOCUS_BOUNDS_EVENT, focus);
      window.removeEventListener("keyup", releaseSpace);
      window.removeEventListener("blur", blur);
      blur();
      viewport.removeEventListener("keydown", key);
      viewport.removeEventListener("gesturestart", gestureStart);
      viewport.removeEventListener("gesturechange", gestureChange);
      viewport.removeEventListener("gestureend", gestureEnd);
    };
  }, [changeScale, resetZoom, focusBounds, moveCamera, readPosition, reportPosition, stopTravel]);

  return <div ref={canvas} className="dim-desktop-canvas" data-desktop-camera tabIndex={0} aria-label="桌面画布，空白处拖动平移">
    <div className="dim-desktop-zoom-space" style={{
      // At low zoom the papers may be smaller than the viewport. Negative-edge
      // growth still needs real overflow, otherwise the browser rejects the
      // compensating scroll and all papers visibly jump by the new padding.
      width: Math.max(1, (geometry.originX + geometry.right + PAPER_PADDING) * scale,
        geometry.originX > PAPER_PADDING ? geometry.viewportWidth + (geometry.originX - PAPER_PADDING) * scale : 0),
      height: Math.max(1, (geometry.originY + geometry.bottom + PAPER_PADDING) * scale,
        geometry.originY > PAPER_PADDING ? geometry.viewportHeight + (geometry.originY - PAPER_PADDING) * scale : 0),
    }}>
      <div ref={surface} className="dim-desk-zoom-surface" data-desktop-zoom={scale}
        style={{ width: geometry.width || "calc(100% - 24px)", left: geometry.originX * scale, top: geometry.originY * scale, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  </div>;
});
