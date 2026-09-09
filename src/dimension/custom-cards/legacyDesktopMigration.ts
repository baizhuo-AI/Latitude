import { DESKTOP_FRAMES_PREFIX, validateDesktopFrameDocument, type DesktopCardFrame } from "../../runtime/layout/desktopFrameStorage";
import {
  CUSTOM_DESKTOP_CARDS_PREFIX, MAX_STORED_CUSTOM_DESKTOP_CARDS, legacyDesktopCardId,
  validateCustomDesktopCardsDocument, type CustomDesktopCard,
} from "./model";

export { legacyDesktopCardId } from "./model";
export type LegacyDesktopStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "length" | "key">>;

export function isLegacyDesktopLayout(rootLayoutId: string, candidate: unknown): candidate is string {
  return typeof candidate === "string" && candidate.startsWith(`${rootLayoutId}--clue-`) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(candidate) &&
    candidate.length > rootLayoutId.length + "--clue-".length;
}

export function migrateLegacyDesktopCard(card: CustomDesktopCard, originLayoutId: string): CustomDesktopCard {
  return { ...card, id: legacyDesktopCardId(originLayoutId, card.id),
    legacyOrigin: { layoutId: originLayoutId, cardId: card.id } };
}

/** Copy presentation records once and leave every old document intact. Root
 * records win on later reloads, so the old snapshot cannot undo current edits. */
export function mergeLegacyDesktopCards(rootLayoutId: string, current: CustomDesktopCard[], storage: LegacyDesktopStorage) {
  const cards = [...current];
  const byId = new Map(cards.map((card) => [card.id, card]));
  const warnings: string[] = [];
  if (typeof storage.length !== "number" || !storage.key) return { cards, changed: false, warnings };
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(CUSTOM_DESKTOP_CARDS_PREFIX) &&
        isLegacyDesktopLayout(rootLayoutId, key.slice(CUSTOM_DESKTOP_CARDS_PREFIX.length))) keys.push(key);
  }
  for (const key of keys.sort()) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      const layoutId = key.slice(CUSTOM_DESKTOP_CARDS_PREFIX.length);
      for (const old of validateCustomDesktopCardsDocument(JSON.parse(raw)).cards) {
        // A nested migrated document is already represented by its real origin.
        if (old.legacyOrigin && !isLegacyDesktopLayout(rootLayoutId, old.legacyOrigin.layoutId)) {
          warnings.push("旧桌面卡片来源不一致，原始内容已保留。");
          continue;
        }
        const next = old.legacyOrigin ? old : migrateLegacyDesktopCard(old, layoutId);
        const existing = byId.get(next.id);
        if (existing) {
          if (existing.legacyOrigin?.layoutId !== next.legacyOrigin?.layoutId ||
              existing.legacyOrigin?.cardId !== next.legacyOrigin?.cardId) warnings.push("旧桌面卡片标识冲突，原始内容已保留。");
          continue;
        }
        if (cards.length >= MAX_STORED_CUSTOM_DESKTOP_CARDS) {
          warnings.push("旧桌面卡片较多，尚未全部迁入；原始内容已保留。");
          break;
        }
        cards.push(next);
        byId.set(next.id, next);
      }
    } catch { warnings.push("部分旧桌面卡片未能读取，原始内容已保留。"); }
  }
  return { cards, changed: cards.length !== current.length, warnings };
}

export interface LegacyDesktopCardGeometry {
  originLayoutId: string;
  /** Effective old geometry, including its drag and resize overrides. */
  frame?: DesktopCardFrame;
  /** Older grid desks have no absolute frame; let the caller supply a base. */
  offset?: { x: number; y: number };
  size?: { width: number; height: number };
  sourceIndex: number;
}

function readRecord(storage: LegacyDesktopStorage, key: string): Record<string, unknown> | null {
  try {
    const raw = storage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

/** Read-only migration geometry. Never writes old or root spatial storage. */
export function readLegacyDesktopCardGeometry(card: CustomDesktopCard, storage: LegacyDesktopStorage = window.localStorage): LegacyDesktopCardGeometry | null {
  if (!card.legacyOrigin) return null;
  const { layoutId, cardId } = card.legacyOrigin;
  const offsetValue = readRecord(storage, `dim-desk-offsets-${layoutId}`)?.[cardId] as Record<string, unknown> | undefined;
  const sizeValue = readRecord(storage, `dim-desk-sizes-${layoutId}`)?.[cardId] as Record<string, unknown> | undefined;
  const offset = offsetValue && finite(offsetValue.x) && finite(offsetValue.y) ? { x: offsetValue.x, y: offsetValue.y } : undefined;
  const size = sizeValue && finite(sizeValue.width) && sizeValue.width > 0 && finite(sizeValue.height) && sizeValue.height >= 140
    ? { width: sizeValue.width, height: sizeValue.height } : undefined;
  let frame: DesktopCardFrame | undefined;
  try {
    const raw = storage.getItem(`${DESKTOP_FRAMES_PREFIX}${layoutId}`);
    const base = raw ? validateDesktopFrameDocument(JSON.parse(raw)).frames[cardId] : undefined;
    if (base) frame = { x: base.x + (offset?.x ?? 0), y: base.y + (offset?.y ?? 0),
      width: size?.width ?? base.width, height: size?.height ?? base.height };
  } catch { /* Legacy offsets and sizes remain usable if frames are absent or damaged. */ }
  let sourceIndex = 0;
  try {
    const raw = storage.getItem(`${CUSTOM_DESKTOP_CARDS_PREFIX}${layoutId}`);
    if (raw) sourceIndex = Math.max(0, validateCustomDesktopCardsDocument(JSON.parse(raw)).cards.findIndex((item) => item.id === cardId));
  } catch { /* A remote-only note has no local ordering information. */ }
  return { originLayoutId: layoutId, sourceIndex, ...(frame ? { frame } : {}), ...(offset ? { offset } : {}), ...(size ? { size } : {}) };
}
