import type { DesktopCardFrames } from "../runtime/layout/desktopFrameStorage";
import type { ClueThread } from "./presets/ClueBoardPreset";

export const DESKTOP_WORKSPACE_PREFIX = "dim-desk-workspace-";
export interface DesktopArea {
  id: string;
  title: string;
  x: number;
  y: number;
  legacyLayoutIds?: string[];
}
export interface DesktopWorkspaceDocument {
  version: 1;
  areas: Record<string, DesktopArea>;
  activeAreaId: string | null;
  hiddenCardIds?: string[];
  /** UI placement only. A card's knowledge/domain ownership is unchanged. */
  cardAreaIds?: Record<string, string>;
}
export interface DesktopViewContext {
  view: "paper" | "clue-board" | "constellation";
  area: { id: string; title: string } | null;
  visibleCardIds: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  record(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function validateDesktopWorkspaceDocument(value: unknown): DesktopWorkspaceDocument {
  if (!record(value) || value.version !== 1 || !record(value.areas) ||
      !(value.activeAreaId === null || typeof value.activeAreaId === "string") ||
      Object.keys(value.areas).length > 256 ||
      (value.hiddenCardIds !== undefined && (!Array.isArray(value.hiddenCardIds) || value.hiddenCardIds.length > 1024 ||
        value.hiddenCardIds.some(id => typeof id !== "string" || id.length > 1000)))) throw new TypeError("Invalid desktop workspace");
  const areas = Object.fromEntries(Object.entries(value.areas).map(([id, area]) => {
    if (!record(area) || !id || id.length > 1000 || area.id !== id || typeof area.title !== "string" ||
        !area.title.trim() || area.title.length > 500 ||
        typeof area.x !== "number" || !Number.isFinite(area.x) || Math.abs(area.x) > 1_000_000 ||
        typeof area.y !== "number" || !Number.isFinite(area.y) || Math.abs(area.y) > 1_000_000 ||
        (area.legacyLayoutIds !== undefined && (!Array.isArray(area.legacyLayoutIds) ||
          area.legacyLayoutIds.length > 256 || area.legacyLayoutIds.some(item => typeof item !== "string" || item.length > 1000)))) {
      throw new TypeError("Invalid desktop area");
    }
    return [id, { id, title: area.title, x: area.x, y: area.y,
      ...(area.legacyLayoutIds ? { legacyLayoutIds: area.legacyLayoutIds as string[] } : {}) }];
  }));
  let cardAreaIds: Record<string, string> | undefined;
  if (value.cardAreaIds !== undefined) {
    if (!plainRecord(value.cardAreaIds) || Object.keys(value.cardAreaIds).length > 1024) throw new TypeError("Invalid desktop card area mapping");
    cardAreaIds = Object.fromEntries(Object.entries(value.cardAreaIds).map(([cardId, areaId]) => {
      if (!cardId.trim() || cardId.length > 1000 || typeof areaId !== "string" || !areaId ||
          areaId.length > 1000 || !own(areas, areaId)) throw new TypeError("Invalid desktop card area mapping");
      return [cardId, areaId];
    }));
  }
  return { version: 1, areas, activeAreaId: value.activeAreaId && own(areas, value.activeAreaId) ? value.activeAreaId : null,
    ...(cardAreaIds ? { cardAreaIds } : {}),
    ...(value.hiddenCardIds ? { hiddenCardIds: value.hiddenCardIds as string[] } : {}) };
}

export function readDesktopWorkspace(layoutId: string): DesktopWorkspaceDocument {
  try {
    const raw = window.localStorage.getItem(`${DESKTOP_WORKSPACE_PREFIX}${layoutId}`);
    if (raw && raw.length < 256_000) return validateDesktopWorkspaceDocument(JSON.parse(raw));
  } catch { /* An unavailable profile must not prevent opening the desktop. */ }
  return { version: 1, areas: {}, activeAreaId: null };
}

export function writeDesktopWorkspace(layoutId: string, value: DesktopWorkspaceDocument): void {
  try { window.localStorage.setItem(`${DESKTOP_WORKSPACE_PREFIX}${layoutId}`, JSON.stringify(value)); }
  catch { /* Keep the current workspace usable in a storage-restricted session. */ }
}

export function legacyThreadLayoutId(layoutId: string, title: string): string {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${layoutId}--clue-${hash.toString(36)}`;
}

/** Allocate once outside the existing papers; navigation never reapplies placement. */
export function reconcileDesktopWorkspace(
  stored: DesktopWorkspaceDocument, threads: readonly ClueThread[], layoutId: string,
  frames: DesktopCardFrames = {}, legacyLayoutIds: readonly string[] = [],
  legacyContentWidths: Readonly<Record<string, number>> = {},
): DesktopWorkspaceDocument {
  const areas = { ...stored.areas };
  const aliases = new Map<string, string>();
  const occupiedRight = Math.max(1200, ...Object.values(frames).map(frame => frame.x + frame.width));
  const areaWidth = (area: DesktopArea) => {
    const widths = (area.legacyLayoutIds ?? []).map(id => legacyContentWidths[id]).filter(width => Number.isFinite(width) && width > 0);
    // Content starts beside the 640px related-record paper. Several historical
    // sources share an area with a 120px gap between their preserved groups.
    return Math.max(1100, 720 + widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 120);
  };
  const allocate = (id: string, title: string, legacyId: string) => {
    // A recovered placeholder can acquire a real thread ID once. Two real
    // threads with the same title remain distinct despite the old title hash.
    const existing = (own(areas, id) ? areas[id] : undefined) ?? Object.values(areas)
      .find(area => area.id.startsWith("legacy:") && area.legacyLayoutIds?.includes(legacyId));
    if (existing) {
      if (existing.id !== id) { delete areas[existing.id]; aliases.set(existing.id, id); }
      const claimedElsewhere = Object.values(areas).some(area => area.id !== id && area.legacyLayoutIds?.includes(legacyId));
      areas[id] = { ...existing, id, title, legacyLayoutIds: [...new Set([...(existing.legacyLayoutIds ?? []), ...(!claimedElsewhere ? [legacyId] : [])])] };
      return;
    }
    if (Object.keys(areas).length >= 256) return;
    const right = Math.max(occupiedRight, ...Object.values(areas).map(area => area.x + areaWidth(area)));
    const claimedElsewhere = Object.values(areas).some(area => area.legacyLayoutIds?.includes(legacyId));
    areas[id] = { id, title, x: right + 420, y: 40, legacyLayoutIds: claimedElsewhere ? [] : [legacyId] };
  };
  threads.slice(0, 256).forEach(thread => allocate(thread.id, thread.title, legacyThreadLayoutId(layoutId, thread.title)));
  legacyLayoutIds.forEach((id, index) => {
    if (Object.values(areas).some(area => area.legacyLayoutIds?.includes(id)) || Object.keys(areas).length >= 256) return;
    allocate(`legacy:${id}`, `保留的线索内容 ${index + 1}`, id);
  });
  const previousActiveId = stored.activeAreaId && (aliases.get(stored.activeAreaId) ?? stored.activeAreaId);
  const activeAreaId = previousActiveId && own(areas, previousActiveId) ? previousActiveId : null;
  const cardAreaIds = stored.cardAreaIds && Object.fromEntries(Object.entries(stored.cardAreaIds)
    .map(([cardId, areaId]) => [cardId, aliases.get(areaId) ?? areaId]));
  return { ...stored, version: 1, areas, activeAreaId, ...(cardAreaIds ? { cardAreaIds } : {}) };
}

export const areaReferenceCardId = (areaId: string) => `area-reference:${areaId}`;
