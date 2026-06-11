//! 飞书 / Lark 日历同步核心（Phase 2 的 P2-3）。
//!
//! 这是整个功能里**数据正确性的命门**：错一点就漏事件 / 丢删除 / 乱序回插脏数据。
//! 所以本文件强 TDD——先把不变量钉成测试，再谈实现。两个对外入口：
//!  - [`sync_calendar_list`]：拉「有哪些日历」（增删改）→ 写 `calendar_meta` → 返回活跃日历 id 列表。
//!  - [`sync_one_calendar`]：拉「某日历的日程」（全量 / 增量）→ upsert / 软删事件行。
//!
//! 三条贯穿全文的硬不变量（每条都有对应注释 + 测试）：
//!
//! **① token 推进与写库同一事务。** 先在事务里写完这一批（calendar_meta 或事件 + 软删），
//! 再在**同一个 `tx`** 里推进 sync_token，最后一起 `commit`。中途任何错都让整个 `tx` 回滚、
//! token 不前进——下次带着旧 token 重来。飞书增量天然可重放（同一 token 拉到的还是那批变更），
//! 所以「整轮重来」不会丢也不会重（去重键保证幂等）。
//!
//! **② tombstone 防乱序回插。** 增量响应不保证有序：可能先收到「某事件已 cancelled（新）」，
//! 紧接着又收到同一事件一条「confirmed（旧）」。若无脑覆盖，删掉的事件会被旧状态复活。
//! 对策：写每条事件前先比对库里已有行的「新鲜度」(`updated_at`/`etag`)，**只有来的更新或
//! 同样新才覆盖**；cancelled 一律软删（置 status，不删行），旧的 confirmed 撞上更新的 tombstone
//! 时被跳过。db.rs 的 `upsert_event` 是无条件覆盖，所以这层守卫在 sync.rs 自己做（见
//! [`should_apply`]），不改 db.rs。
//!
//! **③ sync_token 失效 → 回退全量。** 飞书增量游标会过期 / 失效（返回特定错误码）。命中后
//! 清空该日历 sync_token、当作「从没全量过」跑一次全量重建。错误码联调时补（见
//! [`is_sync_token_invalid`] 的 TODO），但「失效→回退全量」的分支结构现在就钉死、可测。
//!
//! **测试如何不联网**：把「发请求」抽成 [`CalendarApi`] trait，`FeishuClient` 实现它（生产路径），
//! 单测注入 mock（可编程返回分页 / 增量 / 注入错误）。所以 sync 的全量 / 增量 / 事务原子性 /
//! 乱序 / 去重全部能在 `:memory:` sqlite 上完整覆盖，不用真实凭证。

use serde_json::Value;
use sqlx::{Row, SqlitePool};

use crate::feishu::client::{FeishuClient, FeishuError};
use crate::feishu::db::{
    advance_sync_token, set_calendar_writable, soft_delete_event, upsert_event, CalendarEventInput,
};
use crate::feishu::normalize::map_event;
use crate::feishu::Region;
use crate::util::now_iso;

