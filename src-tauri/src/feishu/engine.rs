//! 飞书 / Lark 日历同步的后台调度 + 手动触发（Phase 2 的 P2-4）。
//!
//! 把 [`sync.rs`](crate::feishu::sync) 的「拉一个 region / 一个日历」原子操作，编排成一个
//! **常驻后台任务** + 一个 **手动触发 command**。两条触发路径共享同一套 [`sync_once`] 核心，
//! 也共享同一把串行锁，保证「同一时刻全局只有一轮同步在跑」。
//!
//! ## 调度形态（[`run_scheduler`]）
//! 单个 tokio 任务，三种触发合一：
//!  1. **启动跑一次**：app 起来后立刻同步一轮（不用等第一个 5min tick）。
//!  2. **定时 5min**：`tokio::time::interval` 周期触发。
//!  3. **手动唤醒**：`feishu_sync_now` command 通过 [`tokio::sync::Notify`] 戳一下，立即插一轮。
//!
//! 整个 scheduler 是**单任务**：region 之间串行、region 内日历串行（见 [`sync_once`]）。
//! 故意不并发——飞书有接口限流（client 层已退避），低频串行最稳，也避免多 region 同时刷
//! 把限流打满。
//!
//! ## 单点失败不致命（核心约束）
//! 一个日历同步失败（网络抖动 / 某日历权限丢失 / 脏游标）**绝不 panic、绝不中断整轮**：
//! 把错误写进该日历的 `sync_state.last_error`（[`db::set_sync_status`]），继续下一个日历 /
//! 下一个 region。后台任务必须长命，任何一次同步的失败都不能让它退出。
//!
//! ## token 过期衔接（refresh_token 一次性的坑）
//! client 返回 [`FeishuError::TokenExpired`] 时，调 [`oauth::refresh`] 拿一对**新** token。
//! 飞书的 refresh_token 是**一次性**的（刷新成功后旧的立即失效），所以落盘顺序很关键：
//!  - access_token 先落 keychain（失效无所谓，下次还能再刷）；
//!  - **refresh_token 必须可靠落盘**——这里在「本轮同步的写库 commit 之后」才更新 refresh_token，
//!    缩小「新 refresh 已拿到但还没落盘就崩」的窗口。具体见 [`refresh_and_retry`] 的注释。
//!
//! ## 可测性（不联网、不碰真实 keychain）
//! 难点：生产路径里 `sync_once` 要读 keychain 取凭证、`new FeishuClient` 发真实 HTTP。这两样
//! 都没法在单测里跑。解法和 sync.rs 抽 [`CalendarApi`] 同一个思路——再往上抽一层
//! [`SyncEnv`]：它负责「枚举有哪些已连接 region，并为每个 region 交出一个 token + 一个
//! `CalendarApi` 实现」。生产实现 [`KeychainEnv`] 读 config + keychain + 造 `FeishuClient`；
//! 单测注入 mock env（吐 `MockApi` + `:memory:` 池），于是 `sync_once` 的「逐 region 逐日历、
//! 单点失败继续、结束 notify」整条编排都能在内存里覆盖。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Notify};

use crate::feishu::client::{FeishuClient, FeishuError};
use crate::feishu::sync::{sync_calendar_list, sync_one_calendar, CalendarApi};
use crate::feishu::{config, db, keychain, oauth, Region};

/// 定时同步间隔：5 分钟。
const SYNC_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// 飞书"日历已删除"错误码：拉一个已删但仍赖在列表里的日历的日程时返回。
/// 当成"日历没了"处理（标记 is_deleted、状态归 idle），不当同步失败报错。
const CALENDAR_DELETED_CODE: i64 = 191003;

/// 写库后通知前端刷新的回调（与 mcp::Notifier 同形态：`Arc<dyn Fn(&str) + Send + Sync>`）。
///
/// 复用 lib.rs setup() 里现成的 notify 闭包（emit `latitude://data-changed`）。一轮同步落库后
/// 调 `notify("calendar_events")`，前端据此重新 hydrate 日历事件 store。
pub type Notifier = Arc<dyn Fn(&str) + Send + Sync>;

/// `feishu_sync_now` 的返回：本轮各 region 的同步结果摘要（给前端设置页显示「同步了多少条」）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyncSummary {
    /// 逐 region 的结果（仅包含「已连接、尝试过同步」的 region）。
    pub regions: Vec<RegionSyncSummary>,
}

/// 单个 region 一轮同步的摘要。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RegionSyncSummary {
    /// "feishu" | "lark"。
    pub region: String,
    /// 本轮发现的活跃日历数。
    pub calendars: usize,
    /// 本轮跨所有日历累计 upsert 的事件条数。
    pub upserted: usize,
    /// 本轮跨所有日历累计软删的事件条数。
    pub deleted: usize,
    /// region 级失败原因（取凭证失败 / 列表同步失败等整 region 挂掉的错误）；
    /// 单个日历的失败不进这里（落各自的 sync_state.last_error），只有整 region 没跑成才填。
    pub error: Option<String>,
}

/* ===================== 同步环境抽象（可测性的关键） ===================== */

/// 一轮同步要用的「外部世界」——枚举已连接 region，并为每个 region 交出 token + 出站客户端。
///
/// 抽成 trait 只为一件事：让 [`sync_once`] 能在单测里不碰真实 keychain、不发真实 HTTP。
/// 生产实现 [`KeychainEnv`] 从 config 读 app_id、从 keychain 读 token、造 [`FeishuClient`]；
/// 单测注入 mock（吐预编程的 `MockApi`）。
///
/// 关联类型 `Api: CalendarApi` 让生产用 `FeishuClient`、测试用 `MockApi`，零额外装箱开销。
pub trait SyncEnv {
    /// 本环境提供的出站客户端类型（生产 = FeishuClient，测试 = MockApi）。
    type Api: CalendarApi;

    /// 列出「当前已连接、应当同步」的 region（按固定顺序，保证 region 串行的可预期性）。
    fn connected_regions(&self) -> Vec<Region>;

