//! 活动记录（activity_capture）的原生后台调度引擎。
//!
//! **为什么有这玩意：** 活动记录的心跳原本是主工作台窗口渲染进程里的 `setInterval`
//! （`src/lib/secretary/scheduler.ts`）。macOS 会冻结隐藏 / 最小化窗口里的 JS 定时器，而本 app
//! 常态就是藏主窗只露悬浮条 → **藏窗即停**，主动提醒形同虚设。把这一档下沉到 Tauri 进程内的
//! 常驻 tokio 任务，不受任何窗口可见性影响。
//!
//! **范式照搬 [`crate::feishu::engine`]：** 同款 `tokio::time::interval` 循环 + 同款
//! [`Notifier`]（`Arc<dyn Fn(&str)>` emit `latitude://data-changed`）+ 同款「连库失败退出本任务、
//! 单 tick 失败只记日志不致命」的长命任务原则。
//!
//! **只做 activity_capture 这一档**：晨报 / 会议将至 / ddl / 任务搁置 / 刚完成仍留在前端 TS 调度器。
//!
//! **闸条件镜像 [`shouldRunActivityCapture`](triggers.ts)**：master_on && enabled && 本地小时
//! ∈ [work_start, work_end) && 距上次触发 >= interval_min*60s && 不在「别烦我」窗口内。
//! 「上次触发」以 DB `proactive_log`（type='activity_capture'）为真相源，跨重启不丢。
//!
//! **投递等价前端 `deliverProactive`**：到点 → 写库（conversations + messages + proactive_log）
//! + 按 channel 发系统横幅 + notify 前端刷新。对话 id 沿用 `ac` 前缀（`chatStore` 的回复
//! writeback 靠此前缀把用户回答写回 `activity_log`，见 `deliverProactive.ts isActivityCaptureConvId`）。
//! 后台一律用固定模板文案，**不调 LLM**（窗口可能已睡）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{Local, Timelike};
use sqlx::SqlitePool;
use tauri::AppHandle;

use crate::secretary::config::{ProactiveConfigState, ProactiveRuntimeConfig};
use crate::util::{gen_id, now_iso};

/// tick 周期：60s。真正的触发节奏由 `interval_min` 把关（每分钟看一眼够不够间隔），
/// 60s 足够精准又不浪费（前端原 setInterval 也是分钟级）。
const TICK_INTERVAL: Duration = Duration::from_secs(60);

/// proactive_log 里活动记录这一档的 type 标签（与前端 `candidate.kind` 一致）。
const ACTIVITY_TYPE: &str = "activity_capture";

/// proactive_log 的 ref_id（活动记录无实体 id，固定串作去重键，对齐前端 triggers.ts）。
const ACTIVITY_REF_ID: &str = "activity_capture";

/// 写库后通知前端刷新的回调（与 feishu::engine::Notifier 同形态）。
///
/// 复用 lib.rs setup() 里现成的 notify 闭包（emit `latitude://data-changed`）。投递落库后调
/// `notify("conversations")`，前端 `App.tsx useDataSync` 据此重新 hydrate 对话列表。
pub type Notifier = Arc<dyn Fn(&str) + Send + Sync>;

/// 固定模板文案（后台不调 LLM；与前端 `ACTIVITY_CAPTURE_PROMPT` 一致）。
fn capture_prompt(lang: &str) -> &'static str {
    match lang {
        "en" => "Hey, what've you been up to? One line is enough 🗒️",
        // 默认中文（含 "zh" 及任何未知值，避免空文案）
        _ => "最近在忙啥?一句话记一下就好 🗒️",
    }
}

/// 对话标题（与前端 deliverProactive 的 activity_capture title 一致）。
fn capture_title(lang: &str) -> &'static str {
    match lang {
        "en" => "Activity Check-in",
        _ => "活动记录 · 过去这段时间",
    }
}

/// 系统通知标题（与前端一致）。
fn notify_title(lang: &str) -> &'static str {
    match lang {
        "en" => "Latitude Activity",
        _ => "Latitude 活动记录",
    }
}

