use tauri::Manager;

/// 开 / 收对话悬浮条:可见就藏,藏着就显示并聚焦。
/// 菜单栏图标、全局快捷键、桌面悬浮按钮(Launcher)三处都走这一套(单一真相源)。
fn toggle_chatbar_window(app: &tauri::AppHandle) {
    let visible = app
        .get_webview_window("chatbar")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = if visible {
            pet::pet_hide_chat(app).await
        } else {
            pet::pet_show_chat(app).await
        };
        if let Err(error) = result {
            eprintln!("[pet] conversation window: {error}");
        }
    });
}

/// 前端可调用的开 / 收对话条命令(仅对话条;桌面按钮改用 toggle_floaters 同时控制两个悬浮窗)。
#[tauri::command]
fn toggle_chatbar(app: tauri::AppHandle) {
    toggle_chatbar_window(&app);
}

/// 开 / 收 todo 悬浮窗:可见就藏,藏着就显示并聚焦。与 toggle_chatbar 对称,让桌面按钮分开控制两个悬浮窗。
fn toggle_todo_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("todo") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

/// 前端(桌面悬浮按钮 Launcher 的待办钮)调用的开 / 收 todo 悬浮窗命令。
#[tauri::command]
fn toggle_todo(app: tauri::AppHandle) {
    toggle_todo_window(&app);
}

/// 把工作台主窗唤到前台。主窗"关闭=隐藏",这里负责再唤出来。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 唤起工作台主窗(供桌面按钮的"工作台"钮)。
#[tauri::command]
fn show_main(app: tauri::AppHandle) {
    show_main_window(&app);
}

/// 全局快捷键 → 动作 的映射表(set_global_shortcuts 维护;插件 with_handler 按触发的组合键查它分发)。
#[derive(Default)]
struct ShortcutActions(
    std::sync::Mutex<std::collections::HashMap<tauri_plugin_global_shortcut::Shortcut, String>>,
);

/// 设置三个全局快捷键(开/收对话条、开/收待办、唤起工作台)。
/// 先全部注销 + 清表,再逐个注册并把 组合键→动作 记进表;空串跳过,重复组合键只认第一个。
/// 前端在启动时、以及用户在设置里改时调用(accelerator 形如 "Alt+Space" / "Super+Shift+KeyK")。
#[tauri::command]
fn set_global_shortcuts(
    app: tauri::AppHandle,
    chatbar: String,
    todo: String,
    workbench: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let state = app.state::<ShortcutActions>();
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.clear();
    let mut seen = std::collections::HashSet::new();
    for (accel, action) in [
        (chatbar, "chatbar"),
        (todo, "todo"),
        (workbench, "workbench"),
    ] {
        let accel = accel.trim();
        if accel.is_empty() || !seen.insert(accel.to_string()) {
            continue;
        }
        let sc: Shortcut = accel.parse().map_err(|_| format!("无效快捷键: {accel}"))?;
        gs.register(sc.clone()).map_err(|e| e.to_string())?;
        map.insert(sc, action.to_string());
    }
    Ok(())
}

// pub：让 examples/mcp_smoke.rs 等命令行冒烟测试能调用 mcp::start 单独起 server（不开 GUI）。
pub mod mcp;
// CLI Agent 后端（claude/codex/kiro），通过 spawn 本地 CLI 走用户订阅
pub mod cli_agent;
// 飞书 / Lark 日历同步（OAuth + 增量拉取 + 双向回写）
pub mod feishu;
// AI 秘书原生后台能力（目前：活动记录的常驻调度引擎，绕开藏窗冻结 JS 定时器）
pub mod attachments;
pub mod desktop_http;
pub mod pet;
pub mod secretary;
pub mod speech;
pub mod computer_history;
pub mod local_services;
// 跨模块共享小工具（id 生成 / ISO 时间戳）
pub mod util;

