//! 飞书入站消费端 —— 监督 lark-cli 的事件长连接，把飞书 IM 消息接进 Latitude。
//!
//! 背景：Latitude 的飞书集成原本只有「出站」（主动拉日历 / 写日历）。要让飞书成为对话入口，
//! 需要「入站」：用户私聊 bot 的消息要能进到秘书核心。本模块负责入站：收到消息 → emit 给主窗
//! 前端的飞书桥（feishuChat.ts），由其跑秘书核心并回复（出站见 feishu/outbound.rs）。
//!
//! 为什么走 lark-cli 而不是自己写长连接：飞书长连接协议 + bot 身份认证 lark-cli 全包，
//! 旧 bot（claude-bridge）已用 `lark-cli event consume` 验证可行。Latitude 的 cli_agent
//! 本来就在 spawn 外部 CLI，这里复用同一套二进制解析 + PATH 注入逻辑。
//!
//! 两个 spawn 血泪坑（旧 bot 验证过）：
//! 1. **stdin 必须保持打开**：`event consume` 把 stdin EOF 当退出信号。这里 take 出 stdin 写端
//!    句柄后整段持有不 drop（`_child_stdin`）。app 退出时句柄随任务 drop / 进程死，stdin 关闭
//!    → lark-cli 优雅停（绝不能 kill -9，会泄漏服务端订阅；event-bus daemon 会在最后一个消费者
//!    断开 30s 后自动退出）。
//! 2. **GUI 环境不继承 PATH**：macOS GUI app 的 PATH 很短，找不到 lark-cli。复用 cli_agent 的
//!    `resolve_cli_bin`（绝对路径）+ `enhanced_path`（补全子进程 PATH）。

use serde::Serialize;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// 订阅的事件：接收消息（用户发给 bot 的单聊 / 群里 @ bot）。飞书后台已开通此事件订阅。
const EVENT_KEY: &str = "im.message.receive_v1";

/// emit 给主窗前端飞书桥的载荷（feishuChat.ts 按这些 snake_case 字段读取）。
#[derive(Serialize, Clone)]
struct IncomingPayload {
    chat_id: String,
    chat_type: String,
    sender_id: String,
    message_id: String,
    event_id: String,
    /// content：lark-cli 已渲染成人类可读文本。
    text: String,
}

