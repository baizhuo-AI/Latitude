import type { DragOffset } from "./useCardDrag";
import type { CardSizes } from "./useCardResize";
import { MAX_DESKTOP_FRAME_BYTES, MAX_DESKTOP_FRAME_CARDS, validateDesktopFrameDocument } from "./desktopFrameStorage";
import type { DesktopCardFrames } from "./desktopFrameStorage";

export interface ArrangementSnapshot {
  offsets: Record<string, DragOffset>;
  sizes: CardSizes;
  arranged: boolean;
  scrollLeft: number;
  scrollTop: number;
  /** Absent in legacy grid snapshots. Base frames stay separate from user offsets. */
  frames?: DesktopCardFrames;
}

const MAX_SNAPSHOT_BYTES = 64_000;

export function arrangementUndoKey(modeKey: string): string {
  return modeKey.replace("dim-desk-arranged-", "dim-desk-arrangement-undo-") + (modeKey.startsWith("dim-desk-arranged-") ? "" : "-undo");
}

function validMap(value: unknown, kind: "offsets" | "sizes", limit: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= limit && entries.every(([id, item]) => {
    if (!id.trim() || !item || typeof item !== "object" || Array.isArray(item)) return false;
    return kind === "offsets"
      ? Number.isFinite(item.x) && Number.isFinite(item.y)
      : Number.isFinite(item.width) && item.width > 0 && Number.isFinite(item.height) && item.height >= 140;
  });
}

function validSnapshot(value: unknown): value is ArrangementSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as ArrangementSnapshot;
  const limit = snapshot.frames === undefined ? 256 : MAX_DESKTOP_FRAME_CARDS;
  if (typeof snapshot.arranged !== "boolean" || !Number.isFinite(snapshot.scrollLeft) || !Number.isFinite(snapshot.scrollTop) ||
      !validMap(snapshot.offsets, "offsets", limit) || !validMap(snapshot.sizes, "sizes", limit)) return false;
  if (snapshot.frames !== undefined) {
    try { validateDesktopFrameDocument({ version: 1, frames: snapshot.frames }); } catch { return false; }
  }
  return true;
}

function withinStorageLimit(raw: string, snapshot: ArrangementSnapshot): boolean {
  const limit = snapshot.frames === undefined ? MAX_SNAPSHOT_BYTES : MAX_DESKTOP_FRAME_BYTES;
  return raw.length <= limit && new TextEncoder().encode(raw).byteLength <= limit;
}

export function readArrangementUndo(key: string): ArrangementSnapshot | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw || raw.length > MAX_DESKTOP_FRAME_BYTES) return null;
    const value = JSON.parse(raw);
    return validSnapshot(value) && withinStorageLimit(raw, value) ? value : null;
  } catch { return null; }
}

/** Only the most recent arrangement can be undone, including after a reload. */
export function writeArrangementUndo(key: string, snapshot: ArrangementSnapshot | null): void {
  try {
    if (!snapshot) { window.localStorage.removeItem(key); return; }
    const raw = JSON.stringify(snapshot);
    if (validSnapshot(snapshot) && withinStorageLimit(raw, snapshot)) window.localStorage.setItem(key, raw);
    else window.localStorage.removeItem(key);
  } catch { /* Undo remains available within the current session if storage is full. */ }
}
