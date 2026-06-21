//! 主动配置桥（前端 → Rust）。
//!
//! 「主动消息」的开关 / 间隔 / 工作时段 / 提醒方式都只存在前端 localStorage（见
//! `src/lib/settings.ts`），Rust 后台引擎读不到。这里定义一个可被 Tauri `manage()` 托管的
//! 运行时配置 [`ProactiveRuntimeConfig`]，前端在启动 + 每次改设置时通过 [`set_proactive_config`]
//! 命令把当前值推过来；引擎每 tick 直读这份 state 决定「此刻该不该触发活动记录」。
//!
//! 设计要点：
//!  - 字段语义对齐前端 `src/lib/secretary/triggers.ts` 的 `ActivityCaptureRunConfig` +
//!    `proactive.mode != "off"` 的总开关。
//!  - serde rename 接 camelCase JSON：前端 `invoke("set_proactive_config", { config: {...} })`
//!    传的是驼峰键（enabled / masterOn / intervalMin ...），Rust 侧用 snake_case 字段 +
//!    `#[serde(rename_all = "camelCase")]` 自动映射。
//!  - state 形态 `Mutex<Option<ProactiveRuntimeConfig>>`：None = 前端还没推过（引擎跳过，
//!    不臆测默认值，避免「没开主动却被后台触发」）。

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 后台引擎要用的「主动配置」运行时快照。
///
/// 由前端推送（`set_proactive_config`），引擎只读。字段口径见上方模块注释。
///
/// 注意 `#[serde(rename_all = "camelCase")]`：反序列化时接受前端的驼峰键
/// （`masterOn` / `intervalMin` / `workStart` / `workEnd` / `pausedUntil`），不要改 Rust 字段名
/// 去硬凑——靠 serde 做大小写映射，前后端各保持各自的命名习惯。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProactiveRuntimeConfig {
    /// 活动记录总开关（= 前端 `proactive.activityCapture.enabled`）。
    pub enabled: bool,
    /// 主动姿态总闸（= 前端 `proactive.mode != "off"`）。off 时整个后台引擎不触发。
    pub master_on: bool,
    /// 记录间隔（分钟）。距上次触发 >= `interval_min * 60_000` ms 才再触发。
    pub interval_min: i64,
    /// 工作时段起始小时（0-23），闭区间起点。
    pub work_start: u32,
    /// 工作时段结束小时（0-23），开区间终点 [work_start, work_end)。
    pub work_end: u32,
    /// 「别烦我」截止（epoch ms）。Some 且 now <= 此值 → 暂停触发。None = 未暂停。
    pub paused_until: Option<i64>,
    /// 提醒方式（chat | notification | float | all）。仅 notification/all 发系统横幅。
    pub channel: String,
    /// 语言（"zh" | "en"），决定固定模板文案。
    pub lang: String,
}

/// 被 Tauri `manage()` 托管的主动配置 state。
///
/// `Mutex<Option<_>>`：启动时为 None（前端还没推），前端推一次后变 Some。用 `Mutex` 而非
/// `RwLock` 是因为读写都极低频（每 60s 读一次 / 用户改设置时写一次），简单够用。
#[derive(Default)]
pub struct ProactiveConfigState(pub Mutex<Option<ProactiveRuntimeConfig>>);

/// 前端推送主动配置：写入托管 state，供后台引擎下一 tick 读取。
///
/// 调用时机（前端负责）：① 主窗启动 useEffect 推一次初始值；② 用户在设置里改「记录间隔 /
/// 工作时段 / 主动姿态 / 提醒方式 / 别烦我」后，在 `settings.ts` 的 persist 处再推一次。
/// 漏推会让引擎用旧配置，所以收口在 persist 一处最稳（见计划风险点 5）。
///
/// 锁中毒（前一个持锁线程 panic）时返回 Err 字符串而非再 panic——命令失败可被前端感知，
/// 但不拖垮进程。
#[tauri::command]
pub fn set_proactive_config(
    state: tauri::State<'_, ProactiveConfigState>,
    config: ProactiveRuntimeConfig,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(config);
    Ok(())
}
