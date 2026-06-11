//! 飞书连接相关的 Tauri command（前端「连接飞书/Lark」设置区块调用）。
//!
//! 命名按实施计划的拆分式：set_credentials（存凭证）/ start_auth（跑 OAuth）/
//! disconnect / status。start_auth 后台 spawn 立即返回，进度靠事件 `feishu-auth-event` 推。
//!
//! 这些命令是 keychain + HTTP + 浏览器 + Tauri AppHandle 的编排胶水，**不做单测**
//! （属不可单测的外部依赖），端到端验证靠用户走一次真实授权。唯一的纯逻辑 region_status
//! 抽出来单测。

use std::path::Path;

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::feishu::keychain::Secret;
use crate::feishu::{callback, config, keychain, oauth, Region};

/// OAuth 进度事件（推给前端设置页显示）。
#[derive(Serialize, Clone)]
struct AuthEvent {
    /// waiting_browser | exchanging | success | error
    phase: String,
    region: Region,
    message: Option<String>,
}

/// 单区域连接状态（给前端设置页）。
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct RegionStatus {
    pub has_app_id: bool,
    pub has_secret: bool,
    pub connected: bool,
    pub token_expires_at: Option<i64>,
    pub last_error: Option<String>,
}

/// 整体连接状态。Phase 2 起会再聚合 sync_state（同步态）。
#[derive(Serialize)]
pub struct FeishuStatus {
    pub active_region: Option<Region>,
    pub feishu: RegionStatus,
    pub lark: RegionStatus,
}

/// 由配置 + "钥匙串里有没有 app_secret" 汇成单区域状态。纯函数，可单测。
fn region_status(cfg: &config::RegionConfig, has_secret: bool) -> RegionStatus {
    RegionStatus {
        has_app_id: cfg.app_id.is_some(),
        has_secret,
        connected: cfg.connected,
        token_expires_at: cfg.token_expires_at,
        last_error: cfg.last_error.clone(),
    }
}

fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))
}

fn emit_auth(app: &AppHandle, region: Region, phase: &str, message: Option<String>) {
    let _ = app.emit(
        "feishu-auth-event",
        AuthEvent {
            phase: phase.to_string(),
            region,
            message,
        },
    );
}

/// 存凭证：app_id 落明文 config，app_secret 落 keychain。前端 secret 只写不回显。
#[tauri::command]
pub fn feishu_set_credentials(
    app: AppHandle,
    region: Region,
    app_id: String,
    app_secret: String,
) -> Result<(), String> {
    let dir = config_dir(&app)?;
    keychain::set_secret(region, Secret::AppSecret, &app_secret)?;
    let mut cfg = config::load(&dir);
    cfg.active_region = Some(region);
    let rc = cfg.region_mut(region);
    rc.app_id = Some(app_id);
    rc.last_error = None;
    config::save(&dir, &cfg)
}

/// 断开：清空该区域 keychain 三项 + 配置复位（回到未配置态）。
#[tauri::command]
pub fn feishu_disconnect(app: AppHandle, region: Region) -> Result<(), String> {
    let dir = config_dir(&app)?;
    keychain::clear_region(region)?;
    let mut cfg = config::load(&dir);
    *cfg.region_mut(region) = config::RegionConfig::default();
    config::save(&dir, &cfg)
}

/// 连接状态（前端轮询/连接后刷新用）。
#[tauri::command]
pub fn feishu_status(app: AppHandle) -> Result<FeishuStatus, String> {
    let dir = config_dir(&app)?;
    let cfg = config::load(&dir);
    let feishu = region_status(
        cfg.region(Region::Feishu),
        keychain::get_secret(Region::Feishu, Secret::AppSecret)?.is_some(),
    );
    let lark = region_status(
        cfg.region(Region::Lark),
        keychain::get_secret(Region::Lark, Secret::AppSecret)?.is_some(),
    );
    Ok(FeishuStatus {
        active_region: cfg.active_region,
        feishu,
        lark,
    })
}

