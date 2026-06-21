//! 飞书出站发消息 —— 用 lark-cli 以 bot 身份把消息发回飞书 IM。
//!
//! 用 lark-cli 的高层命令 `im +messages-send`（自动构造 body），而非 raw `api POST`，
//! 少一层手搓 content JSON 的出错面。复用 cli_agent 的二进制解析 + PATH 注入（同 inbound 的坑②）。

use std::process::Stdio;
use tokio::process::Command;

/// 以 bot 身份往指定会话发一条纯文本消息。
///
/// - `chat_id`：oc_ 前缀的会话 ID（入站事件里直接带）。
/// - `idempotency_key`：可选幂等键（如入站 event_id），防同一事件重投导致重复发送。
pub async fn send_text(
    chat_id: &str,
    text: &str,
    idempotency_key: Option<&str>,
) -> Result<(), String> {
    let bin = crate::cli_agent::resolve_cli_bin("lark-cli")
        .ok_or_else(|| "未找到 lark-cli".to_string())?;
    let mut cmd = Command::new(&bin);
    // 坑②：注入补全过的 PATH（GUI 启动的父进程 PATH 太短）。
    cmd.env("PATH", crate::cli_agent::enhanced_path());
    cmd.arg("im")
        .arg("+messages-send")
        .arg("--as")
        .arg("bot")
        .arg("--chat-id")
        .arg(chat_id)
        .arg("--text")
        .arg(text);
    if let Some(key) = idempotency_key {
        cmd.arg("--idempotency-key").arg(key);
    }
    // 一次性命令：不需要 stdin；output() 等其跑完并收集 stdout/stderr。
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("启动 lark-cli 发消息失败: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "lark-cli 发消息失败（退出码 {:?}）: {}",
            output.status.code(),
            stderr.trim()
        ))
    }
}

/// 前端（主窗的飞书桥 feishuChat.ts）调：把秘书的回复发回某个飞书会话。
/// JS 侧 `invoke("feishu_send_reply", { chatId, text })`（Tauri 把 camelCase 映射到 snake_case 形参）。
#[tauri::command]
pub async fn feishu_send_reply(chat_id: String, text: String) -> Result<(), String> {
    send_text(&chat_id, &text, None).await
}
