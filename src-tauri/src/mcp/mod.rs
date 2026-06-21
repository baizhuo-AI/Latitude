//! 内嵌 MCP server 模块。
//!
//! 在 Tauri 进程内启动一个 streamable-http MCP server，让 Claude Code 等 MCP 客户端
//! 访问 Daybreak 的本地数据。与前端共享同一个 daybreak.db（各自独立连接，WAL 下并发安全）。
//!
//! - server.rs：server 启动、鉴权中间件、15 个工具（含记忆 remember/update_memory/forget）
//! - connect.rs：接入密钥（token）管理 + 给前端读接入信息的 Tauri command
//! - db.rs：sqlx 连接 + WAL
//!
//! 注意：connect 设为 pub mod，是因为 #[tauri::command] 生成的隐藏辅助项不随 pub use 重导出，
//! generate_handler! 必须用 mcp::connect::mcp_connection_info 这样的定义模块完整路径。

pub mod connect;
mod db;
mod server;

/// MCP server 监听端口（仅绑 127.0.0.1，不对外网开放）。
pub const MCP_PORT: u16 = 42800;

pub use connect::load_or_create_token;
pub use server::{start, Notifier};
