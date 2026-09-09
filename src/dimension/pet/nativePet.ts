import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PetAction, PetSnapshot, PetState } from "./types";

export const nativePetAvailable = () => isTauri();
export const petCommand = <T = void>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args);
export const sendPetAction = (action: PetAction) => petCommand("pet_action", { action });

/** Subscribe first, then read: a newly opened window cannot miss an intervening update. */
export async function subscribePetState(update: (state: PetState) => void) {
  const unlisten = await listen<PetState>("latitude://pet-state", (event) => update(event.payload));
  try { update(await petCommand<PetState>("pet_get_state")); }
  catch (error) { unlisten(); throw error; }
  return unlisten;
}

export async function subscribePetSnapshot(update: (snapshot: PetSnapshot) => void) {
  const unlisten = await listen<PetSnapshot>("latitude://pet-snapshot", (event) => update(event.payload));
  try {
    const snapshot = await petCommand<PetSnapshot | null>("pet_get_snapshot");
    if (snapshot) update(snapshot);
  } catch (error) { unlisten(); throw error; }
  return unlisten;
}

/** The Rust boundary restricts this adapter to the two local Latitude services. */
export const desktopFetch: typeof fetch = async (input, init = {}) => {
  if (init.signal?.aborted) throw init.signal.reason;
  const request = petCommand<{ status: number; headers: Record<string, string>; body: string }>(
    "desktop_http_request", {
      url: String(input), method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : null,
    },
  );
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(init.signal?.reason ?? new DOMException("请求已取消", "AbortError"));
    init.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const response = await Promise.race([request, cancelled]);
    return new Response(response.status === 204 ? null : response.body, {
      status: response.status, headers: response.headers,
    });
  } finally {
    if (abort) init.signal?.removeEventListener("abort", abort);
  }
};
