import { useEffect, useSyncExternalStore } from "react";
import { isNativeComposer, type ComposerAttachment } from "./attachments";

export interface ComposerDraft { text: string; attachments: ComposerAttachment[]; revision?: string; }
const PREFIX = "latitude.composer.v1:";
const CHANGE = "latitude-composer-draft";
const NATIVE_CHANGE = "latitude://composer-draft";
const cache = new Map<string, { serialized: string | null; draft: ComposerDraft }>();
const volatile = new Map<string, ComposerDraft>();

export function readDraft(key: string): ComposerDraft {
  const temporary = volatile.get(key);
  if (temporary) return temporary;
  let serialized: string | null = null;
  try { serialized = localStorage.getItem(PREFIX + key); } catch { /* Browser storage may be unavailable. */ }
  const previous = cache.get(key);
  if (previous && previous.serialized === serialized) return previous.draft;
  let draft: ComposerDraft = { text: "", attachments: [] };
  if (serialized) {
    try {
      const value = JSON.parse(serialized) as ComposerDraft;
      if (typeof value.text === "string" && Array.isArray(value.attachments)) draft = value;
    } catch { /* A corrupt draft must not prevent opening the conversation. */ }
  }
  cache.set(key, { serialized, draft });
  return draft;
}

/** Re-read before each update so an attachment finishing in another window isn't lost. */
export function updateDraft(key: string, update: (draft: ComposerDraft) => ComposerDraft): boolean {
  const previous = readDraft(key);
  const timestamp = Math.max(Date.now(), Number(previous.revision?.split(":")[0] ?? 0) + 1);
  const draft = { ...update(previous), revision: `${timestamp}:${crypto.randomUUID()}` };
  const serialized = JSON.stringify(draft);
  let persisted = true;
  try {
    localStorage.setItem(PREFIX + key, serialized);
    volatile.delete(key);
    cache.set(key, { serialized, draft });
  } catch {
    volatile.set(key, draft);
    persisted = false;
  }
  window.dispatchEvent(new CustomEvent(CHANGE, { detail: key }));
  if (isNativeComposer()) {
    void import("@tauri-apps/api/event").then(({ emit }) => emit(NATIVE_CHANGE, { key, draft })).catch(() => undefined);
  }
  return persisted;
}

export function useComposerDraft(key: string): ComposerDraft {
  useEffect(() => {
    if (!isNativeComposer()) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<{ key: string; draft: ComposerDraft }>(NATIVE_CHANGE, ({ payload }) => {
      if (payload.key !== key) return;
      if ((readDraft(key).revision ?? "") >= (payload.draft.revision ?? "")) return;
      const serialized = JSON.stringify(payload.draft);
      try { localStorage.setItem(PREFIX + key, serialized); volatile.delete(key); }
      catch { volatile.set(key, payload.draft); }
      cache.set(key, { serialized, draft: payload.draft });
      window.dispatchEvent(new CustomEvent(CHANGE, { detail: key }));
    })).then((unlisten) => { if (cancelled) unlisten(); else dispose = unlisten; }).catch(() => undefined);
    return () => { cancelled = true; dispose?.(); };
  }, [key]);
  return useSyncExternalStore((notify) => {
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === PREFIX + key) { volatile.delete(key); notify(); } };
    const local = (event: Event) => { if ((event as CustomEvent<string>).detail === key) notify(); };
    window.addEventListener("storage", storage);
    window.addEventListener(CHANGE, local);
    return () => { window.removeEventListener("storage", storage); window.removeEventListener(CHANGE, local); };
  }, () => readDraft(key));
}
