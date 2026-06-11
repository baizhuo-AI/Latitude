//! Claude Code CLI adapter
//!
//! 调用：claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages
//!       [--resume <session-id>] [--mcp-config <path>]
//!
//! 用户已经 `claude login` 后，spawn 跑就走他的订阅额度，无需 API key。
//! 输出是 NDJSON：每行一个 JSON 事件（assistant message delta、tool_use、thinking、result 等）。
//! 我们解析成统一 ChatEvent，推给前端。

use super::{ChatEvent, ChatRequest};
use serde::Deserialize;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::Sender;

/// claude stream-json 输出的最小解析模型（只挑我们关心的字段）
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClaudeEvent {
    /// 系统消息：包含 session_id 等元信息
    #[serde(rename = "system")]
    System {
        session_id: Option<String>,
        #[serde(default)]
        subtype: Option<String>,
    },
    /// assistant 消息（含 content 数组：text、thinking、tool_use 等子项）
    #[serde(rename = "assistant")]
    Assistant { message: AssistantMessage },
    /// tool 结果回传（claude 自己执行 MCP 工具后回传给自己；我们只用来标记结束）
    #[serde(rename = "user")]
    User { message: serde_json::Value },
    /// 最终结果（一轮结束）
    #[serde(rename = "result")]
    Result {
        session_id: Option<String>,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        result: Option<String>,
    },
    /// 兜底：未知事件类型，忽略
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct AssistantMessage {
    #[serde(default)]
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "tool_use")]
    ToolUse { name: String },
    #[serde(rename = "tool_result")]
    ToolResult {
        #[serde(default)]
        is_error: Option<bool>,
    },
    #[serde(other)]
    Other,
}

/// 跑一次 Claude Code，事件实时推到 tx。
///
/// MCP：调用前会写一个临时 mcp config 文件指向 Daybreak 自己的 MCP server，
/// 这样 claude 启动会连进来、能调你已有的 16 个工具。
pub async fn run(req: ChatRequest, tx: Sender<ChatEvent>) -> Result<(), String> {
    // 1. 准备 MCP config（如果传了 mcp 信息）
    let mcp_config_path = if let (Some(url), Some(token)) = (&req.mcp_url, &req.mcp_token) {
        Some(write_mcp_config(url, token).map_err(|e| format!("写 mcp config 失败: {e}"))?)
    } else {
        None
    };

    // 2. 组装命令
    let bin = super::resolve_cli_bin("claude")
        .unwrap_or_else(|| std::path::PathBuf::from("claude"));
    let mut cmd = Command::new(&bin);
    cmd.env("PATH", super::enhanced_path());
    cmd.arg("-p")
        .arg(&req.prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages");

    if let Some(sid) = &req.session_id {
        cmd.arg("--resume").arg(sid);
    }
    if let Some(path) = &mcp_config_path {
        cmd.arg("--mcp-config").arg(path);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 claude 失败（用户可能没装 Claude Code）: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude stdout 不可用".to_string())?;
    let mut reader = BufReader::new(stdout).lines();

    let mut last_session_id: Option<String> = None;

    // 3. 逐行解析 NDJSON
    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let ev: ClaudeEvent = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => continue, // 解析不了的行跳过（兼容未来格式变化）
        };
        match ev {
            ClaudeEvent::System { session_id, .. } => {
                if session_id.is_some() {
                    last_session_id = session_id;
                }
            }
            ClaudeEvent::Assistant { message } => {
                for block in message.content {
                    match block {
                        ContentBlock::Text { text } => {
                            let _ = tx.send(ChatEvent::Text { text }).await;
                        }
                        ContentBlock::Thinking { thinking } => {
                            let _ = tx.send(ChatEvent::Thinking { text: thinking }).await;
                        }
                        ContentBlock::ToolUse { name } => {
                            let _ = tx.send(ChatEvent::ToolCallStart { name }).await;
                        }
                        ContentBlock::ToolResult { .. } | ContentBlock::Other => {}
                    }
                }
            }
            ClaudeEvent::User { .. } => {
                // 工具结果回传给 claude 自己；我们补一个 ToolCallEnd（简化：不区分单个工具）
                // 更精细的对应可后续优化（记录 tool_use_id → name 映射）
            }
            ClaudeEvent::Result {
                session_id,
                is_error,
                ..
            } => {
                if session_id.is_some() {
                    last_session_id = session_id;
                }
                if is_error {
                    let _ = tx
                        .send(ChatEvent::Error {
                            message: "claude 返回 is_error".into(),
                        })
                        .await;
                }
            }
            ClaudeEvent::Other => {}
        }
    }

    // 4. 等进程退出，清理临时 mcp config
    let _ = child.wait().await;
    if let Some(path) = mcp_config_path {
        let _ = std::fs::remove_file(&path);
    }

    let _ = tx
        .send(ChatEvent::Done {
            session_id: last_session_id,
        })
        .await;
    Ok(())
}

/// 写一个临时 mcp config 文件，让 claude 启动时连本机 MCP server。
/// 用 streamable-http transport：和 Daybreak MCP server 一致。
fn write_mcp_config(url: &str, token: &str) -> std::io::Result<std::path::PathBuf> {
    let cfg = serde_json::json!({
        "mcpServers": {
            "daybreak": {
                "type": "http",
                "url": url,
                "headers": {
                    "Authorization": format!("Bearer {token}")
                }
            }
        }
    });
    let mut path = std::env::temp_dir();
    path.push(format!("daybreak-mcp-{}.json", std::process::id()));
    std::fs::write(&path, serde_json::to_string_pretty(&cfg)?)?;
    Ok(path)
}