    /// 为某 region 准备「一个出站客户端 + 当前 access_token」。
    ///
    /// 失败（如 keychain 读不到、凭证不全）返回 `Err(原因)`——上层把它记进该 region 的摘要
    /// `error`，跳过这个 region，继续别的。返回 `Ok((api, token))` 即可用于 `sync_*`。
    fn prepare(&self, region: Region) -> Result<(Self::Api, String), String>;

    /// 某 region 的 access_token 过期、刷新成功后回调本方法落新 token（access + refresh）。
    ///
    /// 默认空实现：测试 env 通常不需要真的落盘（mock 不校验持久化）。生产实现
    /// [`KeychainEnv`] 覆盖它，把新 token 写回 keychain + config（见其实现注释里的一次性
    /// refresh_token 落盘顺序）。
    fn on_refreshed(&self, _region: Region, _tokens: &oauth::TokenSet) -> Result<(), String> {
        Ok(())
    }

    /// 用某 region 的 refresh_token 去换一对新 token（命中 `TokenExpired` 时调用）。
    ///
    /// 抽成方法是因为「刷新」也要发 HTTP（[`oauth::refresh`]），同样需要在测试里替身。默认
    /// 返回 `Err`（测试若不演练刷新分支就用默认）；生产实现真正调 `oauth::refresh`。
    fn refresh_token(&self, _region: Region) -> impl std::future::Future<Output = Result<oauth::TokenSet, String>> + Send {
        async { Err("当前同步环境不支持 token 刷新".to_string()) }
    }
}

/* ===================== sync_once：一轮同步的核心编排 ===================== */

/// 跑一轮同步：对每个已连接 region —— 取凭证 → 同步日历列表 → 逐日历同步事件 → 结束 notify。
///
/// 编排约束（全部已在测试里覆盖）：
///  - **region 串行、region 内日历串行**：外层 for region、内层 for calendar，无并发。
///  - **单点失败继续**：某日历 `sync_one_calendar` 失败 → 写它的 `sync_state.last_error`，
///    continue 下一个；某 region `prepare` / `sync_calendar_list` 失败 → 记该 region 摘要的
///    `error`，continue 下一个 region。**任何一步都不 `?` 提前返回、不 panic。**
///  - **结束统一 notify 一次**：只要本轮有任何 region 落过库（upsert/软删 > 0），就在最后调
///    `notify("calendar_events")`，让前端刷新。零变更则不打扰前端（少一次无谓 hydrate）。
///  - **token 过期自愈**：`sync_calendar_list` / `sync_one_calendar` 返回 `TokenExpired` →
///    走 [`refresh_and_retry`]（刷新 token 后用新 token 重试本步一次）。
///
/// 返回 [`SyncSummary`] 供手动触发路径回给前端；后台定时路径忽略返回值（只关心副作用：落库 + notify）。
pub async fn sync_once<E: SyncEnv>(env: &E, pool: &SqlitePool, notify: &Notifier) -> SyncSummary {
    let mut regions_summary: Vec<RegionSyncSummary> = Vec::new();
    // 本轮是否落过库（决定结束要不要 notify 前端）。
    let mut any_change = false;

    for region in env.connected_regions() {
        let mut summary = RegionSyncSummary {
            region: region.tag().to_string(),
            calendars: 0,
            upserted: 0,
            deleted: 0,
            error: None,
        };

        // 1) 取凭证 + 造客户端。失败 → 整 region 跳过（记 error），继续下一个 region。
        let (api, mut token) = match env.prepare(region) {
            Ok(v) => v,
            Err(e) => {
                summary.error = Some(e);
                regions_summary.push(summary);
                continue;
            }
        };

        // 2) 同步日历列表（含 token 过期自愈）。失败 → 整 region 跳过。
        let active = match sync_calendar_list(&api, pool, region, &token).await {
            Ok(list) => list,
            Err(FeishuError::TokenExpired) => {
                // access_token 失效：刷新后用新 token 重试一次列表同步。
                match refresh_and_retry(env, region, &mut token, |t| {
                    let api = &api;
                    async move { sync_calendar_list(api, pool, region, &t).await }
                })
                .await
                {
                    Ok(list) => list,
                    Err(e) => {
                        summary.error = Some(e);
                        regions_summary.push(summary);
                        continue;
                    }
                }
            }
            Err(e) => {
                summary.error = Some(e.to_string());
                regions_summary.push(summary);
                continue;
            }
        };

        summary.calendars = active.len();

        // 3) 逐日历同步事件（region 内串行）。单个日历失败 → 记它的 sync_state.last_error，
        //    continue 下一个日历（不污染整 region 摘要的 error）。
        for calendar_id in &active {
            // 进入前置 'syncing'（旁路写，失败不致命，忽略即可）。
            let _ = db::set_sync_status(pool, region, calendar_id, "syncing", None).await;

            let result = match sync_one_calendar(&api, pool, region, &token, calendar_id).await {
                Err(FeishuError::TokenExpired) => {
                    // 单日历也可能撞 token 过期：刷新后重试这一个日历。
                    refresh_and_retry(env, region, &mut token, |t| {
                        let api = &api;
                        async move { sync_one_calendar(api, pool, region, &t, calendar_id).await }
                    })
                    .await
                    .map_err(FeishuError::Http)
                }
                other => other,
            };

            match result {
                Ok(stats) => {
                    summary.upserted += stats.upserted;
                    summary.deleted += stats.deleted;
                    if stats.upserted > 0 || stats.deleted > 0 {
                        any_change = true;
                    }
                    // sync_one_calendar 内部已在事务里把状态推回 'idle'（advance_sync_token），
                    // 这里不再重复写状态。
                }
                Err(e) => {
                    // 已删但仍赖在飞书列表里的日历（拉日程返回 191003 "calendar is deleted"）：
                    // 这不是同步失败、是日历没了——标记 is_deleted + 状态归 idle/清错误，让它从 UI
                    // 消失、不再吓人地报错；其它日历照常。
                    if matches!(&e, FeishuError::Api { code, .. } if *code == CALENDAR_DELETED_CODE) {
                        let _ = db::mark_calendar_deleted(pool, region, calendar_id).await;
                        let _ = db::set_sync_status(pool, region, calendar_id, "idle", None).await;
                    } else {
                        // 真·单点失败：落该日历 last_error，继续下一个。绝不中断整轮。
                        let _ = db::set_sync_status(pool, region, calendar_id, "error", Some(&e.to_string()))
                            .await;
                        eprintln!(
                            "[feishu] region={} calendar={} 同步失败（已跳过，继续下一个）: {e}",
                            region.tag(),
                            calendar_id
                        );
                    }
                }
            }
        }

        regions_summary.push(summary);
    }

    // 4) 本轮有落库才通知前端刷新（统一一次）。
    if any_change {
        notify("calendar_events");
    }

    SyncSummary {
        regions: regions_summary,
    }
}

