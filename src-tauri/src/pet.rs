//! One native owner for the secretary's docked/floating presentation.
//!
//! A drag never transfers DOM pointer capture to another WKWebView. Rust polls
//! AppKit's current mouse/button state until release; the pre-created pet
//! window is a non-interactive preview during that gesture. Only release over
//! a valid location commits a new presentation. Escape restores the origin.

use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const PET_WIDTH: f64 = 220.0;
const PET_HEIGHT: f64 = 260.0;
const CHAT_WIDTH: f64 = 420.0;
const CHAT_HEIGHT: f64 = 460.0;
const NOTICE_WIDTH: f64 = 340.0;
const NOTICE_HEIGHT: f64 = 180.0;
const STATE_EVENT: &str = "latitude://pet-state";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PetMode {
    #[default]
    Docked,
    Floating,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Rect {
    fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

#[derive(Clone, Copy, Debug)]
struct DragOrigin {
    mode: PetMode,
    hidden: bool,
    x: f64,
    y: f64,
    grab_x: f64,
    grab_y: f64,
}

#[derive(Clone, Debug)]
struct NativeGesture {
    source: String,
    x: f64,
    y: f64,
    pressed: bool,
    updated: Instant,
}

#[derive(Clone, Default)]
struct HitMask {
    width: usize,
    height: usize,
    alpha: Vec<u8>,
}

impl HitMask {
    fn hit(&self, x: f64, y: f64) -> bool {
        if !(0.0..PET_WIDTH).contains(&x) || !(0.0..PET_HEIGHT).contains(&y) {
            return false;
        }
        if self.alpha.is_empty() {
            // The avatar can be picked up before the first render supplies its
            // alpha mask. This small fallback excludes the window's corners.
            return ((x - PET_WIDTH / 2.0) / 75.0).powi(2)
                + ((y - PET_HEIGHT / 2.0) / 115.0).powi(2)
                <= 1.0;
        }
        let col = (x / PET_WIDTH * self.width as f64) as usize;
        let row = (y / PET_HEIGHT * self.height as f64) as usize;
        self.alpha.get(row * self.width + col).copied().unwrap_or(0) > 16
    }
}

/// Only these presentation fields are sent to WebViews and persisted.
/// Coordinates are AppKit screen points in a top-left coordinate system, not
/// mixed per-monitor physical pixels. This keeps Retina/non-Retina drags stable.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PetState {
    mode: PetMode,
    dragging: bool,
    over_dock: bool,
    x: f64,
    y: f64,
    hidden: bool,
    #[serde(skip)]
    dock_rect: Option<Rect>,
    #[serde(skip)]
    drag: Option<DragOrigin>,
    #[serde(skip)]
    gesture: Option<NativeGesture>,
    #[serde(skip)]
    snapshot: Value,
    #[serde(skip)]
    mask: HitMask,
    #[serde(skip)]
    ignores_mouse: Option<bool>,
    #[serde(skip)]
    chat_visible: bool,
    #[serde(skip)]
    notice_visible: bool,
    #[serde(skip)]
    path: PathBuf,
    #[serde(skip)]
    has_position: bool,
    #[serde(skip)]
    last_layout: Option<Instant>,
    #[serde(skip)]
    last_work_area: Option<Rect>,
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            mode: PetMode::Docked,
            dragging: false,
            over_dock: false,
            x: 24.0,
            y: 24.0,
            hidden: false,
            dock_rect: None,
            drag: None,
            gesture: None,
            snapshot: Value::Null,
            mask: HitMask::default(),
            ignores_mouse: None,
            chat_visible: false,
            notice_visible: false,
            path: PathBuf::new(),
            has_position: false,
            last_layout: None,
            last_work_area: None,
        }
    }
}

impl PetState {
    fn resolve_drag(&mut self, cancelled: bool) -> bool {
        let Some(origin) = self.drag.take() else {
            return false;
        };
        if cancelled {
            self.mode = origin.mode;
            self.hidden = origin.hidden;
            self.x = origin.x;
            self.y = origin.y;
        } else {
            self.mode = if self.over_dock {
                PetMode::Docked
            } else {
                PetMode::Floating
            };
            self.hidden = false;
        }
        self.dragging = false;
        self.over_dock = false;
        true
    }
}

