//! Native paths are readable only after a real OS file drop or NSOpenPanel
//! selection. Frontend callers cannot expand a directory into arbitrary reads.
use std::{collections::HashSet, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::{AppHandle, WebviewWindow};

static ALLOWED_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
fn allowed() -> &'static Mutex<HashSet<PathBuf>> { ALLOWED_PATHS.get_or_init(|| Mutex::new(HashSet::new())) }

pub fn authorize_dropped_files(_app: &AppHandle, paths: &[PathBuf]) {
    if let Ok(mut entries) = allowed().lock() {
        for path in paths {
            if let Ok(canonical) = path.canonicalize() {
                if canonical.is_file() { entries.insert(canonical); }
            }
        }
    }
}

fn authorized_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|_| "找不到这个文件，请从本机重新选择。".to_string())?;
    if !allowed().lock().map_err(|_| "文件授权暂时不可用。".to_string())?.contains(&canonical) {
        return Err("请先通过选择文件或拖放操作添加这个文件。".into());
    }
    if !canonical.is_file() { return Err("请添加具体文件，暂不支持文件夹。".into()); }
    Ok(canonical)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAttachment { name: String, mime_type: String, base64: String }

#[tauri::command]
pub async fn pet_pick_attachments(app: AppHandle, window: WebviewWindow) -> Result<Vec<String>, String> {
    crate::speech::check_composer(&window)?;
    let paths = crate::speech::choose_files().await?;
    authorize_dropped_files(&app, &paths.iter().map(PathBuf::from).collect::<Vec<_>>());
    Ok(paths)
}

#[tauri::command]
pub async fn pet_read_attachment(window: WebviewWindow, path: String) -> Result<NativeAttachment, String> {
    crate::speech::check_composer(&window)?;
    let path = authorized_path(Path::new(&path))?;
    tokio::task::spawn_blocking(move || {
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_lowercase();
        let mime_type = match extension.as_str() {
            "txt" | "md" | "markdown" => "text/plain", "csv" => "text/csv", "pdf" => "application/pdf",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp",
            _ => return Err("暂不支持这个文件格式，请转为 TXT、Markdown、CSV、PDF 或 DOCX。".into()),
        };
        let bytes = std::fs::read(&path).map_err(|_| "文件读取失败。请检查权限，云盘文件请先下载到本机。".to_string())?;
        Ok(NativeAttachment { name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(), mime_type: mime_type.into(), base64: STANDARD.encode(bytes) })
    }).await.map_err(|_| "文件读取已中断，请重新添加。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_existing_file_is_not_authorized_by_a_frontend_path_alone() {
        let file = std::env::temp_dir().join(format!("latitude-unselected-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&file, "private").unwrap();
        assert!(authorized_path(&file).unwrap_err().contains("选择文件"));
        std::fs::remove_file(file).unwrap();
    }
}
