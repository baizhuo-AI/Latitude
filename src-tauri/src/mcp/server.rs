//! MCP server 启动逻辑 + 鉴权 + 工具定义。
//!
//! 工具集中在一个 `#[tool_router]` impl 块里注册（rmcp 机制这样最稳）。
//! 覆盖 4 个数据域：todos / goals / activity_log / memory_facts（记忆事实）。
//!
//! 鉴权：所有请求需带 `Authorization: Bearer <token>`，否则 401。
//! 刷新：写操作后调用 notify 回调（Tauri 端转成事件通知前端刷新；命令行测试传空回调）。

use crate::mcp::db;
use crate::util::{gen_id, now_iso};
use chrono::Local;
use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, Content, Implementation, ProtocolVersion, ServerCapabilities, ServerInfo,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpService,
};
use rmcp::{tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};
use schemars::JsonSchema;
use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use std::path::PathBuf;
use std::sync::Arc;

/// 写操作后的刷新通知回调。参数是变更的数据域（todos/goals/activities）。
/// 用回调而非直接依赖 tauri::AppHandle，是为了让命令行 smoke 测试也能复用 start()。
pub type Notifier = Arc<dyn Fn(&str) + Send + Sync>;

/* ===================== 通用 helper ===================== */
// now_iso / gen_id 已提到 crate::util 共享（feishu 仓储层也用），见文件头 use。

fn ok_json(v: serde_json::Value) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![Content::text(
        serde_json::to_string_pretty(&v).unwrap_or_default(),
    )]))
}

fn db_err(e: sqlx::Error) -> McpError {
    McpError::internal_error(format!("数据库操作失败: {e}"), None)
}

fn todo_to_json(r: &sqlx::sqlite::SqliteRow) -> serde_json::Value {
    serde_json::json!({
        "id": r.get::<String, _>("id"),
        "title": r.get::<String, _>("title"),
        "status": r.get::<String, _>("status"),
        "priority": r.get::<String, _>("priority"),
        "scheduled_date": r.get::<Option<String>, _>("scheduled_date"),
        "scheduled_time": r.get::<Option<String>, _>("scheduled_time"),
        "deadline": r.get::<Option<String>, _>("deadline"),
        "reason": r.get::<Option<String>, _>("reason"),
    })
}

const TODO_COLS: &str =
    "id, title, status, priority, scheduled_date, scheduled_time, deadline, reason";

/* ---------- 记忆事实枚举/常量（与 TS db.ts MEMORY_CATEGORIES / chatTools 逐字对齐，Task 4.2） ---------- */

/// 合法分类。单一真相源在 TS（src/lib/db.ts 的 MEMORY_CATEGORIES）；此处镜像，改一处改两处。
const MEMORY_CATEGORIES: [&str; 5] = ["identity", "ongoing", "habit", "people", "preference"];

/// transient 事实未给有效期时兜的默认 TTL（毫秒）。与 TS chatTools 的 TRANSIENT_DEFAULT_TTL_MS 一致：30 天。
const TRANSIENT_DEFAULT_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

fn is_valid_category(c: &str) -> bool {
    MEMORY_CATEGORIES.contains(&c)
}