/// token 过期自愈：刷新 token → 落盘 → 用新 token 重跑一次 `step`。
///
/// `step` 是「拿一个 token 跑某一步同步」的闭包（列表同步 / 单日历同步都可），借此把「刷新后
/// 重试」的公共逻辑收口一处。流程：
///  1. `env.refresh_token(region)` 发 HTTP 换一对新 token（失败 → 把刷新错误回抛，上层记进摘要）。
///  2. `env.on_refreshed(region, &tokens)` 落盘新 token（access + refresh + 过期时间）。
///     **注意**：飞书 refresh_token 一次性，落盘失败属严重情况（下次将拿着已失效的旧 refresh
///     去刷、必然失败要求用户重连），所以落盘失败也回抛、记 last_error 让用户看见。
///  3. 用新 access_token 重跑 `step` 一次；仍失败则把该步错误回抛（不再二次刷新，避免死循环）。
///
/// 把刷新到的新 access_token 写回 `*token`（调用方后续日历继续用这个新 token，不必每个日历各刷一次）。
///
/// 对成功类型 `T` 泛化：列表同步 `step` 返回 `Vec<String>`、单日历同步返回 `SyncStats`，两者共用本
/// 助手（仅「刷新→落盘→重试一次」的控制流相同，产物类型不同）。失败统一返回 `String`（刷新错误 /
/// 落盘错误 / 重试后的步骤错误都转成可读串，由上层记进 last_error 或 region 摘要）。
/// `step` 收**owned** `String`（新 access_token）而非 `&str`：避免「闭包返回的 future 借用入参
/// `&str`」触发的高阶生命周期(HRTB)死结——那种写法要求 `for<'a> FnOnce(&'a str) -> Fut<'a>`，
/// Rust 当前对闭包推不出来。传 owned token 一刀切干净，多一次 clone 无关紧要（每轮至多刷一次）。
async fn refresh_and_retry<E, T, F, Fut>(
    env: &E,
    region: Region,
    token: &mut String,
    step: F,
) -> Result<T, String>
where
    E: SyncEnv,
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<T, FeishuError>>,
{
    let tokens = env.refresh_token(region).await?;
    env.on_refreshed(region, &tokens)?;
    *token = tokens.access_token.clone();
    step(tokens.access_token).await.map_err(|e| e.to_string())
}

/* ===================== run_scheduler：常驻后台任务 ===================== */

/// 进程内常驻的同步调度任务。启动跑一次 + 每 5min 一次 + 可被 [`SyncHandle::wake`] 手动唤醒。
///
/// 与 mcp::start 同款「附加能力，失败只记日志不致命」原则：连库失败 → 打日志后**退出本任务**
/// （后台同步是增强项，连不上库时主应用照常用，下次启动再试）。注意这里 spawn 出来的任务一旦
/// 退出就不会自我重启，所以「连库」放在循环外只做一次；循环内的同步失败由 [`sync_once`] 内部
/// 兜住（不会冒泡到这里、不会让任务退出）。
///
/// 参数：
///  - `db_path`：latitude.db 路径（与前端、mcp 共享同一文件，WAL 并发安全）。
///  - `notify`：写库后刷新前端的回调（复用 lib.rs 现成闭包）。
///  - `handle`：手动唤醒句柄（其内含的 [`Notify`] 被 `feishu_sync_now` 戳一下即插一轮）。
pub async fn run_scheduler(db_path: PathBuf, notify: Notifier, handle: SyncHandle) {
    // 连库（只做一次，失败则本任务退出——见上方注释）。
    let pool = match db::connect(&db_path).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[feishu] 连接数据库失败，日历同步调度未启动: {e}");
            return;
        }
    };

    let env = KeychainEnv::new(db_path);

    // 启动先跑一次（串行锁内）。
    run_locked(&handle, &env, &pool, &notify).await;

    let mut ticker = tokio::time::interval(SYNC_INTERVAL);
    // 第一拍 interval 会立刻就绪（tokio 语义），消费掉它——上面已经手动跑过一次，避免开机连跑两轮。
    ticker.tick().await;

    loop {
        // 定时 tick 或 手动唤醒，谁先来跑谁。
        tokio::select! {
            _ = ticker.tick() => {
                run_locked(&handle, &env, &pool, &notify).await;
            }
            _ = handle.wake.notified() => {
                run_locked(&handle, &env, &pool, &notify).await;
            }
        }
    }
}

/// 在串行锁保护下跑一轮 [`sync_once`]（吞掉返回的 summary，后台路径只要副作用）。
///
/// 持锁跑保证「同一时刻全局只有一轮」——定时 tick 和手动唤醒撞上时，后到的等前一轮跑完再跑，
/// 不会两轮并发刷同一个库 / 同时打飞书接口。
async fn run_locked<E: SyncEnv>(handle: &SyncHandle, env: &E, pool: &SqlitePool, notify: &Notifier) {
    let _guard = handle.lock.lock().await;
    let _ = sync_once(env, pool, notify).await;
}

