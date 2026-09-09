import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useDesktopRuntimeOptional } from "../../runtime/host/DesktopRuntimeProvider";
import { CustomDesktopCardStore } from "./store";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../../projections/desktop/browserUiComposition";
import { CUSTOM_DESKTOP_CARDS_PREFIX } from "./model";

const stores = new Map<string, CustomDesktopCardStore>();

export function useCustomDesktopCards(layoutId: string) {
  const host = useDesktopRuntimeOptional();
  const store = useMemo(() => {
    let existing = stores.get(layoutId);
    if (!existing) { existing = new CustomDesktopCardStore(layoutId); stores.set(layoutId, existing); }
    return existing;
  }, [layoutId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const runtime = host?.runtime;
  const domainReady = host?.health?.domain.state === "ready";
  const domainCheckedAt = host?.health?.domain.checkedAt;
  useEffect(() => {
    // Profiles can be restored/cleared in this same document; re-read on a fresh
    // mount as well as on the shared profile event rather than trusting the cache.
    store.reload();
  }, [store]);
  useEffect(() => {
    // Reuse the host health poll to observe edits/retractions made elsewhere.
    // connect coalesces overlapping reads and does not create another timer.
    if (runtime && domainReady) void store.connect(runtime);
    else store.disconnect();
  }, [store, runtime, domainReady, domainCheckedAt]);
  useEffect(() => () => store.disconnect(), [store, runtime]);
  useEffect(() => {
    const reload = () => {
      store.disconnect();
      store.reload();
      if (runtime && domainReady) void store.connect(runtime);
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === store.key || event.key === null || event.key.startsWith(`${CUSTOM_DESKTOP_CARDS_PREFIX}${layoutId}--clue-`)) reload();
    };
    window.addEventListener("storage", storageChanged);
    window.addEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
    return () => {
      window.removeEventListener("storage", storageChanged);
      window.removeEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, reload);
    };
  }, [store, runtime, domainReady, layoutId]);
  const cards = useMemo(() => state.cards.filter((card) => !card.domainRetracted), [state.cards]);
  return { ...state, cards,
    create: store.create, update: store.update, setVisible: store.setVisible,
    retrySync: store.retrySync, clearError: store.clearError };
}
