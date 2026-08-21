//! OpenAI Codex CLI adapter
//!
//! 调用：codex exec --json [-c mcp_servers.latitude.url=...] [-c mcp_servers.latitude.http_headers=...] "<prompt>"
//! 输出：JSONL，事件类型见下方 CodexEvent。
//!
//! **无状态（铁律①）**：不用 `codex exec resume <sid>`，不持有/回传 session。每轮的完整
//! 上下文（人设 + 记忆 + 历史 + 当前消息）由 app 拼进 `req.prompt`。thread_id 不解析、不存。
//!
//! **MCP 注入（Task 4.4）**：Codex 的 MCP 配置落在 `~/.codex/config.toml` 的
//! `[mcp_servers.<name>]` 表（TOML，注意是下划线 `mcp_servers`，不是 claude 的 JSON
//! `mcpServers`）。Codex 提供 `codex exec -c <dotted.key>=<TOML值>` 可在**调用时**用点路径
//! 覆盖配置，且会与用户既有 config.toml 合并。我们据此程序化注入 latitude MCP，**不写文件、
//! 不改用户的 ~/.codex/config.toml**：
//!   `-c mcp_servers.latitude.url="<url>"`
//!   `-c mcp_servers.latitude.http_headers={Authorization="Bearer <token>"}`
//! 这与 claude.rs 的 `write_mcp_config` + `--mcp-config` 思路对齐（streamable-http + Bearer
//! 鉴权），但更干净:无临时文件、无清理、不污染用户全局配置。token 是 UUID 十六进制
//! (`[0-9a-f]{32}`)，无 TOML 特殊字符，内联进 TOML 字符串安全。
//! 拿不到 MCP 接入信息（req 不带 url/token）时降级为纯聊天，不注入、不报错。

