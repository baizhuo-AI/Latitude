export const DESKTOP_FRAMES_PREFIX = "dim-desk-frames-";
export const MAX_DESKTOP_FRAME_BYTES = 128_000;
export const MAX_DESKTOP_FRAME_CARDS = 512;

export interface DesktopCardFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopCardFrames = Record<string, DesktopCardFrame>;
export interface DesktopFrameDocument { version: 1; frames: DesktopCardFrames }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The same pure validation protects local reads, profile import and undo. */
export function validateDesktopFrameDocument(value: unknown): DesktopFrameDocument {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.frames)) {
    throw new TypeError("Desktop card frame document is invalid");
  }
  const entries = Object.entries(value.frames);
  if (entries.length > MAX_DESKTOP_FRAME_CARDS) throw new TypeError("Desktop card frame count exceeds the limit");
  const frames = Object.fromEntries(entries.map(([id, frame]) => {
    if (!id.trim() || !isRecord(frame) || !finite(frame.x) || !finite(frame.y) ||
        !finite(frame.width) || frame.width <= 0 || !finite(frame.height) || frame.height < 140) {
      throw new TypeError("Desktop card frame geometry is invalid");
    }
    return [id, { x: frame.x, y: frame.y, width: frame.width, height: frame.height }];
  }));
  let raw: string;
  try { raw = JSON.stringify(value); } catch { throw new TypeError("Desktop card frame document is not serializable"); }
  if (raw.length > MAX_DESKTOP_FRAME_BYTES || new TextEncoder().encode(raw).byteLength > MAX_DESKTOP_FRAME_BYTES) {
    throw new TypeError("Desktop card frame document exceeds the storage limit");
  }
  return { version: 1, frames };
}

/** Null means there is no usable persisted frame document. An empty frame map
 * is valid and distinct from a legacy workspace that has never been migrated. */
export function readDesktopFrames(key: string): DesktopCardFrames | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw || raw.length > MAX_DESKTOP_FRAME_BYTES || new TextEncoder().encode(raw).byteLength > MAX_DESKTOP_FRAME_BYTES) return null;
    return validateDesktopFrameDocument(JSON.parse(raw)).frames;
  } catch { return null; }
}

export function writeDesktopFrames(key: string, frames: DesktopCardFrames | null): void {
  try {
    if (frames === null) { window.localStorage.removeItem(key); return; }
    const document = validateDesktopFrameDocument({ version: 1, frames });
    window.localStorage.setItem(key, JSON.stringify(document));
  } catch { /* The live desk remains usable if storage is full or unavailable. */ }
}
