import { useEffect, useState } from "react";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../../projections/desktop/browserUiComposition";

function readLocks(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length < 1000))].slice(0, 1024) : [];
  } catch { return []; }
}

export function useCardLocks(layoutId: string) {
  const key = `dim-desk-locks-${layoutId}`;
  const [stored, setStored] = useState(() => ({ key, ids: readLocks(key) }));
  const ids = stored.key === key ? stored.ids : readLocks(key);
  useEffect(() => {
    const restore = () => setStored({ key, ids: readLocks(key) });
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === key) restore(); };
    restore();
    window.addEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, restore);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, restore); window.removeEventListener("storage", storage); };
  }, [key]);
  return { ids, isLocked: (id: string) => ids.includes(id), toggle: (id: string) => {
    const next = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Remain usable in this session. */ }
    setStored({ key, ids: next });
  } };
}