/// 入站消费端总入口：随 app 启动、常驻。lark-cli 没装就只记一条日志退出（自用需先装并 auth）；
/// 进程掉线则指数退避自动重连，长连接断了也能自愈。
///
/// 注意：目前只要本机装了 lark-cli 就会启动并尝试连接（需 lark-cli 已 auth bot 身份）。
/// 「开关 / 仅在飞书已连接时启动」等精细化留待后续（需前端设置项配合）。
pub async fn run_inbound(app: AppHandle) {
    let bin = match crate::cli_agent::resolve_cli_bin("lark-cli") {
        Some(p) => p,
        None => {
            eprintln!(
                "[feishu-inbound] 未找到 lark-cli，飞书入站消费端未启动（自用需先安装 lark-cli 并完成 bot 鉴权）"
            );
            return;
        }
    };

    // 重连退避秒数：指数增长封顶 60s；稳定运行一段后重置，避免「崩溃即风暴重连」。
    let mut backoff = 2u64;
    loop {
        let started = Instant::now();
        let outcome = consume_once(&bin, &app).await;
        let lasted = started.elapsed();
        match outcome {
            Ok(()) => eprintln!(
                "[feishu-inbound] event consume 进程退出（运行 {:?}），{backoff}s 后重连…",
                lasted
            ),
            Err(e) => eprintln!(
                "[feishu-inbound] event consume 异常：{e}（运行 {:?}），{backoff}s 后重连…",
                lasted
            ),
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        // 跑满 30s 以上视为一次「正常的长连接」，重置退避；否则指数退避。
        backoff = if lasted >= Duration::from_secs(30) {
            2
        } else {
            (backoff * 2).min(60)
        };
    }
}

/// 跑一次 `lark-cli event consume`，逐行把 stdout 的 NDJSON 事件交给 handle_event，直到进程退出。
async fn consume_once(bin: &std::path::Path, app: &AppHandle) -> Result<(), String> {
    let mut cmd = Command::new(bin);
    // 坑②：注入补全过的 PATH，保证 lark-cli 内部再 spawn 子命令也找得到。
    cmd.env("PATH", crate::cli_agent::enhanced_path());
    cmd.arg("event")
        .arg("consume")
        .arg(EVENT_KEY)
        .arg("--as")
        .arg("bot");
    // stdin 用管道并持有写端（坑①）；stdout 收事件；stderr 收 lark-cli 的 ready-marker / 诊断。
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("启动 lark-cli 失败: {e}"))?;

    // 坑①：持有 stdin 写端句柄、整段不 drop —— 子进程 stdin 永不 EOF，event consume 不会自退。
    let _child_stdin = child.stdin.take();

    // lark-cli 的就绪标记和诊断打在 stderr，单独读出来并入日志（便于排查「为什么没连上」）。
    if let Some(stderr) = child.stderr.take() {
        let mut elines = BufReader::new(stderr).lines();
        tokio::spawn(async move {
            while let Ok(Some(l)) = elines.next_line().await {
                eprintln!("[feishu-inbound][lark-cli] {l}");
            }
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "lark-cli stdout 不可用".to_string())?;
    let mut reader = BufReader::new(stdout).lines();

    eprintln!("[feishu-inbound] 已启动 lark-cli event consume {EVENT_KEY}，等待飞书消息…");
    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        handle_event(&line, app);
    }

    let _ = child.wait().await;
    // 函数返回时 _child_stdin drop，关闭 stdin（此时进程已在退出）。
    Ok(())
}

/// 处理一条入站事件：打日志 + 把文本消息 emit 给主窗的前端飞书桥（feishuChat.ts）。
/// 前端在那边跑 submitAgentRound 并调 feishu_send_reply 把回复发回飞书。
fn handle_event(line: &str, app: &AppHandle) {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("[feishu-inbound] 收到非 JSON 行（原样记录）: {line}");
            return;
        }
    };
    // lark-cli 把飞书事件「处理」成扁平的顶层对象（见 `lark-cli event schema im.message.receive_v1`）:
    // chat_id / chat_type / sender_id / message_type / message_id / event_id / content 都在顶层。
    // content 对 text/post/image 等已是渲染好的人类可读文本；interactive（卡片）才是原始 JSON 串。
    let chat_id = v.get("chat_id").and_then(|x| x.as_str()).unwrap_or("");
    let chat_type = v.get("chat_type").and_then(|x| x.as_str()).unwrap_or("");
    let sender = v.get("sender_id").and_then(|x| x.as_str()).unwrap_or("");
    let msg_type = v.get("message_type").and_then(|x| x.as_str()).unwrap_or("");
    let msg_id = v.get("message_id").and_then(|x| x.as_str()).unwrap_or("");
    let event_id = v.get("event_id").and_then(|x| x.as_str()).unwrap_or("");
    let content = v.get("content").and_then(|x| x.as_str()).unwrap_or("");

    eprintln!(
        "[feishu-inbound] 收到消息 chat={chat_id} chat_type={chat_type} sender={sender} type={msg_type} id={msg_id} content={content:?}"
    );

    // 只把文本消息送进核心，避免对非文本类型（图片 / 卡片等）瞎回。
    if msg_type == "text" && !content.is_empty() && !chat_id.is_empty() {
        let payload = IncomingPayload {
            chat_id: chat_id.to_string(),
            chat_type: chat_type.to_string(),
            sender_id: sender.to_string(),
            message_id: msg_id.to_string(),
            event_id: event_id.to_string(),
            text: content.to_string(),
        };
        // emit 给前端飞书桥（只主窗挂了监听）。用广播 emit，沿用 latitude://data-changed 同款模式。
        if let Err(e) = app.emit("feishu://incoming", payload) {
            eprintln!("[feishu-inbound] emit 给前端失败: {e}");
        }
    }
}