/// 发起 OAuth：后台 spawn，立即返回；进度/结果靠 `feishu-auth-event` 推。
#[tauri::command]
pub async fn feishu_start_auth(app: AppHandle, region: Region) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let cfg = config::load(&dir);
    let app_id = cfg
        .region(region)
        .app_id
        .clone()
        .ok_or_else(|| "尚未填写 app_id，请先保存凭证".to_string())?;
    let app_secret = keychain::get_secret(region, Secret::AppSecret)?
        .ok_or_else(|| "尚未填写 app_secret，请先保存凭证".to_string())?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_auth_flow(&handle, region, &app_id, &app_secret, &dir).await {
            // 失败：落 last_error 供设置页显示，并推 error 事件。
            let mut cfg = config::load(&dir);
            cfg.region_mut(region).last_error = Some(e.clone());
            let _ = config::save(&dir, &cfg);
            emit_auth(&handle, region, "error", Some(e));
        }
    });
    Ok(())
}

/// OAuth 主流程：拼授权 URL → 起本地回调监听 → 开浏览器 → 等 code → 换 token → 落库。
async fn run_auth_flow(
    app: &AppHandle,
    region: Region,
    app_id: &str,
    app_secret: &str,
    dir: &Path,
) -> Result<(), String> {
    emit_auth(app, region, "waiting_browser", None);

    let pkce = oauth::gen_pkce();
    let state = oauth::gen_state();
    let redirect_uri = callback::redirect_uri();
    let url = oauth::build_authorize_url(
        region,
        app_id,
        &redirect_uri,
        oauth::SCOPES,
        &state,
        &pkce.challenge,
    );

    // 先起监听（绑定固定端口），再开浏览器，避免回调早于监听就绪。
    let state_for_wait = state.clone();
    let listener =
        tauri::async_runtime::spawn(async move { callback::wait_for_callback(&state_for_wait).await });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    open::that(&url).map_err(|e| format!("打开系统浏览器失败：{e}"))?;

    let cb = listener
        .await
        .map_err(|e| format!("回调监听任务异常：{e}"))??;

    emit_auth(app, region, "exchanging", None);
    let client = reqwest::Client::new();
    let tokens = oauth::exchange_code(
        &client,
        region,
        app_id,
        app_secret,
        &cb.code,
        &pkce.verifier,
        &redirect_uri,
    )
    .await?;

    persist_tokens(region, &tokens, dir)?;
    emit_auth(app, region, "success", None);
    Ok(())
}

/// 落 token：两段提交近似——先写 keychain（access+refresh），全成功再写 config 标连接。
/// keychain 与 SQLite/JSON 无法真同一事务，这是缩小不一致窗口的等价做法。
fn persist_tokens(region: Region, tokens: &oauth::TokenSet, dir: &Path) -> Result<(), String> {
    keychain::set_secret(region, Secret::AccessToken, &tokens.access_token)?;
    keychain::set_secret(region, Secret::RefreshToken, &tokens.refresh_token)?;
    let mut cfg = config::load(dir);
    let rc = cfg.region_mut(region);
    rc.connected = true;
    rc.token_expires_at = Some(Utc::now().timestamp() + tokens.expires_in);
    rc.last_error = None;
    config::save(dir, &cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_status_reflects_config_and_secret() {
        let mut rc = config::RegionConfig::default();
        rc.app_id = Some("x".into());
        rc.connected = true;
        rc.token_expires_at = Some(123);
        let s = region_status(&rc, true);
        assert_eq!(
            s,
            RegionStatus {
                has_app_id: true,
                has_secret: true,
                connected: true,
                token_expires_at: Some(123),
                last_error: None,
            }
        );
    }

    #[test]
    fn region_status_empty_is_all_false() {
        let s = region_status(&config::RegionConfig::default(), false);
        assert!(!s.has_app_id && !s.has_secret && !s.connected);
        assert_eq!(s.token_expires_at, None);
    }
}