/// 当前 epoch 毫秒（用 SystemTime，不引额外依赖）。时钟回拨等异常退化为 0（视为「很久以前」，
/// 最坏多触发一次，不会 panic）。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 读托管 state 里的当前配置（克隆出来，尽快释放锁）。锁中毒 / 尚未推送 → None（引擎跳过本 tick）。
fn read_config(app: &AppHandle) -> Option<ProactiveRuntimeConfig> {
    use tauri::Manager;
    let state = app.try_state::<ProactiveConfigState>()?;
    let guard = state.0.lock().ok()?;
    guard.clone()
}

/// 读「上次触发」的 epoch ms。真相源 = `proactive_log` 里 type='activity_capture' 的最大 sent_at。
///
/// sent_at 在本库是 ISO-8601 UTC 字符串（如 `2026-06-21T03:04:05.678Z`），这里查出后解析成 epoch ms；
/// 无记录（NULL）或解析失败 → 0（视为「从未触发」，间隔判定天然通过）。
///
/// 失败（查询出错）也返回 0 而非中断——多触发一次远比因一次读错而永久静默好。
async fn last_fired_ms(pool: &SqlitePool) -> i64 {
    // MAX(sent_at) 在无行时返回一行 NULL，故用 Option<String> 接。
    let row: Result<Option<String>, _> =
        sqlx::query_scalar("SELECT MAX(sent_at) FROM proactive_log WHERE type = ?")
            .bind(ACTIVITY_TYPE)
            .fetch_one(pool)
            .await;

    match row {
        Ok(Some(s)) => chrono::DateTime::parse_from_rfc3339(&s)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0),
        _ => 0,
    }
}

/// 闸判定（镜像 triggers.ts `shouldRunActivityCapture`，外加 master_on 总闸）。
///
/// 全部条件都满足才返回 true：
///  1. `master_on`（主动姿态非 off）且 `enabled`（活动记录开关）
///  2. 本地小时 ∈ [work_start, work_end)（开区间，与前端 `new Date().getHours()` 同口径——
///     **必须本地时区**，故用 chrono `Local`，否则会在错误时段触发 / 静默）
///  3. 距上次触发 >= interval_min * 60_000 ms
///  4. 不在「别烦我」窗口内（paused_until 为 Some 且 now <= paused_until 时暂停）
///
/// 纯判断（now_ms / hour / last_fired 都从参数注入），便于单测覆盖边界。
fn should_fire(cfg: &ProactiveRuntimeConfig, hour: u32, now_ms: i64, last_fired_ms: i64) -> bool {
    if !cfg.master_on || !cfg.enabled {
        return false;
    }
    // 工作时段外（开区间终点）
    if hour < cfg.work_start || hour >= cfg.work_end {
        return false;
    }
    // 别烦我中
    if let Some(until) = cfg.paused_until {
        if now_ms <= until {
            return false;
        }
    }
    // 间隔未到（严格 < 不触发；>= 即触发，边界与前端一致）
    if now_ms - last_fired_ms < cfg.interval_min * 60 * 1000 {
        return false;
    }
    true
}