pub struct PetController(Mutex<PetState>);

fn lock(app: &AppHandle) -> tauri::State<'_, PetController> {
    app.state::<PetController>()
}

fn persist(state: &PetState) -> Result<(), String> {
    let mut saved = state.clone();
    saved.dragging = false;
    saved.over_dock = false;
    let bytes = serde_json::to_vec(&saved).map_err(|error| error.to_string())?;
    let temporary = state.path.with_extension("tmp");
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, &state.path).map_err(|error| error.to_string())
}

fn publish(app: &AppHandle, state: &PetState) {
    let _ = app.emit(STATE_EVENT, state);
}

async fn on_main<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(work(&handle));
    })
    .map_err(|error| error.to_string())?;
    rx.await
        .map_err(|_| "Native pet operation was interrupted".to_string())?
}

fn pet_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("pet")
        .ok_or_else(|| "Pet window is unavailable".into())
}

fn main_dock_rect(app: &AppHandle, rect: Option<Rect>) -> Option<Rect> {
    let main = app.get_webview_window("main")?;
    if !main.is_visible().ok()? || main.is_minimized().unwrap_or(false) {
        return None;
    }
    let rect = rect?;
    let content = native::content_rect(&main).ok()?;
    Some(Rect {
        x: content.x + rect.x,
        y: content.y + rect.y,
        ..rect
    })
}

fn is_over_dock(app: &AppHandle, rect: Option<Rect>, mouse: (f64, f64)) -> bool {
    let Some(rect) = main_dock_rect(app, rect) else {
        return false;
    };
    if !rect.contains(mouse.0, mouse.1) {
        return false;
    }
    app.get_webview_window("main")
        .is_some_and(|main| native::owns_point(&main, mouse).unwrap_or(false))
}

fn work_area_at(x: f64, y: f64) -> Result<Rect, String> {
    let areas = native::work_areas()?;
    areas
        .iter()
        .find(|area| area.contains(x, y))
        .copied()
        .or_else(|| {
            areas
                .iter()
                .copied()
                .min_by(|a, b| rect_distance(*a, x, y).total_cmp(&rect_distance(*b, x, y)))
        })
        .ok_or_else(|| "No display is available".into())
}

fn rect_distance(rect: Rect, x: f64, y: f64) -> f64 {
    let dx = x - x.clamp(rect.x, rect.x + rect.width);
    let dy = y - y.clamp(rect.y, rect.y + rect.height);
    dx * dx + dy * dy
}

fn clamp_pet(x: f64, y: f64, area: Rect) -> (f64, f64) {
    (
        x.clamp(
            area.x + 8.0,
            (area.x + area.width - PET_WIDTH - 8.0).max(area.x + 8.0),
        ),
        y.clamp(
            area.y + 8.0,
            (area.y + area.height - PET_HEIGHT - 8.0).max(area.y + 8.0),
        ),
    )
}

/// Place a sibling panel inward from its anchor, then clamp to the same display.
fn panel_position(anchor: Rect, width: f64, height: f64, area: Rect) -> (f64, f64) {
    let right = anchor.x + anchor.width + 12.0;
    let left = anchor.x - width - 12.0;
    let x = if right + width <= area.x + area.width - 8.0 {
        right
    } else {
        left
    };
    (
        x.clamp(
            area.x + 8.0,
            (area.x + area.width - width - 8.0).max(area.x + 8.0),
        ),
        (anchor.y + anchor.height - height).clamp(
            area.y + 8.0,
            (area.y + area.height - height - 8.0).max(area.y + 8.0),
        ),
    )
}

