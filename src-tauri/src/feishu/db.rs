//! 飞书/Lark 日历同步的 sqlx 仓储底座（Phase 1 数据层的 Rust 侧）。
//!
//! 复用 mcp/db.rs 同款连接（WAL + busy_timeout + create_if_missing(false)）：表一律由前端
//! src/lib/db.ts 的 SCHEMA_V1 负责建，Rust 端**绝不建表**，只按既有列名读写既有库。
//!
//! 设计要点：所有「写」操作都接受 `&mut Transaction`，而不是直接拿 `&Pool` 各写各的——
//! 这样 Phase 2 的同步引擎能把「写一批事件 + 推进 sync_token」放进**同一个 `pool.begin()`
//! 事务**里原子提交（token 与数据一致：要么都进、要么都不进）。「读」操作只需 `&Pool`。
//!
//! 去重核心：event_map 上有唯一索引 uq_event_map_dedup(region,calendar_id,dedup_key)，
//! 同一(区域,日历,去重键)只对应一行 → 一个稳定的 local_id；calendar_events 以该 local_id
//! 为主键 upsert。重复同步同一事件不会产生第二行。

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use std::path::Path;
use std::time::Duration;

use crate::feishu::Region;
use crate::util::{gen_id, now_iso};

/// 连接 latitude.db（与 mcp/db.rs 的 connect 同款配置）。
///
/// create_if_missing(false)：库由前端创建/建表，Rust 只读写既有库。空库上跑会 `no such
/// table`——这是刻意的时序约束（必须先起一次前端建表，Rust 才能用），不在 Rust 侧兜底建表。
/// WAL + busy_timeout：与前端 tauri-plugin-sql 并发读写同一文件时不互相阻塞 / 报 BUSY。
pub async fn connect(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(opts)
        .await
}

/// 远端事件归一后、准备落库的一行输入。
///
/// 字段对齐 calendar_events 表的可写列；id / created_at / updated_at 由仓储层自动生成。
/// `dedup_key` 是去重唯一键（非重复事件 = remote_event_id；重复实例 = master_id + ":" +
/// instance_start_iso），由上层(normalize)算好传入。
#[derive(Debug, Clone)]
pub struct CalendarEventInput {
    pub region: Region,
    pub calendar_id: String,
    pub remote_event_id: String,
    /// 去重键：决定它是否与库里已有行是「同一个事件」。
    pub dedup_key: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub is_all_day: bool,
    /// 原始 UTC 秒（全天事件为 None）。
    pub start_ts: Option<i64>,
    pub end_ts: Option<i64>,
    /// 事件 IANA 时区（定时事件归一用）。
    pub timezone: Option<String>,
    /// 归一产物：'YYYY-MM-DD'（本地），喂日历视图。
    pub scheduled_date: Option<String>,
    /// 归一产物：'HH:MM-HH:MM'；全天为 None。
    pub scheduled_time: Option<String>,
    /// 'confirmed' | 'cancelled'（软删）。
    pub status: String,
    pub is_recurring_instance: bool,
    /// 重复事件母 id（非重复为 None）。
    pub recurrence_master_id: Option<String>,
    /// 重复实例原始起始时间（去重键的另一半）。
    pub instance_start_iso: Option<String>,
    /// 来源日历名（显示标签用）。
    pub calendar_name: Option<String>,
    /// 该日历是否可写（逐日历探测结果冗余到事件行）。
    pub is_writable: bool,
    /// 远端版本号字符串（Phase 4 冲突三态判定用，原样保存）。
    pub etag: Option<String>,
    /// 可比"新鲜度"i64（增量乱序守卫用，由 sync 层从事件 etag/sequence/updated_* 统一算出）。
    /// 与 etag 字符串列分离：etag 给冲突检测、freshness 给"谁更新"的乱序比较，两者口径不混。
    pub freshness: i64,
}

/// sync_state 一行（读出来给上层判断增量游标 / 状态）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncStateRow {
    pub region: String,
    pub calendar_id: String,
    /// 增量游标；None = 还没全量过。
    pub sync_token: Option<String>,
    pub last_synced_at: Option<String>,
    /// 'idle' | 'syncing' | 'error'。
    pub status: String,
    pub last_error: Option<String>,
    pub is_writable: bool,
}

/// upsert 一条日历事件，返回它对应的本地 id（local_id）。
///
/// 两步走（都在传入的事务里，保证看得到彼此未提交的写）：
/// 1. 先在 event_map 里按去重键查/建映射 → 拿到稳定的 local_id（已存在则复用，绝不换 id）。
/// 2. 以该 local_id 为主键 upsert calendar_events（已存在则全字段覆盖，updated_at 刷新）。
///
/// 关键决策：local_id 的稳定性来自 event_map 的去重唯一键——同一(region,calendar_id,
/// dedup_key)永远映射到同一个 local_id，所以同一事件同步多次只会更新同一行、不产生重复。
pub async fn upsert_event(
    tx: &mut Transaction<'_, Sqlite>,
    input: &CalendarEventInput,
) -> Result<String, sqlx::Error> {
    let now = now_iso();
    let region = input.region.tag();

    // 1) 先查 event_map 里是否已有该去重键的映射，有则复用其 local_id。
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT local_id FROM event_map WHERE region = ?1 AND calendar_id = ?2 AND dedup_key = ?3",
    )
    .bind(region)
    .bind(&input.calendar_id)
    .bind(&input.dedup_key)
    .fetch_optional(&mut **tx)
    .await?;

    let local_id = existing.unwrap_or_else(|| gen_id("ce"));

    // 2) upsert event_map：靠唯一索引 uq_event_map_dedup 命中冲突，更新 remote_event_id /
    //    updated_at，但 local_id 保持不变（已建立的本地 id 不能被后续同步改写）。
    let map_id = gen_id("em");
    sqlx::query(
        "INSERT INTO event_map \
         (id, region, calendar_id, remote_event_id, dedup_key, local_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) \
         ON CONFLICT(region, calendar_id, dedup_key) DO UPDATE SET \
           remote_event_id = excluded.remote_event_id, \
           updated_at = excluded.updated_at",
    )
    .bind(&map_id)
    .bind(region)
    .bind(&input.calendar_id)
    .bind(&input.remote_event_id)
    .bind(&input.dedup_key)
    .bind(&local_id)
    .bind(&now)
    .execute(&mut **tx)
    .await?;

    // 3) upsert calendar_events（主键 id = local_id）。已存在则覆盖全部可变列；created_at
    //    仅首次写入有效（ON CONFLICT 不改它）。
    //    注意：is_writable 故意**不**在 ON CONFLICT 里覆盖——它是 set_calendar_writable 的探测
    //    结果，而同步每轮恒传 false；若覆盖会把已探测到的可写性抹掉（可写日历的事件被打回只读）。
    //    可写性只在 INSERT 给初值、之后由 set_calendar_writable 单独维护。
    //    freshness 走专列做增量乱序守卫（与 etag 字符串列分离，见 sync.rs existing_freshness）。
    sqlx::query(
        "INSERT INTO calendar_events \
         (id, region, calendar_id, remote_event_id, title, description, location, is_all_day, \
          start_ts, end_ts, timezone, scheduled_date, scheduled_time, status, \
          is_recurring_instance, recurrence_master_id, instance_start_iso, calendar_name, \
          is_writable, local_draft, etag, freshness, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, \
                 ?18, ?19, 0, ?20, ?22, ?21, ?21) \
         ON CONFLICT(id) DO UPDATE SET \
           region = excluded.region, \
           calendar_id = excluded.calendar_id, \
           remote_event_id = excluded.remote_event_id, \
           title = excluded.title, \
           description = excluded.description, \
           location = excluded.location, \
           is_all_day = excluded.is_all_day, \
           start_ts = excluded.start_ts, \
           end_ts = excluded.end_ts, \
           timezone = excluded.timezone, \
           scheduled_date = excluded.scheduled_date, \
           scheduled_time = excluded.scheduled_time, \
           status = excluded.status, \
           is_recurring_instance = excluded.is_recurring_instance, \
           recurrence_master_id = excluded.recurrence_master_id, \
           instance_start_iso = excluded.instance_start_iso, \
           calendar_name = excluded.calendar_name, \
           etag = excluded.etag, \
           freshness = excluded.freshness, \
           updated_at = excluded.updated_at",
    )
    .bind(&local_id)
    .bind(region)
    .bind(&input.calendar_id)
    .bind(&input.remote_event_id)
    .bind(&input.title)
    .bind(&input.description)
    .bind(&input.location)
    .bind(input.is_all_day as i64)
    .bind(input.start_ts)
    .bind(input.end_ts)
    .bind(&input.timezone)
    .bind(&input.scheduled_date)
    .bind(&input.scheduled_time)
    .bind(&input.status)
    .bind(input.is_recurring_instance as i64)
    .bind(&input.recurrence_master_id)
    .bind(&input.instance_start_iso)
    .bind(&input.calendar_name)
    .bind(input.is_writable as i64)
    .bind(&input.etag)
    .bind(&now)
    .bind(input.freshness)
    .execute(&mut **tx)
    .await?;

    Ok(local_id)
}

