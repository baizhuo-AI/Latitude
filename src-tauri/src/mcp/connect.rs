//! 接入密钥（token）管理 + 给前端读接入信息的 Tauri command。
//!
//! 密钥持久化在 app config 目录的 mcp_token.txt：首次生成后固定，重启 / 升级都不变，
//! 这样用户「配一次永久有效」。token 同时用于：① server 端鉴权校验 ② 前端拼接入命令。

use serde::Serialize;
use std::path::Path;
use uuid::Uuid;

/// 读取已有 token；不存在则生成一个并落盘。失败时返回内存里的新 token（不影响功能，仅丢失持久化）。
pub fn load_or_create_token(config_dir: &Path) -> String {
    let token_file = config_dir.join("mcp_token.txt");
    if let Ok(existing) = std::fs::read_to_string(&token_file) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let token = Uuid::new_v4().simple().to_string();
    let _ = std::fs::create_dir_all(config_dir);
    let _ = std::fs::write(&token_file, &token);
    token
}

/// 返回给前端接入页显示的连接信息。
#[derive(Serialize)]
pub struct ConnectionInfo {
    /// 监听端口
    pub port: u16,
    /// 接入密钥
    pub token: String,
    /// 现成的 claude mcp add 命令（含密钥），前端一键复制
    pub command: String,
}

/// Tauri command：前端「接入 AI 助手」页面调用，拿到端口 / 密钥 / 现成命令。
#[tauri::command]
pub fn mcp_connection_info(app: tauri::AppHandle) -> Result<ConnectionInfo, String> {
    use tauri::Manager;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?;
    let token = load_or_create_token(&config_dir);
    let port = crate::mcp::MCP_PORT;
    let command = format!(
        "claude mcp add --transport http latitude http://127.0.0.1:{port}/mcp \
         --header \"Authorization: Bearer {token}\""
    );
    Ok(ConnectionInfo {
        port,
        token,
        command,
    })
}
