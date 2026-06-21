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

/* ---------- 自定义字段 helper（镜像 TS src/lib/fieldMatch.ts，自定义字段二期 D1/D2） ---------- */

/// D2 颜色盘：与前端 PRESET_COLORS（fieldMatch.ts / CustomFieldsManager.tsx）逐字一致。
/// 新选项颜色 = PRESET_COLORS[现有选项数 % 10]。
const PRESET_COLORS: [&str; 10] = [
    "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
    "#6b7280", "#18181b",
];

/// 合法字段类型。本期只支持单选 / 多选（D7 YAGNI）。
const FIELD_TYPES: [&str; 2] = ["single_select", "multi_select"];

/// D1 归一化：去除所有空白字符（含全角空格 U+3000）+ 转小写。
/// 用于字段名配 field.name、选项名配 option.label。注意：保留中间不可去除的字符，
/// 仅折叠空白——故 "项目A" ≡ "项目 A" ≡ "项目　A"（三者去空白后都是 "项目a"）。
fn normalize_label(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

/// D2：按现有选项数取色，循环用色盘。
fn color_for_index(i: usize) -> &'static str {
    PRESET_COLORS[i % PRESET_COLORS.len()]
}

/// 字段选项（与 TS option 结构 {id,label,color} 对齐）。options 列存的是这个的 JSON 数组。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct FieldOption {
    id: String,
    label: String,
    color: String,
}

/// 解析 field_definitions.options 列（JSON）成 Vec<FieldOption>；坏数据按空处理（与 TS 容错一致）。
fn parse_options(raw: &str) -> Vec<FieldOption> {
    serde_json::from_str::<Vec<FieldOption>>(raw).unwrap_or_default()
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
    #[schemars(
        description = "自定义字段值，形如 {字段名: 选项名 或 选项名数组}，选项不存在会自动新建。例如 {\"项目\":\"后端\"} 或 {\"标签\":[\"紧急\",\"重要\"]}"
    )]
    custom_fields: Option<serde_json::Value>,
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

/* ---------- 自定义字段参数结构（镜像 TS chatToolsFields，自定义字段二期 Task 6） ---------- */

