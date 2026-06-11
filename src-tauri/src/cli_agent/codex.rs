//! OpenAI Codex CLI adapter
//!
//! 调用：codex exec --json [resume <session-id>] "<prompt>"
//! 输出：JSONL，事件类型见下方 CodexEvent。
//!
//! MCP：Codex 的 MCP 配置在 ~/.codex/config.toml 或通过 `codex mcp add`，
//! 是用户全局/项目配置，Daybreak 不擅自改。MVP 第一版让用户自己一次性配好
//! daybreak MCP（指向本机 42800），后续若要 Daybreak 启动时临时注入，可研究
//! codex 的 --config flag。

use super::{ChatEvent, ChatRequest};
use serde::Deserialize;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::Sender;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum CodexEvent {
    #[serde(rename = "thread.started")]
    ThreadStarted {
        #[serde(default)]
        thread_id: Option<String>,
    },
    #[serde(rename = "turn.started")]
    TurnStarted,
    #[serde(rename = "turn.completed")]
    TurnCompleted,
    #[serde(rename = "turn.failed")]
    TurnFailed,
    #[serde(rename = "item.started")]
    ItemStarted { item: Item },
    #[serde(rename = "item.completed")]
    ItemCompleted { item: Item },
    #[serde(rename = "error")]
    Error,
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Item {
    #[serde(rename = "agent_message")]
    AgentMessage {
        #[serde(default)]
        text: Option<String>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        #[serde(default)]
        text: Option<String>,
    },
    #[serde(rename = "mcp_tool_call")]
    McpToolCall {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        status: Option<String>,
    },
    #[serde(other)]
    Other,
}

pub async fn run(req: ChatRequest, tx: Sender<ChatEvent>) -> Result<(), String> {
    let bin = super::resolve_cli_bin("codex")
        .unwrap_or_else(|| std::path::PathBuf::from("codex"));
    let mut cmd = Command::new(&bin);
    cmd.env("PATH", super::enhanced_path());
    cmd.arg("exec").arg("--json");

    // Codex resume 是子命令而非 flag：codex exec resume <sid> "prompt"
    if let Some(sid) = &req.session_id {
        cmd.arg("resume").arg(sid);
    }
    cmd.arg(&req.prompt);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 codex 失败（用户可能没装 Codex CLI）: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "codex stdout 不可用".to_string())?;
    let mut reader = BufReader::new(stdout).lines();

    let mut last_session_id: Option<String> = None;

    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let ev: CodexEvent = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => continue,
        };
        match ev {
            CodexEvent::ThreadStarted { thread_id } => {
                if thread_id.is_some() {
                    last_session_id = thread_id;
                }
            }
            CodexEvent::ItemStarted { item } | CodexEvent::ItemCompleted { item } => {
                match item {
                    Item::AgentMessage { text } => {
                        if let Some(t) = text {
                            let _ = tx.send(ChatEvent::Text { text: t }).await;
                        }
                    }
                    Item::Reasoning { text } => {
                        if let Some(t) = text {
                            let _ = tx.send(ChatEvent::Thinking { text: t }).await;
                        }
                    }
                    Item::McpToolCall { name, status } => {
                        let n = name.unwrap_or_default();
                        match status.as_deref() {
                            Some("completed") => {
                                let _ = tx
                                    .send(ChatEvent::ToolCallEnd { name: n, ok: true })
                                    .await;
                            }
                            Some("failed") => {
                                let _ = tx
                                    .send(ChatEvent::ToolCallEnd { name: n, ok: false })
                                    .await;
                            }
                            _ => {
                                let _ = tx.send(ChatEvent::ToolCallStart { name: n }).await;
                            }
                        }
                    }
                    Item::Other => {}
                }
            }
            CodexEvent::TurnFailed | CodexEvent::Error => {
                let _ = tx
                    .send(ChatEvent::Error {
                        message: "codex 返回失败".into(),
                    })
                    .await;
            }
            CodexEvent::TurnStarted | CodexEvent::TurnCompleted | CodexEvent::Other => {}
        }
    }

    let _ = child.wait().await;
    let _ = tx
        .send(ChatEvent::Done {
            session_id: last_session_id,
        })
        .await;
    Ok(())
}