/// 投递一条活动记录（等价前端 `deliverProactive` 的副作用，但用固定模板、不调 LLM）。
///
/// 顺序：
///  1. 写 conversations（id = `ac{ms}_{rand}`、title、created/updated = now ISO、channel='local'）。
///  2. 写 messages（role='assistant'、content = 模板文案、conv_id = 上面的 id）。
///  3. 写 proactive_log（type='activity_capture'、conv_id、sent_at = now ISO、content_preview、
///     ref_id='activity_capture'）。
///  4. channel ∈ {notification, all} → 发系统横幅（失败吞掉，不影响已落库的对话）。
///  5. notify("conversations") 让活跃窗口刷新。
///
/// 任一 DB 写失败 → 返回 Err（调用方记日志、跳过本轮，不 panic）。三条写**不强求同一事务**：
/// 即使中途失败，最坏是留下半条记录，下次 tick 因 last_fired 没推进会重试——比加事务复杂度划算。
async fn deliver(
    app: &AppHandle,
    pool: &SqlitePool,
    cfg: &ProactiveRuntimeConfig,
    notify: &Notifier,
) -> Result<(), sqlx::Error> {
    let conv_id = gen_id("ac"); // 关键：ac 前缀，chatStore 回复 writeback 靠它识别
    let now = now_iso();
    let body = capture_prompt(&cfg.lang);
    let title = capture_title(&cfg.lang);

    // 1) conversations（列名照 db.ts dbInsertConversation：含 channel/external_id，本地来源）
    sqlx::query(
        "INSERT INTO conversations (id, title, created_at, updated_at, channel, external_id) \
         VALUES (?, ?, ?, ?, 'local', NULL)",
    )
    .bind(&conv_id)
    .bind(title)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    // 2) messages（列名照 db.ts dbInsertMessage：assistant 首条，reasoning/usage 为 NULL）
    sqlx::query(
        "INSERT INTO messages (id, conv_id, role, content, reasoning_content, usage_json, created_at) \
         VALUES (?, ?, 'assistant', ?, NULL, NULL, ?)",
    )
    .bind(gen_id("m"))
    .bind(&conv_id)
    .bind(body)
    .bind(&now)
    .execute(pool)
    .await?;

    // 3) proactive_log（列名照 db.ts dbLogProactiveSent：replied_at/dismissed_at 默认 NULL）
    let preview: String = body.chars().take(50).collect();
    sqlx::query(
        "INSERT INTO proactive_log (id, type, conv_id, sent_at, content_preview, replied_at, ref_id) \
         VALUES (?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(gen_id("pl"))
    .bind(ACTIVITY_TYPE)
    .bind(&conv_id)
    .bind(&now)
    .bind(&preview)
    .bind(ACTIVITY_REF_ID)
    .execute(pool)
    .await?;

    // 4) 系统横幅：仅 notification / all。失败吞掉（横幅是「额外」提醒，不该回滚已落库的对话）。
    if cfg.channel == "notification" || cfg.channel == "all" {
        send_notification(app, notify_title(&cfg.lang), body);
    }

    // 5) 刷新前端（复用 lib.rs 现成 notify 闭包）。
    notify("conversations");

    Ok(())
}

/// 发 macOS 系统通知（tauri-plugin-notification Rust API）。任何失败只记日志、不上抛。
fn send_notification(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[secretary] 系统通知失败（忽略）: {e}");
    }
}

/// 跑一个 tick：读配置 → 闸判定 → 到点则投递。任何一步失败只记日志、绝不 panic、绝不让任务退出。
///
/// 抽成独立 async fn 便于阅读：`run_scheduler` 的循环每拍只调它一次。
async fn tick_once(app: &AppHandle, pool: &SqlitePool, notify: &Notifier) {
    // 读配置：None（前端没推 / 锁中毒）/ 总闸关 / 活动记录关 → 跳过本 tick。
    let cfg = match read_config(app) {
        Some(c) => c,
        None => return,
    };
    if !cfg.master_on || !cfg.enabled {
        return;
    }

    let last = last_fired_ms(pool).await;
    let now = now_ms();
    let hour = Local::now().hour(); // 本地时区小时，对齐前端 getHours()

    if !should_fire(&cfg, hour, now, last) {
        return;
    }

    // 到点投递；单次失败非致命（记日志，下个 tick 因 last_fired 未推进会重试）。
    if let Err(e) = deliver(app, pool, &cfg, &notify).await {
        eprintln!("[secretary] 活动记录投递失败（已跳过本轮，下次重试）: {e}");
    }
}

