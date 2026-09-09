import { useCallback, useState } from "react";
import type { PetNotice } from "../pet-notices";

export const PET_INBOX_KEY = "latitude.pet-inbox.v1";
type Entry = PetNotice & { dismissed?: boolean };

function loadInbox(): Entry[] {
  try { return JSON.parse(localStorage.getItem(PET_INBOX_KEY) ?? "[]") as Entry[]; }
  catch { return []; }
}

/** Main window owns delivery. Dismissing a bubble never completes its task. */
export function usePetInbox() {
  const [entries, setEntries] = useState(loadInbox);
  const update = useCallback((change: (entries: Entry[]) => Entry[]) => {
    setEntries((current) => {
      const next = change(current);
      localStorage.setItem(PET_INBOX_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const enqueue = useCallback((notice: PetNotice) => {
    update((current) => current.some((entry) => entry.id === notice.id) ? current : [...current, notice]);
  }, [update]);
  const dismiss = useCallback((id: string) => {
    update((current) => current.map((entry) => entry.id === id ? { ...entry, dismissed: true } : entry));
  }, [update]);
  return { notice: entries.find((entry) => !entry.dismissed) ?? null, enqueue, dismiss };
}
