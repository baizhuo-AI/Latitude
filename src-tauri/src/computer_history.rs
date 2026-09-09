//! History runs inside Latitude's application process. The Domain service owns
//! persistent settings; tray and settings UI therefore share one state.
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct HistoryState(pub Arc<Mutex<Value>>);
#[derive(Default)]
pub struct HistoryClearIntent(std::sync::atomic::AtomicBool);
pub struct HistoryTray {
    pub status: tauri::menu::MenuItem<tauri::Wry>,
    pub pause: tauri::menu::MenuItem<tauri::Wry>,
}
fn apply_native_config(config: &Value) {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::{c_char, CString};
        extern "C" {
            fn latitude_history_configure(input: *const c_char);
        }
        if let Ok(value) = CString::new(config.to_string()) {
            unsafe {
                latitude_history_configure(value.as_ptr());
            }
        }
    }
}
#[tauri::command]
pub async fn history_apply_settings(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::speech::check_composer(&window)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let value = client
        .get("http://127.0.0.1:43121/v1/history/settings")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())?;
    apply_native_config(&value["config"]);
    Ok(())
}
#[tauri::command]
pub async fn history_open_source(
    window: tauri::WebviewWindow,
    group_id: String,
) -> Result<(), String> {
    crate::speech::check_composer(&window)?;
    let page = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .post("http://127.0.0.1:43121/v1/history/query")
        .json(&json!({"groupId":group_id}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())?;
    let address = page["items"][0]["url"]
        .as_str()
        .ok_or("原始地址已到期或不可用。")?;
    let url = reqwest::Url::parse(address).map_err(|_| "来源地址无效。")?;
    if url.scheme() == "file" {
        let file = url.to_file_path().map_err(|_| "文件位置无效。")?;
        let extension = file
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !file.is_file()
            || ![
                "pdf", "txt", "md", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "png",
                "jpg", "jpeg",
            ]
            .contains(&extension.as_str())
        {
            return Err("此来源无法直接打开，请在原应用中查找。".into());
        }
    } else if !matches!(url.scheme(), "http" | "https") {
        return Err("此来源需要在原应用中打开。".into());
    }
    std::process::Command::new("/usr/bin/open")
        .args(["--", address])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
async fn sample(config: Value) -> Result<Value, String> {
    use std::ffi::{c_char, c_void, CStr, CString};
    type Callback = unsafe extern "C" fn(*mut c_void, *const c_char);
    extern "C" {
        fn latitude_history_poll(input: *const c_char, callback: Callback, context: *mut c_void);
    }
    unsafe extern "C" fn result(context: *mut c_void, raw: *const c_char) {
        let sender =
            Box::from_raw(context as *mut tokio::sync::oneshot::Sender<Result<Value, String>>);
        let value = if raw.is_null() {
            Err("采集未返回结果".into())
        } else {
            serde_json::from_slice(CStr::from_ptr(raw).to_bytes()).map_err(|e| e.to_string())
        };
        let _ = sender.send(value);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let input = CString::new(config.to_string()).map_err(|e| e.to_string())?;
    unsafe {
        latitude_history_poll(
            input.as_ptr(),
            result,
            Box::into_raw(Box::new(sender)) as *mut c_void,
        );
    }
    receiver.await.map_err(|_| "原生记录已中断".to_string())?
}
#[cfg(not(target_os = "macos"))]
async fn sample(_: Value) -> Result<Value, String> {
    Ok(json!({"state":"unsupported","events":[],"permission":false}))
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(HistoryState::default());
    app.manage(HistoryClearIntent::default());
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let mut pending: Vec<Value> = vec![];
        let mut pending_revision = Value::Null;
        loop {
            let settings = async {
                client
                    .get("http://127.0.0.1:43121/v1/history/settings")
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<Value>()
                    .await
            }
            .await;
            let state = match settings {
                Ok(settings) => {
                    if pending_revision != settings["revision"] {
                        pending.clear();
                        pending_revision = settings["revision"].clone();
                    }
                    let config = &settings["config"];
                    if config["enabled"] != true
                        || config["paused"] == true
                        || config["nativeEnabled"] != true
                    {
                        pending.clear();
                    }
                    match sample(config.clone()).await {
                        Ok(mut state) => {
                            if let Some(events) = state["events"].as_array() {
                                pending.extend(events.iter().cloned());
                            }
                            state.as_object_mut().unwrap().remove("events");
                            if pending.len() > 200 {
                                pending.drain(..pending.len() - 200);
                                state["error"] = json!("服务暂不可用，部分记录未保存。");
                            }
                            if !pending.is_empty() {
                                let sent=client.post("http://127.0.0.1:43121/v1/history/ingest").json(&json!({"provider":"latitude","revision":settings["revision"],"events":pending})).send().await;
                                match sent {
                                    Ok(r) if r.status().is_success() => {
                                        pending.clear();
                                        state["lastImportAt"] = json!(crate::util::now_iso());
                                    }
                                    _ => {
                                        state["error"] = json!("记录暂未保存，正在重试。");
                                    }
                                }
                            }
                            let _ = client
                                .post("http://127.0.0.1:43121/v1/history/heartbeat")
                                .json(&state)
                                .send()
                                .await;
                            state
                        }
                        Err(error) => json!({"state":"error","error":error}),
                    }
                }
                Err(_) => {
                    pending.clear();
                    let _=sample(json!({"enabled":false,"paused":false,"nativeEnabled":false,"externalEnabled":false,"modelProcessing":false,"appMode":"exclude","apps":[],"siteMode":"exclude","sites":[]})).await;
                    json!({"state":"unavailable","error":"记录服务尚未连接。"})
                }
            };
            if let Ok(mut current) = app.state::<HistoryState>().0.lock() {
                *current = state.clone();
            }
            if let Some(tray) = app.try_state::<HistoryTray>() {
                let label = match state["state"].as_str().unwrap_or("") {
                    "running" => "正在记录",
                    "paused" => "已暂停",
                    "stopped" => "未开启",
                    "locked" => "系统暂停",
                    "permission_required" => "需要授权",
                    _ => "暂不可用",
                };
                let label = if state["state"] == "running"
                    && matches!(
                        state["coverage"].as_str(),
                        Some(
                            "private_excluded"
                                | "browser_privacy_unavailable"
                                | "browser_permission_required"
                                | "window_unavailable"
                        )
                    ) {
                    "当前活动已跳过"
                } else {
                    label
                };
                let _ = tray.status.set_text(format!("电脑操作行为记录 · {label}…"));
                let _ = tray.pause.set_text(if state["state"] == "paused" {
                    "恢复记录"
                } else {
                    "暂停记录"
                });
                let _ = tray.pause.set_enabled(matches!(
                    state["state"].as_str(),
                    Some("running" | "paused" | "locked" | "permission_required")
                ));
            }
            let _ = app.emit("latitude://history-state", state);
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn history_native_status(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::speech::check_composer(&window)?;
    window
        .state::<HistoryState>()
        .0
        .lock()
        .map(|v| v.clone())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn history_request_permission(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::speech::check_composer(&window)?;
    #[cfg(target_os = "macos")]
    unsafe {
        extern "C" {
            fn latitude_history_request_permission();
        }
        latitude_history_request_permission();
    }
    Ok(())
}
pub fn open_settings(app: &tauri::AppHandle) {
    crate::show_main_window(app);
    let _ = app.emit_to("main", "latitude://history-open", json!({}));
}
pub fn request_clear_latest(app: &tauri::AppHandle) {
    app.state::<HistoryClearIntent>()
        .0
        .store(true, std::sync::atomic::Ordering::SeqCst);
    open_settings(app);
}
#[tauri::command]
pub fn history_take_clear_request(window: tauri::WebviewWindow) -> Result<bool, String> {
    crate::speech::check_composer(&window)?;
    Ok(window
        .state::<HistoryClearIntent>()
        .0
        .swap(false, std::sync::atomic::Ordering::SeqCst))
}
#[tauri::command]
pub async fn history_reveal_memory(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::speech::check_composer(&window)?;
    let result = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .post("http://127.0.0.1:43121/v1/history/memory")
        .json(&json!({"action":"list"}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())?;
    let file = std::path::Path::new(
        result["memoryFile"]["path"]
            .as_str()
            .ok_or("记忆文件尚未准备好。")?,
    );
    if !file.is_file() || !file.ends_with("computer-history-memory/memories.json") {
        return Err("记忆文件不可用。".into());
    }
    std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(file)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn toggle_pause(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<(), Box<dyn std::error::Error + Send + Sync>> = async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(5))
                .build()?;
            let mut settings: Value = client
                .get("http://127.0.0.1:43121/v1/history/settings")
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            if settings["config"]["enabled"] != true {
                open_settings(&app);
                return Ok(());
            }
            settings["config"]["paused"] = json!(settings["config"]["paused"] != true);
            client
                .post("http://127.0.0.1:43121/v1/history/settings")
                .json(&settings)
                .send()
                .await?
                .error_for_status()?;
            apply_native_config(&settings["config"]);
            let _ = app.emit("latitude://history-settings", json!({}));
            Ok(())
        }
        .await;
        if result.is_err() {
            open_settings(&app);
        }
    });
}