use super::{ChatEvent, ChatRequest};
use serde::Deserialize;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::Sender;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum CodexEvent {
    /// 线程开始（含 thread_id；无状态适配器不解析，仅占位以正确分流）
    #[serde(rename = "thread.started")]
    ThreadStarted,
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

/// 据 MCP 接入信息构造 codex 的 `-c` 注入参数对（每对两项：`-c` 与其值）。
///
/// 返回需要追加到命令行的字符串序列；调用方逐个 `cmd.arg(..)`。两条键：
///   - `mcp_servers.latitude.url="<url>"`
///   - `mcp_servers.latitude.http_headers={Authorization="Bearer <token>"}`
///
/// 拿不到 url/token 时返回空 Vec（不注入，降级纯聊天）。抽成纯函数便于单测（headless 下
/// 没法真起 codex，这里只验参数构造正确）。
///
/// 安全：token 是 UUID 十六进制（`load_or_create_token` 用 `Uuid::new_v4().simple()`），
/// 无引号/反斜杠等 TOML 特殊字符，内联进 TOML 字符串安全，不需转义。
fn build_mcp_config_args(mcp_url: &Option<String>, mcp_token: &Option<String>) -> Vec<String> {
    match (mcp_url, mcp_token) {
        (Some(url), Some(token)) => vec![
            "-c".to_string(),
            format!("mcp_servers.latitude.url=\"{url}\""),
            "-c".to_string(),
            format!("mcp_servers.latitude.http_headers={{Authorization=\"Bearer {token}\"}}"),
        ],
        _ => Vec::new(),
    }
}

pub async fn run(req: ChatRequest, tx: Sender<ChatEvent>) -> Result<(), String> {
    let bin = super::resolve_cli_bin("codex")
        .unwrap_or_else(|| std::path::PathBuf::from("codex"));
    let mut cmd = Command::new(&bin);
    cmd.env("PATH", super::enhanced_path());
    cmd.arg("exec").arg("--json");
    // MCP 注入：在 prompt 之前追加 -c 覆盖项（codex 把 -c 解析为 exec 的选项；
    // 实测 `codex exec --json -c <kv> -c <kv> <prompt>` 顺序可正常解析、与用户配置合并）。
    for a in build_mcp_config_args(&req.mcp_url, &req.mcp_token) {
        cmd.arg(a);
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

    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let ev: CodexEvent = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => continue,
        };
        match ev {
            CodexEvent::ThreadStarted => {
                // 无状态：不解析 thread_id（铁律①）
            }
            // ItemStarted 只标记「工具调用开始」。**不**在这里发 AgentMessage / Reasoning 文字：
            // codex 对同一条 message item 会在 item.started 和 item.completed 各发一次，
            // 文字内容以 item.completed 为准；若两处都发会导致回答/思考翻倍（修双发，Task 4.4）。
            CodexEvent::ItemStarted { item } => {
                if let Item::McpToolCall { name, .. } = item {
                    let n = name.unwrap_or_default();
                    let _ = tx.send(ChatEvent::ToolCallStart { name: n }).await;
                }
                // AgentMessage / Reasoning / Other 在 started 阶段忽略，文字只在 completed 发。
            }
            // ItemCompleted 才发最终文字（AgentMessage→Text、Reasoning→Thinking），
            // 工具调用在这里发 ToolCallEnd（据 status 判定成功/失败）。
            CodexEvent::ItemCompleted { item } => match item {
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
                    // 完成阶段：failed → ok=false，其余(completed/缺省)→ ok=true。
                    let ok = !matches!(status.as_deref(), Some("failed"));
                    let _ = tx.send(ChatEvent::ToolCallEnd { name: n, ok }).await;
                }
                Item::Other => {}
            },
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
    let _ = tx.send(ChatEvent::Done).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_args_inject_url_and_bearer_header_when_present() {
        let args = build_mcp_config_args(
            &Some("http://127.0.0.1:42800/mcp".to_string()),
            &Some("abc123def456".to_string()),
        );
        // 两对 -c：每对前是 "-c"，后是覆盖值。
        assert_eq!(
            args,
            vec![
                "-c".to_string(),
                "mcp_servers.latitude.url=\"http://127.0.0.1:42800/mcp\"".to_string(),
                "-c".to_string(),
                "mcp_servers.latitude.http_headers={Authorization=\"Bearer abc123def456\"}"
                    .to_string(),
            ]
        );
    }

    #[test]
    fn mcp_args_empty_when_url_missing() {
        // 拿不到 url（仅 token）→ 不注入，降级纯聊天。
        let args = build_mcp_config_args(&None, &Some("tok".to_string()));
        assert!(args.is_empty());
    }

    #[test]
    fn mcp_args_empty_when_token_missing() {
        // 拿不到 token（仅 url）→ 不注入。
        let args = build_mcp_config_args(&Some("http://x".to_string()), &None);
        assert!(args.is_empty());
    }

    #[test]
    fn mcp_args_empty_when_both_missing() {
        let args = build_mcp_config_args(&None, &None);
        assert!(args.is_empty());
    }

    // 双发修复（Task 4.4）的回归锚:agent_message 文字只应在 item.completed 产出。
    // run() 是 async + spawn 进程，难在单测里直跑；这里用解析层断言 item.started 的
    // agent_message 被识别为「消息项」，由 run 的 ItemStarted 分支故意忽略其文字
    // （只在 ItemCompleted 发 Text）。本测试锁住「started 的 agent_message 不携带需要
    // 立即下发的语义」这一解析事实，配合 run 的分支拆分共同保证不双发。
    #[test]
    fn item_started_agent_message_parses_but_text_emitted_only_on_completed() {
        let started: CodexEvent = serde_json::from_str(
            r#"{"type":"item.started","item":{"type":"agent_message","text":"你好"}}"#,
        )
        .expect("parse item.started");
        // 解析成 ItemStarted+AgentMessage（带 text），但 run() 的 ItemStarted 分支只处理
        // McpToolCall，不下发 AgentMessage 文字 —— 故同一条消息不会在 started/completed 双发。
        match started {
            CodexEvent::ItemStarted {
                item: Item::AgentMessage { text },
            } => assert_eq!(text.as_deref(), Some("你好")),
            _ => panic!("expected ItemStarted with AgentMessage"),
        }

        let completed: CodexEvent = serde_json::from_str(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"你好"}}"#,
        )
        .expect("parse item.completed");
        match completed {
            CodexEvent::ItemCompleted {
                item: Item::AgentMessage { text },
            } => assert_eq!(text.as_deref(), Some("你好")),
            _ => panic!("expected ItemCompleted with AgentMessage"),
        }
    }
}
