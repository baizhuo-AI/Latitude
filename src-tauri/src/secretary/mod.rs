//! AI 秘书的原生后台能力（Rust 侧）。
//!
//! 目前只下沉了**活动记录（activity_capture）**这一档：把原本挂在主窗渲染进程 `setInterval`
//! 上的心跳，搬到 Tauri 进程内的常驻 tokio 任务，绕开 macOS「隐藏窗口冻结 JS 定时器」导致的
//! 「藏窗即停」。其余主动消息（晨报 / 会议将至 / ddl / 任务搁置 / 刚完成）仍在前端 TS 调度器。
//!
//! 子模块：
//!  - [`config`]：前端 → Rust 的「主动配置」桥（托管 state + `set_proactive_config` 命令）。
//!  - [`engine`]：常驻调度引擎（照搬 `feishu::engine` 的 `tokio::time::interval` 范式 + 投递）。

pub mod config;
pub mod engine;