/// 软删一条事件：把 calendar_events.status 置为 'cancelled'（不真删行，避免乱序回插）。
///
/// 按 (region, calendar_id, remote_event_id) 定位（一个 remote_event_id 在同一日历下唯一）。
/// 返回是否真的命中了行（远端删的事件本地可能根本没拉过 → false）。
///
/// **`AND local_draft = 0`（评审 HIGH-2）**：只软删「主记录」，绝不碰冲突草稿(local_draft=1)。
/// 真冲突时主记录(local_draft=0)与草稿(local_draft=1)共享同一 remote_event_id；若不加这个过滤，
/// 远端删该事件走增量同步时会把草稿也一并 cancel，用户等决断的本地改动被静默抹掉。草稿的生命周期
/// 只由前端冲突 UI（保留我的 / 用远端）掌控，sync 链路一律不动它。
pub async fn soft_delete_event(
    tx: &mut Transaction<'_, Sqlite>,
    region: Region,
    calendar_id: &str,
    remote_event_id: &str,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE calendar_events SET status = 'cancelled', updated_at = ?1 \
         WHERE region = ?2 AND calendar_id = ?3 AND remote_event_id = ?4 AND local_draft = 0",
    )
    .bind(now_iso())
    .bind(region.tag())
    .bind(calendar_id)
    .bind(remote_event_id)
    .execute(&mut **tx)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// 按去重键查本地 id（只读，给上层判断「这条远端事件本地有没有」）。
pub async fn find_local_id(
    pool: &SqlitePool,
    region: Region,
    calendar_id: &str,
    dedup_key: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT local_id FROM event_map WHERE region = ?1 AND calendar_id = ?2 AND dedup_key = ?3",
    )
    .bind(region.tag())
    .bind(calendar_id)
    .bind(dedup_key)
    .fetch_optional(pool)
    .await
}

/// 推进某日历的增量游标（sync_token）+ 刷新 last_synced_at，并把状态置回 'idle'。
///
/// 关键决策：在事务里调用——Phase 2 把「写完这一批事件」与「推进 token」放同一事务，
/// 保证 token 永远不会领先于已落库的数据（否则崩在中间会丢一段增量）。
/// sync_state 用复合主键 (region, calendar_id)，靠 ON CONFLICT 实现「有则更新无则插」。
pub async fn advance_sync_token(
    tx: &mut Transaction<'_, Sqlite>,
    region: Region,
    calendar_id: &str,
    new_token: Option<&str>,
    last_synced_at: &str,
) -> Result<(), sqlx::Error> {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_state \
         (region, calendar_id, sync_token, last_synced_at, status, last_error, is_writable, \
          created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, 'idle', NULL, 0, ?5, ?5) \
         ON CONFLICT(region, calendar_id) DO UPDATE SET \
           sync_token = excluded.sync_token, \
           last_synced_at = excluded.last_synced_at, \
           status = 'idle', \
           last_error = NULL, \
           updated_at = excluded.updated_at",
    )
    .bind(region.tag())
    .bind(calendar_id)
    .bind(new_token)
    .bind(last_synced_at)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 设置某日历的同步状态（'idle' | 'syncing' | 'error'）+ 错误信息。
///
/// 用 &Pool（非事务）：状态标记是同步流程外缘的旁路写，不需要和数据写在一个事务里
/// （比如开始同步前置 'syncing'、失败后置 'error'）。同样靠 ON CONFLICT upsert。
pub async fn set_sync_status(
    pool: &SqlitePool,
    region: Region,
    calendar_id: &str,
    status: &str,
    last_error: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_state \
         (region, calendar_id, sync_token, last_synced_at, status, last_error, is_writable, \
          created_at, updated_at) \
         VALUES (?1, ?2, NULL, NULL, ?3, ?4, 0, ?5, ?5) \
         ON CONFLICT(region, calendar_id) DO UPDATE SET \
           status = excluded.status, \
           last_error = excluded.last_error, \
           updated_at = excluded.updated_at",
    )
    .bind(region.tag())
    .bind(calendar_id)
    .bind(status)
    .bind(last_error)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

/// 读某日历的 sync_state（不存在返回 None）。
pub async fn get_sync_state(
    pool: &SqlitePool,
    region: Region,
    calendar_id: &str,
) -> Result<Option<SyncStateRow>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT region, calendar_id, sync_token, last_synced_at, status, last_error, is_writable \
         FROM sync_state WHERE region = ?1 AND calendar_id = ?2",
    )
    .bind(region.tag())
    .bind(calendar_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| SyncStateRow {
        region: r.get::<String, _>("region"),
        calendar_id: r.get::<String, _>("calendar_id"),
        sync_token: r.get::<Option<String>, _>("sync_token"),
        last_synced_at: r.get::<Option<String>, _>("last_synced_at"),
        status: r.get::<String, _>("status"),
        last_error: r.get::<Option<String>, _>("last_error"),
        is_writable: r.get::<i64, _>("is_writable") == 1,
    }))
}

