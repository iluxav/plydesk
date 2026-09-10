//! Local desktop keyboard integration. Independent of the SSH backend.
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[derive(Deserialize, Serialize)]
pub struct Binding { action: String, code: u16, modifiers: u8 }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    bindings: Vec<Binding>, enabled: bool, recording: bool, switching: bool, capture_system: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { native: bool, accessibility: bool, capture_ready: bool }

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::{ffi::{c_char, c_void, CStr, CString}, sync::OnceLock};
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    extern "C" {
        fn plydesk_keyboard_configure(window: *mut c_void, json: *const c_char, callback: extern "C" fn(*const c_char)) -> bool;
        fn plydesk_keyboard_trusted() -> bool;
        fn plydesk_keyboard_request_access();
    }
    extern "C" fn event(json: *const c_char) {
        // Copy the borrowed native JSON before the callback returns. Only the
        // trusted desktop webview receives action IDs; no keys are logged.
        let value = unsafe { CStr::from_ptr(json) }.to_str().ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
        if let (Some(app), Some(value)) = (APP.get(), value) {
            if let Some(main) = app.get_webview("main") { let _ = main.emit("desktop-shortcut", value); }
        }
    }
    pub fn configure(app: &tauri::AppHandle, config: Configuration) -> Result<Status, String> {
        let _ = APP.set(app.clone());
        let window = app.get_window("main").ok_or("desktop window is unavailable")?;
        let json = CString::new(serde_json::to_string(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let ready = unsafe { plydesk_keyboard_configure(window.ns_window().map_err(|e| e.to_string())?, json.as_ptr(), event) };
        Ok(Status { native: true, accessibility: unsafe { plydesk_keyboard_trusted() }, capture_ready: ready })
    }
    pub fn request() { unsafe { plydesk_keyboard_request_access() } }
}

#[tauri::command]
pub async fn keyboard_configure(webview: tauri::Webview, app: tauri::AppHandle, config: Configuration) -> Result<Status, String> {
    if webview.label() != "main" { return Err("desktop keyboard is available only to the main view".into()); }
    if config.bindings.len() > 32 || config.bindings.iter().any(|b| b.modifiers > 15 || b.modifiers & 14 == 0
        || b.code > 126 || !["snap-left", "snap-right", "maximize", "restore", "next-window", "previous-window", "minimize"].contains(&b.action.as_str())) {
        return Err("invalid desktop shortcuts".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || { let _ = tx.send(mac::configure(&handle, config)); }).map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, config); Ok(Status { native: false, accessibility: false, capture_ready: false }) }
}

#[tauri::command]
pub fn keyboard_request_access(webview: tauri::Webview, app: tauri::AppHandle) -> Result<(), String> {
    if webview.label() != "main" { return Err("desktop keyboard is available only to the main view".into()); }
    #[cfg(target_os = "macos")]
    app.run_on_main_thread(mac::request).map_err(|e| e.to_string())?;
    Ok(())
}
