import { useSyncExternalStore } from "react";
import { DEFAULT_NOTICE_PREFERENCES, type NoticePreferences } from "./types";

export const NOTICE_PREFERENCES_STORAGE_KEY = "latitude.pet-notice-preferences.v1";
const PREFERENCES_CHANGED = "latitude:pet-notice-preferences-changed";

let cachedRaw: string | null | undefined;
let cachedPreferences = DEFAULT_NOTICE_PREFERENCES;

function parsePreferences(raw: string | null): NoticePreferences {
  if (!raw) return DEFAULT_NOTICE_PREFERENCES;
  try {
    const value = JSON.parse(raw) as Partial<NoticePreferences> | null;
    if (!value || typeof value !== "object") return DEFAULT_NOTICE_PREFERENCES;
    return {
      dismissAfterSeconds: value.dismissAfterSeconds === null ||
        (typeof value.dismissAfterSeconds === "number" &&
          Number.isFinite(value.dismissAfterSeconds) && value.dismissAfterSeconds > 0)
        ? value.dismissAfterSeconds
        : DEFAULT_NOTICE_PREFERENCES.dismissAfterSeconds,
      animation: value.animation === "loop" ? "loop" : "once",
      expressionSeconds: typeof value.expressionSeconds === "number" &&
        Number.isFinite(value.expressionSeconds) && value.expressionSeconds > 0
        ? value.expressionSeconds
        : DEFAULT_NOTICE_PREFERENCES.expressionSeconds,
    };
  } catch {
    return DEFAULT_NOTICE_PREFERENCES;
  }
}

function getSnapshot(): NoticePreferences {
  if (typeof window === "undefined") return DEFAULT_NOTICE_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(NOTICE_PREFERENCES_STORAGE_KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cachedPreferences = parsePreferences(raw);
    }
  } catch {
    // Keep changes usable for this session when browser storage is unavailable.
  }
  return cachedPreferences;
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === NOTICE_PREFERENCES_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(PREFERENCES_CHANGED, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(PREFERENCES_CHANGED, listener);
  };
}

function updatePreferences(patch: Partial<NoticePreferences>): void {
  cachedPreferences = { ...getSnapshot(), ...patch };
  const raw = JSON.stringify(cachedPreferences);
  try {
    window.localStorage.setItem(NOTICE_PREFERENCES_STORAGE_KEY, raw);
    cachedRaw = raw;
  } catch {
    // The shared snapshot still updates if persisting is not possible.
  }
  window.dispatchEvent(new Event(PREFERENCES_CHANGED));
}

export function useNoticePreferences() {
  const preferences = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_NOTICE_PREFERENCES,
  );
  return { preferences, updatePreferences };
}
