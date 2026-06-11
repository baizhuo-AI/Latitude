/**
 * 跨窗口数据同步
 *
 * 主 App 和浮窗共享同一个 SQLite，但各自的 zustand store 是独立 JS context。
 * 改动后广播一条事件，各窗口订阅后重新 hydrate。
 *
 * 历史踩坑：原本用 BroadcastChannel（旧注释写"Tauri webview 同 origin 多窗口支持"），
 * 实际上 Tauri 的主窗口和浮窗是各自独立的 WKWebView，不在同一个 browsing context group，
 * BroadcastChannel 跨不过去——所以浮窗和主窗历史上一直没真同步。
 * 改用 Tauri Event：走 Rust 端 IPC 中转，跨窗口 / 跨进程都通。
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

const EVENT_NAME = "daybreak-sync";

export type SyncTopic =
  | "todos"
  | "goals"
  | "conversations"
  | "activities"
  | "reminder"
  | "calendar_events"
  | "layout";

interface SyncPayload {
  topic: SyncTopic;
  source?: string;
  ts: number;
}

/** 广播一条变更通知，跨所有窗口（主 / 浮窗都能收到） */
export function emitSync(topic: SyncTopic, source?: string) {
  const payload: SyncPayload = { topic, source, ts: Date.now() };
  emit(EVENT_NAME, payload).catch((e) =>
    console.warn("[syncBus] emit failed:", e)
  );
}

/**
 * 订阅：topic 触发时调 handler。返回取消订阅函数（同步语义）。
 *
 * 实现细节：Tauri 的 listen 异步返回 UnlistenFn（Promise）。为了让调用方仍能拿到同步的
 * 取消函数（保持原 API），这里做"延迟取消"：取消函数被调时若 listen 还没解析，
 * 标记 cancelled，等 listen 解析后立刻 unlisten；若已解析则直接 unlisten。
 */
export function onSync(topic: SyncTopic, handler: () => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  listen<SyncPayload>(EVENT_NAME, (event) => {
    if (event.payload?.topic === topic) handler();
  })
    .then((u) => {
      if (cancelled) u();
      else unlisten = u;
    })
    .catch((e) => console.warn("[syncBus] listen failed:", e));
  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}
