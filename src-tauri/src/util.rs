//! 跨模块共享的小工具：id 生成 + ISO 时间戳。
//!
//! 这两个 fn 原本是 mcp/server.rs 的私有 helper，feishu 仓储层也要按同样格式造主键和
//! 时间戳（与前端 newTodoId / new Date().toISOString() 风格保持一致），提到这里共用，
//! 避免两处各写一份漂移。

use chrono::Utc;
use uuid::Uuid;

/// ISO 时间戳，与前端 `new Date().toISOString()` 对齐（带毫秒 + Z）。
pub fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// 生成主键，格式 `<prefix><毫秒>_<4位随机>`，与前端 newTodoId 风格一致。
pub fn gen_id(prefix: &str) -> String {
    let u = Uuid::new_v4().simple().to_string();
    format!("{}{}_{}", prefix, Utc::now().timestamp_millis(), &u[..4])
}