fn position_panels(app: &AppHandle, state: &PetState) -> Result<(), String> {
    let anchor = if state.mode == PetMode::Docked {
        main_dock_rect(app, state.dock_rect).unwrap_or(Rect {
            x: state.x,
            y: state.y,
            width: PET_WIDTH,
            height: PET_HEIGHT,
        })
    } else {
        Rect {
            x: state.x,
            y: state.y,
            width: PET_WIDTH,
            height: PET_HEIGHT,
        }
    };
    let area = work_area_at(
        anchor.x + anchor.width / 2.0,
        anchor.y + anchor.height / 2.0,
    )?;
    for (label, visible, width, height) in [
        ("chatbar", state.chat_visible, CHAT_WIDTH, CHAT_HEIGHT),
        (
            "pet-notice",
            state.notice_visible,
            NOTICE_WIDTH,
            NOTICE_HEIGHT,
        ),
    ] {
        if visible {
            if let Some(window) = app.get_webview_window(label) {
                let (x, y) = panel_position(anchor, width, height, area);
                native::position(&window, x, y)?;
            }
        }
    }
    Ok(())
}

fn update_hit_test(app: &AppHandle, state: &mut PetState, mouse: (f64, f64)) {
    let ignore =
        state.dragging || state.hidden || !state.mask.hit(mouse.0 - state.x, mouse.1 - state.y);
    if state.ignores_mouse != Some(ignore) {
        if let Ok(window) = pet_window(app) {
            if window.set_ignore_cursor_events(ignore).is_ok() {
                state.ignores_mouse = Some(ignore);
            }
        }
    }
}

fn finish_drag(app: &AppHandle, cancelled: bool) -> Result<(), String> {
    let controller = lock(app);
    let mut state = controller.0.lock().map_err(|error| error.to_string())?;
    if !state.resolve_drag(cancelled) {
        return Ok(());
    }
    // Release the temporary key binding even if positioning/persistence fails.
    let _ = app.global_shortcut().unregister("Escape");
    if state.mode == PetMode::Floating && !cancelled {
        let area = work_area_at(state.x + PET_WIDTH / 2.0, state.y + PET_HEIGHT / 2.0)?;
        (state.x, state.y) = clamp_pet(state.x, state.y, area);
        state.has_position = true;
    }
    let window = pet_window(app)?;
    if state.mode == PetMode::Floating && !state.hidden {
        native::position(&window, state.x, state.y)?;
        window.show().map_err(|error| error.to_string())?;
    } else {
        window.hide().map_err(|error| error.to_string())?;
    }
    state.ignores_mouse = None;
    update_hit_test(app, &mut state, native::mouse()?.0);
    publish(app, &state);
    persist(&state)
}