#[derive(Debug, Deserialize, JsonSchema)]
struct ListFieldsRequest {}

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateFieldRequest {
    #[schemars(description = "字段名（必填），如 '项目' / '标签'")]
    name: String,
    #[schemars(description = "字段类型（必填）：single_select（单选）/ multi_select（多选）")]
    r#type: String,
    #[schemars(description = "初始选项名列表（可选），如 [\"后端\",\"前端\"]；会自动去重并分配颜色")]
    options: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct UpdateFieldRequest {
    #[schemars(description = "字段 id（必填）")]
    id: String,
    #[schemars(description = "改字段名（可选）")]
    name: Option<String>,
    #[schemars(description = "追加新选项名列表（可选）；已存在的（归一化后）会跳过，新的自动分配颜色")]
    add_options: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DeleteFieldRequest {
    #[schemars(description = "字段 id（必填）")]
    id: String,
    #[schemars(
        description = "确认删除。首次不带（或 false）时只返回将影响的任务数、不删；得用户同意后带 true 再调一次才真删"
    )]
    confirm: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DeleteFieldOptionRequest {
    #[schemars(description = "字段 id（必填）")]
    field_id: String,
    #[schemars(description = "要删的选项名（必填，按归一化匹配该字段已有选项的 label）")]
    option_label: String,
    #[schemars(
        description = "确认删除。首次不带（或 false）时只返回引用该选项的任务数、不删；得用户同意后带 true 再调一次才真删"
    )]
    confirm: Option<bool>,
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

        // D4：把人类可读的 {字段名: 选项名|选项名[]} 翻译成存库的 {fieldId: optId|[optId]}。
        // 字段名归一化匹配 field.name（匹配不到则跳过，记 skipped）；选项名归一化匹配 option.label
        // （匹配不到则在该字段 options 里新建选项、回写 field_definitions，记 created_options）。
        let mut custom_fields_json = "{}".to_string();
        let mut created_options: Vec<serde_json::Value> = Vec::new();
        let mut skipped_fields: Vec<String> = Vec::new();
        if let Some(input) = req.custom_fields.as_ref().and_then(|v| v.as_object()) {
            custom_fields_json = self
                .resolve_custom_fields_input(input, &mut created_options, &mut skipped_fields)
                .await?;
        }

        sqlx::query(
            "INSERT INTO todos \
             (id,title,reason,deadline,priority,tags,est_time,status,scheduled_time,scheduled_date,is_pushback,is_procrastinated,custom_fields,created_at,updated_at) \
             VALUES (?1,?2,?3,?4,?5,'[]',?6,'todo',?7,?8,0,0,?9,?10,?10)",
        )
        .bind(&id)
        .bind(&req.title)
        .bind(&req.reason)
        .bind(&req.deadline)
        .bind(&priority)
        .bind(&req.est_time)
        .bind(&req.scheduled_time)
        .bind(&req.scheduled_date)
        .bind(&custom_fields_json)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        (self.notify)("todos");

        let mut out = serde_json::json!({ "created": { "id": id, "title": req.title } });
        if !created_options.is_empty() {
            out["created_options"] = serde_json::Value::Array(created_options);
        }
        if !skipped_fields.is_empty() {
            out["note"] = serde_json::json!(format!(
                "以下字段名不存在、已跳过（用 create_field 先建）: {}",
                skipped_fields.join("、")
            ));
        }
        ok_json(out)
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
     * 表由前端 migrate 建（memory_facts），此处只读写既有库；写后 notify("memory") 发到后端→前端桥
     * daybreak://data-changed（topic "memory"）。注意它与前端 syncBus 的 emitSync("memory") 是
     * 两条不同事件名，并不直接互通：前端在常驻主窗用 bridgeDataChangedToSync()（见 src/lib/syncBus.ts
     * 与 src/App.tsx 的 MainWindow）把这条 data-changed 的 "memory" 转嫁到 syncBus，
     * onSync("memory") 的消费者（「关于你」面板 AboutYouPanel）才会实时刷新。
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

    /* ===================== 自定义字段工具（自定义字段二期 Task 6） =====================
     * 镜像 TS chatToolsFields（list_fields / create_field / update_field / delete_field /
     * delete_field_option），让 CC/Codex 经 MCP 增删改字段定义、填字段值。
     * field_definitions 表与 todos.custom_fields 列由前端 migrate 建（src/lib/db.ts），此处只读写。
     * 写后 notify("todos")（D6：字段值属 todos 域）。清理 todos 的 SQL 镜像 db.ts 的
     * dbClearFieldFromTodos / dbClearOptionFromTodos。
     */

    #[tool(description = "列出所有自定义字段（含每个字段的选项），用于了解可填哪些字段、有哪些选项")]
    async fn list_fields(
        &self,
        Parameters(_req): Parameters<ListFieldsRequest>,
    ) -> Result<CallToolResult, McpError> {
        let rows = sqlx::query(
            "SELECT id, name, type, options FROM field_definitions ORDER BY sort_order",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        let fields: Vec<_> = rows
            .iter()
            .map(|r| {
                let options = parse_options(&r.get::<String, _>("options"));
                serde_json::json!({
                    "id": r.get::<String, _>("id"),
                    "name": r.get::<String, _>("name"),
                    "type": r.get::<String, _>("type"),
                    "options": options,
                })
            })
            .collect();
        ok_json(serde_json::json!({ "count": fields.len(), "fields": fields }))
    }

    #[tool(
        description = "新建一个自定义字段。type 必须是 single_select（单选）或 multi_select（多选）。可带初始选项名列表，自动去重并分配颜色"
    )]
    async fn create_field(
        &self,
        Parameters(req): Parameters<CreateFieldRequest>,
    ) -> Result<CallToolResult, McpError> {
        let name = req.name.trim();
        if name.is_empty() {
            return ok_json(serde_json::json!({ "error": "字段名必填" }));
        }
        let field_type = req.r#type.trim();
        if !FIELD_TYPES.contains(&field_type) {
            return ok_json(serde_json::json!({
                "error": "暂不支持的字段类型，仅支持 single_select / multi_select"
            }));
        }

        // 构造选项：归一化去重，逐个分配 opt id + 颜色（颜色按当前已收集的选项数取）。
        let mut options: Vec<FieldOption> = Vec::new();
        for raw in req.options.unwrap_or_default() {
            let label = raw.trim();
            if label.is_empty() {
                continue;
            }
            let n = normalize_label(label);
            if options.iter().any(|o| normalize_label(&o.label) == n) {
                continue; // 同一次输入里的重复选项跳过
            }
            options.push(FieldOption {
                id: gen_id("opt"),
                label: label.to_string(),
                color: color_for_index(options.len()).to_string(),
            });
        }
        let options_json = serde_json::to_string(&options).unwrap_or_else(|_| "[]".to_string());

        // sort_order = 当前 MAX(sort_order)+1（空表时 MAX 为 NULL → 兜 0，故首个为 0）。
        let max_order: Option<i64> =
            sqlx::query_scalar("SELECT MAX(sort_order) FROM field_definitions")
                .fetch_one(&self.pool)
                .await
                .map_err(db_err)?;
        let sort_order = max_order.map(|m| m + 1).unwrap_or(0);

        let id = gen_id("fld");
        let now = now_iso();
        sqlx::query(
            "INSERT INTO field_definitions (id, name, type, options, sort_order, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6)",
        )
        .bind(&id)
        .bind(name)
        .bind(field_type)
        .bind(&options_json)
        .bind(sort_order)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        (self.notify)("todos");
        ok_json(serde_json::json!({
            "created": { "id": id, "name": name, "type": field_type, "options": options }
        }))
    }

    #[tool(
        description = "修改自定义字段：改字段名（name）和/或追加新选项（add_options）。本期只支持这两项，不支持改/删已有选项"
    )]
    async fn update_field(
        &self,
        Parameters(req): Parameters<UpdateFieldRequest>,
    ) -> Result<CallToolResult, McpError> {
        let id = req.id.trim();
        if id.is_empty() {
            return ok_json(serde_json::json!({ "error": "id 必填" }));
        }
        // 读现有字段（拿 name + options）。
        let row = sqlx::query("SELECT name, options FROM field_definitions WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?;
        let Some(row) = row else {
            return ok_json(serde_json::json!({ "updated": false, "reason": "没找到该 id" }));
        };

        let mut name = row.get::<String, _>("name");
        if let Some(new_name) = req.name.as_deref().map(str::trim) {
            if !new_name.is_empty() {
                name = new_name.to_string();
            }
        }

        let mut options = parse_options(&row.get::<String, _>("options"));
        let mut added: Vec<FieldOption> = Vec::new();
        for raw in req.add_options.unwrap_or_default() {
            let label = raw.trim();
            if label.is_empty() {
                continue;
            }
            let n = normalize_label(label);
            // 归一化去重：已存在（在原有或本次新增里）则跳过。
            if options.iter().any(|o| normalize_label(&o.label) == n) {
                continue;
            }
            let opt = FieldOption {
                id: gen_id("opt"),
                label: label.to_string(),
                color: color_for_index(options.len()).to_string(),
            };
            options.push(opt.clone());
            added.push(opt);
        }

        let options_json = serde_json::to_string(&options).unwrap_or_else(|_| "[]".to_string());
        sqlx::query("UPDATE field_definitions SET name = ?1, options = ?2 WHERE id = ?3")
            .bind(&name)
            .bind(&options_json)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        (self.notify)("todos");
        ok_json(serde_json::json!({
            "updated": true, "id": id, "name": name, "added_options": added
        }))
    }

    #[tool(
        description = "删除一个自定义字段。删除会清掉所有任务上该字段的值，不可恢复。首次调用不带 confirm（或 false）只返回将影响的任务数、不删；把影响告知用户、得同意后带 confirm:true 再调一次才真删"
    )]
    async fn delete_field(
        &self,
        Parameters(req): Parameters<DeleteFieldRequest>,
    ) -> Result<CallToolResult, McpError> {
        let id = req.id.trim();
        if id.is_empty() {
            return ok_json(serde_json::json!({ "error": "id 必填" }));
        }

        // D5：未确认 → 统计影响、返回 pending、不删。
        if req.confirm != Some(true) {
            let affected: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM todos WHERE custom_fields LIKE '%' || ?1 || '%'",
            )
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .map_err(db_err)?;
            return ok_json(serde_json::json!({
                "pending": true,
                "affected_todos": affected,
                "message": format!("将清除 {affected} 个任务的该字段值，确认请再次调用并带 confirm:true")
            }));
        }

        // confirm=true：删字段定义 + 清理所有 todos 上该字段值（镜像 dbClearFieldFromTodos）。
        let res = sqlx::query("DELETE FROM field_definitions WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return ok_json(serde_json::json!({ "deleted": false, "reason": "没找到该 id" }));
        }
        let cleared = self.clear_field_from_todos(id).await?;
        (self.notify)("todos");
        ok_json(serde_json::json!({
            "deleted": true, "id": id, "cleared_todos": cleared
        }))
    }

    #[tool(
        description = "删除某个字段下的一个选项（按选项名）。会清掉所有任务上该选项的值。首次调用不带 confirm（或 false）只返回引用该选项的任务数、不删；得用户同意后带 confirm:true 再调一次才真删"
    )]
    async fn delete_field_option(
        &self,
        Parameters(req): Parameters<DeleteFieldOptionRequest>,
    ) -> Result<CallToolResult, McpError> {
        let field_id = req.field_id.trim();
        if field_id.is_empty() {
            return ok_json(serde_json::json!({ "error": "field_id 必填" }));
        }
        let row = sqlx::query("SELECT options FROM field_definitions WHERE id = ?1")
            .bind(field_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?;
        let Some(row) = row else {
            return ok_json(serde_json::json!({ "error": "没找到该字段 id" }));
        };
        let mut options = parse_options(&row.get::<String, _>("options"));

        // 归一化匹配要删的选项 label → 拿 optId。
        let n = normalize_label(&req.option_label);
        let Some(opt_id) = options
            .iter()
            .find(|o| normalize_label(&o.label) == n)
            .map(|o| o.id.clone())
        else {
            return ok_json(serde_json::json!({
                "error": format!("该字段下没有名为「{}」的选项", req.option_label.trim())
            }));
        };

        // D5：未确认 → 统计引用该 optId 的任务数、返回 pending、不删。
        if req.confirm != Some(true) {
            let affected: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM todos WHERE custom_fields LIKE '%' || ?1 || '%'",
            )
            .bind(&opt_id)
            .fetch_one(&self.pool)
            .await
            .map_err(db_err)?;
            return ok_json(serde_json::json!({
                "pending": true,
                "affected_todos": affected,
                "message": format!("将清除 {affected} 个任务的该选项值，确认请再次调用并带 confirm:true")
            }));
        }

        // confirm=true：从字段 options 移除该项 + 清理 todos（镜像 dbClearOptionFromTodos）。
        options.retain(|o| o.id != opt_id);
        let options_json = serde_json::to_string(&options).unwrap_or_else(|_| "[]".to_string());
        sqlx::query("UPDATE field_definitions SET options = ?1 WHERE id = ?2")
            .bind(&options_json)
            .bind(field_id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        let cleared = self.clear_option_from_todos(field_id, &opt_id).await?;
        (self.notify)("todos");
        ok_json(serde_json::json!({
            "deleted": true, "field_id": field_id, "option_id": opt_id, "cleared_todos": cleared
        }))
    }
}