/// 调度任务的对外句柄：手动唤醒（`wake`）+ 串行锁（`lock`）。
///
/// `feishu_sync_now` 持有它的克隆：`wake.notify_one()` 戳一下让 scheduler 立即插一轮；`lock`
/// 是「同一时刻一轮」的全局串行锁，手动触发与定时触发共用同一把。clone 共享同一对底层
/// （`Arc<Notify>` / `Arc<Mutex>`），所以放进 Tauri `manage()` 后任何地方拿到的都是同一把锁。
#[derive(Clone)]
pub struct SyncHandle {
    /// 手动唤醒信号：戳一下 scheduler 立即插一轮同步。
    wake: Arc<Notify>,
    /// 全局串行锁：保证同一时刻只有一轮同步在跑。
    lock: Arc<Mutex<()>>,
}

impl Default for SyncHandle {
    fn default() -> Self {
        SyncHandle {
            wake: Arc::new(Notify::new()),
            lock: Arc::new(Mutex::new(())),
        }
    }
}

impl SyncHandle {
    /// 戳一下调度任务，请求立即同步一轮（非阻塞；若调度任务此刻没在 await 唤醒点，信号会被记住
    /// 一次，等它回到 select 时立刻触发）。
    pub fn wake(&self) {
        self.wake.notify_one();
    }
}

/* ===================== 生产实现：KeychainEnv ===================== */

/// 生产环境的 [`SyncEnv`]：从 config 读 app_id、从 keychain 读 token、造 [`FeishuClient`]、
/// 用 [`oauth::refresh`] 刷新并把新 token 落回 keychain + config。
///
/// 持有 `config_dir`（feishu_config.json 所在目录）以读写非敏感配置；keychain 是进程级全局，
/// 不需要额外句柄。
struct KeychainEnv {
    config_dir: PathBuf,
    /// 刷新 token 用的 HTTP 客户端（reqwest，复用同一个连接池）。
    http: reqwest::Client,
}

impl KeychainEnv {
    /// `db_path` 是 latitude.db 路径；其父目录即 app config 目录（feishu_config.json 与
    /// latitude.db 同目录，见 config.rs 的落点约定）。
    fn new(db_path: PathBuf) -> Self {
        let config_dir = db_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        KeychainEnv {
            config_dir,
            http: reqwest::Client::new(),
        }
    }
}

impl SyncEnv for KeychainEnv {
    type Api = FeishuClient;

    fn connected_regions(&self) -> Vec<Region> {
        // 读 config：哪些 region 标了 connected。顺序固定（Feishu 先、Lark 后）保证可预期串行。
        let cfg = config::load(&self.config_dir);
        let mut out = Vec::new();
        for region in [Region::Feishu, Region::Lark] {
            if cfg.region(region).connected {
                out.push(region);
            }
        }
        out
    }

    fn prepare(&self, region: Region) -> Result<(FeishuClient, String), String> {
        // app_id 来自明文 config；secret/token 来自 keychain。三者不全 → 视为未就绪，跳过。
        let cfg = config::load(&self.config_dir);
        let app_id = cfg
            .region(region)
            .app_id
            .clone()
            .ok_or_else(|| "缺少 app_id（尚未配置）".to_string())?;
        let creds = keychain::load_credentials(region, &app_id)?
            .ok_or_else(|| "凭证不全（app_secret / access_token / refresh_token 缺失）".to_string())?;
        Ok((FeishuClient::new(region), creds.access_token))
    }

    async fn refresh_token(&self, region: Region) -> Result<oauth::TokenSet, String> {
        // 取当前 app_id / app_secret / refresh_token，调 oauth::refresh 换一对新的。
        let cfg = config::load(&self.config_dir);
        let app_id = cfg
            .region(region)
            .app_id
            .clone()
            .ok_or_else(|| "刷新失败：缺少 app_id".to_string())?;
        let creds = keychain::load_credentials(region, &app_id)?
            .ok_or_else(|| "刷新失败：凭证不全".to_string())?;
        oauth::refresh(
            &self.http,
            region,
            &creds.app_id,
            &creds.app_secret,
            &creds.refresh_token,
        )
        .await
    }

    fn on_refreshed(&self, region: Region, tokens: &oauth::TokenSet) -> Result<(), String> {
        // 落盘新 token。顺序与 commands.rs::persist_tokens 一致（先 keychain 后 config），
        // 但本方法的调用时机是「本轮同步写库 commit 之后」（见 sync_once 调用链）——refresh_token
        // 一次性，把它的落盘放在数据已安全落库之后，缩小「新 refresh 已换到但还没存就崩」的窗口。
        keychain::set_secret(region, keychain::Secret::AccessToken, &tokens.access_token)?;
        keychain::set_secret(region, keychain::Secret::RefreshToken, &tokens.refresh_token)?;
        let mut cfg = config::load(&self.config_dir);
        let rc = cfg.region_mut(region);
        rc.connected = true;
        rc.token_expires_at = Some(chrono::Utc::now().timestamp() + tokens.expires_in);
        rc.last_error = None;
        config::save(&self.config_dir, &cfg)
    }
}

/* ===================== Tauri command：手动触发一轮 ===================== */

