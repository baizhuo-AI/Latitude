//! CLI Agent 后端 —— 让内置对话能 spawn 本地 AI CLI（Claude Code / OpenAI Codex / AWS Kiro），
//! 走用户自己的订阅或 API key 认证。工具能力通过让 CLI 连本机 MCP server（端口 42800）复用，
//! 无需重复实现 agent loop。
//!
//! 模块结构：
//! - claude.rs / codex.rs / kiro.rs：三家 adapter，各自 spawn 命令、解析输出、维护 session
//! - 本文件：统一的 ChatEvent / ChatRequest 类型 + 两个 Tauri command（send / detect）
//!
//! 每个 adapter 把自家的输出（claude 的 stream-json、codex 的 JSONL、kiro 的纯文本）
//! 解析成统一的 ChatEvent，前端只认一种事件格式。Kiro 因无 JSON 输出，所有内容统一作为 Text。

pub mod claude;
pub mod codex;
pub mod kiro;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// 三家 adapter 把各自的流式输出解析成这个统一事件，推给前端渲染。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    /// 思考过程 token（Claude 的 reasoning / Codex 的 reasoning；Kiro 无）
    Thinking { text: String },
    /// 最终回答的 token
    Text { text: String },
    /// 工具调用开始（前端可显示 "⚙️ 调用 list_todos"）
    ToolCallStart { name: String },
    /// 工具调用结束
    ToolCallEnd { name: String, ok: bool },
    /// 整轮结束。session_id 给前端存起来，下次发送时回传以接续上下文。
    Done { session_id: Option<String> },
    /// 出错（CLI 没装、登录失效、解析失败等）
    Error { message: String },
}

/// 一次对话请求（前端 chatStore 发起，Tauri command 转给 adapter）
#[derive(Debug, Clone, Deserialize)]
pub struct ChatRequest {
    /// 用户当前消息
    pub prompt: String,
    /// 接续会话的 id；首次为空，Done 事件返回 id 后前端持有，下次回传
    #[serde(default)]
    pub session_id: Option<String>,
    /// 本机 MCP server 的 URL + token；adapter 启动时生成 mcp config 让 CLI 连进来，
    /// 这样 CLI 可调你已有的 16 个工具管待办（claude/codex/kiro 都支持 MCP）
    #[serde(default)]
    pub mcp_url: Option<String>,
    #[serde(default)]
    pub mcp_token: Option<String>,
}

/// 哪家 CLI（前端在设置里选；也作为路由分发依据）
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliKind {
    Claude,
    Codex,
    Kiro,
}

impl CliKind {
    /// 各家在 PATH 里的可执行文件名（注意 Kiro 是 `kiro-cli` 不是 `kiro`）
    fn bin(&self) -> &'static str {
        match self {
            CliKind::Claude => "claude",
            CliKind::Codex => "codex",
            CliKind::Kiro => "kiro-cli",
        }
    }
}

/// 扩展 PATH 字符串：macOS GUI app 启动时只读 /etc/paths 那套很短的默认 PATH，
/// 不读用户 .zshrc / .bashrc 里加的 npm global / nvm / cargo / ~/.local/bin 等。
/// 把常见 CLI 安装位置补回来，作为子进程的 PATH，避免 CLI 内部再 spawn 其它命令也撞同坑。
pub fn enhanced_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let extras = [
        format!("{home}/.local/bin"),
        format!("{home}/.npm-global/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.fnm/aliases/default/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    let current = std::env::var("PATH").unwrap_or_default();
    if current.is_empty() {
        extras.join(":")
    } else {
        format!("{}:{}", extras.join(":"), current)
    }
}

/// 在扩展的目录里查找指定二进制，返回绝对路径。
///
/// 为什么不直接 `Command::new("claude")`：Rust 的 Command 用**父进程**的 PATH 查找，
/// macOS GUI app 父 PATH 不含 ~/.local/bin 等，找不到。这里手动遍历扩展目录拿到绝对路径。
pub fn resolve_cli_bin(name: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [
        format!("{home}/.local/bin"),
        format!("{home}/.npm-global/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.fnm/aliases/default/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    for d in &dirs {
        let p = std::path::PathBuf::from(d).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    // 再用系统 PATH 兜底（万一用户装到非标准位置）
    if let Ok(path) = std::env::var("PATH") {
        for d in path.split(':') {
            let p = std::path::PathBuf::from(d).join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// 检测某家 CLI 是否能找到。不 spawn `which`（父进程 PATH 缺路径会假阴性），
/// 直接在扩展过的目录里查文件。
pub async fn detect(kind: CliKind) -> bool {
    resolve_cli_bin(kind.bin()).is_some()
}

/// 前端调：spawn 一个 CLI agent 跑一轮对话。
/// 事件流通过 Tauri event "cli-agent-event" 实时推给前端，前端 chatStore 监听后渲染气泡。
/// 一轮结束（Done 事件）后命令返回。
#[tauri::command]
pub async fn cli_agent_send(
    app: AppHandle,
    kind: CliKind,
    req: ChatRequest,
) -> Result<(), String> {
    let (tx, mut rx) = mpsc::channel::<ChatEvent>(64);
    let app_clone = app.clone();
    // 后台任务：把 channel 里的事件 emit 给前端
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = app_clone.emit("cli-agent-event", &ev);
        }
    });
    match kind {
        CliKind::Claude => claude::run(req, tx).await,
        CliKind::Codex => codex::run(req, tx).await,
        CliKind::Kiro => kiro::run(req, tx).await,
    }
}

/// 前端调：检测某家 CLI 装没装。
#[tauri::command]
pub async fn cli_agent_detect(kind: CliKind) -> bool {
    detect(kind).await
}