/// 进程内常驻的活动记录调度任务。每 60s 一拍，闸判定到点则投递。
///
/// 与 feishu::engine::run_scheduler 同款「附加能力，失败只记日志不致命」原则：连库失败 → 打日志后
/// **退出本任务**（活动记录是增强项，连不上库时主应用照常，下次启动再试）。spawn 出来的任务一旦
/// 退出不会自我重启，所以「连库」放在循环外只做一次；循环内的单 tick 失败由 [`tick_once`] 内部
/// 兜住（不冒泡、不退出）。
///
/// 参数：
///  - `db_path`：latitude.db 路径（与前端 / mcp / feishu 共享同一文件，WAL 并发安全）。
///  - `app`：发系统通知 + 读托管配置 state 用。
///  - `notify`：写库后刷新前端的回调（复用 lib.rs 现成闭包）。
pub async fn run_scheduler(db_path: PathBuf, app: AppHandle, notify: Notifier) {
    // 连库（复用 feishu::db::connect 的同款 WAL + busy_timeout 配置；create_if_missing(false)：
    // 表由前端建，Rust 只读写既有库）。失败则本任务退出——见上方注释。
    let pool = match crate::feishu::db::connect(&db_path).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[secretary] 连接数据库失败，活动记录调度未启动: {e}");
            return;
        }
    };

    let mut ticker = tokio::time::interval(TICK_INTERVAL);
    // 第一拍 interval 立刻就绪（tokio 语义）；消费掉它，避免 app 一起来就在「可能不该触发的时刻」
    // 立即跑一轮——让首轮也等满一个 60s tick，节奏更可预期（间隔判定仍以 proactive_log 为准）。
    ticker.tick().await;

    loop {
        ticker.tick().await;
        tick_once(&app, &pool, &notify).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(enabled: bool, master_on: bool, interval_min: i64) -> ProactiveRuntimeConfig {
        ProactiveRuntimeConfig {
            enabled,
            master_on,
            interval_min,
            work_start: 9,
            work_end: 22,
            paused_until: None,
            channel: "notification".into(),
            lang: "zh".into(),
        }
    }

    const HOUR_MS: i64 = 60 * 60 * 1000;

    #[test]
    fn skips_when_master_off_or_disabled() {
        // 总闸关：即便其它条件都满足也不触发。
        assert!(!should_fire(&cfg(true, false, 60), 10, 100 * HOUR_MS, 0));
        // 活动记录开关关。
        assert!(!should_fire(&cfg(false, true, 60), 10, 100 * HOUR_MS, 0));
    }

    #[test]
    fn respects_work_hours_open_interval() {
        let c = cfg(true, true, 60);
        // 工作时段 [9, 22)：8 点外、9 点内、21 点内、22 点外（开区间终点）。
        assert!(!should_fire(&c, 8, 100 * HOUR_MS, 0), "8 点应在时段外");
        assert!(should_fire(&c, 9, 100 * HOUR_MS, 0), "9 点应在时段内（闭起点）");
        assert!(should_fire(&c, 21, 100 * HOUR_MS, 0), "21 点应在时段内");
        assert!(!should_fire(&c, 22, 100 * HOUR_MS, 0), "22 点应在时段外（开终点）");
    }

    #[test]
    fn enforces_interval_with_inclusive_boundary() {
        let c = cfg(true, true, 60); // 间隔 60min = 3_600_000 ms
        let now = 100 * HOUR_MS;
        // 距上次刚好 60min → 触发（>= 边界即触发）。
        assert!(should_fire(&c, 10, now, now - 60 * 60 * 1000));
        // 距上次 59min59s → 不触发。
        assert!(!should_fire(&c, 10, now, now - (60 * 60 * 1000 - 1000)));
        // 从未触发（last=0，间隔早已远超）→ 触发。
        assert!(should_fire(&c, 10, now, 0));
    }

    #[test]
    fn respects_paused_until() {
        let mut c = cfg(true, true, 60);
        let now = 100 * HOUR_MS;
        // 别烦我截止在未来（now <= until）→ 暂停。
        c.paused_until = Some(now + 1000);
        assert!(!should_fire(&c, 10, now, 0));
        // now 恰好等于 until → 仍暂停（<= 边界）。
        c.paused_until = Some(now);
        assert!(!should_fire(&c, 10, now, 0));
        // 别烦我已过（now > until）→ 恢复。
        c.paused_until = Some(now - 1);
        assert!(should_fire(&c, 10, now, 0));
    }

    #[test]
    fn templates_fall_back_to_zh() {
        assert!(capture_prompt("zh").contains("最近在忙啥"));
        assert!(capture_prompt("en").contains("what've you been up to"));
        // 未知语言回落中文（不空文案）。
        assert!(capture_prompt("fr").contains("最近在忙啥"));
        assert_eq!(notify_title("zh"), "Latitude 活动记录");
        assert_eq!(capture_title("en"), "Activity Check-in");
    }
}
