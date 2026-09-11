//! User-created web and terminal launchers. Only the trusted desktop may
//! manage definitions or launch them; remote pages receive no native API.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::{Emitter, Manager, Webview, WebviewUrl, webview::{WebviewBuilder, NewWindowResponse}};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Launch {
    Web { url: String, #[serde(default)] allowed_origins: Vec<String> },
    Tui { machine: String, command: String, #[serde(default)] cwd: String, #[serde(default)] close_on_ctrl_c: bool },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Shortcut {
    #[serde(default)] pub id: String,
    pub name: String,
    pub icon: String,
    #[serde(flatten)] pub launch: Launch,
}
#[derive(Default)]
pub struct Shortcuts {
    save_lock: Mutex<()>,
    views: Mutex<HashMap<String, String>>,
}
fn desktop(view: &Webview) -> Result<(), String> {
    if view.label() == "main" { Ok(()) } else { Err("PermissionDenied: desktop only".into()) }
}
fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("shortcuts.json"))
}
fn read(path: &Path) -> Result<Vec<Shortcut>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    if bytes.len() > 8 * 1024 * 1024 { return Err("Shortcut catalog is too large".into()); }
    let mut entries: Vec<Shortcut> = serde_json::from_slice(&bytes).map_err(|e| format!("Cannot read shortcuts: {e}"))?;
    let mut ids = std::collections::HashSet::new();
    for entry in &mut entries {
        validate(entry)?;
        if entry.id.is_empty() || !ids.insert(entry.id.clone()) { return Err("Invalid or duplicate shortcut ID".into()); }
    }
    Ok(entries)
}
fn write(path: &Path, entries: &[Shortcut]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 { return Err("Shortcut catalog is full; remove unused shortcuts before adding more".into()); }
    fs::create_dir_all(path.parent().ok_or("Invalid shortcut path")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| e.to_string())
}
pub fn get(app: &tauri::AppHandle, id: &str) -> Result<Shortcut, String> {
    read(&path(app)?)?.into_iter().find(|s| s.id == id).ok_or("Shortcut no longer exists".into())
}
fn web_url(value: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = value.parse().map_err(|_| "Enter a complete http:// or https:// URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Use an HTTP or HTTPS URL without an embedded username or password".into());
    }
    Ok(url)
}
fn validate(s: &mut Shortcut) -> Result<(), String> {
    if !s.id.is_empty() && !s.id.strip_prefix("shortcut-").is_some_and(|v| uuid::Uuid::parse_str(v).is_ok()) { return Err("Invalid shortcut ID".into()); }
    s.name = s.name.trim().into();
    if s.name.is_empty() || s.name.chars().count() > 120 || s.name.chars().any(char::is_control) { return Err("Enter a name of up to 120 characters".into()); }
    if s.icon.is_empty() || s.icon.len() > 100 || s.icon.chars().any(char::is_control) { return Err("Choose an icon".into()); }
    match &mut s.launch {
        Launch::Web { url, allowed_origins } => {
            *url = web_url(url.trim())?.to_string();
            if allowed_origins.len() > 20 { return Err("Use at most 20 additional domains".into()); }
            for origin in allowed_origins.iter_mut() {
                let parsed = web_url(origin.trim())?;
                if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() { return Err("Additional domains must be origins such as https://login.example.com".into()); }
                *origin = parsed.origin().ascii_serialization();
            }
            allowed_origins.sort(); allowed_origins.dedup();
        }
        Launch::Tui { machine, command, cwd, .. } => {
            *machine = machine.trim().into(); *command = command.trim().into(); *cwd = cwd.trim().into();
            if machine.is_empty() || machine.len() > 300 || machine.starts_with('-') || machine.chars().any(char::is_whitespace) { return Err("Choose a saved SSH machine".into()); }
            if command.is_empty() || command.len() > 8192 || command.contains('\0') { return Err("Enter a terminal command".into()); }
            if cwd.len() > 4096 || cwd.contains('\0') { return Err("Invalid working directory".into()); }
        }
    }
    Ok(())
}
#[tauri::command]
pub fn shortcuts_list(app: tauri::AppHandle, webview: Webview) -> Result<Vec<Shortcut>, String> {
    desktop(&webview)?; read(&path(&app)?)
}
#[tauri::command]
pub fn shortcuts_save(app: tauri::AppHandle, webview: Webview, mut shortcut: Shortcut) -> Result<Shortcut, String> {
    desktop(&webview)?; validate(&mut shortcut)?;
    let state = app.state::<Shortcuts>(); let _guard = state.save_lock.lock().map_err(|e| e.to_string())?;
    let path = path(&app)?; let mut entries = read(&path)?;
    if shortcut.id.is_empty() {
        if entries.len() >= 10000 { return Err("Shortcut limit reached".into()); }
        shortcut.id = format!("shortcut-{}", uuid::Uuid::new_v4()); entries.push(shortcut.clone());
    } else {
        let previous = entries.iter_mut().find(|s| s.id == shortcut.id).ok_or("Shortcut no longer exists")?;
        if std::mem::discriminant(&previous.launch) != std::mem::discriminant(&shortcut.launch) { return Err("Create a new shortcut to change its type".into()); }
        *previous = shortcut.clone();
    }
    write(&path, &entries)?;
    app.emit_to("main", "shortcuts-changed", ()).map_err(|e| e.to_string())?;
    Ok(shortcut)
}
#[tauri::command]
pub fn shortcuts_remove(app: tauri::AppHandle, webview: Webview, id: String) -> Result<(), String> {
    desktop(&webview)?;
    let state = app.state::<Shortcuts>(); let _guard = state.save_lock.lock().map_err(|e| e.to_string())?;
    let path = path(&app)?; let mut entries = read(&path)?;
    entries.retain(|s| s.id != id); write(&path, &entries)?;
    app.emit_to("main", "shortcuts-changed", ()).map_err(|e| e.to_string())
}
pub fn terminal_launch(app: &tauri::AppHandle, id: &str, target: &str) -> Result<(Shortcut, String), String> {
    let s = get(app, id)?;
    match &s.launch {
        Launch::Tui { machine, command, cwd, .. } if machine == target => {
            let command = shell_command(command, cwd);
            Ok((s, command))
        }
        Launch::Tui { .. } => Err("This terminal shortcut belongs to another machine".into()),
        _ => Err("This is not a terminal shortcut".into()),
    }
}
fn quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }
fn shell_command(command: &str, cwd: &str) -> String {
    // A login shell supplies the user's usual environment. It runs just this
    // command and exits; quitting the TUI never drops into an interactive shell.
    let directory = if cwd.is_empty() || cwd == "~" { "\"$HOME\"".into() }
        else if let Some(rest) = cwd.strip_prefix("~/") { format!("\"$HOME\"/{}", quote(rest)) }
        else { quote(cwd) };
    let script = format!("cd -- {directory} || exit $?; {command}");
    format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", quote(&script))
}
fn internal(url: &tauri::Url, origin: &str, allowed: &[String]) -> bool {
    matches!(url.scheme(), "http" | "https") && (url.origin().ascii_serialization() == origin || allowed.contains(&url.origin().ascii_serialization()))
}
fn external(url: &tauri::Url, throttle: &Mutex<Option<Instant>>) {
    if web_url(url.as_str()).is_err() { return; }
    let Ok(mut last) = throttle.lock() else { return };
    if last.is_some_and(|t| t.elapsed() < Duration::from_secs(1)) { return; }
    *last = Some(Instant::now());
    // URL parsing above rejects file:, javascript:, and arbitrary app schemes.
    #[cfg(target_os = "macos")] { let _ = std::process::Command::new("open").arg(url.as_str()).spawn(); }
    #[cfg(target_os = "linux")] { let _ = std::process::Command::new("xdg-open").arg(url.as_str()).spawn(); }
    #[cfg(windows)] { let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler",url.as_str()]).spawn(); }
}
#[tauri::command]
pub async fn shortcut_web_open(app: tauri::AppHandle, webview: Webview, id: String) -> Result<String, String> {
    desktop(&webview)?;
    let s = get(&app,&id)?;
    let Launch::Web { url, allowed_origins } = s.launch else { return Err("This is not a web shortcut".into()) };
    let url = web_url(&url)?; let origin = url.origin().ascii_serialization();
    let throttle = Arc::new(Mutex::new(None)); let popup_throttle = throttle.clone();
    let label = format!("web-shortcut-{}",uuid::Uuid::new_v4());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .on_navigation(move |url| { if internal(url,&origin,&allowed_origins) { true } else { external(url,&throttle); false } })
        .on_new_window(move |url,_| { external(&url,&popup_throttle); NewWindowResponse::Deny })
        .on_page_load(|view, page| {
            let _ = view.emit_to("main", "shortcut-web-load", json!({
                "label": view.label(), "url": page.url().as_str(),
                "loading": matches!(page.event(), tauri::webview::PageLoadEvent::Started)
            }));
        })
        .disable_drag_drop_handler();
    let view = app.get_window("main").ok_or("Desktop is unavailable")?.add_child(builder,tauri::LogicalPosition::new(-10000.,-10000.),tauri::LogicalSize::new(1.,1.)).map_err(|e| e.to_string())?;
    let _ = view.hide();
    app.state::<Shortcuts>().views.lock().map_err(|e| e.to_string())?.insert(label.clone(), id);
    Ok(label)
}
fn web_view(app: &tauri::AppHandle, label: &str) -> Result<Webview, String> {
    if !app.state::<Shortcuts>().views.lock().map_err(|e| e.to_string())?.contains_key(label) { return Err("Web shortcut is closed".into()); }
    app.get_webview(label).ok_or("Web shortcut is closed".into())
}
#[tauri::command]
pub fn shortcut_web_close(app: tauri::AppHandle, webview: Webview, label: String) -> Result<(), String> {
    desktop(&webview)?;
    let owned = app.state::<Shortcuts>().views.lock().map_err(|e| e.to_string())?.remove(&label).is_some();
    if owned {
        if let Some(view) = app.get_webview(&label) { view.close().map_err(|e| e.to_string())?; }
    }
    Ok(())
}
#[tauri::command]
pub async fn shortcut_web_snapshot(app: tauri::AppHandle, webview: Webview, label: String) -> Result<String, String> {
    desktop(&webview)?; web_view(&app,&label)?; crate::runtime::snapshot_view(&app,label).await
}
#[tauri::command]
pub fn shortcut_web_browser(app: tauri::AppHandle, webview: Webview, label: String) -> Result<(), String> {
    desktop(&webview)?;
    let url = web_view(&app,&label)?.url().map_err(|e| e.to_string())?;
    web_url(url.as_str())?; external(&url,&Mutex::new(None)); Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn web() -> Shortcut { serde_json::from_value(json!({"name":"Docs","icon":"lucide:globe","kind":"web","url":"https://example.com/docs"})).unwrap() }
    #[test] fn web_navigation_stays_inside_explicit_origins() {
        let allowed = vec!["https://login.example.com".into()];
        assert!(internal(&"https://example.com/another".parse().unwrap(),"https://example.com",&allowed));
        assert!(internal(&"https://login.example.com/start".parse().unwrap(),"https://example.com",&allowed));
        for url in ["https://example.com.evil.test/","http://example.com/","https://example.com:444/","file:///tmp/x","tauri://localhost"] {
            assert!(!internal(&url.parse().unwrap(),"https://example.com",&allowed));
        }
    }
    #[test] fn unsafe_urls_and_malformed_definitions_are_rejected() {
        for url in ["file:///etc/passwd","javascript:alert(1)","https://user:password@example.com/"] { assert!(web_url(url).is_err()); }
        let mut s = web(); s.id = "settings".into(); assert!(validate(&mut s).is_err());
        s = web(); s.name = " ".into(); assert!(validate(&mut s).is_err());
    }
    #[test] fn save_reload_and_removal_preserve_other_definitions() {
        let dir = std::env::temp_dir().join(format!("plydesk-shortcuts-test-{}",uuid::Uuid::new_v4()));
        let path = dir.join("shortcuts.json"); let mut s = web(); s.id = format!("shortcut-{}",uuid::Uuid::new_v4());
        write(&path,&[s.clone()]).unwrap(); assert_eq!(read(&path).unwrap()[0].name,"Docs");
        write(&path,&[]).unwrap(); assert!(read(&path).unwrap().is_empty());
        fs::write(&path,"broken").unwrap(); assert!(read(&path).is_err()); fs::remove_dir_all(dir).unwrap();
    }
    #[test] fn terminal_working_directory_is_quoted_and_command_has_no_interactive_fallback() {
        assert_eq!(shell_command("htop",""), "exec \"${SHELL:-/bin/sh}\" -lc 'cd -- \"$HOME\" || exit $?; htop'");
        let script = shell_command("printf '%s' ok", "~/a folder/it's here");
        assert!(script.contains("$HOME")); assert!(!script.contains("; bash"));
        assert!(shell_command("false", "/tmp/$(touch unsafe)").contains("'\\''/tmp/$(touch unsafe)'\\''"));
    }
    #[cfg(unix)]
    #[test] fn terminal_command_runs_in_the_selected_directory_and_returns_its_exit_status() {
        let dir = std::env::temp_dir().join(format!("plydesk-cwd-{}", uuid::Uuid::new_v4())).join("a folder with ' and $ characters");
        fs::create_dir_all(&dir).unwrap();
        let run = |command: &str, cwd: &str| std::process::Command::new("/bin/sh")
            .args(["-c", &shell_command(command, cwd)]).output().unwrap();
        let output = run("printf '%s' \"$PWD\"", dir.to_str().unwrap());
        assert!(output.status.success());
        assert_eq!(fs::canonicalize(String::from_utf8(output.stdout).unwrap()).unwrap(), fs::canonicalize(&dir).unwrap());
        assert_eq!(run("exit 42", dir.to_str().unwrap()).status.code(), Some(42));
        let output = run("printf MUST_NOT_RUN; printf ALSO_MUST_NOT_RUN", dir.join("missing").to_str().unwrap());
        assert!(!output.status.success()); assert!(!String::from_utf8_lossy(&output.stdout).contains("MUST_NOT_RUN"));
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