/* ---------- 自定义字段非工具 helper（DaybreakMcp 的私有方法，不挂 #[tool]） ---------- */

impl DaybreakMcp {
    /// D4 翻译：把 {字段名: 选项名|选项名[]} 翻成存库的 {fieldId: optId|[optId]} JSON 串。
    /// 字段名归一化匹配 field.name（匹配不到 → 记入 skipped、跳过）；选项名归一化匹配 option.label
    /// （匹配不到 → 在该字段 options 新建选项、回写 field_definitions、记入 created）。
    /// 单选取首个 optId（标量），多选取数组。
    async fn resolve_custom_fields_input(
        &self,
        input: &serde_json::Map<String, serde_json::Value>,
        created: &mut Vec<serde_json::Value>,
        skipped: &mut Vec<String>,
    ) -> Result<String, McpError> {
        // 一次性把所有字段读进内存（字段数量很小），逐个输入按归一化 name 匹配。
        let all_fields = sqlx::query("SELECT id, name, type, options FROM field_definitions")
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;

        let mut result = serde_json::Map::new();
        for (fname, raw_val) in input {
            let nf = normalize_label(fname);
            let matched = all_fields
                .iter()
                .find(|r| normalize_label(&r.get::<String, _>("name")) == nf);
            let Some(field_row) = matched else {
                skipped.push(fname.clone());
                continue;
            };
            let field_id = field_row.get::<String, _>("id");
            let field_type = field_row.get::<String, _>("type");
            let mut options = parse_options(&field_row.get::<String, _>("options"));

            // 收集本字段要填的选项名列表（标量或数组都归一成 Vec<String>）。
            let labels: Vec<String> = match raw_val {
                serde_json::Value::String(s) => vec![s.clone()],
                serde_json::Value::Array(arr) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect(),
                _ => Vec::new(),
            };

            let mut opt_ids: Vec<String> = Vec::new();
            let mut options_dirty = false;
            for lab in labels {
                let label = lab.trim();
                if label.is_empty() {
                    continue;
                }
                let n = normalize_label(label);
                if let Some(hit) = options.iter().find(|o| normalize_label(&o.label) == n) {
                    opt_ids.push(hit.id.clone());
                    continue;
                }
                // 选项不存在 → 新建、回写、记录。
                let opt = FieldOption {
                    id: gen_id("opt"),
                    label: label.to_string(),
                    color: color_for_index(options.len()).to_string(),
                };
                created.push(serde_json::json!({
                    "field_id": field_id, "option_id": opt.id, "label": opt.label, "color": opt.color
                }));
                opt_ids.push(opt.id.clone());
                options.push(opt);
                options_dirty = true;
            }

            // 有新建选项 → 回写 field_definitions.options。
            if options_dirty {
                let options_json =
                    serde_json::to_string(&options).unwrap_or_else(|_| "[]".to_string());
                sqlx::query("UPDATE field_definitions SET options = ?1 WHERE id = ?2")
                    .bind(&options_json)
                    .bind(&field_id)
                    .execute(&self.pool)
                    .await
                    .map_err(db_err)?;
            }

            if opt_ids.is_empty() {
                continue;
            }
            // 单选存标量、多选存数组（与前端 custom_fields 结构一致）。
            let value = if field_type == "single_select" {
                serde_json::Value::String(opt_ids[0].clone())
            } else {
                serde_json::Value::Array(
                    opt_ids.into_iter().map(serde_json::Value::String).collect(),
                )
            };
            result.insert(field_id, value);
        }
        Ok(serde_json::Value::Object(result).to_string())
    }