/**
 * Latitude Tauri 入口
 *
 * 装的 plugin:
 * - tauri-plugin-sql (sqlite):前端通过 @tauri-apps/plugin-sql 调 SQLite
 * - tauri-plugin-single-instance:防双开。重复启动时,把焦点切回已有主窗口,
 *   避免两个进程同时写同一个 SQLite 文件触发 BUSY 错。
 * - tauri-plugin-notification:间歇式时间日志的提醒走 macOS 系统通知
 *   (前端 @tauri-apps/plugin-notification)。
 *
 * Schema 初始化在前端 src/lib/db.ts(IF NOT EXISTS + PRAGMA 自检列),Rust 端不写迁移。
 */
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二次启动时把主窗口拉到前台(可能此前被最小化或"关闭=隐藏"过)
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    // 按触发的组合键查表,分发到对应动作
                    let action = {
                        let state = app.state::<ShortcutActions>();
                        let guard = state.0.lock().ok();
                        guard.and_then(|m| m.get(shortcut).cloned())
                    };
                    match action.as_deref() {
                        Some("chatbar") => toggle_chatbar_window(app),
                        Some("todo") => toggle_todo_window(app),
                        Some("workbench") => show_main_window(app),
                        _ => {}
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if matches!(window.label(), "main" | "chatbar") {
                    attachments::authorize_dropped_files(window.app_handle(), paths);
                }
            }
            // 工作台主窗"关闭"= 隐藏而非销毁:点红叉只是藏起来,Dock 图标 / 菜单栏 / 全局快捷键都能再拉回来。
            // 真正退出走 ⌘Q 或菜单栏"退出 Latitude"。
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if window.label() == "chatbar" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = pet::pet_hide_chat(app).await;
                    });
                }
            }
        })
        .setup(|app| {
            // 全局快捷键 → 动作 的映射表(with_handler 查它分发);set_global_shortcuts 维护。
            app.manage(ShortcutActions::default());
            app.manage(desktop_http::DesktopHttpClient::new()?);
            pet::setup(app)?;
            local_services::setup(app)?;
            computer_history::setup(app)?;

            // NativeDesktopApp now shares the Browser + DSH Agent/Domain runtime.
            // Legacy MCP, Feishu inbound/sync, and activity-capture schedulers
            // are not started here: they own a different database and would
            // otherwise produce duplicate reminders beside the new secretary.
            // Keep their modules/commands for explicit migration tooling.
            app.manage(feishu::engine::SyncHandle::default());
            app.manage(secretary::config::ProactiveConfigState::default());

            // 菜单栏(托盘)图标:菜单可开 / 收对话条、打开 todo 悬浮窗、退出。
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
                use tauri::tray::TrayIconBuilder;
                let toggle_i = MenuItem::with_id(
                    app,
                    "toggle_chatbar",
                    "打开 / 收起对话条",
                    true,
                    None::<&str>,
                )?;
                let show_pet_i =
                    MenuItem::with_id(app, "show_pet", "叫出桌宠", true, None::<&str>)?;
                let dock_pet_i =
                    MenuItem::with_id(app, "dock_pet", "秘书回到框里", true, None::<&str>)?;
                let hide_pet_i =
                    MenuItem::with_id(app, "hide_pet", "暂时隐藏桌宠", true, None::<&str>)?;
                let main_i = MenuItem::with_id(app, "show_main", "打开维度", true, None::<&str>)?;
                let history_i = MenuItem::with_id(app, "history_settings", "电脑操作行为记录…", true, None::<&str>)?;
                let history_pause_i = MenuItem::with_id(app, "history_pause", "暂停 / 恢复记录", true, None::<&str>)?;
                let history_clear_i = MenuItem::with_id(app, "history_clear_latest", "清理最近一次应用活动…", true, None::<&str>)?;
                app.manage(computer_history::HistoryTray { status:history_i.clone(),pause:history_pause_i.clone() });
                let quit_i = MenuItem::with_id(app, "quit", "退出 Latitude", true, None::<&str>)?;
                let sep = PredefinedMenuItem::separator(app)?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &toggle_i,
                        &show_pet_i,
                        &dock_pet_i,
                        &hide_pet_i,
                        &main_i,
                        &history_i,
                        &history_pause_i,
                        &history_clear_i,
                        &sep,
                        &quit_i,
                    ],
                )?;
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _ = TrayIconBuilder::new()
                        .icon(icon)
                        .menu(&menu)
                        .on_menu_event(|app, event| match event.id.as_ref() {
                            "toggle_chatbar" => toggle_chatbar_window(app),
                            "show_pet" | "dock_pet" | "hide_pet" => {
                                let app = app.clone();
                                let action = event.id.as_ref().to_string();
                                tauri::async_runtime::spawn(async move {
                                    let result = match action.as_str() {
                                        "show_pet" => pet::pet_show(app).await,
                                        "dock_pet" => pet::pet_dock(app).await,
                                        _ => pet::pet_hide(app).await,
                                    };
                                    if let Err(error) = result {
                                        eprintln!("[pet] menu action: {error}");
                                    }
                                });
                            }
                            "history_settings" => computer_history::open_settings(app),
                            "history_pause" => computer_history::toggle_pause(app),
                            "history_clear_latest" => computer_history::request_clear_latest(app),
                            "show_main" => show_main_window(app),
                            "quit" => app.exit(0),
                            _ => {}
                        })
                        .build(app);
                }
            }

            // Browser + DSH has no legacy settings effect. Keep the existing
            // Alt+Space default available even while the main window is hidden.
            set_global_shortcuts(
                app.handle().clone(),
                "Alt+Space".into(),
                String::new(),
                String::new(),
            )?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            computer_history::history_native_status,
            computer_history::history_apply_settings,
            computer_history::history_open_source,
            computer_history::history_request_permission,
            computer_history::history_take_clear_request,
            computer_history::history_reveal_memory,
            toggle_chatbar,
            toggle_todo,
            show_main,
            set_global_shortcuts,
            desktop_http::desktop_http_request,
            pet::pet_get_state,
            pet::pet_set_dock_rect,
            pet::pet_begin_drag,
            pet::pet_cancel_drag,
            pet::pet_dock,
            pet::pet_hide,
            pet::pet_show,
            pet::pet_show_chat,
            pet::pet_hide_chat,
            pet::pet_show_notice,
            pet::pet_hide_notice,
            pet::pet_set_hit_mask,
            pet::pet_sync,
            pet::pet_get_snapshot,
            pet::pet_action,
            speech::pet_speech_start,
            speech::pet_speech_stop,
            speech::pet_speech_cancel,
            speech::pet_ocr_attachment,
            attachments::pet_pick_attachments,
            attachments::pet_read_attachment,
            mcp::connect::mcp_connection_info,
            cli_agent::cli_agent_send,
            cli_agent::cli_agent_detect,
            feishu::commands::feishu_set_credentials,
            feishu::commands::feishu_start_auth,
            feishu::commands::feishu_disconnect,
            feishu::commands::feishu_status,
            feishu::engine::feishu_sync_now,
            feishu::engine::feishu_flush_queue,
            feishu::bitable::feishu_bitable_describe,
            feishu::bitable::feishu_bitable_create,
            feishu::bitable::feishu_bitable_update,
            feishu::outbound::feishu_send_reply,
            secretary::config::set_proactive_config,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) { local_services::stop(app_handle); }
            // 点 Dock 图标(macOS reopen):强制把工作台主窗拉回前台。
            // 不依赖 macOS 默认行为——常驻的 launcher 悬浮窗会让默认逻辑以为"已有可见窗口"而不恢复主窗。
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        });
}