fn tick(app: &AppHandle) -> Result<bool, String> {
    let system_mouse = native::mouse()?;
    let controller = lock(app);
    let mut state = controller.0.lock().map_err(|error| error.to_string())?;
    if let Some(origin) = state.drag {
        let mouse = state
            .gesture
            .as_ref()
            .map(|gesture| {
                let pressed = gesture.pressed
                    && (gesture.updated.elapsed() < Duration::from_millis(100) || system_mouse.1);
                ((gesture.x, gesture.y), pressed)
            })
            .unwrap_or(system_mouse);
        state.x = mouse.0 .0 - origin.grab_x;
        state.y = mouse.0 .1 - origin.grab_y;
        state.over_dock = is_over_dock(app, state.dock_rect, mouse.0);
        native::position(&pet_window(app)?, state.x, state.y)?;
        publish(app, &state);
        if !mouse.1 {
            drop(state);
            finish_drag(app, false)?;
            return Ok(false);
        }
        return Ok(true);
    }
    if state.mode == PetMode::Floating && !state.hidden {
        // Once a press has landed on the avatar, keep its source WebView
        // interactive until the frontend crosses its drag threshold.
        let native_press = state.gesture.as_ref().is_some_and(|gesture| {
            gesture.pressed && gesture.updated.elapsed() < Duration::from_secs(2)
        });
        if (!system_mouse.1 && !native_press) || state.ignores_mouse != Some(false) {
            update_hit_test(app, &mut state, system_mouse.0);
        }
        if state
            .last_layout
            .is_none_or(|last| last.elapsed() >= Duration::from_secs(1))
        {
            // Reflow after display disconnect, Dock changes, and waking from
            // sleep. Native screen points keep negative-monitor coordinates.
            let area = work_area_at(state.x + PET_WIDTH / 2.0, state.y + PET_HEIGHT / 2.0)?;
            let next = clamp_pet(state.x, state.y, area);
            let area_changed = state.last_work_area.is_some_and(|previous| {
                (previous.x, previous.y, previous.width, previous.height)
                    != (area.x, area.y, area.width, area.height)
            });
            let moved = next != (state.x, state.y);
            if moved {
                (state.x, state.y) = next;
                native::position(&pet_window(app)?, state.x, state.y)?;
                publish(app, &state);
                persist(&state)?;
            }
            if moved || area_changed {
                position_panels(app, &state)?;
            }
            state.last_layout = Some(Instant::now());
            state.last_work_area = Some(area);
        }
    }
    Ok(false)
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let directory = app.path().app_config_dir()?;
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("native-pet.json");
    let saved = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PetState>(&bytes).ok());
    let has_position = saved
        .as_ref()
        .is_some_and(|state| state.x.is_finite() && state.y.is_finite());
    let mut state = saved.unwrap_or_default();
    state.dragging = false;
    state.over_dock = false;
    state.has_position = has_position;
    state.path = path;
    if native::supported() {
        let mouse = native::mouse()?.0;
        let area = work_area_at(mouse.0, mouse.1)?;
        if !state.has_position {
            state.x = area.x + area.width - PET_WIDTH - 24.0;
            state.y = area.y + area.height - PET_HEIGHT - 24.0;
        }
        let area = work_area_at(state.x + PET_WIDTH / 2.0, state.y + PET_HEIGHT / 2.0)?;
        (state.x, state.y) = clamp_pet(state.x, state.y, area);
        if let Some(window) = app.get_webview_window("pet") {
            native::position(&window, state.x, state.y)?;
            if state.mode == PetMode::Floating && !state.hidden {
                window.show()?;
            }
        }
    }
    app.manage(PetController(Mutex::new(state)));
    if native::supported() {
        native::install_input_monitor(app.handle())?;
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let dragging = on_main(handle.clone(), tick).await.unwrap_or(false);
                tokio::time::sleep(Duration::from_millis(if dragging { 16 } else { 50 })).await;
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn pet_get_state(app: AppHandle) -> Result<PetState, String> {
    Ok(lock(&app)
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .clone())
}

#[tauri::command]
pub async fn pet_set_dock_rect(window: WebviewWindow, rect: Option<Rect>) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window owns the portrait dock".into());
    }
    if rect.is_some_and(|rect| !rect.valid()) {
        return Err("Invalid portrait dock rectangle".into());
    }
    on_main(window.app_handle().clone(), move |app| {
        let controller = lock(app);
        let mut state = controller.0.lock().map_err(|error| error.to_string())?;
        state.dock_rect = rect;
        position_panels(app, &state)
    })
    .await
}

