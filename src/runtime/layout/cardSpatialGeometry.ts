export interface SpatialRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SpatialPoint { x: number; y: number }

/** The camera keeps this gutter even when there are no negative card offsets. */
export const DESKTOP_CANVAS_PADDING = 12;

/** Screen-space rectangles and pointer deltas must be converted to the desk's
 * logical coordinates before saving layout state. Browser page zoom is already
 * accounted for by client coordinates; only our explicit desk transform counts. */
export function desktopZoomFor(element: Element): number {
  const value = Number(element.closest<HTMLElement>("[data-desktop-zoom]")?.dataset.desktopZoom);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** The toolbar and viewport padding are not usable paper space. */
export function cardViewportBounds(card: HTMLElement): SpatialRect | undefined {
  const viewport = card.closest<HTMLElement>(".dim-desk-scroll");
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const toolbar = viewport.querySelector<HTMLElement>(".dim-desktop-toolbar");
  const toolbarRect = toolbar?.getBoundingClientRect();
  const connectionRect = viewport.querySelector<HTMLElement>(".dim-desktop-connection")?.getBoundingClientRect();
  const canvasRect = viewport.querySelector<HTMLElement>(".dim-grid-wrap")?.getBoundingClientRect();
  const surfaceRect = card.closest<HTMLElement>("[data-desktop-zoom]")?.getBoundingClientRect();
  const zoomed = Boolean(surfaceRect);
  const stageRect = card.closest<HTMLElement>(".dim-desktop-canvas")?.getBoundingClientRect();
  const gridRect = card.closest<HTMLElement>(".dim-grid")?.getBoundingClientRect() ?? canvasRect;
  // Arrangement will remove negative offsets. Use the grid's natural top with
  // its normal gutter, independent of extra camera padding for old lost cards.
  const canvasTop = zoomed && stageRect && surfaceRect
    ? stageRect.top + DESKTOP_CANVAS_PADDING * desktopZoomFor(card) + ((gridRect?.top ?? surfaceRect.top) - surfaceRect.top)
    : canvasRect?.top;
  const left = zoomed ? rect.left + 12 : Math.max(rect.left + 12, canvasRect?.left ?? rect.left + 12);
  // A zoomed-out desktop has useful empty space beyond its original grid width.
  // Keep that space reachable instead of treating the shrunken grid as a wall.
  const right = zoomed
    ? rect.right - 12
    : Math.min(rect.right - 12, canvasRect?.right ?? rect.right - 12);
  const top = Math.max(
    rect.top + 12,
    canvasTop ?? rect.top + 12,
    toolbarRect?.height ? Math.min(rect.bottom - 60, toolbarRect.bottom + 12) : rect.top + 12,
    connectionRect?.height ? Math.min(rect.bottom - 60, connectionRect.bottom + 12) : rect.top + 12,
  );
  const bottom = rect.bottom - 12;
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Keep a title-sized grab area reachable, while still allowing cards to overlap. */
export function clampCardTitleToBounds(rect: SpatialRect, bounds: SpatialRect): SpatialPoint {
  const grabWidth = Math.min(144, rect.width, bounds.width);
  const grabHeight = Math.min(48, rect.height, bounds.height);
  const left = Math.min(Math.max(rect.left, bounds.left), bounds.right - grabWidth);
  const top = Math.min(Math.max(rect.top, bounds.top), bounds.bottom - grabHeight);
  return { x: left - rect.left, y: top - rect.top };
}

/** Find brings the entire paper into view when it fits, otherwise its top edge. */
export function locateCardCorrection(rect: SpatialRect, bounds: SpatialRect): SpatialPoint {
  const left = bounds.left + Math.max(0, (bounds.width - rect.width) / 2);
  const top = bounds.top + Math.max(0, (bounds.height - rect.height) / 3);
  return { x: left - rect.left, y: top - rect.top };
}

export function cardIsInView(rect: SpatialRect, bounds: SpatialRect): boolean {
  const tolerance = 3;
  // A user-sized tall/wide paper is findable once its title and primary controls
  // are reachable; its deliberate content size must not make it permanently lost.
  const right = rect.width > bounds.width ? rect.left + Math.min(240, bounds.width) : rect.right;
  const bottom = rect.height > bounds.height ? rect.top + Math.min(72, bounds.height) : rect.bottom;
  return rect.width > 0 && rect.height > 0 &&
    rect.left >= bounds.left - tolerance && right <= bounds.right + tolerance &&
    rect.top >= bounds.top - tolerance && bottom <= bounds.bottom + tolerance;
}

export function arrangedCardSize(width: number, height: number, count: number, gap = 16) {
  const columns = width >= 980 ? 3 : width >= 620 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(count / columns));
  return {
    width: Math.floor((width - gap * (columns - 1)) / columns),
    height: Math.round(Math.max(190, Math.min(320, (height - gap * (rows - 1)) / rows))),
  };
}
