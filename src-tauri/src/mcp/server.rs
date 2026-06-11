//! MCP server 启动逻辑 + 鉴权 + 工具定义。
//!
//! 工具集中在一个 `#[tool_router]` impl 块里注册（rmcp 机制这样最稳）。
//! 覆盖 3 个数据域：todos / goals / activity_log。
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
                "Daybreak 本地 MCP：管理你的任务、目标、时间日志".to_string(),
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