/// 前端「立即同步」按钮调：手动触发一轮同步，**等这一轮跑完**再把摘要返回。
///
/// 与定时调度共用同一把全局串行锁（[`SyncHandle::lock`]）——若此刻定时那轮正在跑，这里会等它
/// 跑完再跑自己这轮（不会并发）。直接在 command 里持锁跑 [`sync_once`]（而不是只 `wake` 让后台
/// 跑）是为了**拿到这一轮的 SyncSummary 回给前端**；后台 wake 路径无法把结果传回 command。
///
/// 取 `db_path` / `config_dir` 的方式与 lib.rs setup() 一致：app config 目录下的 latitude.db。
#[tauri::command]
pub async fn feishu_sync_now(app: AppHandle) -> Result<SyncSummary, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?;
    let db_path = config_dir.join("latitude.db");

    // 从 Tauri 全局状态取调度句柄（lib.rs setup() 里 manage 进去的同一把锁）。没有则退化为
    // 「自建一把临时锁」——保证 command 仍可独立工作（虽然此时与后台调度不互斥，但 WAL 下并发写
    // 安全，最坏是偶尔多刷一轮；正常路径句柄一定在）。
    let handle = app
        .try_state::<SyncHandle>()
        .map(|s| s.inner().clone())
        .unwrap_or_default();

    let pool = db::connect(&db_path)
        .await
        .map_err(|e| format!("连接数据库失败: {e}"))?;

    let env = KeychainEnv::new(db_path);

    // notify：手动同步落库后也要刷新前端。emit 与 lib.rs 的 notify 闭包同频道（data-changed）。
    let app_for_notify = app.clone();
    let notify: Notifier = Arc::new(move |topic: &str| {
        use tauri::Emitter;
        let _ = app_for_notify.emit("latitude://data-changed", topic.to_string());
    });

    // 持全局串行锁跑这一轮，拿摘要回前端。
    let _guard = handle.lock.lock().await;
    Ok(sync_once(&env, &pool, &notify).await)
}

/* ===================== Tauri command：回写变更队列（Phase 4 P4-3） ===================== */

