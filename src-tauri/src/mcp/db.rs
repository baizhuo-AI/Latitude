//! MCP server 的数据库连接。
//!
//! 独立于 tauri-plugin-sql，自己开一个 sqlx 连接池连同一个 latitude.db 文件。
//! WAL 模式 + busy_timeout：保证与前端并发读写时不会互相阻塞 / 报 BUSY。

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::time::Duration;

/// 连接 latitude.db。
/// create_if_missing(false)：数据库由主应用负责创建/建表，MCP 只读写既有库，绝不自己建空库。
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
