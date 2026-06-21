use tauri::Manager;

/// 开 / 收对话悬浮条:可见就藏,藏着就显示并聚焦。
/// 菜单栏图标、全局快捷键、桌面悬浮按钮(Launcher)三处都走这一套(单一真相源)。
fn toggle_chatbar_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("chatbar") {
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
pub mod secretary;
// 跨模块共享小工具（id 生成 / ISO 时间戳）
pub mod util;

/**
 * Daybreak Tauri 入口
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
            // 工作台主窗"关闭"= 隐藏而非销毁:点红叉只是藏起来,Dock 图标 / 菜单栏 / 全局快捷键都能再拉回来。
            // 真正退出走 ⌘Q 或菜单栏"退出 Daybreak"。其它窗口(悬浮窗)不拦,保持默认。
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // 全局快捷键 → 动作 的映射表(with_handler 查它分发);set_global_shortcuts 维护。
            app.manage(ShortcutActions::default());

            // 内嵌 MCP server：进程内后台任务，连同一个 daybreak.db。
            // - token 持久化在 app config 目录，供鉴权和前端接入页共用
            // - 写操作通过 Tauri 事件 daybreak://data-changed 通知前端刷新
            // - start() 内部自行兜底（连库 / 端口失败只记日志），不会让主应用崩溃
            use tauri::Emitter;
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let db_path = config_dir.join("daybreak.db");
            let token = mcp::load_or_create_token(&config_dir);
            let handle = app.handle().clone();
            let notify: mcp::Notifier = std::sync::Arc::new(move |topic: &str| {
                let _ = handle.emit("daybreak://data-changed", topic.to_string());
            });
            tauri::async_runtime::spawn(mcp::start(db_path.clone(), token, notify));

            // 飞书/Lark 日历后台同步调度（P2-4）：启动跑一次 + 每 5min + 可手动唤醒。
            // - 复用同一个 daybreak.db（WAL 并发安全），与 mcp / 前端共享。
            // - 写库后通过 daybreak://data-changed 事件（topic "calendar_events"）通知前端刷新，
            //   与上面 mcp 的 notify 同款闭包形态。
            // - SyncHandle 既是手动唤醒句柄、又持「同一时刻一轮」的全局串行锁；manage 进 Tauri
            //   状态，供 feishu_sync_now 命令拿到同一把锁（手动同步与定时同步互斥）。
            // - run_scheduler 内部自兜底（连库失败只记日志、单点同步失败不中断），不会让主应用崩。
            let sync_handle = feishu::engine::SyncHandle::default();
            app.manage(sync_handle.clone());
            let feishu_handle = app.handle().clone();
            let feishu_notify: feishu::engine::Notifier = std::sync::Arc::new(move |topic: &str| {
                let _ = feishu_handle.emit("daybreak://data-changed", topic.to_string());
            });
            tauri::async_runtime::spawn(feishu::engine::run_scheduler(
                db_path.clone(),
                feishu_notify,
                sync_handle,
            ));

            // AI 秘书「活动记录」原生调度（替代主窗渲染进程里会被 macOS 冻结的 setInterval）：
            // - 主动配置只在前端 localStorage，Rust 读不到 → 前端通过 set_proactive_config 命令推过来，
            //   这里 manage 一个 ProactiveConfigState（Mutex<Option<_>>）承接（前端没推时引擎跳过）。
            // - run_scheduler 内部每 60s tick、闸判定到点则写库 + 发系统通知 + notify 前端刷新；
            //   连库失败只记日志退出本任务、单 tick 失败不中断，与 feishu 引擎同款长命兜底。
            // - 复用同一个 daybreak.db（WAL 并发安全）与同款 notify 闭包（emit data-changed）。
            app.manage(secretary::config::ProactiveConfigState::default());
            let secretary_app = app.handle().clone();
            let secretary_handle = app.handle().clone();
            let secretary_notify: secretary::engine::Notifier =
                std::sync::Arc::new(move |topic: &str| {
                    let _ = secretary_handle.emit("daybreak://data-changed", topic.to_string());
                });
            tauri::async_runtime::spawn(secretary::engine::run_scheduler(
                db_path,
                secretary_app,
                secretary_notify,
            ));

            // 飞书入站消费端（飞书对话入口）：监督 lark-cli event consume 收 IM 消息 → emit 给
            // 主窗前端飞书桥（feishuChat.ts）→ 跑秘书核心 → feishu_send_reply 发回飞书。
            // 自兜底：lark-cli 没装就只记日志退出、不影响主应用；进程掉了指数退避自动重连。
            tauri::async_runtime::spawn(feishu::inbound::run_inbound(app.handle().clone()));

            // 菜单栏(托盘)图标:菜单可开 / 收对话条、打开 todo 悬浮窗、退出。
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
                use tauri::tray::TrayIconBuilder;
                let toggle_i =
                    MenuItem::with_id(app, "toggle_chatbar", "打开 / 收起对话条", true, None::<&str>)?;
                let todo_i =
                    MenuItem::with_id(app, "open_todo", "打开 todo 悬浮窗", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "退出 Daybreak", true, None::<&str>)?;
                let sep = PredefinedMenuItem::separator(app)?;
                let menu = Menu::with_items(app, &[&toggle_i, &todo_i, &sep, &quit_i])?;
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _ = TrayIconBuilder::new()
                        .icon(icon)
                        .menu(&menu)
                        .on_menu_event(|app, event| match event.id.as_ref() {
                            "toggle_chatbar" => toggle_chatbar_window(app),
                            "open_todo" => {
                                if let Some(w) = app.get_webview_window("todo") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }
                            "quit" => app.exit(0),
                            _ => {}
                        })
                        .build(app);
                }
            }

            // 全局快捷键不在这里注册:由前端启动时按设置里保存的 accelerator 调 set_global_shortcut 注册,
            // 用户改快捷键时也走同一命令。响应逻辑在上面 global-shortcut 插件的 with_handler。

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_chatbar,
            toggle_todo,
            show_main,
            set_global_shortcuts,
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
