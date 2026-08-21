//! 阶段 0 冒烟测试：单独启动内嵌 MCP server（不开 Tauri GUI），用于命令行验证 MCP 链路。
//!
//! 运行：cargo run --example mcp_smoke
//! 然后用 curl 走 MCP 协议调 list_todos，确认能读到真实 latitude.db 数据。

use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // 默认连真实库；测试写操作时用 LATITUDE_DB 环境变量指向临时副本，避免污染真实数据。
    let db = std::env::var("LATITUDE_DB").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from("/Users/apple/Library/Application Support/com.latitude.desktop/latitude.db")
    });
    // 固定测试密钥；curl 测试时带同样的 Authorization。刷新回调用空实现。
    let token = std::env::var("LATITUDE_MCP_TOKEN").unwrap_or_else(|_| "smoke-token".to_string());
    println!("[smoke] 启动 MCP server，db = {}, token = {token}", db.display());
    let notify: latitude_lib::mcp::Notifier = Arc::new(|_| {});
    latitude_lib::mcp::start(db, token, notify).await;
}
