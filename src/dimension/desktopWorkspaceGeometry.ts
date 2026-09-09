import { readDesktopFrames, type DesktopCardFrame, type DesktopCardFrames } from "../runtime/layout/desktopFrameStorage";
import { readLegacyDesktopCardGeometry, type LegacyDesktopCardGeometry } from "./custom-cards/legacyDesktopMigration";
import type { CustomDesktopCard } from "./custom-cards/model";
import type { DesktopBounds } from "./desktopCamera";

function readMap(key: string): Record<string, Record<string, unknown>> {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Allocation uses the actual occupied space, not only each paper's old base.
 * This is a read-only envelope: persisted drag and resize records stay intact. */
export function readOccupiedDesktopFrames(layoutId: string): DesktopCardFrames {
  const frames = readDesktopFrames(`dim-desk-frames-${layoutId}`) ?? {};
  const offsets = readMap(`dim-desk-offsets-${layoutId}`);
  const sizes = readMap(`dim-desk-sizes-${layoutId}`);
  const ids = new Set([...Object.keys(frames), ...Object.keys(offsets), ...Object.keys(sizes)]);
  return Object.fromEntries([...ids].map(id => {
    const base = frames[id];
    const offset = offsets[id];
    const size = sizes[id];
    // A legacy grid without absolute frames cannot provide its exact base.
    // Reserve its original row width conservatively before allocating regions.
    return [id, {
      x: (base?.x ?? 1200) + (finite(offset?.x) ? offset.x : 0),
      y: (base?.y ?? 0) + (finite(offset?.y) ? offset.y : 0),
      width: finite(size?.width) && size.width > 0 ? size.width : base?.width ?? 640,
      height: finite(size?.height) && size.height >= 140 ? size.height : base?.height ?? 360,
    }];
  }));
}

/** Legacy absolute frames already include drag offsets. Older grid records
 * contain only a delta; rebuild a stable base before adding that delta. */
export function resolveLegacyDesktopFrames(items: Array<LegacyDesktopCardGeometry | null>): DesktopCardFrame[] {
  const groups = new Map<string, number[]>();
  items.forEach((item, index) => {
    const origin = item?.originLayoutId ?? "unknown";
    groups.set(origin, [...(groups.get(origin) ?? []), index]);
  });
  const result: DesktopCardFrame[] = Array(items.length);
  let nextGroupLeft: number | null = null;
  for (const indices of groups.values()) {
    const width = Math.max(340, ...indices.map(index => items[index]?.size?.width ?? items[index]?.frame?.width ?? 340));
    const height = Math.max(300, ...indices.map(index => items[index]?.size?.height ?? items[index]?.frame?.height ?? 300));
    const absolute = indices.flatMap(index => items[index]?.frame ? [items[index]!.frame!] : []);
    const fallbackLeft = absolute.length ? Math.max(...absolute.map(frame => frame.x + frame.width)) + 60 : 0;
    const usedSlots = new Set<number>();
    indices.forEach((index, groupIndex) => {
      const old = items[index];
      if (old?.frame) { result[index] = { ...old.frame }; return; }
      let slot = old?.sourceIndex ?? groupIndex;
      while (usedSlots.has(slot)) slot += 1;
      usedSlots.add(slot);
      result[index] = {
        x: fallbackLeft + (slot % 2) * (width + 40) + (old?.offset?.x ?? 0),
        y: Math.floor(slot / 2) * (height + 60) + (old?.offset?.y ?? 0),
        width: old?.size?.width ?? 340,
        height: old?.size?.height ?? 300,
      };
    });
    // Several historical title-based desks can resolve to one stable area.
    // Preserve each desk's internal deltas while separating their source groups.
    const left = Math.min(...indices.map(index => result[index].x));
    const shift = nextGroupLeft === null ? 0 : nextGroupLeft - left;
    indices.forEach(index => { result[index].x += shift; });
    nextGroupLeft = Math.max(...indices.map(index => result[index].x + result[index].width)) + 120;
  }
  return result;
}

/** Needed before the first frame commit so adjacent areas do not occupy the
 * future space of a wide group of migrated notes. Hidden notes reserve space. */
export function readLegacyContentWidths(cards: readonly CustomDesktopCard[]): Record<string, number> {
  const groups = new Map<string, CustomDesktopCard[]>();
  for (const card of cards) {
    if (!card.legacyOrigin) continue;
    const id = card.legacyOrigin.layoutId;
    groups.set(id, [...(groups.get(id) ?? []), card]);
  }
  return Object.fromEntries([...groups].map(([id, group]) => {
    const frames = resolveLegacyDesktopFrames(group.map(card => readLegacyDesktopCardGeometry(card)));
    const left = Math.min(0, ...frames.map(frame => frame.x));
    return [id, Math.max(...frames.map(frame => frame.x + frame.width)) - left];
  }));
}

const overlaps = (a: DesktopBounds, b: DesktopBounds, gap = 20) =>
  a.left < b.left + b.width + gap && a.left + a.width + gap > b.left
  && a.top < b.top + b.height + gap && a.top + a.height + gap > b.top;

/** Search visible gaps nearest the current center, then try its immediate
 * edges. Only the new frame is returned; neighboring papers never move. */
export function findDesktopCardPlacement(visible: DesktopBounds, occupied: readonly DesktopBounds[], size = { width: 340, height: 280 }): DesktopCardFrame {
  const gap = 24;
  const center = { x: visible.left + (visible.width - size.width) / 2, y: visible.top + (visible.height - size.height) / 2 };
  const candidates = [center];
  const add = (x: number, y: number) => candidates.push({ x, y });
  const stepX = Math.max(64, size.width / 3, visible.width / 24);
  const stepY = Math.max(64, size.height / 3, visible.height / 24);
  for (let y = visible.top + gap; y + size.height <= visible.top + visible.height - gap; y += stepY) {
    for (let x = visible.left + gap; x + size.width <= visible.left + visible.width - gap; x += stepX) add(x, y);
  }
  const right = visible.left + visible.width;
  const bottom = visible.top + visible.height;
  // Card edges reveal usable gaps that a regular sampling grid can miss.
  for (const box of occupied) {
    if (!overlaps(visible, box, Math.max(size.width, size.height))) continue;
    add(box.left + box.width + gap, box.top);
    add(box.left - size.width - gap, box.top);
    add(box.left, box.top + box.height + gap);
    add(box.left, box.top - size.height - gap);
  }
  const distance = (point: { x: number; y: number }) => (point.x - center.x) ** 2 + (point.y - center.y) ** 2;
  const free = (point: { x: number; y: number }) => occupied.every(box => !overlaps({ left: point.x, top: point.y, ...size }, box));
  candidates.sort((a, b) => distance(a) - distance(b));
  const inside = candidates.find(point => point.x >= visible.left + gap && point.y >= visible.top + gap
    && point.x + size.width <= right - gap && point.y + size.height <= bottom - gap && free(point));
  if (inside) return { ...inside, ...size };
  const edges = [
    { x: right + gap, y: center.y }, { x: center.x, y: bottom + gap },
    { x: visible.left - size.width - gap, y: center.y }, { x: center.x, y: visible.top - size.height - gap },
    ...candidates,
  ].sort((a, b) => distance(a) - distance(b));
  const nearby = edges.find(free);
  if (nearby) return { ...nearby, ...size };
  // A dense cluster can fill all four visible edges. Its nearest free right
  // edge is still deterministic and is immediately located after creation.
  return { x: Math.max(right, ...occupied.map(box => box.left + box.width)) + gap, y: center.y, ...size };
}

export function readNewDesktopCardPlacement(viewport: HTMLElement | null, camera: { x: number; y: number; zoom: number }): DesktopCardFrame {
  const surface = viewport?.querySelector<HTMLElement>(".dim-desk-zoom-surface");
  const view = viewport?.getBoundingClientRect();
  const origin = surface?.getBoundingClientRect();
  const outerZoom = viewport?.clientWidth && view ? view.width / viewport.clientWidth || 1 : 1;
  const screenZoom = camera.zoom * outerZoom;
  const toolbar = viewport?.querySelector<HTMLElement>(".dim-desktop-toolbar")?.getBoundingClientRect();
  const top = view && toolbar?.height ? Math.min(view.bottom - 40, Math.max(view.top, toolbar.bottom)) : view?.top ?? 0;
  const width = view?.width ? view.width / screenZoom : 920 / camera.zoom;
  const height = view?.height ? (view.bottom - top) / screenZoom : 640 / camera.zoom;
  const visible = { left: camera.x - width / 2, top: camera.y - height / 2, width, height };
  const occupied = origin ? Array.from(surface?.querySelectorAll<HTMLElement>("[data-spatial-card-id], [data-desktop-anchor]") ?? [])
    .map(card => card.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0)
    .map(box => ({ left: (box.left - origin.left) / screenZoom, top: (box.top - origin.top) / screenZoom,
      width: box.width / screenZoom, height: box.height / screenZoom })) : [];
  return findDesktopCardPlacement(visible, occupied);
}

/** Inputs include all ancestor transforms; screenZoom is desk zoom × deck scale. */
export function desktopBoundsFromScreenBoxes(origin: { left: number; top: number }, boxes: DesktopBounds[], screenZoom: number): DesktopBounds {
  const left = Math.min(...boxes.map(box => box.left));
  const top = Math.min(...boxes.map(box => box.top));
  return {
    left: (left - origin.left) / screenZoom - 20,
    top: (top - origin.top) / screenZoom - 65,
    width: (Math.max(...boxes.map(box => box.left + box.width)) - left) / screenZoom + 40,
    height: (Math.max(...boxes.map(box => box.top + box.height)) - top) / screenZoom + 85,
  };
}