/// 设置某日历的可写性：同时落 sync_state.is_writable **和**该日历下所有 calendar_events
/// 行的 is_writable（探测结果要冗余到事件行，前端按 event.is_writable 直接判能否编辑）。
///
/// 用 &Pool 内部自开一个事务把两处写包起来：可写性是一致的语义，不能只更新一半。
pub async fn set_calendar_writable(
    pool: &SqlitePool,
    region: Region,
    calendar_id: &str,
    writable: bool,
) -> Result<(), sqlx::Error> {
    let now = now_iso();
    let w = writable as i64;
    let mut tx = pool.begin().await?;

    // sync_state：有行则更新 is_writable，无行则插一条最小行。
    sqlx::query(
        "INSERT INTO sync_state \
         (region, calendar_id, sync_token, last_synced_at, status, last_error, is_writable, \
          created_at, updated_at) \
         VALUES (?1, ?2, NULL, NULL, 'idle', NULL, ?3, ?4, ?4) \
         ON CONFLICT(region, calendar_id) DO UPDATE SET \
           is_writable = excluded.is_writable, \
           updated_at = excluded.updated_at",
    )
    .bind(region.tag())
    .bind(calendar_id)
    .bind(w)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    // 冗余到该日历下的事件行。
    sqlx::query(
        "UPDATE calendar_events SET is_writable = ?1, updated_at = ?2 \
         WHERE region = ?3 AND calendar_id = ?4",
    )
    .bind(w)
    .bind(&now)
    .bind(region.tag())
    .bind(calendar_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await
}

/// 标记某日历已删除（飞书上删了、但还赖在日历列表里，拉它的日程时返回 191003 "calendar is
/// deleted"）。置 calendar_meta.is_deleted=1，让前端把它从展示里排除；这不是同步失败，是日历没了。
pub async fn mark_calendar_deleted(
    pool: &SqlitePool,
    region: Region,
    calendar_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE calendar_meta SET is_deleted = 1, updated_at = ?1 WHERE region = ?2 AND calendar_id = ?3",
    )
    .bind(now_iso())
    .bind(region.tag())
    .bind(calendar_id)
    .execute(pool)
    .await?;
    Ok(())
}

/* ===================== Phase 4 回写：变更队列读 + 写回成功后的事件更新 ===================== */

/// calendar_change_queue 的一行（出站待回写的本地变更）。字段对齐表列（见 db.ts SCHEMA_V1）。
///
/// `op`：'create' | 'update' | 'delete'。`remote_event_id`：create 入队时通常为 None（还没建），
/// update/delete 必有。`payload_json`：前端组好的事件字段 JSON（create/update 用作请求体）。
/// `base_etag`：入队时本地持有的远端 etag（冲突基线，三态判定用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeRow {
    pub id: String,
    pub op: String,
    pub local_id: String,
    pub calendar_id: String,
    pub remote_event_id: Option<String>,
    pub payload_json: String,
    pub base_etag: Option<String>,
    pub state: String,
    pub retry_count: i64,
}

/// 失败重试上限：一条变更失败累计到这个次数后不再被 [`list_pending_changes`] 捞出（进死信，见
/// 评审 HIGH-3）。取 6：网络抖动/限流类的瞬时失败远不到 6 次就该恢复；到 6 次仍失败基本是确定性
/// 问题（payload 非法 / 权限 / 路由错配），继续重试只是无意义地打飞书接口、耗配额。
pub const MAX_RETRY_COUNT: i64 = 6;

/// 列出待回写的变更：`state='pending'` 或 `state='failed' 且 retry_count < MAX_RETRY_COUNT`，
/// 按入队顺序（created_at）升序。
///
/// 只读，用 &Pool。'failed' 且未达重试上限才拉：失败项下一轮重放（离线/网络抖动恢复后自动重试，
/// 见 P4-5）；达到上限的 failed 视为死信，不再捞出（避免无限重试打飞书，评审 HIGH-3）。
/// 'sending'（在途，本实现不置，见模块头说明）/'done'/'conflict'/'dead' 不再拉——conflict 要用户
/// 决断后才重新入队，dead 是确定性失败的终态（payload 非法 / 未知 op）需人工处理。
pub async fn list_pending_changes(pool: &SqlitePool) -> Result<Vec<ChangeRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, op, local_id, calendar_id, remote_event_id, payload_json, base_etag, \
                state, retry_count \
         FROM calendar_change_queue \
         WHERE state = 'pending' \
            OR (state = 'failed' AND retry_count < ?1) \
         ORDER BY created_at ASC",
    )
    .bind(MAX_RETRY_COUNT)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ChangeRow {
            id: r.get::<String, _>("id"),
            op: r.get::<String, _>("op"),
            local_id: r.get::<String, _>("local_id"),
            calendar_id: r.get::<String, _>("calendar_id"),
            remote_event_id: r.get::<Option<String>, _>("remote_event_id"),
            payload_json: r.get::<String, _>("payload_json"),
            base_etag: r.get::<Option<String>, _>("base_etag"),
            state: r.get::<String, _>("state"),
            retry_count: r.get::<i64, _>("retry_count"),
        })
        .collect())
}