/// 把毫秒偏移加到当前时刻，输出与 TS `new Date(...).toISOString()` 同款 ISO 串（UTC，带毫秒 + Z）。
fn iso_after_ms(offset_ms: i64) -> String {
    use chrono::Utc;
    (Utc::now() + chrono::Duration::milliseconds(offset_ms))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/* ===================== server 实例 ===================== */

#[derive(Clone)]
pub struct DaybreakMcp {
    pool: SqlitePool,
    notify: Notifier,
    tool_router: ToolRouter<DaybreakMcp>,
}

/* ---------- 请求参数结构 ---------- */

#[derive(Debug, Deserialize, JsonSchema)]
struct ListTodosRequest {
    #[schemars(description = "按状态过滤：todo / doing / done / dropped；留空返回全部")]
    status: Option<String>,
    #[schemars(description = "最多返回多少条，默认 50，上限 500")]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateTodoRequest {
    #[schemars(description = "任务标题（必填）")]
    title: String,
    #[schemars(description = "优先级：high / medium / low / none，默认 none")]
    priority: Option<String>,
    #[schemars(description = "截止日期，YYYY-MM-DD")]
    deadline: Option<String>,
    #[schemars(description = "排期到哪天，YYYY-MM-DD")]
    scheduled_date: Option<String>,
    #[schemars(description = "排期时段，如 09:30-11:00")]
    scheduled_time: Option<String>,
    #[schemars(description = "预估耗时，如 1.5h")]
    est_time: Option<String>,
    #[schemars(description = "为什么做这件事（可选备注）")]
    reason: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SetTodoStatusRequest {
    #[schemars(description = "任务 id")]
    id: String,
    #[schemars(description = "新状态：todo / doing / done / dropped")]
    status: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ScheduleTodoRequest {
    #[schemars(description = "任务 id")]
    id: String,
    #[schemars(description = "排期到哪天，YYYY-MM-DD；留空表示清除")]
    scheduled_date: Option<String>,
    #[schemars(description = "排期时段，如 09:30-11:00；留空表示清除")]
    scheduled_time: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct TodayOverviewRequest {
    #[schemars(description = "查询哪一天，YYYY-MM-DD；留空默认今天（本机时区）")]
    date: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ListGoalsRequest {
    #[schemars(description = "周期过滤：year / quarter / month；留空返回全部")]
    period: Option<String>,
    #[schemars(description = "状态过滤：active / achieved / abandoned；留空返回全部")]
    status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateGoalRequest {
    #[schemars(description = "目标标题（必填）")]
    title: String,
    #[schemars(description = "周期：year / quarter / month（必填）")]
    period: String,
    #[schemars(description = "目标描述")]
    description: Option<String>,
    #[schemars(description = "目标日期，YYYY-MM-DD")]
    target_date: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SetGoalStatusRequest {
    #[schemars(description = "目标 id")]
    id: String,
    #[schemars(description = "新状态：active / achieved / abandoned")]
    status: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ListActivitiesRequest {
    #[schemars(description = "最多返回多少条，默认 100")]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct LogActivityRequest {
    #[schemars(description = "正在做什么（一句话时间日志）")]
    content: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct IdRequest {
    #[schemars(description = "目标对象的 id")]
    id: String,
}

/* ---------- 记忆事实参数结构（镜像 TS chatTools remember/update_memory/forget，Task 4.2） ---------- */

#[derive(Debug, Deserialize, JsonSchema)]
struct RememberRequest {
    #[schemars(description = "分类（必填）：identity=身份/职业；ongoing=当前在进行的事（通常用 durability=transient）；habit=习惯/作息；people=人际；preference=偏好")]
    category: String,
    #[schemars(description = "事实正文（必填），一句话讲清楚")]
    content: String,
    #[schemars(description = "told=用户明确说的；inferred=你从对话推断的。默认 inferred")]
    source: Option<String>,
    #[schemars(description = "durable=长期有效；transient=阶段性（会自动过期）。默认 durable。ongoing 类一般用 transient")]
    durability: Option<String>,
    #[schemars(description = "有效期 YYYY-MM-DD（可选）。transient 但不填时自动兜约 30 天；durable 一般不填")]
    expires_at: Option<String>,
    #[schemars(description = "钉住：即使过期也保留并优先（默认 false）。慎用，通常交给用户在面板钉")]
    pinned: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct UpdateMemoryRequest {
    #[schemars(description = "目标事实的 id（必填）")]
    id: String,
    #[schemars(description = "分类：identity / ongoing / habit / people / preference")]
    category: Option<String>,
    #[schemars(description = "事实正文")]
    content: Option<String>,
    #[schemars(description = "来源：told / inferred")]
    source: Option<String>,
    #[schemars(description = "耐久度：durable / transient")]
    durability: Option<String>,
    #[schemars(description = "改有效期 YYYY-MM-DD；传空字符串则清空（变永不过期）")]
    expires_at: Option<String>,
    #[schemars(description = "钉住与否")]
    pinned: Option<bool>,
}

/* ---------- 工具实现 ---------- */

#[tool_router]
impl DaybreakMcp {
    fn new(pool: SqlitePool, notify: Notifier) -> Self {
        Self {
            pool,
            notify,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(description = "列出待办任务，可按状态过滤")]
    async fn list_todos(
        &self,
        Parameters(req): Parameters<ListTodosRequest>,
    ) -> Result<CallToolResult, McpError> {
        let limit = req.limit.unwrap_or(50).clamp(1, 500);
        let sql = format!(
            "SELECT {TODO_COLS} FROM todos WHERE (?1 IS NULL OR status = ?1) \
             ORDER BY created_at DESC LIMIT ?2"
        );
        let rows = sqlx::query(&sql)
            .bind(req.status)
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        let todos: Vec<_> = rows.iter().map(todo_to_json).collect();
        ok_json(serde_json::json!({ "count": todos.len(), "todos": todos }))
    }

    #[tool(description = "创建一个新待办任务，返回新任务 id")]
    async fn create_todo(
        &self,
        Parameters(req): Parameters<CreateTodoRequest>,
    ) -> Result<CallToolResult, McpError> {
        let id = gen_id("t");
        let now = now_iso();
        let priority = req.priority.unwrap_or_else(|| "none".to_string());
        sqlx::query(
            "INSERT INTO todos \
             (id,title,reason,deadline,priority,tags,est_time,status,scheduled_time,scheduled_date,is_pushback,is_procrastinated,created_at,updated_at) \
             VALUES (?1,?2,?3,?4,?5,'[]',?6,'todo',?7,?8,0,0,?9,?9)",
        )
        .bind(&id)
        .bind(&req.title)
        .bind(&req.reason)
        .bind(&req.deadline)
        .bind(&priority)
        .bind(&req.est_time)
        .bind(&req.scheduled_time)
        .bind(&req.scheduled_date)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        (self.notify)("todos");
        ok_json(serde_json::json!({ "created": { "id": id, "title": req.title } }))
    }

    #[tool(description = "更新任务状态。状态取值：todo / doing / done / dropped")]
    async fn set_todo_status(
        &self,
        Parameters(req): Parameters<SetTodoStatusRequest>,
    ) -> Result<CallToolResult, McpError> {
        let res = sqlx::query("UPDATE todos SET status = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(&req.status)
            .bind(now_iso())
            .bind(&req.id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "updated": false, "reason": "没找到该 id" }));
        }
        (self.notify)("todos");
        ok_json(serde_json::json!({ "updated": true, "id": req.id, "status": req.status }))
    }

    #[tool(description = "给任务排期（设置归属日期和/或时段）")]
    async fn schedule_todo(
        &self,
        Parameters(req): Parameters<ScheduleTodoRequest>,
    ) -> Result<CallToolResult, McpError> {
        let res = sqlx::query(
            "UPDATE todos SET scheduled_date = ?1, scheduled_time = ?2, updated_at = ?3 WHERE id = ?4",
        )
        .bind(&req.scheduled_date)
        .bind(&req.scheduled_time)
        .bind(now_iso())
        .bind(&req.id)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "updated": false, "reason": "没找到该 id" }));
        }
        (self.notify)("todos");
        ok_json(serde_json::json!({ "updated": true, "id": req.id }))
    }

    #[tool(description = "查看某一天的任务概览（默认今天）")]
    async fn today_overview(
        &self,
        Parameters(req): Parameters<TodayOverviewRequest>,
    ) -> Result<CallToolResult, McpError> {
        let date = req
            .date
            .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
        let sql = format!(
            "SELECT {TODO_COLS} FROM todos WHERE scheduled_date = ?1 ORDER BY scheduled_time ASC"
        );
        let rows = sqlx::query(&sql)
            .bind(&date)
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        let todos: Vec<_> = rows.iter().map(todo_to_json).collect();
        ok_json(serde_json::json!({ "date": date, "count": todos.len(), "todos": todos }))
    }

    #[tool(description = "列出目标，可按周期 / 状态过滤")]
    async fn list_goals(
        &self,
        Parameters(req): Parameters<ListGoalsRequest>,
    ) -> Result<CallToolResult, McpError> {
        let rows = sqlx::query(
            "SELECT id, title, description, period, target_date, status FROM goals \
             WHERE (?1 IS NULL OR period = ?1) AND (?2 IS NULL OR status = ?2) \
             ORDER BY created_at DESC",
        )
        .bind(req.period)
        .bind(req.status)
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        let goals: Vec<_> = rows
            .iter()
            .map(|r| {
                serde_json::json!({
                    "id": r.get::<String, _>("id"),
                    "title": r.get::<String, _>("title"),
                    "description": r.get::<Option<String>, _>("description"),
                    "period": r.get::<String, _>("period"),
                    "target_date": r.get::<Option<String>, _>("target_date"),
                    "status": r.get::<String, _>("status"),
                })
            })
            .collect();
        ok_json(serde_json::json!({ "count": goals.len(), "goals": goals }))
    }

    #[tool(description = "创建一个目标。period 取值：year / quarter / month")]
    async fn create_goal(
        &self,
        Parameters(req): Parameters<CreateGoalRequest>,
    ) -> Result<CallToolResult, McpError> {
        let id = gen_id("g");
        let now = now_iso();
        sqlx::query(
            "INSERT INTO goals (id,title,description,period,target_date,status,created_at,updated_at) \
             VALUES (?1,?2,?3,?4,?5,'active',?6,?6)",
        )
        .bind(&id)
        .bind(&req.title)
        .bind(&req.description)
        .bind(&req.period)
        .bind(&req.target_date)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        (self.notify)("goals");
        ok_json(serde_json::json!({ "created": { "id": id, "title": req.title } }))
    }

    #[tool(description = "更新目标状态。状态取值：active / achieved / abandoned")]
    async fn set_goal_status(
        &self,
        Parameters(req): Parameters<SetGoalStatusRequest>,
    ) -> Result<CallToolResult, McpError> {
        let res = sqlx::query("UPDATE goals SET status = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(&req.status)
            .bind(now_iso())
            .bind(&req.id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "updated": false, "reason": "没找到该 id" }));
        }
        (self.notify)("goals");
        ok_json(serde_json::json!({ "updated": true, "id": req.id, "status": req.status }))
    }

    #[tool(description = "列出最近的时间日志（间歇式记录你在做什么）")]
    async fn list_activities(
        &self,
        Parameters(req): Parameters<ListActivitiesRequest>,
    ) -> Result<CallToolResult, McpError> {
        let limit = req.limit.unwrap_or(100).clamp(1, 500);
        let rows = sqlx::query(
            "SELECT id, content, created_at FROM activity_log ORDER BY created_at DESC LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        let items: Vec<_> = rows
            .iter()
            .map(|r| {
                serde_json::json!({
                    "id": r.get::<String, _>("id"),
                    "content": r.get::<String, _>("content"),
                    "created_at": r.get::<String, _>("created_at"),
                })
            })
            .collect();
        ok_json(serde_json::json!({ "count": items.len(), "activities": items }))
    }

    #[tool(description = "记一条时间日志（你现在/刚才在做什么）")]
    async fn log_activity(
        &self,
        Parameters(req): Parameters<LogActivityRequest>,
    ) -> Result<CallToolResult, McpError> {
        let id = gen_id("a");
        sqlx::query("INSERT INTO activity_log (id, content, created_at) VALUES (?1,?2,?3)")
            .bind(&id)
            .bind(&req.content)
            .bind(now_iso())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        (self.notify)("activities");
        ok_json(serde_json::json!({ "logged": { "id": id, "content": req.content } }))
    }

    #[tool(description = "删除（放弃）任务——实为标记 dropped 状态，可用 recover_todo 恢复，不会真删数据")]
    async fn delete_todo(
        &self,
        Parameters(req): Parameters<IdRequest>,
    ) -> Result<CallToolResult, McpError> {
        let res = sqlx::query("UPDATE todos SET status = 'dropped', updated_at = ?1 WHERE id = ?2")
            .bind(now_iso())
            .bind(&req.id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "deleted": false, "reason": "没找到该 id" }));
        }
        (self.notify)("todos");
        ok_json(serde_json::json!({ "deleted": true, "id": req.id, "note": "已标记为 dropped，可恢复" }))
    }

    #[tool(description = "恢复被删除（dropped）的任务，状态改回 todo")]
    async fn recover_todo(
        &self,
        Parameters(req): Parameters<IdRequest>,
    ) -> Result<CallToolResult, McpError> {
        let res = sqlx::query("UPDATE todos SET status = 'todo', updated_at = ?1 WHERE id = ?2")
            .bind(now_iso())
            .bind(&req.id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "recovered": false, "reason": "没找到该 id" }));
        }
        (self.notify)("todos");
        ok_json(serde_json::json!({ "recovered": true, "id": req.id }))
    }

    #[tool(description = "删除（放弃）目标——实为标记 abandoned 状态，可用 recover_goal 恢复")]
    async fn delete_goal(
        &self,
        Parameters(req): Parameters<IdRequest>,
    ) -> Result<CallToolResult, McpError> {
        let res = sqlx::query("UPDATE goals SET status = 'abandoned', updated_at = ?1 WHERE id = ?2")
            .bind(now_iso())
            .bind(&req.id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "deleted": false, "reason": "没找到该 id" }));
        }
        (self.notify)("goals");
        ok_json(serde_json::json!({ "deleted": true, "id": req.id, "note": "已标记为 abandoned，可恢复" }))
    }

    #[tool(description = "恢复被删除（abandoned）的目标，状态改回 active")]
    async fn recover_goal(
        &self,
        Parameters(req): Parameters<IdRequest>,
    ) -> Result<CallToolResult, McpError> {
        let res = sqlx::query("UPDATE goals SET status = 'active', updated_at = ?1 WHERE id = ?2")
            .bind(now_iso())
            .bind(&req.id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "recovered": false, "reason": "没找到该 id" }));
        }
        (self.notify)("goals");
        ok_json(serde_json::json!({ "recovered": true, "id": req.id }))
    }

    /* ===================== 记忆事实工具（Task 4.2） =====================
     * 镜像 TS chatTools 的 remember / update_memory / forget，让 CC/Codex 经 MCP 写记忆。
     * 字段、枚举、默认值、TTL 兜底与 TS 侧逐字对齐（见 src/lib/chatTools.ts 与 src/lib/db.ts）。
     * 表由前端 migrate 建（memory_facts），此处只读写既有库；写后 notify("memory")
     * 与 TS 的 emitSync("memory") 对齐，触发「关于你」面板等窗口刷新。
     */

    #[tool(
        description = "记住一条关于用户的长期事实（身份/在做的事/习惯/人际/偏好），供以后的对话个性化参考。只在确实值得长期记的信息上用；一次性、马上过时的内容不要记。category 必须是枚举值之一：identity / ongoing / habit / people / preference"
    )]
    async fn remember(
        &self,
        Parameters(req): Parameters<RememberRequest>,
    ) -> Result<CallToolResult, McpError> {
        let category = req.category.trim();
        if !is_valid_category(category) {
            return ok_json(serde_json::json!({
                "error": format!("category 必须是以下之一: {}", MEMORY_CATEGORIES.join(" / "))
            }));
        }
        let content = req.content.trim();
        if content.is_empty() {
            return ok_json(serde_json::json!({ "error": "content 必填" }));
        }

        // source 默认 inferred；只有显式 "told" 才记为 told（与 TS 一致）。
        let source = if req.source.as_deref() == Some("told") {
            "told"
        } else {
            "inferred"
        };
        // durability 默认 durable；只有显式 "transient" 才记为 transient（与 TS 一致）。
        let durability = if req.durability.as_deref() == Some("transient") {
            "transient"
        } else {
            "durable"
        };
        let pinned = req.pinned.unwrap_or(false);

        // transient 没给有效期 → 兜默认 TTL，防止阶段性事实变成永久噪音（与 TS 一致）。
        let expires_at: Option<String> = match req.expires_at.as_deref().map(str::trim) {
            Some(s) if !s.is_empty() => Some(s.to_string()),
            _ if durability == "transient" => Some(iso_after_ms(TRANSIENT_DEFAULT_TTL_MS)),
            _ => None,
        };

        let id = gen_id("mf");
        let now = now_iso();
        sqlx::query(
            "INSERT INTO memory_facts \
             (id, category, content, source, durability, pinned, created_at, expires_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        )
        .bind(&id)
        .bind(category)
        .bind(content)
        .bind(source)
        .bind(durability)
        .bind(if pinned { 1 } else { 0 })
        .bind(&now)
        .bind(&expires_at)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        (self.notify)("memory");
        ok_json(serde_json::json!({
            "id": id,
            "remembered": { "category": category, "content": content }
        }))
    }

    #[tool(
        description = "修改一条已有的记忆事实（按 id）。只填想改的字段。改正、补充、或把 transient 续期/转 durable 时用。expires_at 传空字符串则清空（变永不过期）"
    )]
    async fn update_memory(
        &self,
        Parameters(req): Parameters<UpdateMemoryRequest>,
    ) -> Result<CallToolResult, McpError> {
        let id = req.id.trim();
        if id.is_empty() {
            return ok_json(serde_json::json!({ "error": "id 必填" }));
        }

        // 动态拼 SET 子句，只更新传入的字段（与 TS dbUpdateMemoryFact 一致）。
        let mut sets: Vec<String> = Vec::new();
        let mut idx = 0;
        // 收集绑定值；用 enum 统一文本/整数/null 三种绑定类型。
        enum Bind {
            Text(String),
            Int(i64),
            Null,
        }
        let mut binds: Vec<Bind> = Vec::new();
        let mut push = |col: &str, b: Bind, sets: &mut Vec<String>, binds: &mut Vec<Bind>| {
            idx += 1;
            sets.push(format!("{col} = ?{idx}"));
            binds.push(b);
        };

        if let Some(c) = req.category.as_deref().map(str::trim) {
            if !is_valid_category(c) {
                return ok_json(serde_json::json!({
                    "error": format!("category 必须是以下之一: {}", MEMORY_CATEGORIES.join(" / "))
                }));
            }
            push("category", Bind::Text(c.to_string()), &mut sets, &mut binds);
        }
        // content：仅在非空（去空白后）时更新，与 TS 一致。
        if let Some(content) = req.content.as_deref().map(str::trim) {
            if !content.is_empty() {
                push("content", Bind::Text(content.to_string()), &mut sets, &mut binds);
            }
        }
        // source / durability：仅接受合法枚举值，否则忽略（与 TS 一致）。
        if let Some(s) = req.source.as_deref() {
            if s == "told" || s == "inferred" {
                push("source", Bind::Text(s.to_string()), &mut sets, &mut binds);
            }
        }
        if let Some(d) = req.durability.as_deref() {
            if d == "durable" || d == "transient" {
                push("durability", Bind::Text(d.to_string()), &mut sets, &mut binds);
            }
        }
        if let Some(p) = req.pinned {
            push("pinned", Bind::Int(if p { 1 } else { 0 }), &mut sets, &mut binds);
        }
        // expires_at：字段缺省=不动；空字符串=清空(NULL)；非空=设值（与 TS 一致）。
        if let Some(e) = req.expires_at.as_deref().map(str::trim) {
            if e.is_empty() {
                push("expires_at", Bind::Null, &mut sets, &mut binds);
            } else {
                push("expires_at", Bind::Text(e.to_string()), &mut sets, &mut binds);
            }
        }

        if sets.is_empty() {
            // 没有要改的字段：与 TS 一样不打空 UPDATE，直接返回。
            return ok_json(serde_json::json!({
                "updated": true, "id": id, "fieldsChanged": []
            }));
        }

        idx += 1;
        let sql = format!("UPDATE memory_facts SET {} WHERE id = ?{}", sets.join(", "), idx);
        let mut q = sqlx::query(&sql);
        for b in &binds {
            q = match b {
                Bind::Text(s) => q.bind(s),
                Bind::Int(n) => q.bind(n),
                Bind::Null => q.bind(Option::<String>::None),
            };
        }
        q = q.bind(id);
        let res = q.execute(&self.pool).await.map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "updated": false, "reason": "没找到该 id" }));
        }
        (self.notify)("memory");
        // fieldsChanged：从 SET 子句反推列名（"col = ?n" → "col"）。
        let fields: Vec<&str> = sets
            .iter()
            .filter_map(|s| s.split(" = ").next())
            .collect();
        ok_json(serde_json::json!({ "updated": true, "id": id, "fieldsChanged": fields }))
    }

    #[tool(
        description = "删除一条记忆事实（按 id），硬删不可恢复。用户说『忘掉/别记这个』或事实已彻底失效时用"
    )]
    async fn forget(
        &self,
        Parameters(req): Parameters<IdRequest>,
    ) -> Result<CallToolResult, McpError> {
        let id = req.id.trim();
        if id.is_empty() {
            return ok_json(serde_json::json!({ "error": "id 必填" }));
        }
        // 硬删，与 TS dbDeleteMemoryFact 一致（记忆无软删/可恢复语义）。
        let res = sqlx::query("DELETE FROM memory_facts WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "deleted": false, "reason": "没找到该 id" }));
        }
        (self.notify)("memory");
        ok_json(serde_json::json!({ "deleted": true, "id": id }))
    }
}

