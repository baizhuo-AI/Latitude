//! Same-process macOS Speech/Vision bridge. No background microphone or browser
//! service is opened until a trusted visible composer invokes a command.
use serde::Serialize;
use serde_json::Value;
use tauri::WebviewWindow;

#[derive(Serialize)]
pub struct SpeechText { pub text: String }

pub fn check_composer(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "chatbar") { Ok(()) }
    else { Err("请从秘书对话窗口执行这个操作。".into()) }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::ffi::{c_char, c_void, CStr, CString};

    type Callback = unsafe extern "C" fn(*mut c_void, *const c_char);
    extern "C" {
        fn latitude_speech_start(callback: Callback, context: *mut c_void);
        fn latitude_speech_stop(callback: Callback, context: *mut c_void);
        fn latitude_speech_cancel(callback: Callback, context: *mut c_void);
        fn latitude_ocr_attachment(base64: *const c_char, callback: Callback, context: *mut c_void);
        fn latitude_pick_attachments(callback: Callback, context: *mut c_void);
    }

    unsafe extern "C" fn completed(context: *mut c_void, json: *const c_char) {
        let sender = Box::from_raw(context as *mut tokio::sync::oneshot::Sender<Result<Value, String>>);
        let result = if json.is_null() { Err("系统没有返回处理结果。".into()) }
        else { serde_json::from_slice(CStr::from_ptr(json).to_bytes()).map_err(|error| error.to_string()) };
        let _ = sender.send(result);
    }

    pub async fn call(operation: &str, input: Option<String>) -> Result<Value, String> {
        let encoded = input.map(CString::new).transpose().map_err(|_| "图片数据无法读取，请重新选择。".to_string())?;
        let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Value, String>>();
        {
            let context = Box::into_raw(Box::new(sender)) as *mut c_void;
            unsafe {
                match operation {
                    "start" => latitude_speech_start(completed, context),
                    "stop" => latitude_speech_stop(completed, context),
                    "cancel" => latitude_speech_cancel(completed, context),
                    "pick" => latitude_pick_attachments(completed, context),
                    "ocr" => {
                        latitude_ocr_attachment(encoded.as_ref().expect("OCR input is always supplied").as_ptr(), completed, context);
                    },
                    _ => unreachable!(),
                }
            }
        }
        let value = receiver.await.map_err(|_| "系统操作已中断，请重试。".to_string())??;
        if let Some(error) = value.get("error").and_then(Value::as_str) { Err(error.to_owned()) }
        else { Ok(value) }
    }
}

async fn media_call(operation: &str, input: Option<String>) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    { native::call(operation, input).await }
    #[cfg(not(target_os = "macos"))]
    { let _ = (operation, input); Err("系统语音和图片识别目前需要 macOS 桌面版。可以继续打字或添加文字文档。".into()) }
}

pub async fn choose_files() -> Result<Vec<String>, String> {
    let result = media_call("pick", None).await?;
    serde_json::from_value(result["paths"].clone()).map_err(|_| "没有取得所选文件，请重试。".to_string())
}

#[tauri::command]
pub async fn pet_speech_start(window: WebviewWindow) -> Result<(), String> {
    check_composer(&window)?;
    media_call("start", None).await.map(|_| ())
}

#[tauri::command]
pub async fn pet_speech_stop(window: WebviewWindow) -> Result<SpeechText, String> {
    check_composer(&window)?;
    let value = media_call("stop", None).await?;
    Ok(SpeechText { text: value["text"].as_str().unwrap_or_default().to_owned() })
}

#[tauri::command]
pub async fn pet_speech_cancel(window: WebviewWindow) -> Result<(), String> {
    check_composer(&window)?;
    media_call("cancel", None).await.map(|_| ())
}

#[tauri::command]
pub async fn pet_ocr_attachment(window: WebviewWindow, base64: String, mime_type: Option<String>) -> Result<SpeechText, String> {
    check_composer(&window)?;
    let _ = mime_type; // Vision determines image type from its actual bytes.
    let value = media_call("ocr", Some(base64)).await?;
    Ok(SpeechText { text: value["text"].as_str().unwrap_or_default().to_owned() })
}
