//! AWS Kiro CLI adapter
//!
//! 调用：kiro-cli chat --no-interactive --trust-all-tools "<prompt>"
//! 输出：**纯文本流**（Kiro CLI headless 模式不提供结构化 JSON 输出）。
//!
//! **无状态（铁律①）**：不用 `--resume-id`，每轮的完整上下文（人设 + 记忆 + 历史 +
//! 当前消息）由 app 拼进 `req.prompt`。Kiro 本就无可靠 session 输出，正好契合无状态约束。
//!
//! 限制（MVP 第一版的取舍）：
//! - 输出是纯文本，**无法精细区分思考过程 / 工具调用 / 最终答复**，全部作为 Text 流给前端
//! - **必须有 KIRO_API_KEY 环境变量**：MVP 依赖系统环境继承，后续可在 Latitude 设置里
//!   让用户填，spawn 时通过 .env() 注入
//! - MCP 配置走 Kiro IDE / CLI 共享的全局配置，需用户自己一次性配好 latitude MCP

use super::{ChatEvent, ChatRequest};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::Sender;

pub async fn run(req: ChatRequest, tx: Sender<ChatEvent>) -> Result<(), String> {
    let bin = super::resolve_cli_bin("kiro-cli")
        .unwrap_or_else(|| std::path::PathBuf::from("kiro-cli"));
    let mut cmd = Command::new(&bin);
    cmd.env("PATH", super::enhanced_path());
    cmd.arg("chat")
        .arg("--no-interactive")
        .arg("--trust-all-tools");
    cmd.arg(&req.prompt);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        format!("启动 kiro-cli 失败（用户可能没装 Kiro CLI，或没设 KIRO_API_KEY）: {e}")
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "kiro-cli stdout 不可用".to_string())?;
    let mut reader = BufReader::new(stdout).lines();

    // 纯文本流：按行读，每行作为 Text 事件推给前端（保留换行符以保持格式）
    while let Ok(Some(line)) = reader.next_line().await {
        let _ = tx
            .send(ChatEvent::Text {
                text: format!("{line}\n"),
            })
            .await;
    }

    let _ = child.wait().await;
    let _ = tx.send(ChatEvent::Done).await;
    Ok(())
}