#[tool_handler]
impl ServerHandler for DaybreakMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2025_03_26,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "daybreak".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                title: None,
                website_url: None,
                icons: None,
            },
            instructions: Some(
                "Daybreak 本地 MCP：管理你的任务、目标、时间日志，以及关于你的长期记忆事实".to_string(),
            ),
        }
    }
}

/* ===================== 鉴权中间件 ===================== */

/// 校验 Authorization: Bearer <token>，不匹配返回 401。
async fn require_auth(
    expected: &str,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let ok = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t == expected)
        .unwrap_or(false);
    if ok {
        Ok(next.run(req).await)
    } else {
        Err(axum::http::StatusCode::UNAUTHORIZED)
    }
}

/* ===================== 启动 ===================== */

/// 启动 MCP server。
///
/// 设计原则：MCP 是附加能力，任何启动失败（连库失败、端口被占）都只记日志、安静退出，
/// 绝不 panic、不影响 Daybreak 主应用的正常使用。
///
/// - `token`：鉴权密钥，所有请求需带 `Authorization: Bearer <token>`
/// - `notify`：写操作后的刷新回调（Tauri 端转 event；测试传空回调）
pub async fn start(db_path: PathBuf, token: String, notify: Notifier) {
    let pool = match db::connect(&db_path).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[mcp] 连接数据库失败，MCP server 未启动: {e}");
            return;
        }
    };

    let notify_for_factory = notify.clone();
    let service = StreamableHttpService::new(
        move || Ok(DaybreakMcp::new(pool.clone(), notify_for_factory.clone())),
        LocalSessionManager::default().into(),
        Default::default(),
    );

    let expected = Arc::new(token);
    let app = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(
            move |req: axum::extract::Request, next: axum::middleware::Next| {
                let expected = expected.clone();
                async move { require_auth(&expected, req, next).await }
            },
        ));

    let addr = format!("127.0.0.1:{}", crate::mcp::MCP_PORT);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[mcp] 绑定 {addr} 失败（端口可能被占用），MCP server 未启动: {e}");
            return;
        }
    };

    eprintln!("[mcp] Daybreak MCP server 已启动: http://{addr}/mcp");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[mcp] MCP server 运行出错: {e}");
    }
}