/// 更新一条变更的状态（+ 可选错误信息）。用 &Pool（状态流转是回写流程的旁路写，不强绑事务）。
///
/// 关键决策：失败时 `retry_count` 自增由本函数内部完成——传 `state="failed"` 时 `retry_count = retry_count + 1`，
/// 其它状态不动计数。这样调用方只管「我现在要把它标成什么状态」，重试计数语义集中一处不散落。
/// `last_error` 仅在 Some 时覆盖（成功置 done 时传 None 不会用 NULL 抹掉历史错误，便于排查；
/// 真要清错误显式传 Some("")）。
pub async fn update_change_state(
    pool: &SqlitePool,
    id: &str,
    state: &str,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = now_iso();
    // failed 自增 retry_count；其它状态保持。用 CASE 在 SQL 里判，避免先读后写两趟。
    sqlx::query(
        "UPDATE calendar_change_queue SET \
           state = ?1, \
           retry_count = retry_count + CASE WHEN ?1 = 'failed' THEN 1 ELSE 0 END, \
           last_error = COALESCE(?2, last_error), \
           updated_at = ?3 \
         WHERE id = ?4",
    )
    .bind(state)
    .bind(error)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 在**传入事务里**置一条变更的状态（+ 可选错误）。语义同 [`update_change_state`]，只是写在调用方
/// 的事务连接上，用于「落库 + 改队列状态」需要原子提交的场景（评审 MED-4：冲突处置把存草稿 +
/// 覆盖主记录 + 置 'conflict' 绑成一个事务，崩溃重放因 state 已是 'conflict' 不再被 list 捞）。
pub async fn update_change_state_tx(
    tx: &mut Transaction<'_, Sqlite>,
    id: &str,
    state: &str,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = now_iso();
    sqlx::query(
        "UPDATE calendar_change_queue SET \
           state = ?1, \
           retry_count = retry_count + CASE WHEN ?1 = 'failed' THEN 1 ELSE 0 END, \
           last_error = COALESCE(?2, last_error), \
           updated_at = ?3 \
         WHERE id = ?4",
    )
    .bind(state)
    .bind(error)
    .bind(&now)
    .bind(id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 回写「新建」成功后，把远端返回的 remote_event_id + etag 落回本地事件行，并清掉 local_draft 标记。
/// **同一事务内**还把队列行 (`change_id`) 的 `remote_event_id` 补上 + 置 `state='done'`，原子落地。
///
/// 在传入事务里执行。关键：create 时本地行是用临时 local_id 落的草稿（remote_event_id 可能是占位空串），
/// 推送成功后才拿到真正的远端 id —— 这里把它补上，并把 etag 设成远端新版本、freshness 同步推进、
/// local_draft 归 0（草稿转正式）。按主键 local_id 定位（前端入队时记的本地行 id）。
///
/// **为什么要在同一事务里同时写队列行的 remote_event_id + done（评审 HIGH-1/HIGH-2）**：create 的
/// 幂等闸门判的是 `list_pending_changes` 读出来的队列行 `remote_event_id`。若只把 remote_id 写进
/// calendar_events、不写进队列行，崩溃重放时队列行 remote_event_id 仍为 NULL → 闸门放行 → 飞书端
/// 双建。把「事件行回写 + 队列行补 remote_id + 置 done」三者绑成一个事务：要么全成（远端已建、队列
/// done、下轮不再捞），要么全滚（远端已建但队列仍 pending → 下轮重放时队列行已带 remote_id，闸门转
/// update 而非再 create）。无论崩在哪一步，都不会再 create 第二次。
///
/// 返回事件行命中的行数（rows_affected）：==0 说明本地行已被并发删（评审 LOW-8），调用方据此留痕。
pub async fn apply_pushed_create(
    tx: &mut Transaction<'_, Sqlite>,
    change_id: &str,
    local_id: &str,
    remote_event_id: &str,
    etag: Option<&str>,
) -> Result<u64, sqlx::Error> {
    // freshness 用 etag 的数字形式（与 sync.rs 的乱序守卫同源：etag 是纯数字串时取其值，否则保持 0）。
    // 这样回写产生的版本与后续增量同步拉回的同一事件版本可比，不会被旧增量误判覆盖。
    let fresh = etag.and_then(|e| e.trim().parse::<i64>().ok()).unwrap_or(0);
    let now = now_iso();
    let res = sqlx::query(
        "UPDATE calendar_events SET \
           remote_event_id = ?1, \
           etag = ?2, \
           freshness = ?3, \
           local_draft = 0, \
           updated_at = ?4 \
         WHERE id = ?5",
    )
    .bind(remote_event_id)
    .bind(etag)
    .bind(fresh)
    .bind(&now)
    .bind(local_id)
    .execute(&mut **tx)
    .await?;

    // 同一事务里把队列行补上 remote_event_id + 置 done（消灭「远端已建、队列没 done」中间态）。
    sqlx::query(
        "UPDATE calendar_change_queue SET \
           remote_event_id = ?1, \
           state = 'done', \
           updated_at = ?2 \
         WHERE id = ?3",
    )
    .bind(remote_event_id)
    .bind(&now)
    .bind(change_id)
    .execute(&mut **tx)
    .await?;

    Ok(res.rows_affected())
}

/// 回写「更新」成功后，把远端返回的新 etag 落回本地事件行 + 清 local_draft（草稿转正式），
/// **同一事务内**把队列行 (`change_id`) 置 `state='done'`，原子落地（同 [`apply_pushed_create`] 的理由）。
///
/// 在传入事务里执行。按主键 local_id 定位。与 [`apply_pushed_create`] 的区别：不动 remote_event_id
/// （update 的目标行早就有正确的远端 id），只刷 etag/freshness/local_draft/updated_at。
///
/// 返回事件行命中的行数（rows_affected）：==0 说明本地行已被并发删（评审 LOW-8），调用方据此留痕。
pub async fn apply_pushed_update(
    tx: &mut Transaction<'_, Sqlite>,
    change_id: &str,
    local_id: &str,
    etag: Option<&str>,
) -> Result<u64, sqlx::Error> {
    let fresh = etag.and_then(|e| e.trim().parse::<i64>().ok()).unwrap_or(0);
    let now = now_iso();
    let res = sqlx::query(
        "UPDATE calendar_events SET \
           etag = ?1, \
           freshness = ?2, \
           local_draft = 0, \
           updated_at = ?3 \
         WHERE id = ?4",
    )
    .bind(etag)
    .bind(fresh)
    .bind(&now)
    .bind(local_id)
    .execute(&mut **tx)
    .await?;

    // 同一事务里置队列 done（事件行回写与队列收口原子化）。
    sqlx::query(
        "UPDATE calendar_change_queue SET state = 'done', updated_at = ?1 WHERE id = ?2",
    )
    .bind(&now)
    .bind(change_id)
    .execute(&mut **tx)
    .await?;

    Ok(res.rows_affected())
}

/// 读某本地事件行（按主键 local_id）当前的 etag。不存在 → None（外层 None；行在但 etag 列为 NULL
/// 也返回 None）。给回写前判断 / 测试断言用。
pub async fn read_event_etag(
    pool: &SqlitePool,
    local_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query("SELECT etag FROM calendar_events WHERE id = ?1")
        .bind(local_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|r| r.get::<Option<String>, _>("etag")))
}

/// `save_local_draft` 的结果，让调用方区分三种情形（评审 MED-4 / MED-5）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DraftSnapshot {
    /// 新建了一条草稿（返回草稿行 id）。
    Created(String),
    /// 该 local_id 已有 local_draft=1 草稿 → 跳过新建（崩溃重放幂等，不重复堆草稿）。
    AlreadyExists,
    /// 主记录不存在 → 无本地版可快照（调用方应留痕，别静默丢编辑）。
    NoMaster,
}

/// 把当前主记录行（local_id）整行快照成一条**本地草稿**新行（local_draft=1，新主键 id）。
///
/// **三态冲突「保留本地草稿」的一半**（另一半是 [`overwrite_event_with_remote`] 把主记录覆盖成远端版）。
/// 在传入事务里执行。做法：SELECT 主记录全列 → 用一个新 id INSERT 一份副本，仅把 local_draft 改成 1、
/// id 改成新值、created_at/updated_at 刷新。其余字段（title/时间/etag…）原样保留 = 用户冲突前那一刻的
/// 本地版本，不丢。主记录尚未被覆盖前调用（先存草稿、再覆盖主记录）。
///
/// **幂等守卫（评审 MED-4）**：先查该 local_id 是否已有 local_draft=1 的草稿，有则返回 `AlreadyExists`
/// 跳过新建——冲突处置若在「已存草稿+覆盖主记录」提交后、置 conflict 前崩溃，下轮 flush 会重判冲突
/// 再进来，没有这个守卫就会每次重放堆一条新草稿，前端冲突卡看到多份重复本地版。
///
/// 关键决策（草稿行的 remote_event_id / etag 怎么留）：原样拷贝主记录的当前值。草稿是「我本地的版本」，
/// 它指向同一个远端事件 id；前端渲染从 calendar_events 直接读、按 local_draft 区分主/草稿（去重键带
/// local_draft 维度，见计划 P4-4），不会互相吃掉。按 remote_event_id 定位的 sync 写已统一加
/// `AND local_draft = 0`（见 [`soft_delete_event`]），草稿不会被增量同步误伤。主记录被远端覆盖后，
/// 两行并存：主=远端、草稿=本地。主记录不存在（异常）返回 `NoMaster`，调用方据此别静默置 conflict。
pub async fn save_local_draft(
    tx: &mut Transaction<'_, Sqlite>,
    local_id: &str,
) -> Result<DraftSnapshot, sqlx::Error> {
    // 先确认主记录存在（草稿的所有字段都从它拷贝）。主记录按主键 `id = local_id` 定位（前端入队记的
    // 本地行 id）——不加 local_draft 过滤：主记录恒以 local_id 为主键、不存在歧义；而冲突草稿是另起新 id
    // 的行（id != local_id），永不与这里的主键匹配。不存在 → NoMaster，调用方留痕、别静默置 conflict。
    let master: Option<(String, String, String)> = sqlx::query_as(
        "SELECT region, calendar_id, remote_event_id FROM calendar_events WHERE id = ?1",
    )
    .bind(local_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((region, calendar_id, remote_event_id)) = master else {
        return Ok(DraftSnapshot::NoMaster);
    };

    // 幂等守卫（评审 MED-4）：找该主记录是否已有「冲突草稿」(local_draft=1 且 id != local_id) 同源行，
    // 有则跳过新建，避免崩溃重放（提交草稿后、置 conflict 前崩）下轮重判冲突时重复堆草稿。
    // 草稿与主记录靠 (region, calendar_id, remote_event_id) 同源；remote_event_id 为占位空串（极少：
    // create 尚未补 id 就冲突）时同源键不可靠，跳过去重直接建（不影响正确性，至多多一条草稿）。
    if !remote_event_id.is_empty() {
        let dup: Option<String> = sqlx::query_scalar(
            "SELECT id FROM calendar_events \
             WHERE region = ?1 AND calendar_id = ?2 AND remote_event_id = ?3 \
               AND local_draft = 1 AND id != ?4",
        )
        .bind(&region)
        .bind(&calendar_id)
        .bind(&remote_event_id)
        .bind(local_id)
        .fetch_optional(&mut **tx)
        .await?;
        if dup.is_some() {
            return Ok(DraftSnapshot::AlreadyExists);
        }
    }

    let now = now_iso();
    let draft_id = gen_id("ce");
    // INSERT ... SELECT 整行拷贝：列出全部列，用子查询取主记录（按主键 id）、覆写 id / local_draft / 时间戳。
    // 用具名列保证顺序稳定（不依赖 SELECT *）。草稿行 local_draft 恒为 1。
    let res = sqlx::query(
        "INSERT INTO calendar_events \
         (id, region, calendar_id, remote_event_id, title, description, location, is_all_day, \
          start_ts, end_ts, timezone, scheduled_date, scheduled_time, status, \
          is_recurring_instance, recurrence_master_id, instance_start_iso, calendar_name, \
          is_writable, local_draft, etag, freshness, created_at, updated_at) \
         SELECT ?1, region, calendar_id, remote_event_id, title, description, location, is_all_day, \
          start_ts, end_ts, timezone, scheduled_date, scheduled_time, status, \
          is_recurring_instance, recurrence_master_id, instance_start_iso, calendar_name, \
          is_writable, 1, etag, freshness, ?2, ?2 \
         FROM calendar_events WHERE id = ?3",
    )
    .bind(&draft_id)
    .bind(&now)
    .bind(local_id)
    .execute(&mut **tx)
    .await?;

    if res.rows_affected() == 0 {
        // 主记录不存在 → 没东西可快照（与上面 NoMaster 同义，双保险）。
        return Ok(DraftSnapshot::NoMaster);
    }
    Ok(DraftSnapshot::Created(draft_id))
}

/// 把主记录行（local_id）覆盖成「远端版本」：写远端事件的关键字段 + 远端 etag，并把 local_draft 归 0。
///
/// **三态冲突「远端为准」的一半**（与 [`save_local_draft`] 配套：先存本地草稿、再用本函数覆盖主记录）。
/// 在传入事务里执行。覆盖的字段取自 normalize 后的远端事件（title / 时间 / status / 重复信息），etag 落
/// 远端 etag 字符串。**不动 remote_event_id**（更新场景下主记录早有正确远端 id，远端版仍是同一个事件）。
///
/// `freshness` 由调用方用 sync 的同源算法 `event_freshness`（crate::feishu::sync，pub(crate)）从远端
/// 事件算好传入（评审 LOW-9）——不再在本函数里只 `etag.parse::<i64>()`，否则非数字 etag 会塌成 0、
/// 与后续增量拉回同一事件的新鲜度口径不一，可能被乱序守卫误判。
///
/// 关键决策：只覆盖「会冲突的内容字段」，不重建整行——description/location 等本同步链路不维护的列保持原值
/// （sync 的 to_input 也把它们留空，口径一致）。这样「远端为准」= 主记录内容对齐远端、版本对齐远端、
/// 不再是草稿（local_draft=0），前端看到的就是远端权威版。
///
/// 返回命中行数（rows_affected）：==0 说明主记录不存在（评审 MED-5），调用方据此感知并留痕。
#[allow(clippy::too_many_arguments)]
pub async fn overwrite_event_with_remote(
    tx: &mut Transaction<'_, Sqlite>,
    local_id: &str,
    title: &str,
    status: &str,
    is_all_day: bool,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
    scheduled_date: Option<&str>,
    scheduled_time: Option<&str>,
    etag: Option<&str>,
    freshness: i64,
) -> Result<u64, sqlx::Error> {
    // 按主键 id 定位主记录（前端入队记的本地行 id）。不加 local_draft 过滤：主记录以 id 为唯一主键、
    // 无歧义；冲突草稿是另起新 id 的行（id != local_id），永不与此主键匹配。覆盖后把主记录 local_draft
    // 归 0（远端权威版不再是草稿）。返回命中行数：==0 = 主记录不存在（评审 MED-5），调用方据此留痕。
    let res = sqlx::query(
        "UPDATE calendar_events SET \
           title = ?1, status = ?2, is_all_day = ?3, start_ts = ?4, end_ts = ?5, \
           scheduled_date = ?6, scheduled_time = ?7, etag = ?8, freshness = ?9, \
           local_draft = 0, updated_at = ?10 \
         WHERE id = ?11",
    )
    .bind(title)
    .bind(status)
    .bind(is_all_day as i64)
    .bind(start_ts)
    .bind(end_ts)
    .bind(scheduled_date)
    .bind(scheduled_time)
    .bind(etag)
    .bind(freshness)
    .bind(now_iso())
    .bind(local_id)
    .execute(&mut **tx)
    .await?;
    Ok(res.rows_affected())
}

/// 按主键 local_id 软删一条本地事件（置 status='cancelled'，不删行）。delete 回写成功后用。
///
/// 与 [`soft_delete_event`]（按 remote_event_id 定位）的区别：回写队列持有的是 local_id（前端入队记的
/// 本地行 id），按主键定位更直接、且 create 后 remote_event_id 才补上、用 local_id 不依赖它已就位。
pub async fn soft_delete_by_local_id(
    tx: &mut Transaction<'_, Sqlite>,
    local_id: &str,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE calendar_events SET status = 'cancelled', updated_at = ?1 WHERE id = ?2",
    )
    .bind(now_iso())
    .bind(local_id)
    .execute(&mut **tx)
    .await?;
    Ok(res.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    // SqliteConnectOptions / SqlitePoolOptions / SqliteJournalMode 由 super 的文件头 use 带入。
    use super::*;

    /// 测试用的最小 DDL：只建本仓储读写到的三张表（含去重/主键约束）。
    /// 真实库的建表在前端 SCHEMA_V1，这里手动建是为了让 Rust 单测自给自足、不依赖前端。
    const TEST_DDL: &str = "
        CREATE TABLE calendar_events (
          id                    TEXT PRIMARY KEY,
          region                TEXT NOT NULL,
          calendar_id           TEXT NOT NULL,
          remote_event_id       TEXT NOT NULL,
          title                 TEXT NOT NULL DEFAULT '',
          description           TEXT,
          location              TEXT,
          is_all_day            INTEGER NOT NULL DEFAULT 0,
          start_ts              INTEGER,
          end_ts                INTEGER,
          timezone              TEXT,
          scheduled_date        TEXT,
          scheduled_time        TEXT,
          status                TEXT NOT NULL DEFAULT 'confirmed',
          is_recurring_instance INTEGER NOT NULL DEFAULT 0,
          recurrence_master_id  TEXT,
          instance_start_iso    TEXT,
          calendar_name         TEXT,
          is_writable           INTEGER NOT NULL DEFAULT 0,
          local_draft           INTEGER NOT NULL DEFAULT 0,
          etag                  TEXT,
          freshness             INTEGER NOT NULL DEFAULT 0,
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL
        );
        CREATE TABLE event_map (
          id              TEXT PRIMARY KEY,
          region          TEXT NOT NULL,
          calendar_id     TEXT NOT NULL,
          remote_event_id TEXT NOT NULL,
          dedup_key       TEXT NOT NULL,
          local_id        TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        CREATE UNIQUE INDEX uq_event_map_dedup ON event_map(region, calendar_id, dedup_key);
        CREATE UNIQUE INDEX uq_event_map_local ON event_map(local_id);
        CREATE TABLE sync_state (
          region          TEXT NOT NULL,
          calendar_id     TEXT NOT NULL,
          sync_token      TEXT,
          last_synced_at  TEXT,
          status          TEXT NOT NULL DEFAULT 'idle',
          last_error      TEXT,
          is_writable     INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          PRIMARY KEY (region, calendar_id)
        );
        CREATE TABLE calendar_change_queue (
          id              TEXT PRIMARY KEY,
          op              TEXT NOT NULL,
          local_id        TEXT NOT NULL,
          calendar_id     TEXT NOT NULL,
          remote_event_id TEXT,
          payload_json    TEXT NOT NULL,
          base_etag       TEXT,
          state           TEXT NOT NULL DEFAULT 'pending',
          retry_count     INTEGER NOT NULL DEFAULT 0,
          last_error      TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
    ";

    /// 开一个内存库（`:memory:`）+ 建测试表。max_connections=1 保证整个池共享同一个内存库
    /// （sqlite 的 :memory: 是每连接一个库，多连接会各看各的）。
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

    /// 造一个最小可用的事件输入（定时事件，confirmed）。
    fn sample_input(dedup_key: &str, remote_id: &str) -> CalendarEventInput {
        CalendarEventInput {
            region: Region::Feishu,
            calendar_id: "cal_1".into(),
            remote_event_id: remote_id.into(),
            dedup_key: dedup_key.into(),
            title: "测试事件".into(),
            description: None,
            location: None,
            is_all_day: false,
            start_ts: Some(1_700_000_000),
            end_ts: Some(1_700_003_600),
            timezone: Some("Asia/Shanghai".into()),
            scheduled_date: Some("2026-05-30".into()),
            scheduled_time: Some("09:00-10:00".into()),
            status: "confirmed".into(),
            is_recurring_instance: false,
            recurrence_master_id: None,
            instance_start_iso: None,
            calendar_name: Some("我的日历".into()),
            is_writable: true,
            etag: Some("etag-1".into()),
            freshness: 0,
        }
    }

    async fn count(pool: &SqlitePool, sql: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(sql).fetch_one(pool).await.unwrap()
    }

    /// 同一 dedup_key upsert 两次：event_map 仍 1 行、calendar_events 仍 1 行（去重生效），
    /// 且两次返回同一个 local_id（id 稳定不漂移）。
    #[tokio::test]
    async fn upsert_dedup_keeps_single_row() {
        let pool = test_pool().await;

        let mut tx = pool.begin().await.unwrap();
        let id1 = upsert_event(&mut tx, &sample_input("dk-1", "ev-1")).await.unwrap();
        tx.commit().await.unwrap();

        // 第二次：同 dedup_key，标题改一下，应更新同一行而非新增。
        let mut input2 = sample_input("dk-1", "ev-1");
        input2.title = "改过的标题".into();
        let mut tx = pool.begin().await.unwrap();
        let id2 = upsert_event(&mut tx, &input2).await.unwrap();
        tx.commit().await.unwrap();

        assert_eq!(id1, id2, "同一去重键两次 upsert 必须复用同一 local_id");
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM event_map").await, 1);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1);

        // 标题确实被更新。
        let title: String =
            sqlx::query_scalar("SELECT title FROM calendar_events WHERE id = ?1")
                .bind(&id1)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "改过的标题");
    }

    /// 不同 dedup_key → 两行（去重键不同就是不同事件）。
    #[tokio::test]
    async fn upsert_distinct_keys_make_two_rows() {
        let pool = test_pool().await;
        let mut tx = pool.begin().await.unwrap();
        upsert_event(&mut tx, &sample_input("dk-1", "ev-1")).await.unwrap();
        upsert_event(&mut tx, &sample_input("dk-2", "ev-2")).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM event_map").await, 2);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 2);
    }

    /// soft_delete 把 status 置 cancelled、行仍在；命中返回 true，未命中返回 false。
    #[tokio::test]
    async fn soft_delete_sets_cancelled() {
        let pool = test_pool().await;
        let mut tx = pool.begin().await.unwrap();
        upsert_event(&mut tx, &sample_input("dk-1", "ev-1")).await.unwrap();
        tx.commit().await.unwrap();

        let mut tx = pool.begin().await.unwrap();
        let hit = soft_delete_event(&mut tx, Region::Feishu, "cal_1", "ev-1").await.unwrap();
        tx.commit().await.unwrap();
        assert!(hit, "已存在的事件应命中");

        let status: String =
            sqlx::query_scalar("SELECT status FROM calendar_events WHERE remote_event_id = 'ev-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "cancelled");
        // 行没被真删。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1);

        // 删一个不存在的 → false。
        let mut tx = pool.begin().await.unwrap();
        let miss = soft_delete_event(&mut tx, Region::Feishu, "cal_1", "nope").await.unwrap();
        tx.commit().await.unwrap();
        assert!(!miss);
    }

    /// 冲突草稿隔离（评审 HIGH-2）：主记录(local_draft=0) 与冲突草稿(local_draft=1) 共享同一
    /// remote_event_id 时，soft_delete_event（按 remote_event_id 定位，带 `AND local_draft = 0`）
    /// 只把主记录置 cancelled，**草稿行原样存活、status 不变**——草稿等用户决断，绝不被增量同步抹掉。
    #[tokio::test]
    async fn soft_delete_does_not_touch_conflict_draft() {
        let pool = test_pool().await;
        let now = now_iso();
        // 主记录：ce_main，local_draft=0，confirmed。
        sqlx::query(
            "INSERT INTO calendar_events (id, region, calendar_id, remote_event_id, title, \
             status, is_writable, local_draft, etag, freshness, created_at, updated_at) \
             VALUES ('ce_main','feishu','cal_1','ev_shared','远端版','confirmed',1,0,'9',9,?1,?1)",
        )
        .bind(&now).execute(&pool).await.unwrap();
        // 冲突草稿：另起 id，local_draft=1，共享同一 remote_event_id，confirmed（用户本地版）。
        sqlx::query(
            "INSERT INTO calendar_events (id, region, calendar_id, remote_event_id, title, \
             status, is_writable, local_draft, etag, freshness, created_at, updated_at) \
             VALUES ('ce_draft','feishu','cal_1','ev_shared','本地版','confirmed',1,1,'5',5,?1,?1)",
        )
        .bind(&now).execute(&pool).await.unwrap();

        // 远端删该事件 → 走增量 soft_delete（按 remote_event_id）。
        let mut tx = pool.begin().await.unwrap();
        let hit = soft_delete_event(&mut tx, Region::Feishu, "cal_1", "ev_shared").await.unwrap();
        tx.commit().await.unwrap();
        assert!(hit, "命中主记录");

        // 主记录被 cancelled。
        let main_status: String =
            sqlx::query_scalar("SELECT status FROM calendar_events WHERE id='ce_main'")
                .fetch_one(&pool).await.unwrap();
        assert_eq!(main_status, "cancelled", "主记录应被软删");

        // 草稿行仍存活、status 未变（未被 cancel）。
        let draft_status: String =
            sqlx::query_scalar("SELECT status FROM calendar_events WHERE id='ce_draft'")
                .fetch_one(&pool).await.unwrap();
        assert_eq!(draft_status, "confirmed", "冲突草稿绝不被增量删除误伤（评审 HIGH-2）");
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE local_draft=1").await,
            1,
            "草稿行仍在"
        );
    }

    /// advance_sync_token 写入游标 + last_synced_at，get_sync_state 能读回。
    #[tokio::test]
    async fn advance_token_then_read_back() {
        let pool = test_pool().await;

        // 初始无行。
        assert!(get_sync_state(&pool, Region::Feishu, "cal_1").await.unwrap().is_none());

        let mut tx = pool.begin().await.unwrap();
        advance_sync_token(&mut tx, Region::Feishu, "cal_1", Some("tok-abc"), "2026-05-30T01:00:00.000Z")
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let st = get_sync_state(&pool, Region::Feishu, "cal_1").await.unwrap().unwrap();
        assert_eq!(st.sync_token.as_deref(), Some("tok-abc"));
        assert_eq!(st.last_synced_at.as_deref(), Some("2026-05-30T01:00:00.000Z"));
        assert_eq!(st.status, "idle");

        // 再推一次，游标被覆盖。
        let mut tx = pool.begin().await.unwrap();
        advance_sync_token(&mut tx, Region::Feishu, "cal_1", Some("tok-def"), "2026-05-30T02:00:00.000Z")
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let st = get_sync_state(&pool, Region::Feishu, "cal_1").await.unwrap().unwrap();
        assert_eq!(st.sync_token.as_deref(), Some("tok-def"));
    }

    /// set_sync_status 把状态/错误写入并能读回。
    #[tokio::test]
    async fn set_status_writes_error() {
        let pool = test_pool().await;
        set_sync_status(&pool, Region::Lark, "cal_x", "error", Some("boom"))
            .await
            .unwrap();
        let st = get_sync_state(&pool, Region::Lark, "cal_x").await.unwrap().unwrap();
        assert_eq!(st.status, "error");
        assert_eq!(st.last_error.as_deref(), Some("boom"));
    }

    /// find_local_id 命中已映射的去重键、未命中返回 None。
    #[tokio::test]
    async fn find_local_id_lookup() {
        let pool = test_pool().await;
        let mut tx = pool.begin().await.unwrap();
        let lid = upsert_event(&mut tx, &sample_input("dk-1", "ev-1")).await.unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            find_local_id(&pool, Region::Feishu, "cal_1", "dk-1").await.unwrap(),
            Some(lid)
        );
        assert_eq!(
            find_local_id(&pool, Region::Feishu, "cal_1", "nope").await.unwrap(),
            None
        );
    }

    /// set_calendar_writable 同时落 sync_state 与该日历下事件行。
    #[tokio::test]
    async fn set_writable_updates_state_and_events() {
        let pool = test_pool().await;

        // 先放一条 is_writable=true 的事件。
        let mut tx = pool.begin().await.unwrap();
        let lid = upsert_event(&mut tx, &sample_input("dk-1", "ev-1")).await.unwrap();
        tx.commit().await.unwrap();

        // 探测为不可写 → 落 false。
        set_calendar_writable(&pool, Region::Feishu, "cal_1", false).await.unwrap();

        let st = get_sync_state(&pool, Region::Feishu, "cal_1").await.unwrap().unwrap();
        assert!(!st.is_writable, "sync_state.is_writable 应被置 false");

        let ev_writable: i64 =
            sqlx::query_scalar("SELECT is_writable FROM calendar_events WHERE id = ?1")
                .bind(&lid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ev_writable, 0, "事件行的 is_writable 应被冗余更新为 0");
    }

    /* ===================== Phase 4 回写队列读写 ===================== */

    /// 直接插一条 calendar_change_queue 行（测试辅助；生产由前端 plugin-sql 写）。
    async fn enqueue(
        pool: &SqlitePool,
        id: &str,
        op: &str,
        local_id: &str,
        remote_event_id: Option<&str>,
        base_etag: Option<&str>,
        state: &str,
    ) {
        let now = now_iso();
        sqlx::query(
            "INSERT INTO calendar_change_queue \
             (id, op, local_id, calendar_id, remote_event_id, payload_json, base_etag, \
              state, retry_count, last_error, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'cal_1', ?4, '{}', ?5, ?6, 0, NULL, ?7, ?7)",
        )
        .bind(id)
        .bind(op)
        .bind(local_id)
        .bind(remote_event_id)
        .bind(base_etag)
        .bind(state)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
    }

    /// list_pending_changes 只拉 pending/failed，不拉 done/conflict/sending；字段映射正确。
    #[tokio::test]
    async fn list_pending_filters_by_state() {
        let pool = test_pool().await;
        enqueue(&pool, "c1", "create", "ce_1", None, None, "pending").await;
        enqueue(&pool, "c2", "update", "ce_2", Some("ev_2"), Some("etag-2"), "failed").await;
        enqueue(&pool, "c3", "delete", "ce_3", Some("ev_3"), None, "done").await;
        enqueue(&pool, "c4", "update", "ce_4", Some("ev_4"), None, "conflict").await;

        let rows = list_pending_changes(&pool).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["c1", "c2"], "只拉 pending/failed");

        // 字段映射对齐。
        let c2 = rows.iter().find(|r| r.id == "c2").unwrap();
        assert_eq!(c2.op, "update");
        assert_eq!(c2.local_id, "ce_2");
        assert_eq!(c2.remote_event_id.as_deref(), Some("ev_2"));
        assert_eq!(c2.base_etag.as_deref(), Some("etag-2"));
    }

    /// list_pending_changes 的重试上限（评审 HIGH-3）：failed 且 retry_count >= MAX_RETRY_COUNT
    /// 不再被捞出（死信）；'dead' 终态也不捞。pending 与未达上限的 failed 正常捞。
    #[tokio::test]
    async fn list_pending_respects_retry_cap_and_dead() {
        let pool = test_pool().await;
        enqueue(&pool, "c_pending", "create", "ce_1", None, None, "pending").await;
        enqueue(&pool, "c_failed_low", "update", "ce_2", Some("ev_2"), None, "failed").await;
        enqueue(&pool, "c_failed_cap", "update", "ce_3", Some("ev_3"), None, "failed").await;
        enqueue(&pool, "c_dead", "create", "ce_4", None, None, "dead").await;

        // 把 c_failed_cap 的 retry_count 顶到上限（达到 MAX → 视为死信，不再捞）。
        sqlx::query("UPDATE calendar_change_queue SET retry_count = ?1 WHERE id = 'c_failed_cap'")
            .bind(MAX_RETRY_COUNT)
            .execute(&pool)
            .await
            .unwrap();
        // c_failed_low 的 retry_count 设成上限-1（仍可重试）。
        sqlx::query("UPDATE calendar_change_queue SET retry_count = ?1 WHERE id = 'c_failed_low'")
            .bind(MAX_RETRY_COUNT - 1)
            .execute(&pool)
            .await
            .unwrap();

        let rows = list_pending_changes(&pool).await.unwrap();
        let mut ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            vec!["c_failed_low", "c_pending"],
            "只拉 pending + 未达上限的 failed；达上限的 failed 与 dead 都不捞"
        );
    }

    /// update_change_state：置 failed 自增 retry_count + 写错误；置 done 不动计数、不抹错误。
    #[tokio::test]
    async fn update_state_manages_retry_and_error() {
        let pool = test_pool().await;
        enqueue(&pool, "c1", "create", "ce_1", None, None, "pending").await;

        // 失败一次：retry_count 0→1，last_error 写入。
        update_change_state(&pool, "c1", "failed", Some("boom")).await.unwrap();
        let (state, retry, err) = read_change(&pool, "c1").await;
        assert_eq!(state, "failed");
        assert_eq!(retry, 1);
        assert_eq!(err.as_deref(), Some("boom"));

        // 再失败：retry_count 1→2。
        update_change_state(&pool, "c1", "failed", Some("boom2")).await.unwrap();
        let (_, retry, _) = read_change(&pool, "c1").await;
        assert_eq!(retry, 2);

        // 置 done（error 传 None）：retry_count 不变、旧错误不被 NULL 抹掉。
        update_change_state(&pool, "c1", "done", None).await.unwrap();
        let (state, retry, err) = read_change(&pool, "c1").await;
        assert_eq!(state, "done");
        assert_eq!(retry, 2, "非 failed 不动 retry_count");
        assert_eq!(err.as_deref(), Some("boom2"), "成功置 done 不抹历史错误");
    }

    async fn read_change(pool: &SqlitePool, id: &str) -> (String, i64, Option<String>) {
        let row = sqlx::query("SELECT state, retry_count, last_error FROM calendar_change_queue WHERE id = ?1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();
        (
            row.get::<String, _>("state"),
            row.get::<i64, _>("retry_count"),
            row.get::<Option<String>, _>("last_error"),
        )
    }

    /// apply_pushed_create：补 remote_event_id + etag + 清 local_draft + 推进 freshness；
    /// **同一事务内**把队列行补 remote_event_id + 置 done（评审 HIGH-1）；返回事件行命中行数。
    #[tokio::test]
    async fn apply_create_writes_back_remote_id_and_etag() {
        let pool = test_pool().await;

        // 先放一条草稿行（local_draft=1，remote_event_id 占位空串，etag NULL）。
        let now = now_iso();
        sqlx::query(
            "INSERT INTO calendar_events (id, region, calendar_id, remote_event_id, title, \
             is_writable, local_draft, etag, freshness, created_at, updated_at) \
             VALUES ('ce_1', 'feishu', 'cal_1', '', '草稿', 1, 1, NULL, 0, ?1, ?1)",
        )
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        // 对应的队列行（pending）：apply_pushed_create 要在同一事务里把它补 remote_id + 置 done。
        enqueue(&pool, "q1", "create", "ce_1", None, None, "pending").await;

        let mut tx = pool.begin().await.unwrap();
        let rows = apply_pushed_create(&mut tx, "q1", "ce_1", "ev_new", Some("42")).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(rows, 1, "命中本地事件行 1 行");

        let row = sqlx::query(
            "SELECT remote_event_id, etag, freshness, local_draft FROM calendar_events WHERE id='ce_1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("remote_event_id"), "ev_new");
        assert_eq!(row.get::<Option<String>, _>("etag").as_deref(), Some("42"));
        assert_eq!(row.get::<i64, _>("freshness"), 42, "etag 数字串 → freshness 同步推进");
        assert_eq!(row.get::<i64, _>("local_draft"), 0, "草稿转正式");

        // 队列行：remote_event_id 被补上、state=done（与事件行回写同一事务原子落地）。
        let (state, _, _) = read_change(&pool, "q1").await;
        assert_eq!(state, "done", "队列行应在同一事务里置 done");
        let q_remote: Option<String> =
            sqlx::query_scalar("SELECT remote_event_id FROM calendar_change_queue WHERE id='q1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(q_remote.as_deref(), Some("ev_new"), "队列行补上 remote_event_id（重放幂等命门）");
    }

    /// apply_pushed_create 本地事件行不存在（被并发删）→ 返回 0 行（评审 LOW-8 由上层据此留痕）。
    #[tokio::test]
    async fn apply_create_returns_zero_when_local_row_gone() {
        let pool = test_pool().await;
        enqueue(&pool, "q1", "create", "ce_gone", None, None, "pending").await;
        let mut tx = pool.begin().await.unwrap();
        let rows = apply_pushed_create(&mut tx, "q1", "ce_gone", "ev_x", Some("1")).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(rows, 0, "本地行不存在 → 命中 0 行");
    }

    /// read_event_etag 读回主键行的 etag；行不存在 → None。
    #[tokio::test]
    async fn read_etag_by_local_id() {
        let pool = test_pool().await;
        let now = now_iso();
        sqlx::query(
            "INSERT INTO calendar_events (id, region, calendar_id, remote_event_id, etag, \
             created_at, updated_at) VALUES ('ce_1','feishu','cal_1','ev_1','etag-9', ?1, ?1)",
        )
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(read_event_etag(&pool, "ce_1").await.unwrap().as_deref(), Some("etag-9"));
        assert_eq!(read_event_etag(&pool, "nope").await.unwrap(), None);
    }
}