/// 拉日历列表 / 日程列表的最小出站能力。
///
/// 抽成 trait 只为一件事：让 [`sync_calendar_list`] / [`sync_one_calendar`] 能在单测里注入
/// mock（不联网跑通全量/增量/事务/乱序/去重）。生产路径由 [`FeishuClient`] 实现，语义与
/// `FeishuClient::get_json` 完全一致（同样的「飞书 code!=0 → Err」「429 已在 client 层退避」）。
///
/// 两个方法各对应一个飞书接口：
///  - [`list_calendars`](CalendarApi::list_calendars)：`GET /calendar/v4/calendars`
///  - [`list_events`](CalendarApi::list_events)：`GET /calendar/v4/calendars/{id}/events`
///
/// `page_token` / `sync_token` 二选一传 `Option`：调用方按「全量翻页 vs 增量」决定带哪个。
/// 返回的是飞书响应壳里的 `data` 子对象（已由实现剥掉外层 `{code,msg,data}`），含
/// `items` / `page_token` / `has_more` / `sync_token`。
///
/// 实现用原生 async fn in trait（Rust 1.75+ 稳定，无需 `async-trait` 依赖，避免动 Cargo.toml）。
///
/// **为什么显式返回 `impl Future + Send` 而不是裸 `async fn`**：裸 `async fn` in trait 不保证
/// 返回的 future 是 `Send`，而 P2-4 的后台调度（engine）会 `tokio::spawn(sync_one_calendar(...))`，
/// spawn 要求 future `Send`。这里把方法手动 desugar 成 `impl Future<...> + Send`，让整条
/// 同步调用链的 future 都带上 `Send`，提前消掉「engine spawn 时才暴露 not-Send」的坑。
/// `impl` 块里仍可写 `async fn`（async 块只要捕获的类型都是 Send 就自动满足 `Future + Send`）。
pub trait CalendarApi {
    /// 拉日历列表的一页。`page_token` 用于全量翻页，`sync_token` 用于增量；两者互斥。
    fn list_calendars(
        &self,
        token: &str,
        page_token: Option<&str>,
        sync_token: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Value, FeishuError>> + Send;

    /// 拉某日历的日程一页。全量时带 `start_time`/`end_time`（可见时间窗，Unix 秒字符串）+
    /// `page_token`；增量时只带 `sync_token`。
    #[allow(clippy::too_many_arguments)]
    fn list_events(
        &self,
        token: &str,
        calendar_id: &str,
        page_token: Option<&str>,
        sync_token: Option<&str>,
        time_min: Option<&str>,
        time_max: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Value, FeishuError>> + Send;
}

/// 列表接口路径（飞书日历 v4）。
const CALENDARS_PATH: &str = "/calendar/v4/calendars";
/// 单页最大条数（飞书上限 500，取 500 少翻几页）。
const PAGE_SIZE: &str = "500";

/// 生产实现：直接转调 [`FeishuClient::get_json`]，把业务语义（哪个 path、带哪些 query）落在这里。
///
/// 关键决策：path/query 的拼装放在「实现 trait」这一层，而不是 sync 主流程——这样 sync 主流程
/// 只关心「翻页 / 增量 / 写库 / 推进 token」的控制流，HTTP 细节全收敛在此处一目了然。
impl CalendarApi for FeishuClient {
    async fn list_calendars(
        &self,
        token: &str,
        page_token: Option<&str>,
        sync_token: Option<&str>,
    ) -> Result<Value, FeishuError> {
        let mut query: Vec<(&str, &str)> = vec![("page_size", PAGE_SIZE)];
        if let Some(pt) = page_token {
            query.push(("page_token", pt));
        }
        if let Some(st) = sync_token {
            query.push(("sync_token", st));
        }
        self.get_json(token, CALENDARS_PATH, &query).await
    }

    async fn list_events(
        &self,
        token: &str,
        calendar_id: &str,
        page_token: Option<&str>,
        sync_token: Option<&str>,
        time_min: Option<&str>,
        time_max: Option<&str>,
    ) -> Result<Value, FeishuError> {
        let path = format!("{CALENDARS_PATH}/{calendar_id}/events");
        let mut query: Vec<(&str, &str)> = vec![("page_size", PAGE_SIZE)];
        if let Some(pt) = page_token {
            query.push(("page_token", pt));
        }
        if let Some(st) = sync_token {
            query.push(("sync_token", st));
        }
        // 全量时给可见时间窗（飞书 events 接口用 start_time/end_time，Unix 秒字符串）。
        if let Some(tmin) = time_min {
            query.push(("start_time", tmin));
        }
        if let Some(tmax) = time_max {
            query.push(("end_time", tmax));
        }
        self.get_json(token, &path, &query).await
    }
}

/// 一次 [`sync_one_calendar`] 的产出统计（供日志 / 上层聚合，不影响落库正确性）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncStats {
    /// 本轮 upsert（新增或更新）的事件条数。
    pub upserted: usize,
    /// 本轮软删（cancelled）命中的事件条数。
    pub deleted: usize,
    /// 本轮因乱序守卫被跳过（来的比库里旧）的事件条数。
    pub skipped_stale: usize,
    /// 本轮是否走的全量（true=全量重建 / 首拉；false=增量）。
    pub full_sync: bool,
}

/// 判断飞书错误是否属于「sync_token 失效」一类（命中则清空 token 回退全量）。
///
/// TODO（联调补全）：飞书增量游标失效的确切错误码以真实接口返回为准。常见相关码（公开文档/
/// 社区经验，**最终以联调实测为准**）：
///   - 1254290 / 1254291：sync_token 过期 / 非法（calendar events 增量游标）
/// 联调时把真实出现的失效码加进这个 `matches!` 即可，「失效→回退全量」的控制流不用改。
fn is_sync_token_invalid(err: &FeishuError) -> bool {
    matches!(err, FeishuError::Api { code, .. } if matches!(code, 1254290 | 1254291))
}

/// 全量同步的可见时间窗（相对 now 的秒数）：往前 90 天、往后 365 天。
///
/// 飞书 events 全量接口需要时间窗（不给会拒），这里取「近 3 个月 + 未来 1 年」覆盖绝大多数
/// 日程视图需求。重复事件让服务端在这个窗内展开成一条条实例（我们不在本地算重复规则）。
const WINDOW_PAST_SECS: i64 = 90 * 24 * 3600;
const WINDOW_FUTURE_SECS: i64 = 365 * 24 * 3600;

/// 取当前 Unix 秒（抽出来便于测试替身覆盖；生产用系统时钟）。
fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 比较「新来的事件」相对「库里已有行」是否应当被应用（写入 / 覆盖）。
///
/// 这是铁律②（tombstone 防乱序回插）的核心判定。规则（与 db.ts 的「软删不删行」语义配套）：
///  - 库里没有这条（`existing` 为 None）→ 必写（首次见到）。
///  - 库里有 → 比较「新鲜度」：来的 `incoming_fresh` **大于等于** 已有 `existing_fresh` 才写。
///    严格旧（`incoming_fresh < existing_fresh`）→ 跳过，保留库里更新的版本（含 tombstone）。
///
/// 「新鲜度」用一个可比较的 i64：优先取事件的远端版本号（etag/sequence 能转 i64 时），否则
/// 取远端 `updated_at`（Unix 秒）。两者都没有时用 0——意味着「无从判定新鲜度」，此时退化为
/// 「>=0 永远成立」即总是写（保守覆盖，宁可被后到的真更新再纠正，也不要漏掉变更）。
///
/// 纯函数，不碰库，便于穷举乱序组合单测。
fn should_apply(existing_fresh: Option<i64>, incoming_fresh: i64) -> bool {
    match existing_fresh {
        None => true,
        Some(cur) => incoming_fresh >= cur,
    }
}

/// 从一条远端事件 JSON 里抽「新鲜度」i64（见 [`should_apply`] 的定义）。
///
/// 取值优先级：`etag`/`sequence`（能解析成 i64）> `updated_time`/`updated_at`（Unix 秒）> 0。
/// 飞书事件的版本字段在不同接口叫法可能不一（联调时确认），这里把已知的几个名字都兜住。
///
/// `pub(crate)`：writeback.rs 的冲突覆盖主记录时也用它算 freshness（评审 LOW-9），与增量同步的乱序
/// 守卫严格同源——避免冲突路径只 parse etag、非数字 etag 塌成 0 而与 sync 拉回的新鲜度口径不一。
pub(crate) fn event_freshness(ev: &Value) -> i64 {
    // 版本号优先：etag 可能是纯数字字符串，sequence 是整数。
    if let Some(n) = ev.get("etag").and_then(parse_i64_loose) {
        return n;
    }
    if let Some(n) = ev.get("sequence").and_then(Value::as_i64) {
        return n;
    }
    // 退而求其次：远端更新时间（秒）。两个常见字段名都试。
    for key in ["updated_time", "updated_at"] {
        if let Some(n) = ev.get(key).and_then(parse_i64_loose) {
            return n;
        }
    }
    0
}

/// 把 Value 宽松解析成 i64：接受整数 Number 或纯数字 String。非数字返回 None。
fn parse_i64_loose(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// 读库里某行（按 region+calendar_id+remote_event_id）当前的「新鲜度」+ 是否存在。
///
/// 读专门的 `freshness` 列（i64）。**关键：它由写入侧用同一个 [`event_freshness`] 算出后落库**
/// （见写入循环把 `incoming_fresh` 写进 input.freshness，及 [`stamp_tombstone_freshness`]）——
/// 存与比严格同源，杜绝早先版本「写入侧存 etag 字符串、比较侧用 event_freshness（可回退到
/// updated_time）」两套口径不一致：那会让 etag 缺失/非数字时库里新鲜度塌成 0、守卫退化成恒覆盖，
/// 后到的更旧 confirmed 复活已删事件。freshness 列 NOT NULL DEFAULT 0，恒能读出 i64。
/// 返回 `Some(fresh)` 表示库里有这行；`None` 表示没有。
///
/// **关键决策（必须在事务连接上读，不能另从 pool 取连接）**：写入阶段我们已持有一个
/// `pool.begin()` 的事务（占着连接）。生产/测试都可能把池开成小连接数（测试甚至
/// `max_connections(1)`）。若这里改用 `&Pool` 再 fetch 一次，就会向池要「第二个连接」——
/// 事务占着唯一连接不放、这边死等第二个，直接 pool timeout 死锁。所以这里收 `&mut Transaction`，
/// 在同一连接上读。语义上也更对：读到的是「本事务起点的一致快照」（本批尚未写入该行之前）。
async fn existing_freshness(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    region: Region,
    calendar_id: &str,
    remote_event_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    // `AND local_draft = 0`（评审 HIGH-2）：乱序守卫只看「主记录」的新鲜度。真冲突时主记录与冲突草稿
    // (local_draft=1) 共享同一 remote_event_id，若不过滤，fetch_optional 可能取到草稿那行，新鲜度基准
    // 错乱（草稿是用户本地版、freshness 停在冲突前）。草稿不参与增量同步的版本比较，只由前端决断。
    let row = sqlx::query(
        "SELECT freshness FROM calendar_events \
         WHERE region = ?1 AND calendar_id = ?2 AND remote_event_id = ?3 AND local_draft = 0",
    )
    .bind(region.tag())
    .bind(calendar_id)
    .bind(remote_event_id)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(row.map(|r| r.get::<i64, _>("freshness")))
}

/// 软删后把「这次取消事件的新鲜度」盖到该行 `freshness` 列上（在传入事务里执行）。
///
/// **为什么必须做（铁律②的关键一环）**：db.rs 的 `soft_delete_event` 只改 `status` 与
/// `updated_at`，**不动 `freshness`**——于是 tombstone 行的 `freshness` 还停留在「被取消前那条
/// confirmed」的旧值。若不修正，[`existing_freshness`] 读到的就是这个偏旧的值，后到的一条「更旧
/// 但仍比旧 confirmed 新」的 confirmed 会被误判为「更新」从而把已删事件复活。
///
/// 所以这里把取消事件自己的新鲜度写进 `freshness`：tombstone 的新鲜度 = 取消时刻的版本，后续
/// 任何 `incoming_fresh < 取消新鲜度` 的事件都会被 [`should_apply`] 正确拦下。
/// 只在传入 `fresh > 0`（确实拿到了取消事件的可比新鲜度）时才覆盖，避免用 0 抹掉原有可比值。
async fn stamp_tombstone_freshness(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    region: Region,
    calendar_id: &str,
    remote_event_id: &str,
    fresh: i64,
) -> Result<(), sqlx::Error> {
    if fresh <= 0 {
        return Ok(());
    }
    // `AND local_draft = 0`（评审 HIGH-2）：tombstone 新鲜度只盖到主记录，不动冲突草稿——与
    // soft_delete_event / existing_freshness 一致，按 remote_event_id 定位的写一律绕开草稿。
    sqlx::query(
        "UPDATE calendar_events SET freshness = ?1 \
         WHERE region = ?2 AND calendar_id = ?3 AND remote_event_id = ?4 AND local_draft = 0",
    )
    .bind(fresh)
    .bind(region.tag())
    .bind(calendar_id)
    .bind(remote_event_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/* ===================== 逐日历可写探测（P4-1） ===================== */

/// 判定某日历是否「可写」（能在本地编辑并回写飞书）。纯函数，便于穷举真值表单测。
///
/// 规则：`is_writable = (cal_type ∈ {primary, shared}) && (access_role ∈ {writer, owner})`。
///  - 类型：只有「主日历 primary」「共享日历 shared」可写；其它类型（如 google / resource /
///    exchange 等外部/资源日历）一律视为只读。
///  - 角色：必须是「owner / writer」；reader（只读订阅者）不可写。
///
/// 缺字段保守判只读：`cal_type` 或 `access_role` 任一为 None（飞书没返回 / 字段名对不上）→ false。
/// 宁可把一个本可写的日历误判只读（用户只是不能编辑、不丢数据），也不要把只读日历误判可写
/// （用户编辑后写回必然被飞书拒、徒增冲突队列噪音）。
///
/// TODO（联调核实字段值）：飞书日历列表 `calendar` 对象的 `type` / `role` 取值以真实接口返回为准。
/// 文档常见 `type ∈ {primary, shared, google, resource, exchange}`、`role ∈ {unknown, free_busy_reader,
/// reader, writer, owner}`；若联调发现更多可写角色/类型，扩这里的 `matches!` 即可，调用方无需改。
fn is_calendar_writable(cal_type: Option<&str>, access_role: Option<&str>) -> bool {
    let type_ok = matches!(cal_type, Some("primary") | Some("shared"));
    let role_ok = matches!(access_role, Some("writer") | Some("owner"));
    type_ok && role_ok
}

/* ===================== calendar_meta 写入 ===================== */

/// upsert 一条 calendar_meta（发现日历 / 更新名字、类型、角色）。在传入事务里执行。
///
/// 复合主键 (region, calendar_id)：有则更新、无则插。is_deleted 置 0（活跃）。
async fn upsert_calendar_meta(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    region: Region,
    calendar_id: &str,
    summary: Option<&str>,
    cal_type: Option<&str>,
    access_role: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO calendar_meta \
         (region, calendar_id, summary, cal_type, access_role, is_deleted, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6) \
         ON CONFLICT(region, calendar_id) DO UPDATE SET \
           summary = excluded.summary, \
           cal_type = excluded.cal_type, \
           access_role = excluded.access_role, \
           is_deleted = 0, \
           updated_at = excluded.updated_at",
    )
    .bind(region.tag())
    .bind(calendar_id)
    .bind(summary)
    .bind(cal_type)
    .bind(access_role)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 把一条 calendar_meta 标记为已删除（远端删了这个日历）。在传入事务里执行。
async fn mark_calendar_deleted(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    region: Region,
    calendar_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE calendar_meta SET is_deleted = 1, updated_at = ?1 \
         WHERE region = ?2 AND calendar_id = ?3",
    )
    .bind(now_iso())
    .bind(region.tag())
    .bind(calendar_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/* ===================== 日历列表同步 ===================== */

/// 列表同步在 sync_state 里的「保留行」日历 id（存列表级 sync_token，不与真实日历冲突）。
const LIST_CURSOR_ID: &str = "__list__";

/// 同步「有哪些日历」。
///
/// 流程（铁律①：calendar_meta 写入 + 列表 sync_token 推进**同一事务**）：
///  1. 读列表级 sync_token（sync_state 的保留行 `__list__`）。
///  2. 空 → 全量：`page_token` 翻页拉全部日历，期间累计 items，**翻页中途失败直接返回 Err、
///     不提交任何东西**（铁律④：page_token 翻页未走完不推进新 sync_token）。非空 → 增量：只带
///     sync_token 拉一页变更（飞书列表增量通常一页给完，这里也支持 has_more 续翻）。
///  3. 开一个事务：把这批日历逐条写 calendar_meta（status_deleted='deleted' 的标删、其余 upsert），
///     再在**同一事务**推进列表 sync_token，一起 commit。
///  4. 返回活跃（未删）日历 id 列表，供上层逐个 [`sync_one_calendar`]。
///
/// 关键决策：日历列表也走「全量→增量」同一套游标机制，和单日历同步对称。首次没游标就翻页全量，
/// 之后靠 sync_token 只拉「日历增删改」，避免每轮把所有日历元信息重拉一遍。
pub async fn sync_calendar_list<C: CalendarApi>(
    client: &C,
    pool: &SqlitePool,
    region: Region,
    token: &str,
) -> Result<Vec<String>, FeishuError> {
    // 1) 读列表级游标。
    let cursor = read_sync_token(pool, region, LIST_CURSOR_ID)
        .await
        .map_err(db_to_feishu)?;

    // 2) 拉取：空游标全量翻页、否则增量。收集 (items, 最终 sync_token)。
    let (items, new_sync_token) = if cursor.is_none() {
        fetch_all_calendars_full(client, token).await?
    } else {
        fetch_calendars_incremental(client, token, cursor.as_deref().unwrap()).await?
    };

    // 3) 一个事务里：写 calendar_meta + 推进列表 sync_token，一起 commit（铁律①）。
    let mut tx = pool.begin().await.map_err(db_to_feishu)?;

    // 收集本轮每个活跃日历的可写探测结果，待 tx commit 后再统一刷（见下方「为什么探测刷写
    // 放在 commit 之后」）。元素是 (calendar_id, is_writable)。
    let mut writable_flags: Vec<(String, bool)> = Vec::new();
    for cal in &items {
        let calendar_id = match cal.get("calendar_id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id,
            _ => continue, // 没 id 的脏数据跳过，不让它毁掉整批。
        };

        // 飞书用 status == "deleted" 标记日历被删（增量里会带）。
        let is_deleted = cal.get("status").and_then(Value::as_str) == Some("deleted");
        if is_deleted {
            mark_calendar_deleted(&mut tx, region, calendar_id)
                .await
                .map_err(db_to_feishu)?;
            continue;
        }

        // 字段名以飞书日历列表响应为准（calendar 对象里的 type/role）。
        // TODO（联调核实）：先按文档常见名 type/role 取；若实际接口字段名不同，改这两行取键即可。
        let summary = cal.get("summary").and_then(Value::as_str);
        let cal_type = cal.get("type").and_then(Value::as_str);
        let access_role = cal.get("role").and_then(Value::as_str);
        upsert_calendar_meta(&mut tx, region, calendar_id, summary, cal_type, access_role)
            .await
            .map_err(db_to_feishu)?;

        // 逐日历可写探测（P4-1）：按 type/role 算 is_writable，留到 commit 后落库。
        writable_flags.push((
            calendar_id.to_string(),
            is_calendar_writable(cal_type, access_role),
        ));
    }

    // 同一事务推进列表 sync_token（None 也写：表示「这轮没拿到新游标」，下次仍走当前模式）。
    advance_sync_token(
        &mut tx,
        region,
        LIST_CURSOR_ID,
        new_sync_token.as_deref(),
        &now_iso(),
    )
    .await
    .map_err(db_to_feishu)?;

    tx.commit().await.map_err(db_to_feishu)?;

    // 逐日历可写探测落库（P4-1）：写 calendar_meta 之外，还要把 is_writable 冗余进
    // sync_state + 该日历下所有 calendar_events 行，前端按 event.is_writable 直接 gate 编辑。
    //
    // 关键决策（为什么放在 commit 之后、而不是上面那个事务里）：`set_calendar_writable` 收的是
    // `&SqlitePool` 且内部自开一个事务（它要把 sync_state 与 events 两处写包成一致语义）。若在上面
    // `tx` 还活着时调它，就会向连接池要「第二个连接」——而池可能只开 1 个连接（测试 max_connections(1)，
    // 生产也偏小），tx 占着唯一连接不放、这边死等第二个 → pool timeout 死锁（与 existing_freshness
    // 注释同一个坑）。所以等 calendar_meta 事务 commit 释放连接后，再逐日历刷可写性。
    //
    // 正确性不受影响：可写性是「探测后单独刷」的冗余信息，与日历增删/列表游标推进解耦——上面的
    // 元信息事务已原子落地；这里即使中途失败也只是某几个日历的 is_writable 暂未更新，下轮列表同步
    // 会重算重刷。失败按整体 Err 上抛（与本函数其它落库失败一致走 db_to_feishu 通道）。
    for (calendar_id, writable) in &writable_flags {
        set_calendar_writable(pool, region, calendar_id, *writable)
            .await
            .map_err(db_to_feishu)?;
    }

    // active = 所有非删除日历（从 calendar_meta 读全量），而非只本轮列表 items 里的那几个。
    // 增量列表只返回「有变化的」日历，没变化就不返回——若用 items 当 active，稳定态那轮会一个日历
    // 都不做事件同步，事件从此不再更新（首次全量后就僵住）。必须每轮对所有已知活跃日历都跑一次
    // 各自的增量事件同步。已标 is_deleted 的日历（如已删但仍被飞书列出的）天然排除、不再无谓重试。
    let active: Vec<String> = sqlx::query_scalar(
        "SELECT calendar_id FROM calendar_meta WHERE region = ?1 AND is_deleted = 0",
    )
    .bind(region.tag())
    .fetch_all(pool)
    .await
    .map_err(db_to_feishu)?;

    Ok(active)
}

/// 全量翻页拉全部日历。任一页失败 → 返回 Err（铁律④：翻页未完不提交新游标）。
async fn fetch_all_calendars_full<C: CalendarApi>(
    client: &C,
    token: &str,
) -> Result<(Vec<Value>, Option<String>), FeishuError> {
    let mut items: Vec<Value> = Vec::new();
    let mut page_token: Option<String> = None;
    // 最终一页飞书会给 sync_token，作为下次增量的起点。
    let mut final_sync_token: Option<String> = None;

    loop {
        let resp = client
            .list_calendars(token, page_token.as_deref(), None)
            .await?;
        let data = envelope_data(&resp);
        collect_calendar_list(data, &mut items);

        // 飞书全量翻页：has_more==true 且给了 page_token 就继续翻。
        let has_more = data.get("has_more").and_then(Value::as_bool).unwrap_or(false);
        let next_page = data
            .get("page_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        // 最后一页带 sync_token：记下来作为增量起点。
        if let Some(st) = data
            .get("sync_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            final_sync_token = Some(st.to_string());
        }

        // 翻页继续的条件：has_more 且拿到了**新的、非空且与当前不同**的 page_token。
        // 飞书在时间窗模式下会返回 has_more=true 但 page_token 为空或不前进（实测重复同一个），
        // 只判 has_more 会无限翻同一页把同步卡死——必须额外要求 page_token 真的变化才续翻。
        if has_more && next_page.is_some() && next_page != page_token {
            page_token = next_page;
            continue;
        }
        break;
    }

    Ok((items, final_sync_token))
}

/// 增量拉日历变更（带 sync_token）。支持 has_more 续翻（飞书极少分页，但稳妥起见兜住）。
async fn fetch_calendars_incremental<C: CalendarApi>(
    client: &C,
    token: &str,
    sync_token: &str,
) -> Result<(Vec<Value>, Option<String>), FeishuError> {
    let mut items: Vec<Value> = Vec::new();
    // 起点是旧 sync_token；若飞书在末页给了新 sync_token 就推进到新的。
    let mut final_sync_token: Option<String> = Some(sync_token.to_string());
    let mut page_token: Option<String> = None;

    loop {
        let resp = client
            .list_calendars(token, page_token.as_deref(), Some(sync_token))
            .await?;
        let data = envelope_data(&resp);
        collect_calendar_list(data, &mut items);

        if let Some(st) = data
            .get("sync_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            final_sync_token = Some(st.to_string());
        }

        let has_more = data.get("has_more").and_then(Value::as_bool).unwrap_or(false);
        let next_page = data
            .get("page_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // 翻页继续的条件：has_more 且拿到了**新的、非空且与当前不同**的 page_token。
        // 飞书在时间窗模式下会返回 has_more=true 但 page_token 为空或不前进（实测重复同一个），
        // 只判 has_more 会无限翻同一页把同步卡死——必须额外要求 page_token 真的变化才续翻。
        if has_more && next_page.is_some() && next_page != page_token {
            page_token = next_page;
            continue;
        }
        break;
    }

    Ok((items, final_sync_token))
}

/* ===================== 单日历日程同步 ===================== */

/// 同步「某日历的日程」。
///
/// 流程：
///  1. 读该日历 sync_token。空 → 全量（带可见时间窗 + page_token 翻页）；非空 → 增量（只带 sync_token）。
///  2. **拉取阶段**先把所有页拉完、累计 items + 末页 sync_token。增量途中若命中「sync_token 失效」
///     错误码（[`is_sync_token_invalid`]）→ 清空该日历 token + 递归走一次全量重建（铁律③）。
///     翻页/拉取任一步失败 → 返回 Err，**不开事务、不推进 token**（铁律④/①）。
///  3. **写入阶段**开一个事务：逐条 `map_event` → 按乱序守卫 [`should_apply`] 决定是否写 →
///     cancelled 走 `soft_delete_event`、confirmed 走 `upsert_event`；最后在**同一事务**
///     `advance_sync_token`，一起 commit（铁律①：事件写入 + token 推进原子）。
///
/// `is_writable` 暂传 false（逐日历可写探测是 Phase 4 的 P4-1，本相位先不阻塞，统一按只读冗余；
/// 真正的可写性由 `set_calendar_writable` 在探测后单独刷，不影响这里的事件正确性）。
pub async fn sync_one_calendar<C: CalendarApi>(
    client: &C,
    pool: &SqlitePool,
    region: Region,
    token: &str,
    calendar_id: &str,
) -> Result<SyncStats, FeishuError> {
    let cursor = read_sync_token(pool, region, calendar_id)
        .await
        .map_err(db_to_feishu)?;

    // 本日历的可写性：列表同步阶段 set_calendar_writable 已按 cal_type/role 写进 sync_state。
    // 这里读出来、在插事件时就带上——否则新插的事件 is_writable 恒为 0、要等下一轮列表同步才补，
    // 前端拖拽回写会因 isWritable=false 误判为只读拖不动（修可写性的时序 bug）。
    let calendar_writable: bool = sqlx::query_scalar::<_, i64>(
        "SELECT is_writable FROM sync_state WHERE region = ?1 AND calendar_id = ?2",
    )
    .bind(region.tag())
    .bind(calendar_id)
    .fetch_optional(pool)
    .await
    .map_err(db_to_feishu)?
    .map(|v| v == 1)
    .unwrap_or(false);

    // —— 拉取阶段（不写库）。增量遇 token 失效 → 回退全量。 ——
    let full_sync = cursor.is_none();
    let (items, new_sync_token, did_full) = if full_sync {
        let (items, st) = fetch_events_full(client, token, calendar_id).await?;
        (items, st, true)
    } else {
        match fetch_events_incremental(client, token, calendar_id, cursor.as_deref().unwrap()).await
        {
            Ok((items, st)) => (items, st, false),
            Err(ref e) if is_sync_token_invalid(e) => {
                // 铁律③：增量游标失效 → 直接跑全量重建。
                // 无需先清空旧 token：全量分支不读旧 token，且本轮末尾的 advance_sync_token 会用新游标
                // 覆盖它——少一次写，也消除「清空后、全量大事务 commit 前崩溃」留下的 token/数据中间态窗口。
                let (items, st) = fetch_events_full(client, token, calendar_id).await?;
                (items, st, true)
            }
            Err(e) => return Err(e),
        }
    };

    // —— 写入阶段（铁律①：事件写入 + token 推进同一事务）。 ——
    let mut tx = pool.begin().await.map_err(db_to_feishu)?;
    let mut stats = SyncStats {
        full_sync: did_full,
        ..Default::default()
    };

    for ev in &items {
        let Some(mapped) = map_event(region, calendar_id, calendar_writable, ev) else {
            continue; // 拿不到 event_id 的脏数据丢弃（map_event 已处理）。
        };

        // 乱序守卫：先比对库里已有行的新鲜度。读走**本事务连接**，所以既能看到此前已 commit 的
        // 跨轮/跨页数据，也能看到本批早先迭代刚写进 tx 的同事件（同批同事件出现两次时，后到的更
        // 旧版本会被这里拦下）。incoming 新鲜度从事件 JSON 抽（etag/sequence/updated_*）。
        let incoming_fresh = event_freshness(ev);
        let existing_fresh =
            existing_freshness(&mut tx, region, calendar_id, &mapped.remote_event_id)
                .await
                .map_err(db_to_feishu)?;
        if !should_apply(existing_fresh, incoming_fresh) {
            stats.skipped_stale += 1;
            continue;
        }

        if mapped.status == "cancelled" {
            // 软删：置 status='cancelled'，不删行（保留 tombstone 防后到的旧 confirmed 复活）。
            // 命中与否都算「处理过」；未命中（本地没这条）说明远端删的我们没拉过，无需建行。
            let hit = soft_delete_event(&mut tx, region, calendar_id, &mapped.remote_event_id)
                .await
                .map_err(db_to_feishu)?;
            if hit {
                // 把取消事件的新鲜度盖到 tombstone（soft_delete 不动 etag，必须在这补，否则后到的
                // 更旧 confirmed 会绕过乱序守卫复活已删事件）。
                stamp_tombstone_freshness(
                    &mut tx,
                    region,
                    calendar_id,
                    &mapped.remote_event_id,
                    incoming_fresh,
                )
                .await
                .map_err(db_to_feishu)?;
                stats.deleted += 1;
            }
        } else {
            // confirmed：组 CalendarEventInput → upsert（event_map 去重 + calendar_events 主键 upsert）。
            // freshness 用本条事件的 incoming_fresh（与乱序守卫 existing_freshness 严格同源），落 freshness 列。
            let mut input = to_input(region, calendar_id, &mapped);
            input.freshness = incoming_fresh;
            upsert_event(&mut tx, &input).await.map_err(db_to_feishu)?;
            stats.upserted += 1;
        }
    }

    // 同一事务推进该日历 sync_token（铁律①）。None 也写（表示这轮没拿到新游标，下次仍按当前模式）。
    advance_sync_token(
        &mut tx,
        region,
        calendar_id,
        new_sync_token.as_deref(),
        &now_iso(),
    )
    .await
    .map_err(db_to_feishu)?;

    tx.commit().await.map_err(db_to_feishu)?;

    Ok(stats)
}

/// 全量拉某日历日程（带可见时间窗 + page_token 翻页）。任一页失败 → Err（不提交）。
async fn fetch_events_full<C: CalendarApi>(
    client: &C,
    token: &str,
    calendar_id: &str,
) -> Result<(Vec<Value>, Option<String>), FeishuError> {
    let now = now_unix();
    let time_min = (now - WINDOW_PAST_SECS).to_string();
    let time_max = (now + WINDOW_FUTURE_SECS).to_string();

    let mut items: Vec<Value> = Vec::new();
    let mut page_token: Option<String> = None;
    let mut final_sync_token: Option<String> = None;

    loop {
        let resp = client
            .list_events(
                token,
                calendar_id,
                page_token.as_deref(),
                None,
                Some(&time_min),
                Some(&time_max),
            )
            .await?;
        let data = envelope_data(&resp);
        collect_items(data, &mut items);

        if let Some(st) = data
            .get("sync_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            final_sync_token = Some(st.to_string());
        }

        let has_more = data.get("has_more").and_then(Value::as_bool).unwrap_or(false);
        let next_page = data
            .get("page_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // 翻页继续的条件：has_more 且拿到了**新的、非空且与当前不同**的 page_token。
        // 飞书在时间窗模式下会返回 has_more=true 但 page_token 为空或不前进（实测重复同一个），
        // 只判 has_more 会无限翻同一页把同步卡死——必须额外要求 page_token 真的变化才续翻。
        if has_more && next_page.is_some() && next_page != page_token {
            page_token = next_page;
            continue;
        }
        break;
    }

    Ok((items, final_sync_token))
}

/// 增量拉某日历日程（只带 sync_token）。支持 has_more 续翻。
async fn fetch_events_incremental<C: CalendarApi>(
    client: &C,
    token: &str,
    calendar_id: &str,
    sync_token: &str,
) -> Result<(Vec<Value>, Option<String>), FeishuError> {
    let mut items: Vec<Value> = Vec::new();
    let mut final_sync_token: Option<String> = Some(sync_token.to_string());
    let mut page_token: Option<String> = None;

    loop {
        let resp = client
            .list_events(
                token,
                calendar_id,
                page_token.as_deref(),
                Some(sync_token),
                None,
                None,
            )
            .await?;
        let data = envelope_data(&resp);
        collect_items(data, &mut items);

        if let Some(st) = data
            .get("sync_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            final_sync_token = Some(st.to_string());
        }

        let has_more = data.get("has_more").and_then(Value::as_bool).unwrap_or(false);
        let next_page = data
            .get("page_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // 翻页继续的条件：has_more 且拿到了**新的、非空且与当前不同**的 page_token。
        // 飞书在时间窗模式下会返回 has_more=true 但 page_token 为空或不前进（实测重复同一个），
        // 只判 has_more 会无限翻同一页把同步卡死——必须额外要求 page_token 真的变化才续翻。
        if has_more && next_page.is_some() && next_page != page_token {
            page_token = next_page;
            continue;
        }
        break;
    }

    Ok((items, final_sync_token))
}

/* ===================== 小工具 ===================== */

/// 飞书标准响应外壳是 `{code, msg, data:{...}}`。真实响应取 `data` 层；测试 mock 直接给
/// `data` 层（无 `data` 键）则原样返回。**统一只在读取侧解包**，不动 client::get_json——因为
/// 写回侧 writeback::extract_event 依赖完整包（读 `body.data.event`），改 get_json 会搞坏它。
fn envelope_data(resp: &Value) -> &Value {
    resp.get("data").unwrap_or(resp)
}

/// 把响应 data 里的 `items` 数组追加进累计器（非数组 / 缺失则不动）。日程列表用这个。
fn collect_items(data: &Value, out: &mut Vec<Value>) {
    if let Some(arr) = data.get("items").and_then(Value::as_array) {
        out.extend(arr.iter().cloned());
    }
}

/// 日历**列表**的数组字段叫 `calendar_list`（日程列表才是 `items`）。优先取 `calendar_list`、
/// 回退 `items`（回退是为兼容只给 `items` 的测试 mock，真实响应里日历列表只有 calendar_list）。
fn collect_calendar_list(data: &Value, out: &mut Vec<Value>) {
    if let Some(arr) = data
        .get("calendar_list")
        .or_else(|| data.get("items"))
        .and_then(Value::as_array)
    {
        out.extend(arr.iter().cloned());
    }
}

/// 把 [`MappedEvent`](crate::feishu::normalize::MappedEvent) 组装成仓储层的 [`CalendarEventInput`]。
///
/// 关键决策：`calendar_name` 这里留 None——日历名在 calendar_meta 里（列表同步写的），事件行的
/// calendar_name 是显示冗余，由前端 join 或后续填充；本相位不在每条事件上重复塞名字（避免列表
/// 同步与事件同步顺序耦合）。`instance_start_iso` 用 original_start_ts（去重键的另一半）转字符串。
fn to_input(
    region: Region,
    calendar_id: &str,
    m: &crate::feishu::normalize::MappedEvent,
) -> CalendarEventInput {
    CalendarEventInput {
        region,
        calendar_id: calendar_id.to_string(),
        remote_event_id: m.remote_event_id.clone(),
        dedup_key: m.dedup_key.clone(),
        title: m.title.clone(),
        description: None,
        location: None,
        is_all_day: m.time.is_all_day,
        start_ts: m.time.start_ts,
        end_ts: m.time.end_ts,
        // 时区冗余：定时事件从 normalize 拿不到原始 tz 字符串（已折算进 scheduled_*），
        // 这里不强塞；前端重新归一时用 scheduled_* 即可，timezone 列留 None 不影响视图。
        timezone: None,
        scheduled_date: m.time.scheduled_date.clone(),
        scheduled_time: m.time.scheduled_time.clone(),
        status: m.status.clone(),
        is_recurring_instance: m.master_event_id.is_some(),
        recurrence_master_id: m.master_event_id.clone(),
        instance_start_iso: m.original_start_ts.map(|ts| ts.to_string()),
        calendar_name: None,
        is_writable: m.is_writable,
        etag: m.etag.clone(),
        // 初值占位，写入循环用 event_freshness(ev) 覆盖成与乱序守卫同源的可比新鲜度。
        freshness: 0,
    }
}

/// 读某 (region, calendar_id) 的 sync_token（只读）。不存在或为 NULL → None。
async fn read_sync_token(
    pool: &SqlitePool,
    region: Region,
    calendar_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT sync_token FROM sync_state WHERE region = ?1 AND calendar_id = ?2",
    )
    .bind(region.tag())
    .bind(calendar_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|r| r.get::<Option<String>, _>("sync_token")))
}

/// 把 sqlx 错误并入 FeishuError（落库失败也走统一错误通道，上层只需处理一种错误类型）。
fn db_to_feishu(e: sqlx::Error) -> FeishuError {
    FeishuError::Http(format!("本地数据库写入失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::Mutex;

    /* ---------- 测试库（:memory: + 手建表，max_connections(1)） ---------- */

    /// 只建 sync 用到的表（calendar_events / event_map / sync_state / calendar_meta）。
    /// 与 db.rs 的 TEST_DDL 同构 + 补 calendar_meta（本文件要写它）。
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

    /* ---------- mock CalendarApi ---------- */

    /// 一次接口调用要返回的东西：要么一页 data（Ok），要么一个错误（Err，用于注入失败）。
    enum Step {
        Page(Value),
        Err(FeishuError),
    }

    /// 可编程 mock：list_events 按预设的 Step 序列逐次返回（每调一次弹一个）。
    /// list_calendars 单独一组序列。用 Mutex 包内部可变状态（trait 方法是 &self）。
    struct MockApi {
        events_steps: Mutex<Vec<Step>>,
        calendars_steps: Mutex<Vec<Step>>,
    }

    impl MockApi {
        fn new() -> Self {
            MockApi {
                events_steps: Mutex::new(Vec::new()),
                calendars_steps: Mutex::new(Vec::new()),
            }
        }
        /// 预设 list_events 的返回序列（按调用顺序消费）。
        fn with_events(self, steps: Vec<Step>) -> Self {
            *self.events_steps.lock().unwrap() = steps;
            self
        }
        /// 预设 list_calendars 的返回序列。
        fn with_calendars(self, steps: Vec<Step>) -> Self {
            *self.calendars_steps.lock().unwrap() = steps;
            self
        }
        fn pop(steps: &Mutex<Vec<Step>>) -> Result<Value, FeishuError> {
            let mut g = steps.lock().unwrap();
            if g.is_empty() {
                // 序列耗尽：返回一个「空且无 more」的终页，避免测试里少配一页就 panic。
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

    /// 造一条 confirmed 定时事件 JSON（带 etag 当新鲜度）。
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

    /// 造一条 cancelled 事件 JSON（带 etag）。
    fn ev_cancelled(id: &str, etag: i64) -> Value {
        json!({
            "event_id": id,
            "status": "cancelled",
            "etag": etag.to_string(),
            "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" }
        })
    }

    /* ================= should_apply 纯函数（铁律②核心判定） ================= */

    #[test]
    fn should_apply_writes_when_absent() {
        assert!(should_apply(None, 0), "库里没有 → 必写");
        assert!(should_apply(None, 999), "库里没有 → 必写");
    }

    #[test]
    fn should_apply_blocks_strictly_older() {
        // 库里是 etag=10，来的 etag=5（更旧）→ 跳过。
        assert!(!should_apply(Some(10), 5), "更旧的不许覆盖更新的（含 tombstone）");
        // 同样新（==）→ 写（幂等覆盖无害）。
        assert!(should_apply(Some(10), 10));
        // 更新（>）→ 写。
        assert!(should_apply(Some(10), 11));
    }

    /* ================= is_calendar_writable 真值表（P4-1） ================= */

    #[test]
    fn is_calendar_writable_truth_table() {
        // 可写：类型 ∈ {primary, shared} 且 角色 ∈ {writer, owner}。
        assert!(is_calendar_writable(Some("primary"), Some("owner")), "主日历 + owner = 可写");
        assert!(is_calendar_writable(Some("primary"), Some("writer")), "主日历 + writer = 可写");
        assert!(is_calendar_writable(Some("shared"), Some("writer")), "共享日历 + writer = 可写");
        assert!(is_calendar_writable(Some("shared"), Some("owner")), "共享日历 + owner = 可写");

        // 角色不够：reader（只读订阅）即便类型对也不可写。
        assert!(!is_calendar_writable(Some("primary"), Some("reader")), "主日历 + reader = 只读");
        assert!(!is_calendar_writable(Some("shared"), Some("reader")), "共享日历 + reader = 只读");

        // 未知/不支持类型：即便角色是 owner 也不可写（外部/资源日历不回写）。
        assert!(!is_calendar_writable(Some("google"), Some("owner")), "未知类型 = 只读");
        assert!(!is_calendar_writable(Some("resource"), Some("writer")), "资源类型 = 只读");

        // 缺字段：任一为 None → 保守判只读。
        assert!(!is_calendar_writable(None, Some("owner")), "缺类型 = 只读");
        assert!(!is_calendar_writable(Some("primary"), None), "缺角色 = 只读");
        assert!(!is_calendar_writable(None, None), "全缺 = 只读");
    }

    /* ================= 全量首拉 ================= */

    /// 全量首拉 N 条 → calendar_events N 行 + event_map N 行 + sync_token 写入。
    #[tokio::test]
    async fn full_sync_writes_n_rows_and_token() {
        let pool = test_pool().await;
        let api = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_confirmed("ev1", 1), ev_confirmed("ev2", 1), ev_confirmed("ev3", 1) ],
            "has_more": false,
            "sync_token": "TOK_FULL_END"
        }))]);

        let stats = sync_one_calendar(&api, &pool, Region::Feishu, "tkn", "cal_1")
            .await
            .unwrap();

        assert!(stats.full_sync, "无游标应走全量");
        assert_eq!(stats.upserted, 3);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 3);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM event_map").await, 3);

        // sync_token 推进到末页给的值。
        let tok = scalar_str(
            &pool,
            "SELECT sync_token FROM sync_state WHERE calendar_id = 'cal_1'",
        )
        .await;
        assert_eq!(tok.as_deref(), Some("TOK_FULL_END"));
    }

    /// 全量翻页：第一页 has_more + page_token，第二页收尾。两页合计落库。
    #[tokio::test]
    async fn full_sync_paginates() {
        let pool = test_pool().await;
        let api = MockApi::new().with_events(vec![
            Step::Page(json!({
                "items": [ ev_confirmed("ev1", 1), ev_confirmed("ev2", 1) ],
                "has_more": true,
                "page_token": "PAGE2"
            })),
            Step::Page(json!({
                "items": [ ev_confirmed("ev3", 1) ],
                "has_more": false,
                "sync_token": "TOK_END"
            })),
        ]);

        let stats = sync_one_calendar(&api, &pool, Region::Feishu, "tkn", "cal_1")
            .await
            .unwrap();
        assert_eq!(stats.upserted, 3);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 3);
        assert_eq!(
            scalar_str(&pool, "SELECT sync_token FROM sync_state WHERE calendar_id='cal_1'").await.as_deref(),
            Some("TOK_END")
        );
    }

    /* ================= 增量：cancelled 软删不消失 ================= */

    /// 先全量拉到 ev1（confirmed），再增量来一条 ev1 cancelled → 该行 status='cancelled'、行还在。
    #[tokio::test]
    async fn incremental_cancelled_soft_deletes() {
        let pool = test_pool().await;

        // 第一轮：全量拿到 ev1 confirmed（etag=1）+ 写 token。
        let api1 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_confirmed("ev1", 1) ],
            "has_more": false,
            "sync_token": "TOK1"
        }))]);
        sync_one_calendar(&api1, &pool, Region::Feishu, "tkn", "cal_1")
            .await
            .unwrap();
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1);

        // 第二轮：增量来 ev1 cancelled（etag=2，更新）→ 软删。
        let api2 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_cancelled("ev1", 2) ],
            "has_more": false,
            "sync_token": "TOK2"
        }))]);
        let stats = sync_one_calendar(&api2, &pool, Region::Feishu, "tkn", "cal_1")
            .await
            .unwrap();
        assert!(!stats.full_sync, "有游标应走增量");
        assert_eq!(stats.deleted, 1);

        // 行还在，status 变 cancelled。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1);
        assert_eq!(
            scalar_str(&pool, "SELECT status FROM calendar_events WHERE remote_event_id='ev1'").await.as_deref(),
            Some("cancelled")
        );
        // token 推进到 TOK2。
        assert_eq!(
            scalar_str(&pool, "SELECT sync_token FROM sync_state WHERE calendar_id='cal_1'").await.as_deref(),
            Some("TOK2")
        );
    }

    /// 评审盲区回归：事件**只带 updated_time、不带 etag/sequence** 时，乱序到来的更旧 confirmed
    /// 不得复活已 cancelled 的行。
    ///
    /// 修复前：upsert 落 etag 字符串列、existing_freshness 读 etag 列，无 etag 时该行新鲜度塌成 0
    /// → should_apply(Some(0), 旧updated_time>0)=true → 复活已删事件（数据损坏）。
    /// 修复后：freshness 走专列、由 event_freshness(updated_time) 同源落库与比较，乱序被正确拦下。
    #[tokio::test]
    async fn out_of_order_no_etag_only_updated_time_does_not_resurrect() {
        let pool = test_pool().await;
        // 无 etag/sequence，仅 updated_time 作新鲜度。
        let ev = |status: &str, ut: i64| {
            json!({
                "event_id": "ev1",
                "summary": "无 etag 的事件",
                "status": status,
                "updated_time": ut.to_string(),
                "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" },
                "end_time":   { "timestamp": "1767229200", "timezone": "Asia/Shanghai" }
            })
        };

        // 轮1 全量：confirmed, updated_time=1000。
        let api1 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev("confirmed", 1000) ], "has_more": false, "sync_token": "T1"
        }))]);
        sync_one_calendar(&api1, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        // 轮2 增量：cancelled, updated_time=3000 → 软删 + tombstone freshness=3000。
        let api2 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev("cancelled", 3000) ], "has_more": false, "sync_token": "T2"
        }))]);
        sync_one_calendar(&api2, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();
        assert_eq!(
            scalar_str(&pool, "SELECT status FROM calendar_events WHERE remote_event_id='ev1'")
                .await.as_deref(),
            Some("cancelled")
        );

        // 轮3 增量：更旧 confirmed, updated_time=2000（< 3000）→ 必须被乱序守卫拦下。
        let api3 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev("confirmed", 2000) ], "has_more": false, "sync_token": "T3"
        }))]);
        let stats = sync_one_calendar(&api3, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        assert_eq!(stats.skipped_stale, 1, "更旧的 confirmed 应被跳过");
        assert_eq!(stats.upserted, 0, "不应写入复活");
        assert_eq!(
            scalar_str(&pool, "SELECT status FROM calendar_events WHERE remote_event_id='ev1'")
                .await.as_deref(),
            Some("cancelled"),
            "已删事件不得被更旧的 confirmed 复活"
        );
    }

    /* ================= 事务原子性：中途注入 Err → token 未推进、事件未写 ================= */

    /// 全量拉取阶段第二页注入 Err：整轮失败，sync_token 仍为空（未推进）、calendar_events 0 行。
    /// 验证铁律①/④：拉取未完不开写事务、不提交 token。
    #[tokio::test]
    async fn error_mid_fetch_rolls_back_everything() {
        let pool = test_pool().await;
        let api = MockApi::new().with_events(vec![
            Step::Page(json!({
                "items": [ ev_confirmed("ev1", 1), ev_confirmed("ev2", 1) ],
                "has_more": true,
                "page_token": "PAGE2"
            })),
            // 第二页爆错。
            Step::Err(FeishuError::Http("注入的网络错误".into())),
        ]);

        let res = sync_one_calendar(&api, &pool, Region::Feishu, "tkn", "cal_1").await;
        assert!(res.is_err(), "翻页中途失败应整轮返回 Err");

        // 没有任何事件落库（拉取未完根本没进写事务）。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 0);
        // sync_state 要么没行、要么 token 仍为空——总之没推进出非空 token。
        let tok = sqlx::query_scalar::<_, Option<String>>(
            "SELECT sync_token FROM sync_state WHERE calendar_id='cal_1'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        // fetch_optional：没行→None；有行→Some(inner)，inner 应为 None（token 没推进）。
        assert!(
            matches!(tok, None | Some(None)),
            "拉取失败后 sync_token 绝不应被推进，实际={tok:?}"
        );
    }

    /// 增量第一轮成功写了 TOK1；第二轮增量首页就爆错 → 旧 token 不被改写（仍是 TOK1）、不丢已有行。
    /// 直击「整个 tx 回滚、token 不前进、下次带旧 token 重来」。
    #[tokio::test]
    async fn error_in_incremental_keeps_old_token() {
        let pool = test_pool().await;
        // 先全量铺一条 + TOK1。
        let api1 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_confirmed("ev1", 1) ], "has_more": false, "sync_token": "TOK1"
        }))]);
        sync_one_calendar(&api1, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        // 增量首页爆错。
        let api2 = MockApi::new()
            .with_events(vec![Step::Err(FeishuError::Api { code: 99999, msg: "boom".into() })]);
        let res = sync_one_calendar(&api2, &pool, Region::Feishu, "tkn", "cal_1").await;
        assert!(res.is_err());

        // token 仍是 TOK1（没被改写），ev1 还在。
        assert_eq!(
            scalar_str(&pool, "SELECT sync_token FROM sync_state WHERE calendar_id='cal_1'").await.as_deref(),
            Some("TOK1")
        );
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1);
    }

    /* ================= 乱序：先 cancelled(新)，再来 confirmed(旧) → 仍 cancelled ================= */

    /// 模拟跨轮乱序：
    ///  轮1 全量：ev1 confirmed etag=1（建行）。
    ///  轮2 增量：ev1 cancelled etag=5（软删，新鲜度 5）。
    ///  轮3 增量：ev1 confirmed etag=2（更旧，新鲜度 2）→ 守卫拦下，仍 cancelled。
    #[tokio::test]
    async fn out_of_order_old_confirmed_does_not_resurrect() {
        let pool = test_pool().await;

        let a1 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_confirmed("ev1", 1) ], "has_more": false, "sync_token": "T1"
        }))]);
        sync_one_calendar(&a1, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        let a2 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_cancelled("ev1", 5) ], "has_more": false, "sync_token": "T2"
        }))]);
        sync_one_calendar(&a2, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();
        assert_eq!(
            scalar_str(&pool, "SELECT status FROM calendar_events WHERE remote_event_id='ev1'").await.as_deref(),
            Some("cancelled"),
            "轮2 后应已 cancelled"
        );

        // 轮3：更旧的 confirmed 到来。
        let a3 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_confirmed("ev1", 2) ], "has_more": false, "sync_token": "T3"
        }))]);
        let stats = sync_one_calendar(&a3, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        assert_eq!(stats.skipped_stale, 1, "更旧的 confirmed 应被乱序守卫跳过");
        assert_eq!(stats.upserted, 0);
        // 仍 cancelled，没被复活。
        assert_eq!(
            scalar_str(&pool, "SELECT status FROM calendar_events WHERE remote_event_id='ev1'").await.as_deref(),
            Some("cancelled"),
            "更旧的 confirmed 绝不能把已删事件复活"
        );
        // token 仍推进（这轮本身成功）。
        assert_eq!(
            scalar_str(&pool, "SELECT sync_token FROM sync_state WHERE calendar_id='cal_1'").await.as_deref(),
            Some("T3")
        );
    }

    /* ================= 冲突草稿隔离：增量删除不碰 local_draft=1 草稿（评审 HIGH-2） ================= */

    /// 端到端回归：制造真冲突产出的「主记录(local_draft=0) + 草稿(local_draft=1)」共享同一
    /// remote_event_id 的形态，然后远端删该事件走**增量同步** soft_delete → 主记录 status=cancelled、
    /// 但草稿行仍在且未被 cancel。直击 existing_freshness/soft_delete_event 的 `AND local_draft = 0` 守卫。
    #[tokio::test]
    async fn incremental_delete_does_not_cancel_conflict_draft() {
        let pool = test_pool().await;

        // 轮1 全量：建主记录 ev1（confirmed, etag=1）+ 写 token，让后续走增量。
        let a1 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_confirmed("ev1", 1) ], "has_more": false, "sync_token": "T1"
        }))]);
        sync_one_calendar(&a1, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        // 手工模拟「冲突已发生」：在 calendar_events 里另插一条草稿(local_draft=1)，共享 ev1 的 remote_event_id。
        // （冲突的产生由 writeback 负责并已单测；这里只验证 sync 的增量删除不误伤已存在的草稿。）
        let now = now_iso();
        sqlx::query(
            "INSERT INTO calendar_events (id, region, calendar_id, remote_event_id, title, \
             status, is_writable, local_draft, etag, freshness, created_at, updated_at) \
             VALUES ('ce_draft','feishu','cal_1','ev1','本地草稿版','confirmed',1,1,'1',1,?1,?1)",
        )
        .bind(&now).execute(&pool).await.unwrap();
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE local_draft=1").await, 1);

        // 轮2 增量：远端删 ev1（cancelled, etag=2）→ 走 soft_delete_event。
        let a2 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_cancelled("ev1", 2) ], "has_more": false, "sync_token": "T2"
        }))]);
        let stats = sync_one_calendar(&a2, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();
        assert_eq!(stats.deleted, 1, "命中主记录软删");

        // 主记录（local_draft=0）被 cancelled。
        assert_eq!(
            scalar_str(&pool, "SELECT status FROM calendar_events WHERE remote_event_id='ev1' AND local_draft=0").await.as_deref(),
            Some("cancelled"),
            "主记录应被软删"
        );
        // 草稿（local_draft=1）仍存活、未被 cancel。
        assert_eq!(
            scalar_str(&pool, "SELECT status FROM calendar_events WHERE id='ce_draft'").await.as_deref(),
            Some("confirmed"),
            "冲突草稿绝不被增量删除误伤"
        );
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE local_draft=1").await, 1, "草稿行仍在");
    }

    /* ================= 去重：同 dedup_key 两次 → event_map 仍一行 ================= */

    /// 同一非重复事件（同 event_id → 同 dedup_key）两轮各来一次 → event_map / calendar_events 各 1 行。
    #[tokio::test]
    async fn dedup_same_key_keeps_single_row() {
        let pool = test_pool().await;

        let a1 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_confirmed("ev_dup", 1) ], "has_more": false, "sync_token": "T1"
        }))]);
        sync_one_calendar(&a1, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        // 第二轮同一事件（etag 抬高保证能覆盖），仍同 dedup_key。
        let a2 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ ev_confirmed("ev_dup", 2) ], "has_more": false, "sync_token": "T2"
        }))]);
        sync_one_calendar(&a2, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        assert_eq!(count(&pool, "SELECT COUNT(*) FROM event_map").await, 1, "同 dedup_key 去重，event_map 仍一行");
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1);
    }

    /// 重复事件实例：同 master + 同 original_start → 同 dedup_key，两次仍一行。
    #[tokio::test]
    async fn dedup_recurring_instance_single_row() {
        let pool = test_pool().await;
        let inst = |etag: i64| {
            json!({
                "event_id": "inst_x",
                "recurring_event_id": "master_a",
                "original_time": 1767225600_i64,
                "status": "confirmed",
                "etag": etag.to_string(),
                "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" },
                "end_time":   { "timestamp": "1767229200", "timezone": "Asia/Shanghai" }
            })
        };
        let a1 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ inst(1) ], "has_more": false, "sync_token": "T1"
        }))]);
        sync_one_calendar(&a1, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();
        let a2 = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ inst(2) ], "has_more": false, "sync_token": "T2"
        }))]);
        sync_one_calendar(&a2, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        assert_eq!(count(&pool, "SELECT COUNT(*) FROM event_map").await, 1);
        // dedup_key 应是 master:original_start。
        assert_eq!(
            scalar_str(&pool, "SELECT dedup_key FROM event_map").await.as_deref(),
            Some("master_a:1767225600")
        );
    }

    /* ================= sync_token 失效 → 回退全量重建 ================= */

    /// 增量返回「sync_token 失效」错误码 → 清空 token + 全量重拉，最终拿到全量数据 + 新 token。
    #[tokio::test]
    async fn invalid_sync_token_falls_back_to_full() {
        let pool = test_pool().await;
        // 先铺一个旧 token（让它走增量分支）。
        {
            let mut tx = pool.begin().await.unwrap();
            advance_sync_token(&mut tx, Region::Feishu, "cal_1", Some("OLD_TOK"), &now_iso())
                .await
                .unwrap();
            tx.commit().await.unwrap();
        }

        // mock：第一次调用（增量）返回失效码；第二次调用（全量）返回数据。
        let api = MockApi::new().with_events(vec![
            Step::Err(FeishuError::Api { code: 1254290, msg: "sync_token expired".into() }),
            Step::Page(json!({
                "items": [ ev_confirmed("ev1", 1), ev_confirmed("ev2", 1) ],
                "has_more": false,
                "sync_token": "FRESH_TOK"
            })),
        ]);

        let stats = sync_one_calendar(&api, &pool, Region::Feishu, "tkn", "cal_1")
            .await
            .unwrap();

        assert!(stats.full_sync, "失效后应回退全量");
        assert_eq!(stats.upserted, 2);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 2);
        // token 被刷新成全量末页的新值。
        assert_eq!(
            scalar_str(&pool, "SELECT sync_token FROM sync_state WHERE calendar_id='cal_1'").await.as_deref(),
            Some("FRESH_TOK")
        );
    }

    /// 非「失效」类的业务错误（普通 Api code）→ 不回退全量，直接 Err 上抛。
    #[tokio::test]
    async fn non_invalid_api_error_does_not_fallback() {
        let pool = test_pool().await;
        {
            let mut tx = pool.begin().await.unwrap();
            advance_sync_token(&mut tx, Region::Feishu, "cal_1", Some("OLD"), &now_iso())
                .await
                .unwrap();
            tx.commit().await.unwrap();
        }
        let api = MockApi::new().with_events(vec![Step::Err(FeishuError::Api {
            code: 1254005,
            msg: "calendar not found".into(),
        })]);
        let res = sync_one_calendar(&api, &pool, Region::Feishu, "tkn", "cal_1").await;
        assert!(matches!(res, Err(FeishuError::Api { code: 1254005, .. })));
        // 没退回全量、没写事件、旧 token 不变。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 0);
        assert_eq!(
            scalar_str(&pool, "SELECT sync_token FROM sync_state WHERE calendar_id='cal_1'").await.as_deref(),
            Some("OLD")
        );
    }

    /* ================= 日历列表同步 ================= */

    /// 全量列表：两个日历 → calendar_meta 两行 + 返回两个 active id + 列表 token 写入 __list__。
    #[tokio::test]
    async fn calendar_list_full_writes_meta_and_returns_active() {
        let pool = test_pool().await;
        let api = MockApi::new().with_calendars(vec![Step::Page(json!({
            "items": [
                { "calendar_id": "cal_a", "summary": "工作", "type": "primary", "role": "owner" },
                { "calendar_id": "cal_b", "summary": "共享", "type": "shared", "role": "reader" }
            ],
            "has_more": false,
            "sync_token": "LIST_TOK"
        }))]);

        let active = sync_calendar_list(&api, &pool, Region::Feishu, "tkn")
            .await
            .unwrap();

        assert_eq!(active, vec!["cal_a".to_string(), "cal_b".to_string()]);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_meta WHERE is_deleted=0").await, 2);
        // 列表游标写到保留行。
        assert_eq!(
            scalar_str(&pool, "SELECT sync_token FROM sync_state WHERE calendar_id='__list__'").await.as_deref(),
            Some("LIST_TOK")
        );
        // 元信息字段落库正确。
        assert_eq!(
            scalar_str(&pool, "SELECT cal_type FROM calendar_meta WHERE calendar_id='cal_a'").await.as_deref(),
            Some("primary")
        );
    }

    /// P4-1：列表全量含「一个可写（primary+owner）+ 一个只读（shared+reader）」日历，
    /// 同步后两者 calendar_meta 的 type/role 正确，且 sync_state.is_writable 分别为 1 / 0；
    /// 可写日历下已有的事件行 is_writable 被冗余刷成 1（前端按 event.is_writable gate 编辑）。
    #[tokio::test]
    async fn calendar_list_detects_writable_per_calendar() {
        let pool = test_pool().await;

        // 先在可写日历 cal_w 下铺一条 is_writable=false 的事件（默认 0），用于验证探测后被刷成 1。
        {
            let mut tx = pool.begin().await.unwrap();
            let mut input = to_input(
                Region::Feishu,
                "cal_w",
                &map_event(Region::Feishu, "cal_w", false, &ev_confirmed("seed_ev", 1)).unwrap(),
            );
            input.freshness = 1;
            upsert_event(&mut tx, &input).await.unwrap();
            tx.commit().await.unwrap();
        }
        // 入库初值确认为只读（0）。
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE calendar_id='cal_w' AND is_writable=0").await,
            1,
            "事件初值应为只读 0"
        );

        let api = MockApi::new().with_calendars(vec![Step::Page(json!({
            "items": [
                // 可写：主日历 + owner。
                { "calendar_id": "cal_w", "summary": "我的", "type": "primary", "role": "owner" },
                // 只读：共享日历 + reader。
                { "calendar_id": "cal_r", "summary": "订阅", "type": "shared", "role": "reader" }
            ],
            "has_more": false,
            "sync_token": "LIST_TOK"
        }))]);

        let active = sync_calendar_list(&api, &pool, Region::Feishu, "tkn")
            .await
            .unwrap();
        // active 现在从 calendar_meta 读全量(非删除),顺序按 PK(calendar_id)、与插入序无关 → 排序后比。
        let mut active_sorted = active.clone();
        active_sorted.sort();
        assert_eq!(
            active_sorted,
            vec!["cal_r".to_string(), "cal_w".to_string()],
            "active 应含两个活跃日历(顺序无关)"
        );

        // calendar_meta 的 type/role 落库正确。
        assert_eq!(
            scalar_str(&pool, "SELECT access_role FROM calendar_meta WHERE calendar_id='cal_w'").await.as_deref(),
            Some("owner")
        );
        assert_eq!(
            scalar_str(&pool, "SELECT access_role FROM calendar_meta WHERE calendar_id='cal_r'").await.as_deref(),
            Some("reader")
        );

        // sync_state.is_writable：可写日历=1、只读日历=0（直接读列，避免引入 get_sync_state 依赖）。
        assert_eq!(
            count(&pool, "SELECT is_writable FROM sync_state WHERE calendar_id='cal_w'").await,
            1,
            "primary+owner → sync_state.is_writable 应为 1"
        );
        assert_eq!(
            count(&pool, "SELECT is_writable FROM sync_state WHERE calendar_id='cal_r'").await,
            0,
            "shared+reader → sync_state.is_writable 应为 0"
        );

        // 可写日历下的事件行 is_writable 被冗余刷成 1。
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE calendar_id='cal_w' AND is_writable=1").await,
            1,
            "可写探测应把该日历下事件行刷成可写 1"
        );
    }

    /// 列表增量：已有 __list__ 游标 → 走增量；status='deleted' 的日历标删、不进 active。
    #[tokio::test]
    async fn calendar_list_incremental_marks_deleted() {
        let pool = test_pool().await;
        // 第一轮全量铺 cal_a / cal_b。
        let a1 = MockApi::new().with_calendars(vec![Step::Page(json!({
            "items": [
                { "calendar_id": "cal_a", "summary": "A", "type": "primary", "role": "owner" },
                { "calendar_id": "cal_b", "summary": "B", "type": "shared", "role": "writer" }
            ],
            "has_more": false, "sync_token": "L1"
        }))]);
        sync_calendar_list(&a1, &pool, Region::Feishu, "tkn").await.unwrap();

        // 第二轮增量：cal_b 被删。
        let a2 = MockApi::new().with_calendars(vec![Step::Page(json!({
            "items": [ { "calendar_id": "cal_b", "status": "deleted" } ],
            "has_more": false, "sync_token": "L2"
        }))]);
        let active = sync_calendar_list(&a2, &pool, Region::Feishu, "tkn").await.unwrap();

        // 增量这轮只返回本轮活跃的（cal_b 被删，不在内；cal_a 这轮没出现也不在本轮返回值里）。
        assert!(!active.contains(&"cal_b".to_string()), "被删日历不应在 active 里");
        // calendar_meta：cal_b 标删。
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM calendar_meta WHERE calendar_id='cal_b' AND is_deleted=1").await,
            1
        );
        // cal_a 仍活跃（库里没被动过）。
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM calendar_meta WHERE calendar_id='cal_a' AND is_deleted=0").await,
            1
        );
        // 列表游标推进到 L2。
        assert_eq!(
            scalar_str(&pool, "SELECT sync_token FROM sync_state WHERE calendar_id='__list__'").await.as_deref(),
            Some("L2")
        );
    }

    /// 列表全量翻页中途失败 → 整轮 Err，calendar_meta 不写、__list__ 游标不推进（铁律④）。
    #[tokio::test]
    async fn calendar_list_pagination_failure_commits_nothing() {
        let pool = test_pool().await;
        let api = MockApi::new().with_calendars(vec![
            Step::Page(json!({
                "items": [ { "calendar_id": "cal_a", "summary": "A", "type": "primary", "role": "owner" } ],
                "has_more": true, "page_token": "P2"
            })),
            Step::Err(FeishuError::Http("列表第二页失败".into())),
        ]);

        let res = sync_calendar_list(&api, &pool, Region::Feishu, "tkn").await;
        assert!(res.is_err());
        // 一行 meta 都不该写（拉取未完没进事务）。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_meta").await, 0);
        // __list__ 游标没被建出来 / 没推进。
        let tok = sqlx::query_scalar::<_, Option<String>>(
            "SELECT sync_token FROM sync_state WHERE calendar_id='__list__'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(matches!(tok, None | Some(None)));
    }

    /* ================= 全天事件路径 ================= */

    /// 全天事件全量同步：scheduled_time 为 NULL、is_all_day=1、scheduled_date 原样（零偏移）。
    #[tokio::test]
    async fn all_day_event_round_trip() {
        let pool = test_pool().await;
        let api = MockApi::new().with_events(vec![Step::Page(json!({
            "items": [ {
                "event_id": "ev_allday",
                "summary": "假期",
                "status": "confirmed",
                "etag": "1",
                "start_time": { "date": "2026-10-01" },
                "end_time":   { "date": "2026-10-01" }
            } ],
            "has_more": false, "sync_token": "T1"
        }))]);
        sync_one_calendar(&api, &pool, Region::Feishu, "tkn", "cal_1").await.unwrap();

        let date = scalar_str(&pool, "SELECT scheduled_date FROM calendar_events WHERE remote_event_id='ev_allday'").await;
        assert_eq!(date.as_deref(), Some("2026-10-01"), "全天日期零偏移");
        let time = scalar_str(&pool, "SELECT scheduled_time FROM calendar_events WHERE remote_event_id='ev_allday'").await;
        assert_eq!(time, None, "全天 scheduled_time 必须 NULL");
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE remote_event_id='ev_allday' AND is_all_day=1").await,
            1
        );
    }
}