/* ===================== 测试（Task 4.2：记忆工具端到端） ===================== */

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// memory_facts 的建表 DDL，逐字镜像前端 SCHEMA_V1（src/lib/db.ts）。
    /// Rust 单测自给自足、不依赖前端建表；真实运行时表仍由前端 migrate() 创建。
    const MEMORY_DDL: &str = "
        CREATE TABLE memory_facts (
          id          TEXT PRIMARY KEY,
          category    TEXT NOT NULL,
          content     TEXT NOT NULL,
          source      TEXT NOT NULL DEFAULT 'inferred',
          durability  TEXT NOT NULL DEFAULT 'durable',
          pinned      INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          expires_at  TEXT
        );
    ";

    /// 内存库 + 建 memory_facts 表。max_connections=1：sqlite `:memory:` 每连接一个库，
    /// 多连接会各看各的，限 1 连接保证整池共享同一个内存库。
    async fn test_mcp() -> DaybreakMcp {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        for stmt in MEMORY_DDL.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            sqlx::query(stmt).execute(&pool).await.unwrap();
        }
        // 测试用空 notify（不接 Tauri）。
        let notify: Notifier = Arc::new(|_domain: &str| {});
        DaybreakMcp::new(pool, notify)
    }

    /// 把工具返回的 CallToolResult 取出首个文本内容并解析成 JSON。
    fn result_json(res: &CallToolResult) -> serde_json::Value {
        let text = res
            .content
            .first()
            .and_then(|c| c.as_text())
            .map(|t| t.text.clone())
            .expect("工具应返回文本内容");
        serde_json::from_str(&text).expect("工具返回应是合法 JSON")
    }

    /// 直接查 memory_facts 单行（按 id），便于断言落库结果。
    async fn fetch_fact(pool: &SqlitePool, id: &str) -> Option<sqlx::sqlite::SqliteRow> {
        sqlx::query("SELECT * FROM memory_facts WHERE id = ?1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn remember_inserts_with_defaults() {
        let mcp = test_mcp().await;
        let res = mcp
            .remember(Parameters(RememberRequest {
                category: "identity".into(),
                content: "  是个 AI Agent 产品负责人  ".into(),
                source: None,
                durability: None,
                expires_at: None,
                pinned: None,
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        let id = j["id"].as_str().expect("应返回 id");
        assert!(id.starts_with("mf"), "id 应带 mf 前缀: {id}");
        // 正文应被 trim
        assert_eq!(j["remembered"]["content"], "是个 AI Agent 产品负责人");

        let row = fetch_fact(&mcp.pool, id).await.expect("应落库");
        assert_eq!(row.get::<String, _>("category"), "identity");
        assert_eq!(row.get::<String, _>("content"), "是个 AI Agent 产品负责人");
        // 默认 source=inferred、durability=durable、pinned=0
        assert_eq!(row.get::<String, _>("source"), "inferred");
        assert_eq!(row.get::<String, _>("durability"), "durable");
        assert_eq!(row.get::<i64, _>("pinned"), 0);
        // durable 未给有效期 → NULL
        assert!(row.get::<Option<String>, _>("expires_at").is_none());
    }

    #[tokio::test]
    async fn remember_transient_backfills_ttl() {
        let mcp = test_mcp().await;
        let res = mcp
            .remember(Parameters(RememberRequest {
                category: "ongoing".into(),
                content: "正在做 AI 秘书 Phase 4".into(),
                source: Some("told".into()),
                durability: Some("transient".into()),
                expires_at: None,
                pinned: Some(true),
            }))
            .await
            .unwrap();
        let id = result_json(&res)["id"].as_str().unwrap().to_string();

        let row = fetch_fact(&mcp.pool, &id).await.unwrap();
        assert_eq!(row.get::<String, _>("source"), "told");
        assert_eq!(row.get::<String, _>("durability"), "transient");
        assert_eq!(row.get::<i64, _>("pinned"), 1);
        // transient 未给有效期 → 兜默认 TTL，落了一个非空 ISO 串
        let exp = row.get::<Option<String>, _>("expires_at").expect("应兜 TTL");
        assert!(exp.ends_with('Z'), "应是 ISO 串: {exp}");
        assert!(
            chrono::DateTime::parse_from_rfc3339(&exp).is_ok(),
            "TTL 应可解析: {exp}"
        );
    }

    #[tokio::test]
    async fn remember_rejects_bad_category_and_empty_content() {
        let mcp = test_mcp().await;
        // 非法 category
        let res = mcp
            .remember(Parameters(RememberRequest {
                category: "mood".into(),
                content: "x".into(),
                source: None,
                durability: None,
                expires_at: None,
                pinned: None,
            }))
            .await
            .unwrap();
        assert!(result_json(&res)["error"].is_string());

        // 空 content（全空白）
        let res = mcp
            .remember(Parameters(RememberRequest {
                category: "habit".into(),
                content: "   ".into(),
                source: None,
                durability: None,
                expires_at: None,
                pinned: None,
            }))
            .await
            .unwrap();
        assert!(result_json(&res)["error"].is_string());

        // 两次都该被拒，表里 0 行
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM memory_facts")
            .fetch_one(&mcp.pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn update_memory_partial_fields_only() {
        let mcp = test_mcp().await;
        let id = result_json(
            &mcp.remember(Parameters(RememberRequest {
                category: "preference".into(),
                content: "原内容".into(),
                source: None,
                durability: None,
                expires_at: None,
                pinned: None,
            }))
            .await
            .unwrap(),
        )["id"]
            .as_str()
            .unwrap()
            .to_string();

        // 只改 content + pinned
        let res = mcp
            .update_memory(Parameters(UpdateMemoryRequest {
                id: id.clone(),
                category: None,
                content: Some("改后内容".into()),
                source: None,
                durability: None,
                expires_at: None,
                pinned: Some(true),
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        assert_eq!(j["updated"], true);

        let row = fetch_fact(&mcp.pool, &id).await.unwrap();
        assert_eq!(row.get::<String, _>("content"), "改后内容");
        assert_eq!(row.get::<i64, _>("pinned"), 1);
        // 未传的 category 保持原值
        assert_eq!(row.get::<String, _>("category"), "preference");
    }

    #[tokio::test]
    async fn update_memory_empty_expires_clears_to_null() {
        let mcp = test_mcp().await;
        // 先建一条带有效期的 transient
        let id = result_json(
            &mcp.remember(Parameters(RememberRequest {
                category: "ongoing".into(),
                content: "阶段任务".into(),
                source: None,
                durability: Some("transient".into()),
                expires_at: Some("2026-12-31".into()),
                pinned: None,
            }))
            .await
            .unwrap(),
        )["id"]
            .as_str()
            .unwrap()
            .to_string();
        let row = fetch_fact(&mcp.pool, &id).await.unwrap();
        assert_eq!(row.get::<Option<String>, _>("expires_at").as_deref(), Some("2026-12-31"));

        // expires_at 传空串 → 清空为 NULL（永不过期）
        mcp.update_memory(Parameters(UpdateMemoryRequest {
            id: id.clone(),
            category: None,
            content: None,
            source: None,
            durability: None,
            expires_at: Some("".into()),
            pinned: None,
        }))
        .await
        .unwrap();
        let row = fetch_fact(&mcp.pool, &id).await.unwrap();
        assert!(row.get::<Option<String>, _>("expires_at").is_none());
    }

    #[tokio::test]
    async fn update_memory_missing_id_returns_not_found() {
        let mcp = test_mcp().await;
        let res = mcp
            .update_memory(Parameters(UpdateMemoryRequest {
                id: "mf_not_exist".into(),
                category: None,
                content: Some("x".into()),
                source: None,
                durability: None,
                expires_at: None,
                pinned: None,
            }))
            .await
            .unwrap();
        assert_eq!(result_json(&res)["updated"], false);
    }

    #[tokio::test]
    async fn forget_hard_deletes() {
        let mcp = test_mcp().await;
        let id = result_json(
            &mcp.remember(Parameters(RememberRequest {
                category: "people".into(),
                content: "合作方 A".into(),
                source: None,
                durability: None,
                expires_at: None,
                pinned: None,
            }))
            .await
            .unwrap(),
        )["id"]
            .as_str()
            .unwrap()
            .to_string();

        let res = mcp.forget(Parameters(IdRequest { id: id.clone() })).await.unwrap();
        assert_eq!(result_json(&res)["deleted"], true);
        assert!(fetch_fact(&mcp.pool, &id).await.is_none());

        // 再删一次 → not found
        let res = mcp.forget(Parameters(IdRequest { id })).await.unwrap();
        assert_eq!(result_json(&res)["deleted"], false);
    }
}
