import { invoke } from "@tauri-apps/api/core";

/**
 * 飞书/Lark 日历同步 — 前端薄封装层
 *
 * 只做一件事:把 Rust 侧的 `feishu_sync_now` command 包成一个有类型的 async 函数,
 * 让设置页(SettingsPage 的 FeishuConnectSection)能一行调用、拿到结构化摘要。
 *
 * 同步本身的真相源是 SQLite + Rust 引擎:这里 **不** 读写 store、**不** 触发 hydrate,
 * 刷新内存的活儿留给调用方(调完 syncNow 后自己 hydrate() + refreshSyncStates())。
 * 这样保持本模块零副作用,纯 IPC 转发。
 */

/** 单个 region(飞书 / Lark)一轮同步的结果摘要,字段与 Rust `RegionSyncSummary` 对齐(serde snake_case)。 */
export interface RegionSyncSummary {
  /** "feishu" | "lark"。 */
  region: string;
  /** 本轮发现的活跃日历数。 */
  calendars: number;
  /** 本轮跨所有日历累计 upsert 的事件条数。 */
  upserted: number;
  /** 本轮跨所有日历累计软删的事件条数。 */
  deleted: number;
  /** region 级失败原因(整 region 没跑成才填);单日历失败落各自 sync_state.last_error,不进这里。 */
  error: string | null;
}

/** 一轮手动同步的总摘要,字段与 Rust `SyncSummary` 对齐。 */
export interface SyncSummary {
  /** 逐 region 的结果(仅含「已连接、尝试过同步」的 region)。 */
  regions: RegionSyncSummary[];
}

/**
 * 手动触发一轮飞书/Lark 日历同步。
 *
 * 后台 scheduler 会被戳一下立即插一轮,本调用等这一轮跑完拿到 SyncSummary 返回。
 * 抛错(凭证缺失 / 引擎未起 / IPC 失败等)由调用方 try/catch 兜底,本函数不吞错。
 */
export async function feishuSyncNow(): Promise<SyncSummary> {
  return invoke<SyncSummary>("feishu_sync_now");
}

/** 写回队列 flush 的结果，字段与 Rust `FlushResult` 对齐。 */
export interface FlushResult {
  /** 成功推送到飞书的变更数。 */
  pushed: number;
  /** 检测到冲突（远端为准、本地已存草稿待用户决断）的变更数。 */
  conflicted: number;
  /** 失败（留待重试 / 达上限已死信）的变更数。 */
  failed: number;
}

/**
 * 触发一轮本地变更队列写回飞书（create / PATCH / DELETE）。
 *
 * 与后台同步共用 Rust 侧同一把串行锁（同一时刻只有一轮同步或 flush）。抛错由调用方 try/catch 兜底。
 * 调用方应在 await dbEnqueueChange 入队 commit **之后**再调本函数，避免 WAL 跨连接可见性窗口漏读。
 */
export async function flushQueue(): Promise<FlushResult> {
  return invoke<FlushResult>("feishu_flush_queue");
}

/**
 * 注册「网络恢复 → flush 一轮」的冗余触发（P4-5 离线重放）。
 *
 * 离线期间本地编辑只入队、不发网络；联网后这里自动重放。返回 cleanup 解绑监听。
 * Rust 的定时调度本身也会驱动 flush，这里只是加一条更快的触发，失败静默（留队列下次再试）。
 */
export function setupOnlineReplay(): () => void {
  const handler = () => {
    void flushQueue().catch(() => {
      /* 离线重放失败无所谓：变更仍在队列里，下一轮自动重试，不打扰用户 */
    });
  };
  window.addEventListener("online", handler);
  return () => window.removeEventListener("online", handler);
}