#[tauri::command]
pub async fn pet_begin_drag(
    window: WebviewWindow,
    source: String,
    grab_x: f64,
    grab_y: f64,
) -> Result<(), String> {
    if !native::supported() {
        return Err("Native pet dragging currently requires macOS".into());
    }
    if !matches!(
        (window.label(), source.as_str()),
        ("main", "dock") | ("pet", "pet")
    ) {
        return Err("Invalid portrait drag source".into());
    }
    if !grab_x.is_finite() || !grab_y.is_finite() {
        return Err("Invalid portrait grab point".into());
    }
    let app = window.app_handle().clone();
    // Registration is done before any preview/state change so failure leaves
    // the original portrait untouched, rather than starting an uncancellable drag.
    app.global_shortcut()
        .on_shortcut("Escape", |app, _, event| {
            if event.state == ShortcutState::Pressed {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = pet_cancel_drag(handle).await;
                });
            }
        })
        .map_err(|error| format!("Could not enable drag cancellation: {error}"))?;
    let result = on_main(app.clone(), move |app| {
        let controller = lock(app);
        let mut state = controller.0.lock().map_err(|error| error.to_string())?;
        if state.dragging {
            return Ok(());
        }
        let expected = if source == "dock" {
            PetMode::Docked
        } else {
            PetMode::Floating
        };
        if state.mode != expected {
            return Err("The portrait has already moved".into());
        }
        // A quick native mouse-up can precede the JS -> IPC round trip. The
        // AppKit monitor keeps that gesture's actual endpoint so a quick drag
        // still commits there instead of disappearing or throwing an error.
        let source_window = if source == "dock" { "main" } else { "pet" };
        let gesture = state.gesture.as_ref().filter(|gesture| {
            gesture.source == source_window && gesture.updated.elapsed() < Duration::from_secs(2)
        });
        let mouse = if let Some(gesture) = gesture {
            ((gesture.x, gesture.y), gesture.pressed)
        } else {
            native::mouse()?
        };
        if !mouse.1 && gesture.is_none() {
            return Err("请按住秘书再拖动。".into());
        }
        state.drag = Some(DragOrigin {
            mode: state.mode,
            hidden: state.hidden,
            x: state.x,
            y: state.y,
            grab_x: grab_x.clamp(0.0, PET_WIDTH),
            grab_y: grab_y.clamp(0.0, PET_HEIGHT),
        });
        state.dragging = true;
        state.over_dock = source == "dock";
        state.hidden = false;
        state.x = mouse.0 .0 - grab_x.clamp(0.0, PET_WIDTH);
        state.y = mouse.0 .1 - grab_y.clamp(0.0, PET_HEIGHT);
        for label in ["chatbar", "pet-notice"] {
            if let Some(panel) = app.get_webview_window(label) {
                let _ = panel.hide();
            }
        }
        state.chat_visible = false;
        state.notice_visible = false;
        let pet = pet_window(app)?;
        native::position(&pet, state.x, state.y)?;
        pet.set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
        state.ignores_mouse = Some(true);
        publish(app, &state);
        pet.show().map_err(|error| error.to_string())?;
        if !mouse.1 {
            state.over_dock = is_over_dock(app, state.dock_rect, mouse.0);
            drop(state);
            finish_drag(app, false)?;
        }
        Ok(())
    })
    .await;
    if result.is_err() {
        let _ = app.global_shortcut().unregister("Escape");
    }
    result
}

#[tauri::command]
pub async fn pet_cancel_drag(app: AppHandle) -> Result<(), String> {
    on_main(app, |app| finish_drag(app, true)).await
}

/// Menu restoration also works while the original portrait window is hidden.
#[tauri::command]
pub async fn pet_dock(app: AppHandle) -> Result<(), String> {
    on_main(app, |app| {
        finish_drag(app, true)?;
        let main = app
            .get_webview_window("main")
            .ok_or("Main window is unavailable")?;
        main.unminimize().map_err(|error| error.to_string())?;
        main.show().map_err(|error| error.to_string())?;
        main.set_focus().map_err(|error| error.to_string())?;
        let controller = lock(app);
        let mut state = controller.0.lock().map_err(|error| error.to_string())?;
        state.mode = PetMode::Docked;
        state.hidden = false;
        state.over_dock = false;
        pet_window(app)?.hide().map_err(|error| error.to_string())?;
        for label in ["chatbar", "pet-notice"] {
            if let Some(panel) = app.get_webview_window(label) {
                let _ = panel.hide();
            }
        }
        state.chat_visible = false;
        state.notice_visible = false;
        publish(app, &state);
        persist(&state)
    })
    .await
}

#[tauri::command]
pub async fn pet_hide(app: AppHandle) -> Result<(), String> {
    on_main(app, |app| {
        finish_drag(app, true)?;
        let controller = lock(app);
        let mut state = controller.0.lock().map_err(|error| error.to_string())?;
        state.hidden = true;
        state.chat_visible = false;
        state.notice_visible = false;
        for label in ["pet", "chatbar", "pet-notice"] {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.hide();
            }
        }
        publish(app, &state);
        persist(&state)
    })
    .await
}

#[tauri::command]
pub async fn pet_show(app: AppHandle) -> Result<(), String> {
    on_main(app, |app| {
        let controller = lock(app);
        let mut state = controller.0.lock().map_err(|error| error.to_string())?;
        state.mode = PetMode::Floating;
        state.hidden = false;
        let area = work_area_at(state.x + PET_WIDTH / 2.0, state.y + PET_HEIGHT / 2.0)?;
        (state.x, state.y) = clamp_pet(state.x, state.y, area);
        let pet = pet_window(app)?;
        native::position(&pet, state.x, state.y)?;
        publish(app, &state);
        pet.show().map_err(|error| error.to_string())?;
        persist(&state)
    })
    .await
}