    /// 清掉所有 todos 上某字段的值（镜像 TS dbClearFieldFromTodos）。返回被改的任务数。
    async fn clear_field_from_todos(&self, field_id: &str) -> Result<usize, McpError> {
        let rows = sqlx::query("SELECT id, custom_fields FROM todos WHERE custom_fields LIKE ?1")
            .bind(format!("%{field_id}%"))
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        let now = now_iso();
        let mut changed = 0usize;
        for r in &rows {
            let raw = r.get::<String, _>("custom_fields");
            let Ok(mut cf) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw)
            else {
                continue;
            };
            if cf.remove(field_id).is_none() {
                continue; // LIKE 误命中（id 仅作为子串出现在别处）→ 不动
            }
            let id = r.get::<String, _>("id");
            sqlx::query("UPDATE todos SET custom_fields = ?1, updated_at = ?2 WHERE id = ?3")
                .bind(serde_json::Value::Object(cf).to_string())
                .bind(&now)
                .bind(&id)
                .execute(&self.pool)
                .await
                .map_err(db_err)?;
            changed += 1;
        }
        Ok(changed)
    }

    /// 清掉所有 todos 上某选项的值（镜像 TS dbClearOptionFromTodos）：单选值==optId 删 key；
    /// 多选数组 filter 掉该 optId，空了删 key。返回被改的任务数。
    async fn clear_option_from_todos(
        &self,
        field_id: &str,
        option_id: &str,
    ) -> Result<usize, McpError> {
        let rows = sqlx::query("SELECT id, custom_fields FROM todos WHERE custom_fields LIKE ?1")
            .bind(format!("%{option_id}%"))
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        let now = now_iso();
        let mut changed = 0usize;
        for r in &rows {
            let raw = r.get::<String, _>("custom_fields");
            let Ok(mut cf) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw)
            else {
                continue;
            };
            let Some(val) = cf.get(field_id).cloned() else {
                continue;
            };
            let mut dirty = false;
            match val {
                serde_json::Value::String(s) if s == option_id => {
                    cf.remove(field_id);
                    dirty = true;
                }
                serde_json::Value::Array(arr) => {
                    let filtered: Vec<serde_json::Value> = arr
                        .into_iter()
                        .filter(|v| v.as_str() != Some(option_id))
                        .collect();
                    if filtered.is_empty() {
                        cf.remove(field_id);
                    } else {
                        cf.insert(field_id.to_string(), serde_json::Value::Array(filtered));
                    }
                    dirty = true;
                }
                _ => {}
            }
            if !dirty {
                continue;
            }
            let id = r.get::<String, _>("id");
            sqlx::query("UPDATE todos SET custom_fields = ?1, updated_at = ?2 WHERE id = ?3")
                .bind(serde_json::Value::Object(cf).to_string())
                .bind(&now)
                .bind(&id)
                .execute(&self.pool)
                .await
                .map_err(db_err)?;
            changed += 1;
        }
        Ok(changed)
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

    /// field_definitions + 最小 todos（含 custom_fields 列）的建表 DDL，镜像 src/lib/db.ts。
    /// todos 只建自定义字段工具会读写的列（id/title/custom_fields/created_at/updated_at），
    /// create_todo 的 INSERT 还会写其它列，故一并补齐为可空或带默认值，使单测能跑通 INSERT。
    const FIELDS_DDL: &str = "
        CREATE TABLE field_definitions (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL,
          options     TEXT NOT NULL DEFAULT '[]',
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );
        CREATE TABLE todos (
          id                TEXT PRIMARY KEY,
          title             TEXT NOT NULL,
          reason            TEXT,
          deadline          TEXT,
          priority          TEXT NOT NULL DEFAULT 'none',
          tags              TEXT NOT NULL DEFAULT '[]',
          est_time          TEXT,
          status            TEXT NOT NULL DEFAULT 'todo',
          scheduled_time    TEXT,
          scheduled_date    TEXT,
          is_pushback       INTEGER NOT NULL DEFAULT 0,
          is_procrastinated INTEGER NOT NULL DEFAULT 0,
          custom_fields     TEXT NOT NULL DEFAULT '{}',
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
    ";

    /// 内存库 + 建 memory_facts / field_definitions / todos 表。max_connections=1：
    /// sqlite `:memory:` 每连接一个库，多连接会各看各的，限 1 连接保证整池共享同一个内存库。
    async fn test_mcp() -> DaybreakMcp {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        let ddl = format!("{MEMORY_DDL}{FIELDS_DDL}");
        for stmt in ddl.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            sqlx::query(stmt).execute(&pool).await.unwrap();
        }
        // 测试用空 notify（不接 Tauri）。
        let notify: Notifier = Arc::new(|_domain: &str| {});
        DaybreakMcp::new(pool, notify)
    }

    /// 直接查 field_definitions 单行（按 id）。
    async fn fetch_field(pool: &SqlitePool, id: &str) -> Option<sqlx::sqlite::SqliteRow> {
        sqlx::query("SELECT * FROM field_definitions WHERE id = ?1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .unwrap()
    }

    /// 取某 todo 的 custom_fields（解析成 JSON）。
    async fn fetch_todo_custom_fields(pool: &SqlitePool, id: &str) -> serde_json::Value {
        let raw: String = sqlx::query_scalar("SELECT custom_fields FROM todos WHERE id = ?1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();
        serde_json::from_str(&raw).unwrap()
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

    /* ===================== 自定义字段工具测试（自定义字段二期 Task 6） ===================== */

    /// 便捷：建一个字段，返回 (field_id, 返回 JSON)。
    async fn make_field(
        mcp: &DaybreakMcp,
        name: &str,
        ftype: &str,
        options: Vec<&str>,
    ) -> (String, serde_json::Value) {
        let res = mcp
            .create_field(Parameters(CreateFieldRequest {
                name: name.into(),
                r#type: ftype.into(),
                options: Some(options.into_iter().map(|s| s.to_string()).collect()),
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        let id = j["created"]["id"].as_str().unwrap().to_string();
        (id, j)
    }

    #[tokio::test]
    async fn create_field_persists_with_options_json() {
        let mcp = test_mcp().await;
        let (id, j) = make_field(&mcp, "项目", "single_select", vec!["后端", "前端"]).await;
        assert!(id.starts_with("fld"), "字段 id 应带 fld 前缀: {id}");
        // 返回里 options 带 id/label/color
        let opts = j["created"]["options"].as_array().unwrap();
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0]["label"], "后端");
        assert_eq!(opts[0]["color"], "#ef4444"); // PRESET_COLORS[0]
        assert_eq!(opts[1]["color"], "#f97316"); // PRESET_COLORS[1]
        assert!(opts[0]["id"].as_str().unwrap().starts_with("opt"));

        // 落库：options 列是合法 JSON 数组、sort_order=0（首个字段）
        let row = fetch_field(&mcp.pool, &id).await.expect("应落库");
        assert_eq!(row.get::<String, _>("name"), "项目");
        assert_eq!(row.get::<String, _>("type"), "single_select");
        assert_eq!(row.get::<i64, _>("sort_order"), 0);
        let stored = parse_options(&row.get::<String, _>("options"));
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[1].label, "前端");
    }

    #[tokio::test]
    async fn create_field_rejects_bad_type() {
        let mcp = test_mcp().await;
        let res = mcp
            .create_field(Parameters(CreateFieldRequest {
                name: "日期字段".into(),
                r#type: "date".into(),
                options: None,
            }))
            .await
            .unwrap();
        assert_eq!(
            result_json(&res)["error"],
            "暂不支持的字段类型，仅支持 single_select / multi_select"
        );
        // 没落库
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM field_definitions")
            .fetch_one(&mcp.pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn create_field_dedups_and_sort_order_increments() {
        let mcp = test_mcp().await;
        // 同一次输入里 "后端" 和 " 后 端 "（去空白后归一化相同）应只留一个
        let (id1, j1) = make_field(&mcp, "字段1", "multi_select", vec!["后端", " 后 端 "]).await;
        assert_eq!(j1["created"]["options"].as_array().unwrap().len(), 1);
        let (id2, _) = make_field(&mcp, "字段2", "single_select", vec![]).await;
        assert_ne!(id1, id2);
        // 第二个字段 sort_order = MAX+1 = 1
        let row2 = fetch_field(&mcp.pool, &id2).await.unwrap();
        assert_eq!(row2.get::<i64, _>("sort_order"), 1);
    }

    #[tokio::test]
    async fn list_fields_returns_all_ordered() {
        let mcp = test_mcp().await;
        make_field(&mcp, "A", "single_select", vec!["x"]).await;
        make_field(&mcp, "B", "multi_select", vec![]).await;
        let res = mcp
            .list_fields(Parameters(ListFieldsRequest {}))
            .await
            .unwrap();
        let j = result_json(&res);
        assert_eq!(j["count"], 2);
        // 按 sort_order：A 在前
        assert_eq!(j["fields"][0]["name"], "A");
        assert_eq!(j["fields"][1]["name"], "B");
        assert_eq!(j["fields"][0]["options"][0]["label"], "x");
    }

    #[tokio::test]
    async fn update_field_renames_and_appends_options() {
        let mcp = test_mcp().await;
        let (id, _) = make_field(&mcp, "旧名", "multi_select", vec!["a"]).await;
        let res = mcp
            .update_field(Parameters(UpdateFieldRequest {
                id: id.clone(),
                name: Some("新名".into()),
                // "a" 已存在（归一化重复）应跳过；新增 "b"/"c"
                add_options: Some(vec!["A".into(), "b".into(), "c".into()]),
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        assert_eq!(j["updated"], true);
        assert_eq!(j["name"], "新名");
        // 只新增了 b、c（A 与已有 a 归一化冲突被跳过）
        assert_eq!(j["added_options"].as_array().unwrap().len(), 2);

        let row = fetch_field(&mcp.pool, &id).await.unwrap();
        assert_eq!(row.get::<String, _>("name"), "新名");
        let opts = parse_options(&row.get::<String, _>("options"));
        assert_eq!(opts.len(), 3);
        // 新选项颜色按追加时的现有数量取：b→index1、c→index2
        assert_eq!(opts[1].label, "b");
        assert_eq!(opts[1].color, "#f97316");
        assert_eq!(opts[2].color, "#eab308");
    }

    #[tokio::test]
    async fn update_field_missing_id_not_found() {
        let mcp = test_mcp().await;
        let res = mcp
            .update_field(Parameters(UpdateFieldRequest {
                id: "fld_nope".into(),
                name: Some("x".into()),
                add_options: None,
            }))
            .await
            .unwrap();
        assert_eq!(result_json(&res)["updated"], false);
    }

    #[tokio::test]
    async fn create_todo_resolves_custom_fields_and_autocreates_options() {
        let mcp = test_mcp().await;
        // 单选字段「项目」，已有选项「后端」
        let (fld_id, _) = make_field(&mcp, "项目", "single_select", vec!["后端"]).await;

        // 填一个已存在选项「后端」+ 一个不存在的多选字段不涉及——这里测单选已存在 + 不存在自动建。
        // 用大小写/空格变体命中已有：" 后 端 " → 命中 "后端"，不新建。
        let res = mcp
            .create_todo(Parameters(CreateTodoRequest {
                title: "任务A".into(),
                priority: None,
                deadline: None,
                scheduled_date: None,
                scheduled_time: None,
                est_time: None,
                reason: None,
                custom_fields: Some(serde_json::json!({ "项目": " 后 端 " })),
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        let todo_id = j["created"]["id"].as_str().unwrap().to_string();
        // 命中已有选项 → 不应有 created_options
        assert!(j.get("created_options").is_none(), "不该新建选项: {j}");
        let cf = fetch_todo_custom_fields(&mcp.pool, &todo_id).await;
        // custom_fields = {fld_id: optId(后端)}
        let opt_backend = {
            let row = fetch_field(&mcp.pool, &fld_id).await.unwrap();
            parse_options(&row.get::<String, _>("options"))[0].id.clone()
        };
        assert_eq!(cf[&fld_id], opt_backend);

        // 再建一个任务，填不存在的选项「前端」→ 自动新建选项并写回字段、custom_fields 指向新 optId
        let res = mcp
            .create_todo(Parameters(CreateTodoRequest {
                title: "任务B".into(),
                priority: None,
                deadline: None,
                scheduled_date: None,
                scheduled_time: None,
                est_time: None,
                reason: None,
                custom_fields: Some(serde_json::json!({ "项目": "前端" })),
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        let created = j["created_options"].as_array().expect("应自动建选项");
        assert_eq!(created.len(), 1);
        assert_eq!(created[0]["label"], "前端");
        let new_opt_id = created[0]["option_id"].as_str().unwrap().to_string();
        // 字段 options 现在有 2 个
        let row = fetch_field(&mcp.pool, &fld_id).await.unwrap();
        let opts = parse_options(&row.get::<String, _>("options"));
        assert_eq!(opts.len(), 2);
        // 新选项颜色 = index1
        assert_eq!(opts[1].color, "#f97316");
        let todo_b = j["created"]["id"].as_str().unwrap().to_string();
        let cf = fetch_todo_custom_fields(&mcp.pool, &todo_b).await;
        assert_eq!(cf[&fld_id], new_opt_id);
    }

    #[tokio::test]
    async fn create_todo_skips_unknown_field() {
        let mcp = test_mcp().await;
        let res = mcp
            .create_todo(Parameters(CreateTodoRequest {
                title: "任务".into(),
                priority: None,
                deadline: None,
                scheduled_date: None,
                scheduled_time: None,
                est_time: None,
                reason: None,
                custom_fields: Some(serde_json::json!({ "不存在的字段": "x" })),
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        let todo_id = j["created"]["id"].as_str().unwrap().to_string();
        // note 提示跳过
        assert!(j["note"].as_str().unwrap().contains("不存在的字段"));
        // custom_fields 落空 {}
        let cf = fetch_todo_custom_fields(&mcp.pool, &todo_id).await;
        assert_eq!(cf, serde_json::json!({}));
    }

    #[tokio::test]
    async fn delete_field_confirm_protocol() {
        let mcp = test_mcp().await;
        let (fld_id, _) = make_field(&mcp, "项目", "single_select", vec!["后端"]).await;
        // 建个任务并归到该字段
        mcp.create_todo(Parameters(CreateTodoRequest {
            title: "X".into(),
            priority: None,
            deadline: None,
            scheduled_date: None,
            scheduled_time: None,
            est_time: None,
            reason: None,
            custom_fields: Some(serde_json::json!({ "项目": "后端" })),
        }))
        .await
        .unwrap();

        // confirm=false（None）→ pending，不删，affected=1
        let res = mcp
            .delete_field(Parameters(DeleteFieldRequest {
                id: fld_id.clone(),
                confirm: None,
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        assert_eq!(j["pending"], true);
        assert_eq!(j["affected_todos"], 1);
        // 字段仍在
        assert!(fetch_field(&mcp.pool, &fld_id).await.is_some());

        // confirm=true → 真删 + 清理 todo
        let res = mcp
            .delete_field(Parameters(DeleteFieldRequest {
                id: fld_id.clone(),
                confirm: Some(true),
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        assert_eq!(j["deleted"], true);
        assert_eq!(j["cleared_todos"], 1);
        assert!(fetch_field(&mcp.pool, &fld_id).await.is_none());
        // todo 的 custom_fields 已清空该字段 key
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM todos WHERE custom_fields LIKE '%' || ?1 || '%'",
        )
        .bind(&fld_id)
        .fetch_one(&mcp.pool)
        .await
        .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn delete_field_option_clears_multiselect_array() {
        let mcp = test_mcp().await;
        // 多选字段，两个选项
        let (fld_id, jf) = make_field(&mcp, "标签", "multi_select", vec!["紧急", "重要"]).await;
        let opts = jf["created"]["options"].as_array().unwrap();
        let opt_urgent = opts[0]["id"].as_str().unwrap().to_string();
        let opt_important = opts[1]["id"].as_str().unwrap().to_string();

        // 任务1：两个都选；任务2：只选「紧急」
        mcp.create_todo(Parameters(CreateTodoRequest {
            title: "T1".into(),
            priority: None,
            deadline: None,
            scheduled_date: None,
            scheduled_time: None,
            est_time: None,
            reason: None,
            custom_fields: Some(serde_json::json!({ "标签": ["紧急", "重要"] })),
        }))
        .await
        .unwrap();
        let t2 = result_json(
            &mcp.create_todo(Parameters(CreateTodoRequest {
                title: "T2".into(),
                priority: None,
                deadline: None,
                scheduled_date: None,
                scheduled_time: None,
                est_time: None,
                reason: None,
                custom_fields: Some(serde_json::json!({ "标签": ["紧急"] })),
            }))
            .await
            .unwrap(),
        )["created"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        // 删「紧急」选项：confirm=false 先看影响（2 个任务引用）
        let res = mcp
            .delete_field_option(Parameters(DeleteFieldOptionRequest {
                field_id: fld_id.clone(),
                option_label: "紧急".into(),
                confirm: None,
            }))
            .await
            .unwrap();
        assert_eq!(result_json(&res)["affected_todos"], 2);

        // confirm=true：从字段移除该选项 + 清理 todos
        let res = mcp
            .delete_field_option(Parameters(DeleteFieldOptionRequest {
                field_id: fld_id.clone(),
                option_label: "紧急".into(),
                confirm: Some(true),
            }))
            .await
            .unwrap();
        let j = result_json(&res);
        assert_eq!(j["deleted"], true);
        assert_eq!(j["option_id"], opt_urgent);

        // 字段 options 只剩「重要」
        let row = fetch_field(&mcp.pool, &fld_id).await.unwrap();
        let remain = parse_options(&row.get::<String, _>("options"));
        assert_eq!(remain.len(), 1);
        assert_eq!(remain[0].id, opt_important);

        // T2 只剩「紧急」→ 数组空了 → 删 key（custom_fields 变 {}）
        let cf2 = fetch_todo_custom_fields(&mcp.pool, &t2).await;
        assert_eq!(cf2, serde_json::json!({}));

        // 整体不再有任务引用 opt_urgent
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM todos WHERE custom_fields LIKE '%' || ?1 || '%'",
        )
        .bind(&opt_urgent)
        .fetch_one(&mcp.pool)
        .await
        .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn delete_field_option_unknown_label_errors() {
        let mcp = test_mcp().await;
        let (fld_id, _) = make_field(&mcp, "标签", "multi_select", vec!["紧急"]).await;
        let res = mcp
            .delete_field_option(Parameters(DeleteFieldOptionRequest {
                field_id: fld_id,
                option_label: "不存在".into(),
                confirm: Some(true),
            }))
            .await
            .unwrap();
        assert!(result_json(&res)["error"].as_str().unwrap().contains("不存在"));
    }
}
