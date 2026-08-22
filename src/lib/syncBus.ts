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

const EVENT_NAME = "latitude-sync";

export type SyncTopic =
  | "todos"
  | "goals"
  | "conversations"
  | "activities"
  | "reminder"
  | "calendar_events"
  | "layout"
  | "memory";

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

/**
 * 后端事件 → 前端 syncBus 的桥接（纯函数,便于单测)。
 *
 * 背景:Latitude 有两条独立通道——
 *  (1) 后端→前端桥 `latitude://data-changed`:Rust(MCP / 飞书同步)写库后 emit 的就是这条;
 *  (2) 应用内 `latitude-sync`(本文件 emitSync/onSync):前端写库后广播、各窗口订阅刷新。
 * 两条事件名不同,本身不互通。多数数据域(todos/goals/activities/calendar_events)恰好被
 * useDataSync 的 data-changed 监听覆盖,所以没事;但 `memory` 不在那个列表里,又只有 onSync("memory")
 * 的消费者(AboutYouPanel),于是 MCP 经 data-changed 发的 "memory" 会被丢弃——面板不实时刷新。
 *
 * 这个映射把后端 data-changed 的 payload 翻成本地 syncBus topic,专门补上 memory 这个孤儿桥。
 * 返回 null 表示「不转嫁」(该 topic 已由 useDataSync 的 data-changed 路径直接消费,无需重复广播,
 * 避免双触发 hydrate)。当前仅转嫁 memory。
 */
export function dataChangedToSyncTopic(payload: string): SyncTopic | null {
  return payload === "memory" ? "memory" : null;
}

/**
 * 在常驻窗口挂一次:监听后端 `latitude://data-changed`,把需要转嫁的 payload re-emit 到 syncBus,
 * 让现有 onSync 消费者(如 AboutYouPanel 的 onSync("memory"))收到。返回同步取消函数。
 *
 * listen 参数可注入,默认用 Tauri 的 listen;测试时注入假 listen 即可断言转嫁行为。
 */
export function bridgeDataChangedToSync(
  listenFn: typeof listen = listen
): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  listenFn<string>("latitude://data-changed", (event) => {
    const topic = dataChangedToSyncTopic(event.payload);
    if (topic) emitSync(topic, "data-changed-bridge");
  })
    .then((u) => {
      if (cancelled) u();
      else unlisten = u;
    })
    .catch((e) => console.warn("[syncBus] bridge listen failed:", e));
  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}