async fn set_panel(app: AppHandle, chat: bool, visible: bool) -> Result<(), String> {
    on_main(app, move |app| {
        let controller = lock(app);
        let mut state = controller.0.lock().map_err(|error| error.to_string())?;
        if chat {
            state.chat_visible = visible;
        } else {
            state.notice_visible = visible;
        }
        // A conversation supersedes the short passive notice.
        if chat && visible {
            state.notice_visible = false;
            if let Some(notice) = app.get_webview_window("pet-notice") {
                let _ = notice.hide();
            }
        }
        if !chat && visible && (state.hidden || state.chat_visible || state.dragging) {
            state.notice_visible = false;
            return Ok(());
        }
        let panel = app
            .get_webview_window(if chat { "chatbar" } else { "pet-notice" })
            .ok_or("Pet panel is unavailable")?;
        if visible {
            position_panels(app, &state)?;
            panel.show().map_err(|error| error.to_string())?;
            if chat {
                panel.set_focus().map_err(|error| error.to_string())?;
            }
        } else {
            panel.hide().map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn pet_show_chat(app: AppHandle) -> Result<(), String> {
    set_panel(app, true, true).await
}
#[tauri::command]
pub async fn pet_hide_chat(app: AppHandle) -> Result<(), String> {
    set_panel(app, true, false).await
}
#[tauri::command]
pub async fn pet_show_notice(app: AppHandle) -> Result<(), String> {
    set_panel(app, false, true).await
}
#[tauri::command]
pub async fn pet_hide_notice(app: AppHandle) -> Result<(), String> {
    set_panel(app, false, false).await
}

#[tauri::command]
pub fn pet_set_hit_mask(
    window: WebviewWindow,
    width: usize,
    height: usize,
    alpha: Vec<u8>,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("Only the pet window supplies its hit mask".into());
    }
    if width == 0
        || height == 0
        || width > 220
        || height > 260
        || width.checked_mul(height) != Some(alpha.len())
    {
        return Err("Pet hit mask must match its declared dimensions within the viewport".into());
    }
    let controller = lock(window.app_handle());
    let mut state = controller.0.lock().map_err(|error| error.to_string())?;
    state.mask = HitMask {
        width,
        height,
        alpha,
    };
    state.ignores_mouse = None;
    Ok(())
}

#[tauri::command]
pub fn pet_sync(window: WebviewWindow, snapshot: Value) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window publishes the secretary snapshot".into());
    }
    lock(window.app_handle())
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .snapshot = snapshot.clone();
    window
        .app_handle()
        .emit("latitude://pet-snapshot", snapshot)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pet_get_snapshot(app: AppHandle) -> Result<Value, String> {
    Ok(lock(&app)
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .snapshot
        .clone())
}

#[tauri::command]
pub fn pet_action(window: WebviewWindow, action: Value) -> Result<(), String> {
    if !matches!(window.label(), "main" | "pet" | "chatbar" | "pet-notice") {
        return Err("This window cannot send secretary actions".into());
    }
    window
        .app_handle()
        .emit_to("main", "latitude://pet-action", action)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
mod native {
    use super::{NativeGesture, Rect};
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2::{rc::Retained, runtime::AnyObject};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSScreen, NSWindow};
    use objc2_foundation::NSPoint;
    use std::{cell::RefCell, ptr::NonNull, time::Instant};
    use tauri::{AppHandle, Manager, WebviewWindow};

    thread_local! {
        static INPUT_MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    pub fn supported() -> bool {
        true
    }

    pub fn install_input_monitor(app: &AppHandle) -> Result<(), String> {
        marker()?;
        let app = app.clone();
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let event_ref = unsafe { event.as_ref() };
            let event_type = event_ref.r#type();
            if event_type == NSEventType::KeyDown {
                if event_ref.keyCode() == 53 {
                    let dragging = super::lock(&app).0.lock().is_ok_and(|state| state.dragging);
                    if dragging {
                        let _ = super::finish_drag(&app, true);
                        return std::ptr::null_mut();
                    }
                }
                return event.as_ptr();
            }
            let Ok(mtm) = marker() else {
                return event.as_ptr();
            };
            let Some(event_window) = event_ref.window(mtm) else {
                return event.as_ptr();
            };
            let source = ["main", "pet"].into_iter().find(|label| {
                app.get_webview_window(label)
                    .and_then(|handle| window(&handle).ok().map(|window| window.windowNumber()))
                    == Some(event_window.windowNumber())
            });
            let Some(source) = source else {
                return event.as_ptr();
            };
            let point = event_window.convertPointToScreen(event_ref.locationInWindow());
            let Ok(top) = screen_top() else {
                return event.as_ptr();
            };
            let controller = super::lock(&app);
            if let Ok(mut state) = controller.0.lock() {
                state.gesture = Some(NativeGesture {
                    source: source.into(),
                    x: point.x,
                    y: top - point.y,
                    pressed: event_type != NSEventType::LeftMouseUp,
                    updated: Instant::now(),
                });
            }
            // Updating the actual native preview here makes movement smooth
            // even if a hidden WKWebView is throttled or a JS event is delayed.
            let _ = super::tick(&app);
            event.as_ptr()
        });
        let mask = NSEventMask::LeftMouseDown
            | NSEventMask::LeftMouseDragged
            | NSEventMask::LeftMouseUp
            | NSEventMask::KeyDown;
        let monitor =
            unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler) }
                .ok_or("Could not install the native portrait drag monitor")?;
        INPUT_MONITOR.with(|slot| *slot.borrow_mut() = Some(monitor));
        Ok(())
    }

    fn marker() -> Result<MainThreadMarker, String> {
        MainThreadMarker::new()
            .ok_or_else(|| "AppKit pet operation requires the main thread".into())
    }

    fn screen_top() -> Result<f64, String> {
        let screens = NSScreen::screens(marker()?);
        let screen = screens
            .firstObject()
            .ok_or("No macOS screen is available")?;
        let frame = screen.frame();
        Ok(frame.origin.y + frame.size.height)
    }

    fn window(handle: &WebviewWindow) -> Result<&NSWindow, String> {
        marker()?;
        let pointer = handle.ns_window().map_err(|error| error.to_string())?;
        // Tauri owns this NSWindow for the duration of the main-thread call.
        unsafe { (pointer as *const NSWindow).as_ref() }
            .ok_or_else(|| "Native window is unavailable".into())
    }

    pub fn mouse() -> Result<((f64, f64), bool), String> {
        marker()?;
        let position = NSEvent::mouseLocation();
        Ok((
            (position.x, screen_top()? - position.y),
            NSEvent::pressedMouseButtons() & 1 != 0,
        ))
    }

    pub fn position(handle: &WebviewWindow, x: f64, y: f64) -> Result<(), String> {
        window(handle)?.setFrameTopLeftPoint(NSPoint::new(x, screen_top()? - y));
        Ok(())
    }

    pub fn content_rect(handle: &WebviewWindow) -> Result<Rect, String> {
        let window = window(handle)?;
        let rect = window.contentRectForFrameRect(window.frame());
        Ok(Rect {
            x: rect.origin.x,
            y: screen_top()? - rect.origin.y - rect.size.height,
            width: rect.size.width,
            height: rect.size.height,
        })
    }

    pub fn owns_point(handle: &WebviewWindow, point: (f64, f64)) -> Result<bool, String> {
        let native_window = window(handle)?;
        let found = NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(
            NSPoint::new(point.0, screen_top()? - point.1),
            0,
            marker()?,
        );
        Ok(found == native_window.windowNumber())
    }

    pub fn work_areas() -> Result<Vec<Rect>, String> {
        let top = screen_top()?;
        Ok(NSScreen::screens(marker()?)
            .iter()
            .map(|screen| {
                let area = screen.visibleFrame();
                Rect {
                    x: area.origin.x,
                    y: top - area.origin.y - area.size.height,
                    width: area.size.width,
                    height: area.size.height,
                }
            })
            .collect())
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::Rect;
    use tauri::WebviewWindow;
    pub fn supported() -> bool {
        false
    }
    pub fn install_input_monitor(_: &tauri::AppHandle) -> Result<(), String> {
        Ok(())
    }
    pub fn mouse() -> Result<((f64, f64), bool), String> {
        Err("Native pet requires macOS".into())
    }
    pub fn position(_: &WebviewWindow, _: f64, _: f64) -> Result<(), String> {
        Err("Native pet requires macOS".into())
    }
    pub fn content_rect(_: &WebviewWindow) -> Result<Rect, String> {
        Err("Native pet requires macOS".into())
    }
    pub fn owns_point(_: &WebviewWindow, _: (f64, f64)) -> Result<bool, String> {
        Ok(false)
    }
    pub fn work_areas() -> Result<Vec<Rect>, String> {
        Err("Native pet requires macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docking_and_panel_placement_preserve_negative_display_coordinates() {
        let area = Rect {
            x: -1600.0,
            y: -900.0,
            width: 1600.0,
            height: 900.0,
        };
        assert_eq!(clamp_pet(-500.0, -700.0, area), (-500.0, -700.0));
        assert_eq!(clamp_pet(800.0, 900.0, area), (-228.0, -268.0));
        let anchor = Rect {
            x: -228.0,
            y: -268.0,
            width: PET_WIDTH,
            height: PET_HEIGHT,
        };
        let (x, y) = panel_position(anchor, CHAT_WIDTH, CHAT_HEIGHT, area);
        assert_eq!(x, -660.0);
        assert!(area.contains(x, y));
        assert!(x + CHAT_WIDTH <= area.x + area.width);
        assert!(y + CHAT_HEIGHT <= area.y + area.height);
    }

    #[test]
    fn alpha_mask_excludes_transparent_pixels_without_losing_buttons() {
        let mask = HitMask {
            width: 2,
            height: 2,
            alpha: vec![0, 255, 255, 0],
        };
        assert!(!mask.hit(10.0, 10.0));
        assert!(mask.hit(150.0, 10.0));
        assert!(mask.hit(10.0, 200.0));
        assert!(!mask.hit(200.0, 200.0));
        assert!(!mask.hit(220.0, 40.0));
    }

    #[test]
    fn persisted_presentation_has_no_runtime_snapshot_or_drag_origin() {
        let state = PetState {
            mode: PetMode::Floating,
            x: -1400.0,
            y: 120.0,
            snapshot: serde_json::json!({ "private": "conversation" }),
            ..PetState::default()
        };
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["mode"], "floating");
        assert_eq!(value["x"], -1400.0);
        assert!(value.get("snapshot").is_none());
        assert!(value.get("drag").is_none());
        let restored: PetState = serde_json::from_value(value).unwrap();
        assert_eq!(restored.mode, PetMode::Floating);
        assert!(restored.snapshot.is_null());
    }

    #[test]
    fn release_commits_once_and_escape_restores_both_drag_sources() {
        for mode in [PetMode::Docked, PetMode::Floating] {
            let mut state = PetState {
                mode,
                x: -400.0,
                y: 80.0,
                dragging: true,
                over_dock: mode == PetMode::Floating,
                drag: Some(DragOrigin {
                    mode,
                    hidden: false,
                    x: 12.0,
                    y: 34.0,
                    grab_x: 90.0,
                    grab_y: 100.0,
                }),
                ..PetState::default()
            };
            let mut cancelled = state.clone();
            assert!(cancelled.resolve_drag(true));
            assert_eq!(cancelled.mode, mode);
            assert_eq!((cancelled.x, cancelled.y), (12.0, 34.0));
            assert!(!cancelled.dragging);
            assert!(!cancelled.resolve_drag(false));

            assert!(state.resolve_drag(false));
            assert_eq!(
                state.mode,
                if mode == PetMode::Docked {
                    PetMode::Floating
                } else {
                    PetMode::Docked
                }
            );
            assert!(!state.dragging);
            assert!(state.drag.is_none());
            assert!(!state.resolve_drag(false));
        }
    }
}