/// 前端编辑事件后调：把 `calendar_change_queue` 里 pending/failed 的本地变更回写到飞书。
///
/// 流程：取首个已连接 region 的凭证 + 造 [`FeishuClient`] → 持**同一把全局串行锁**（与同步互斥，
/// 避免回写与拉取并发，也避免两次 flush 抢同一队列）→ 调 [`writeback::flush_pending`] → 回
/// [`FlushResult`]{pushed,conflicted,failed} 给前端（据此重 hydrate / 弹冲突卡）。
///
/// **关键决策（region 路由）**：`calendar_change_queue` 表无 region 列（队列项按 calendar_id 区分日历，
/// 但不区分平台）。本命令用「首个已连接 region」的凭证回写——覆盖最常见的单平台（仅飞书 或 仅 Lark）
/// 场景。若用户同时连了飞书 + Lark，队列项无法据此自动路由到正确平台（需给队列表加 region 列才能彻底
/// 解决，属后续增强）。当前实现保证单平台正确、双平台不崩（用首个 region 凭证尝试，跨平台的项会因
/// calendar_id 不属于该平台而失败入 failed、留待后续按 region 路由的版本处理），不丢数据。
///
/// 落库后若有任何 pushed/conflicted（队列状态变化），统一 notify 前端刷新日历事件 store。
#[tauri::command]
pub async fn feishu_flush_queue(app: AppHandle) -> Result<crate::feishu::writeback::FlushResult, String> {
    // SyncEnv（prepare / connected_regions）就定义在本模块，方法已在作用域内，无需额外 use。

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?;
    let db_path = config_dir.join("latitude.db");

    let handle = app
        .try_state::<SyncHandle>()
        .map(|s| s.inner().clone())
        .unwrap_or_default();

    let pool = db::connect(&db_path)
        .await
        .map_err(|e| format!("连接数据库失败: {e}"))?;

    let env = KeychainEnv::new(db_path);

    // 取首个已连接 region 的凭证 + 客户端（见上方 region 路由决策）。
    let region = env
        .connected_regions()
        .into_iter()
        .next()
        .ok_or_else(|| "没有已连接的飞书/Lark 账号，无法回写".to_string())?;
    let (api, token) = env.prepare(region)?;

    // 持全局串行锁跑回写（与同步、其它 flush 互斥）。
    let _guard = handle.lock.lock().await;
    let result = crate::feishu::writeback::flush_pending(&api, &pool, &token, region)
        .await
        .map_err(|e| e.to_string())?;

    // 有任何队列项被处理（成功或转冲突）→ 通知前端刷新（重 hydrate 日历事件 / 弹冲突卡）。
    if result.pushed > 0 || result.conflicted > 0 {
        use tauri::Emitter;
        let _ = app.emit("latitude://data-changed", "calendar_events".to_string());
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    /* ---------- 测试库（:memory: + 手建表，max_connections(1)），与 sync.rs 同构 ---------- */

    const TEST_DDL: &str = "
        CREATE TABLE calendar_events (
          id TEXT PRIMARY KEY, region TEXT NOT NULL, calendar_id TEXT NOT NULL,
          remote_event_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
          description TEXT, location TEXT, is_all_day INTEGER NOT NULL DEFAULT 0,
          start_ts INTEGER, end_ts INTEGER, timezone TEXT,
          scheduled_date TEXT, scheduled_time TEXT,
          status TEXT NOT NULL DEFAULT 'confirmed',
          is_recurring_instance INTEGER NOT NULL DEFAULT 0,
          recurrence_master_id TEXT, instance_start_iso TEXT, calendar_name TEXT,
          is_writable INTEGER NOT NULL DEFAULT 0, local_draft INTEGER NOT NULL DEFAULT 0,
          etag TEXT, freshness INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE event_map (
          id TEXT PRIMARY KEY, region TEXT NOT NULL, calendar_id TEXT NOT NULL,
          remote_event_id TEXT NOT NULL, dedup_key TEXT NOT NULL, local_id TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX uq_event_map_dedup ON event_map(region, calendar_id, dedup_key);
        CREATE UNIQUE INDEX uq_event_map_local ON event_map(local_id);
        CREATE TABLE sync_state (
          region TEXT NOT NULL, calendar_id TEXT NOT NULL, sync_token TEXT,
          last_synced_at TEXT, status TEXT NOT NULL DEFAULT 'idle', last_error TEXT,
          is_writable INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (region, calendar_id)
        );
        CREATE TABLE calendar_meta (
          region TEXT NOT NULL, calendar_id TEXT NOT NULL, summary TEXT,
          cal_type TEXT, access_role TEXT, is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (region, calendar_id)
        );
    ";

    async fn test_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        for stmt in TEST_DDL.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            sqlx::query(stmt).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn count(pool: &SqlitePool, sql: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(sql).fetch_one(pool).await.unwrap()
    }

    async fn scalar_str(pool: &SqlitePool, sql: &str) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>(sql)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// 计数型 notify：记录被调用了几次、最后一次的 topic（断言「落库后通知前端」）。
    fn counting_notifier() -> (Notifier, Arc<AtomicUsize>, Arc<StdMutex<Vec<String>>>) {
        let count = Arc::new(AtomicUsize::new(0));
        let topics = Arc::new(StdMutex::new(Vec::<String>::new()));
        let c = count.clone();
        let t = topics.clone();
        let notify: Notifier = Arc::new(move |topic: &str| {
            c.fetch_add(1, Ordering::SeqCst);
            t.lock().unwrap().push(topic.to_string());
        });
        (notify, count, topics)
    }

    /* ---------- mock CalendarApi（与 sync.rs 测试同款 Step 序列驱动） ---------- */

    enum Step {
        Page(Value),
        Err(FeishuError),
    }

    struct MockApi {
        events_steps: std::sync::Mutex<Vec<Step>>,
        calendars_steps: std::sync::Mutex<Vec<Step>>,
    }

    impl MockApi {
        fn pop(steps: &std::sync::Mutex<Vec<Step>>) -> Result<Value, FeishuError> {
            let mut g = steps.lock().unwrap();
            if g.is_empty() {
                return Ok(json!({ "items": [], "has_more": false }));
            }
            match g.remove(0) {
                Step::Page(v) => Ok(v),
                Step::Err(e) => Err(e),
            }
        }
    }

    impl CalendarApi for MockApi {
        async fn list_calendars(
            &self,
            _token: &str,
            _page_token: Option<&str>,
            _sync_token: Option<&str>,
        ) -> Result<Value, FeishuError> {
            MockApi::pop(&self.calendars_steps)
        }
        async fn list_events(
            &self,
            _token: &str,
            _calendar_id: &str,
            _page_token: Option<&str>,
            _sync_token: Option<&str>,
            _time_min: Option<&str>,
            _time_max: Option<&str>,
        ) -> Result<Value, FeishuError> {
            MockApi::pop(&self.events_steps)
        }
    }

    fn ev_confirmed(id: &str, etag: i64) -> Value {
        json!({
            "event_id": id,
            "summary": format!("事件 {id}"),
            "status": "confirmed",
            "etag": etag.to_string(),
            "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" },
            "end_time":   { "timestamp": "1767229200", "timezone": "Asia/Shanghai" }
        })
    }

    /// 一个区域一组「list_calendars 序列 + list_events 序列」的预案。
    struct RegionPlan {
        calendars: Vec<Step>,
        events: Vec<Step>,
    }

    /// 可编程的测试 env：预设若干 region 的返回序列。可选地演练「TokenExpired → 刷新成功」。
    struct MockEnv {
        regions: Vec<Region>,
        /// 每个 region 对应一份 MockApi（用 Option 是为了 prepare 时 take 出来交给 sync_once）。
        plans: std::sync::Mutex<std::collections::HashMap<&'static str, MockApi>>,
        /// 哪些 region 的 prepare 应当直接失败（模拟取凭证失败）。
        prepare_fail: Vec<Region>,
        /// refresh_token 被调用的次数（断言 token 过期时确实走了刷新）。
        refresh_calls: Arc<AtomicUsize>,
        /// refresh_token 是否应当成功（true=返回新 token；false=刷新本身失败）。
        refresh_ok: bool,
    }

    impl MockEnv {
        fn new(plans: Vec<(Region, RegionPlan)>) -> Self {
            let regions: Vec<Region> = plans.iter().map(|(r, _)| *r).collect();
            let mut map = std::collections::HashMap::new();
            for (r, plan) in plans {
                map.insert(
                    r.tag(),
                    MockApi {
                        events_steps: std::sync::Mutex::new(plan.events),
                        calendars_steps: std::sync::Mutex::new(plan.calendars),
                    },
                );
            }
            MockEnv {
                regions,
                plans: std::sync::Mutex::new(map),
                prepare_fail: Vec::new(),
                refresh_calls: Arc::new(AtomicUsize::new(0)),
                refresh_ok: true,
            }
        }
        fn with_prepare_fail(mut self, regions: Vec<Region>) -> Self {
            self.prepare_fail = regions;
            self
        }
        fn with_refresh_ok(mut self, ok: bool) -> Self {
            self.refresh_ok = ok;
            self
        }
    }

    impl SyncEnv for MockEnv {
        type Api = MockApi;

        fn connected_regions(&self) -> Vec<Region> {
            self.regions.clone()
        }

        fn prepare(&self, region: Region) -> Result<(MockApi, String), String> {
            if self.prepare_fail.contains(&region) {
                return Err("模拟：取凭证失败".to_string());
            }
            let api = self
                .plans
                .lock()
                .unwrap()
                .remove(region.tag())
                .ok_or_else(|| "测试预案缺失".to_string())?;
            Ok((api, "tok".to_string()))
        }

        async fn refresh_token(&self, _region: Region) -> Result<oauth::TokenSet, String> {
            self.refresh_calls.fetch_add(1, Ordering::SeqCst);
            if self.refresh_ok {
                Ok(oauth::TokenSet {
                    access_token: "new_access".into(),
                    refresh_token: "new_refresh".into(),
                    expires_in: 7200,
                    refresh_token_expires_in: 604800,
                })
            } else {
                Err("模拟：刷新 token 失败".to_string())
            }
        }
    }

    /* ================= sync_once：基本跑通（mock + :memory:） ================= */

    /// 单 region 单日历：列表给一个日历、该日历给两条事件 → 落库 2 行 + notify 被调一次。
    #[tokio::test]
    async fn sync_once_single_region_writes_and_notifies() {
        let pool = test_pool().await;
        let (notify, ncount, topics) = counting_notifier();

        let env = MockEnv::new(vec![(
            Region::Feishu,
            RegionPlan {
                calendars: vec![Step::Page(json!({
                    "items": [ { "calendar_id": "cal_1", "summary": "工作", "type": "primary", "role": "owner" } ],
                    "has_more": false, "sync_token": "L1"
                }))],
                events: vec![Step::Page(json!({
                    "items": [ ev_confirmed("ev1", 1), ev_confirmed("ev2", 1) ],
                    "has_more": false, "sync_token": "E1"
                }))],
            },
        )]);

        let summary = sync_once(&env, &pool, &notify).await;

        // 摘要正确。
        assert_eq!(summary.regions.len(), 1);
        let r = &summary.regions[0];
        assert_eq!(r.region, "feishu");
        assert_eq!(r.calendars, 1);
        assert_eq!(r.upserted, 2);
        assert_eq!(r.deleted, 0);
        assert!(r.error.is_none());

        // 落库 2 行。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 2);
        // notify 恰好一次、topic 是 calendar_events。
        assert_eq!(ncount.load(Ordering::SeqCst), 1, "落库后应通知前端一次");
        assert_eq!(topics.lock().unwrap().as_slice(), &["calendar_events".to_string()]);
    }

    /// 零变更（列表为空、没有日历）→ 不 notify（不打扰前端）。
    #[tokio::test]
    async fn sync_once_no_change_does_not_notify() {
        let pool = test_pool().await;
        let (notify, ncount, _topics) = counting_notifier();

        let env = MockEnv::new(vec![(
            Region::Feishu,
            RegionPlan {
                calendars: vec![Step::Page(json!({ "items": [], "has_more": false, "sync_token": "L1" }))],
                events: vec![],
            },
        )]);

        let summary = sync_once(&env, &pool, &notify).await;
        assert_eq!(summary.regions[0].calendars, 0);
        assert_eq!(summary.regions[0].upserted, 0);
        assert_eq!(ncount.load(Ordering::SeqCst), 0, "零变更不应 notify");
    }

    /* ================= 多 region 串行 + region 顺序保持 ================= */

    /// 两个 region 都给数据 → 都落库、摘要按 connected_regions 顺序排列、notify 仍只一次（结束统一）。
    #[tokio::test]
    async fn sync_once_two_regions_serial_single_notify() {
        let pool = test_pool().await;
        let (notify, ncount, _topics) = counting_notifier();

        let plan = |cal: &str, ev: &str| RegionPlan {
            calendars: vec![Step::Page(json!({
                "items": [ { "calendar_id": cal, "summary": "c", "type": "primary", "role": "owner" } ],
                "has_more": false, "sync_token": "L"
            }))],
            events: vec![Step::Page(json!({
                "items": [ ev_confirmed(ev, 1) ], "has_more": false, "sync_token": "E"
            }))],
        };

        let env = MockEnv::new(vec![
            (Region::Feishu, plan("cal_f", "ev_f")),
            (Region::Lark, plan("cal_l", "ev_l")),
        ]);

        let summary = sync_once(&env, &pool, &notify).await;

        // 摘要顺序 = 输入顺序（feishu 先、lark 后）。
        assert_eq!(summary.regions.len(), 2);
        assert_eq!(summary.regions[0].region, "feishu");
        assert_eq!(summary.regions[1].region, "lark");
        // 两 region 各 1 条，库里共 2 行（region 列区分）。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE region='feishu'").await, 1);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE region='lark'").await, 1);
        // 结束统一 notify 一次（不是每 region 一次）。
        assert_eq!(ncount.load(Ordering::SeqCst), 1);
    }

    /* ================= 单点失败不中断整轮 ================= */

    /// 某 region prepare 失败 → 该 region 记 error、跳过；另一个 region 照常同步落库。
    #[tokio::test]
    async fn sync_once_region_prepare_failure_skips_only_that_region() {
        let pool = test_pool().await;
        let (notify, ncount, _t) = counting_notifier();

        let env = MockEnv::new(vec![
            (
                Region::Feishu,
                RegionPlan {
                    // feishu 的预案存在但 prepare 会失败（被 with_prepare_fail 拦），不会被消费。
                    calendars: vec![],
                    events: vec![],
                },
            ),
            (
                Region::Lark,
                RegionPlan {
                    calendars: vec![Step::Page(json!({
                        "items": [ { "calendar_id": "cal_l", "summary": "c", "type": "primary", "role": "owner" } ],
                        "has_more": false, "sync_token": "L"
                    }))],
                    events: vec![Step::Page(json!({
                        "items": [ ev_confirmed("ev_l", 1) ], "has_more": false, "sync_token": "E"
                    }))],
                },
            ),
        ])
        .with_prepare_fail(vec![Region::Feishu]);

        let summary = sync_once(&env, &pool, &notify).await;

        // feishu：记了 error、没落库。
        let f = summary.regions.iter().find(|r| r.region == "feishu").unwrap();
        assert!(f.error.is_some(), "prepare 失败应记 error");
        assert_eq!(f.upserted, 0);
        // lark：照常落库。
        let l = summary.regions.iter().find(|r| r.region == "lark").unwrap();
        assert!(l.error.is_none());
        assert_eq!(l.upserted, 1);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE region='lark'").await, 1);
        // 有 region 落了库 → notify 一次。
        assert_eq!(ncount.load(Ordering::SeqCst), 1);
    }

    /// region 内某日历同步失败（注入 Err）→ 该日历落 sync_state.error、跳过；同 region 另一个
    /// 日历照常落库。验证「region 内日历级单点失败继续」。
    #[tokio::test]
    async fn sync_once_one_calendar_fails_others_continue() {
        let pool = test_pool().await;
        let (notify, _n, _t) = counting_notifier();

        // 列表给两个日历：cal_bad（事件拉取爆错）、cal_ok（正常）。events 序列按日历同步顺序消费：
        // sync_once 先同步 active[0]=cal_bad（弹 Err），再 active[1]=cal_ok（弹正常页）。
        let env = MockEnv::new(vec![(
            Region::Feishu,
            RegionPlan {
                calendars: vec![Step::Page(json!({
                    "items": [
                        { "calendar_id": "cal_bad", "summary": "坏", "type": "primary", "role": "owner" },
                        { "calendar_id": "cal_ok",  "summary": "好", "type": "primary", "role": "owner" }
                    ],
                    "has_more": false, "sync_token": "L"
                }))],
                events: vec![
                    Step::Err(FeishuError::Http("cal_bad 拉取失败".into())),
                    Step::Page(json!({
                        "items": [ ev_confirmed("ev_ok", 1) ], "has_more": false, "sync_token": "E_OK"
                    })),
                ],
            },
        )]);

        let summary = sync_once(&env, &pool, &notify).await;

        // 整 region 摘要 error 为 None（日历级失败不冒泡到 region.error）。
        let r = &summary.regions[0];
        assert!(r.error.is_none(), "日历级失败不应污染 region 摘要 error");
        assert_eq!(r.calendars, 2);
        assert_eq!(r.upserted, 1, "只有 cal_ok 的一条落库");

        // cal_ok 落了库；cal_bad 没有。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE calendar_id='cal_ok'").await, 1);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE calendar_id='cal_bad'").await, 0);
        // cal_bad 的 sync_state 落了 error。
        let st = scalar_str(&pool, "SELECT last_error FROM sync_state WHERE calendar_id='cal_bad'").await;
        assert!(st.is_some(), "失败日历应落 last_error");
        assert_eq!(
            scalar_str(&pool, "SELECT status FROM sync_state WHERE calendar_id='cal_bad'").await.as_deref(),
            Some("error")
        );
    }

    /* ================= token 过期 → 刷新后重试 ================= */

    /// 列表同步首次返回 TokenExpired → 走刷新（refresh_calls+1）→ 用新 token 重试列表成功 → 落库。
    #[tokio::test]
    async fn sync_once_token_expired_refreshes_and_retries() {
        let pool = test_pool().await;
        let (notify, _n, _t) = counting_notifier();

        let env = MockEnv::new(vec![(
            Region::Feishu,
            RegionPlan {
                // 第一次 list_calendars → TokenExpired；刷新后第二次 → 正常返回一个日历。
                calendars: vec![
                    Step::Err(FeishuError::TokenExpired),
                    Step::Page(json!({
                        "items": [ { "calendar_id": "cal_1", "summary": "c", "type": "primary", "role": "owner" } ],
                        "has_more": false, "sync_token": "L1"
                    })),
                ],
                events: vec![Step::Page(json!({
                    "items": [ ev_confirmed("ev1", 1) ], "has_more": false, "sync_token": "E1"
                }))],
            },
        )]);

        let summary = sync_once(&env, &pool, &notify).await;

        // 刷新被调一次、最终落库成功。
        assert_eq!(env.refresh_calls.load(Ordering::SeqCst), 1, "TokenExpired 应触发一次刷新");
        let r = &summary.regions[0];
        assert!(r.error.is_none());
        assert_eq!(r.upserted, 1);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1);
    }

    /// 刷新本身失败（refresh_ok=false）→ 该 region 记 error、不落库、不 panic。
    #[tokio::test]
    async fn sync_once_token_expired_refresh_failure_records_error() {
        let pool = test_pool().await;
        let (notify, ncount, _t) = counting_notifier();

        let env = MockEnv::new(vec![(
            Region::Feishu,
            RegionPlan {
                calendars: vec![Step::Err(FeishuError::TokenExpired)],
                events: vec![],
            },
        )])
        .with_refresh_ok(false);

        let summary = sync_once(&env, &pool, &notify).await;

        assert_eq!(env.refresh_calls.load(Ordering::SeqCst), 1);
        let r = &summary.regions[0];
        assert!(r.error.is_some(), "刷新失败应记 region error");
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 0);
        assert_eq!(ncount.load(Ordering::SeqCst), 0, "没落库不 notify");
    }

    /* ================= Mutex 串行化：同一时刻只有一轮 ================= */

    /// 用共享句柄的锁演练「两路触发撞上时串行」：两个并发任务各自先抢锁再跑一段，断言它们的临界区
    /// 不重叠（同一时刻只有一个在「跑」）。这直接验证 run_locked / feishu_sync_now 共用的那把锁
    /// 能把「同一时刻一轮」钉死。
    #[tokio::test]
    async fn handle_lock_serializes_concurrent_rounds() {
        let handle = SyncHandle::default();
        // 当前正在临界区里的任务数；任何时刻都不应 > 1。
        let inside = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let mut joins = Vec::new();
        for _ in 0..8 {
            let h = handle.clone();
            let inside = inside.clone();
            let max_seen = max_seen.clone();
            joins.push(tokio::spawn(async move {
                let _g = h.lock.lock().await; // 与 run_locked 同一把锁
                let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                // 记录见到过的最大并发度。
                max_seen.fetch_max(now, Ordering::SeqCst);
                // 在临界区里让出执行权，给别的任务抢锁的机会（若锁没生效就会并发进来）。
                tokio::task::yield_now().await;
                tokio::time::sleep(Duration::from_millis(5)).await;
                inside.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for j in joins {
            j.await.unwrap();
        }

        assert_eq!(
            max_seen.load(Ordering::SeqCst),
            1,
            "串行锁必须保证同一时刻最多一轮（实际见到的最大并发度应为 1）"
        );
    }

    /// SyncHandle::wake 不阻塞、可被后续 notified() 收到（手动唤醒信号语义自检）。
    #[tokio::test]
    async fn handle_wake_is_observed() {
        let handle = SyncHandle::default();
        // 先 wake（notify_one 会记住一个许可），再 notified() 应立即就绪。
        handle.wake();
        // 加超时兜底：若信号没被记住，这里会卡住 → 测试超时失败。
        let woke = tokio::time::timeout(Duration::from_millis(200), handle.wake.notified()).await;
        assert!(woke.is_ok(), "wake 后 notified() 应立即就绪");
    }
}
