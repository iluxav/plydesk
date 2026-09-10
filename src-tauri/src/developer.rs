//! Local development folders. This module never connects to a remote machine.
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, sync::Mutex, time::UNIX_EPOCH};
use tauri::{Manager, State};

#[derive(Default)]
pub struct DeveloperApps(Mutex<()>);

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    enabled: bool,
    apps: Vec<LocalApp>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct LocalApp {
    directory: String,
    enabled: bool,
    #[serde(default)]
    watch: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Change {
    Mode { enabled: bool },
    Add { directory: String },
    Update { directory: String, enabled: Option<bool>, watch: Option<bool> },
    Remove { directory: String },
    Describe { directory: String, name: String, icon: String },
}

#[derive(Serialize)]
pub struct Source {
    name: String,
    dir: String,
    manifest: crate::runtime::Manifest,
    stamp: String,
}

fn trusted(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("Only the desktop can manage local apps".into()); }
    Ok(())
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("developer-apps.json"))
}

fn read_config(path: &Path) -> Result<Config, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Cannot read developer settings: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(format!("Cannot read developer settings: {e}")),
    }
}

fn save_config(path: &Path, config: &Config) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid settings path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&temporary, bytes).map_err(|e| format!("Cannot save developer settings: {e}"))?;
    fs::rename(&temporary, path).map_err(|e| format!("Cannot save developer settings: {e}"))
}

fn app_directory(directory: &str) -> Result<PathBuf, String> {
    let trimmed = directory.trim();
    let expanded = if let Some(rest) = trimmed.strip_prefix("~/") {
        PathBuf::from(std::env::var_os("HOME").ok_or("Home directory is unavailable")?).join(rest)
    } else { PathBuf::from(trimmed) };
    if !expanded.is_absolute() { return Err("Choose a folder or enter an absolute path".into()); }
    let dir = fs::canonicalize(expanded).map_err(|e| format!("Cannot open app folder: {e}"))?;
    if !dir.is_dir() { return Err("Choose the app folder, rather than a file".into()); }
    if !dir.join("index.js").is_file() {
        return Err("This folder needs an index.js entry file. For JSX or TypeScript, build your app first and select its output folder.".into());
    }
    crate::runtime::manifest_at(&dir)?;
    Ok(dir)
}

fn change_config(config: &mut Config, change: Change) -> Result<(), String> {
    match change {
        Change::Mode { enabled } => config.enabled = enabled,
        Change::Add { directory } => {
            if !config.enabled { return Err("Enable developer mode first".into()); }
            let directory = app_directory(&directory)?.to_string_lossy().into_owned();
            if config.apps.iter().any(|app| app.directory == directory) {
                return Err("This folder is already registered".into());
            }
            config.apps.push(LocalApp { directory, enabled: true, watch: false, name: None, icon: None });
        }
        Change::Update { directory, enabled, watch } => {
            let entry = config.apps.iter_mut().find(|a| a.directory == directory).ok_or("App folder is no longer registered")?;
            if let Some(value) = enabled { entry.enabled = value; }
            if let Some(value) = watch { entry.watch = value; }
        }
        Change::Describe { directory, name, icon } => {
            let entry = config.apps.iter_mut().find(|a| a.directory == directory).ok_or("App folder is no longer registered")?;
            entry.name = Some(name);
            entry.icon = Some(icon);
        }
        Change::Remove { directory } => config.apps.retain(|a| a.directory != directory),
    }
    Ok(())
}

fn registered<'a>(config: &'a Config, directory: &str) -> Result<&'a LocalApp, String> {
    if !config.enabled { return Err("Developer mode is off".into()); }
    config.apps.iter().find(|a| a.enabled && a.directory == directory).ok_or("App folder is not enabled".into())
}

// Metadata polling avoids a persistent watcher per folder and ignores node_modules.
fn stamp(dir: &Path) -> String {
    ["manifest.json", "index.js", "style.css"].iter().map(|name| match fs::metadata(dir.join(name)) {
        Ok(m) => format!("{}:{}", m.len(), m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|t| t.as_nanos()).unwrap_or(0)),
        Err(e) => format!("{:?}", e.kind()),
    }).collect::<Vec<_>>().join("|")
}

fn read_source(directory: &str) -> Result<Source, String> {
    let dir = Path::new(directory);
    let before = stamp(dir);
    let manifest = crate::runtime::manifest_at(dir)?;
    let after = stamp(dir);
    if before != after { return Err("App files changed while loading. Wait for the build to finish, then reload.".into()); }
    Ok(Source { name: dir.file_name().unwrap_or_default().to_string_lossy().into_owned(), dir: directory.into(), manifest, stamp: after })
}

#[tauri::command]
pub fn developer_apps_get(app: tauri::AppHandle, webview: tauri::Webview, state: State<DeveloperApps>) -> Result<Config, String> {
    trusted(&webview)?;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    read_config(&config_path(&app)?)
}

#[tauri::command]
pub fn developer_apps_change(app: tauri::AppHandle, webview: tauri::Webview, state: State<DeveloperApps>, change: Change) -> Result<Config, String> {
    trusted(&webview)?;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let path = config_path(&app)?;
    let mut config = read_config(&path)?;
    change_config(&mut config, change)?;
    save_config(&path, &config)?;
    Ok(config)
}

#[tauri::command]
pub fn developer_open_devtools(app: tauri::AppHandle, webview: tauri::Webview, state: State<DeveloperApps>) -> Result<(), String> {
    trusted(&webview)?;
    {
        let _guard = state.0.lock().map_err(|e| e.to_string())?;
        if !read_config(&config_path(&app)?)?.enabled {
            return Err("Enable developer mode to open DevTools".into());
        }
    }
    // The desktop inspector is separate from each running app inspector.
    webview.open_devtools();
    Ok(())
}

#[tauri::command]
pub fn developer_app_read(app: tauri::AppHandle, webview: tauri::Webview, state: State<DeveloperApps>, directory: String) -> Result<Source, String> {
    trusted(&webview)?;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    registered(&read_config(&config_path(&app)?)?, &directory)?;
    read_source(&directory)
}

#[tauri::command]
pub fn developer_app_stamps(app: tauri::AppHandle, webview: tauri::Webview, state: State<DeveloperApps>) -> Result<Vec<(String, String)>, String> {
    trusted(&webview)?;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let config = read_config(&config_path(&app)?)?;
    Ok(config.apps.iter().filter(|a| config.enabled && a.enabled && a.watch)
        .map(|a| (a.directory.clone(), stamp(Path::new(&a.directory)))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registrations_persist_and_removal_keeps_source() {
        let root = std::env::temp_dir().join(format!("plydesk-dev-test-{}", std::process::id()));
        let plugin = root.join("my app");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("index.js"), "export const manifest = {}").unwrap();
        fs::write(plugin.join("manifest.json"), r#"{"schemaVersion":1,"id":"test-app","name":"Test","version":"1","permissions":[]}"#).unwrap();
        let mut config = Config::default();
        assert!(change_config(&mut config, Change::Add { directory: plugin.to_string_lossy().into() }).is_err());
        config.enabled = true;
        change_config(&mut config, Change::Add { directory: plugin.to_string_lossy().into() }).unwrap();
        let directory = config.apps[0].directory.clone();
        assert!(change_config(&mut config, Change::Add { directory: directory.clone() }).is_err());
        let path = root.join("settings.json");
        save_config(&path, &config).unwrap();
        let mut saved = read_config(&path).unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.apps[0].directory, directory);
        assert!(registered(&saved, &directory).is_ok());
        assert!(registered(&saved, "/unregistered").is_err());
        change_config(&mut saved, Change::Update { directory: directory.clone(), enabled: Some(false), watch: Some(true) }).unwrap();
        assert!(registered(&saved, &directory).is_err());
        change_config(&mut saved, Change::Remove { directory }).unwrap();
        assert!(saved.apps.is_empty());
        assert!(plugin.join("index.js").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_settings_are_reported_instead_of_overwritten() {
        let path = std::env::temp_dir().join(format!("plydesk-dev-invalid-{}.json", std::process::id()));
        fs::write(&path, "broken").unwrap();
        assert!(read_config(&path).is_err());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn missing_entry_is_rejected() {
        assert!(app_directory("relative/path").is_err());
        assert!(read_source("/nonexistent/plydesk-test").is_err());
    }
}

pub fn mode_enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    Ok(read_config(&config_path(app)?)?.enabled)
}
pub fn enabled_directory(app: &tauri::AppHandle, directory: &str) -> Result<bool, String> {
    let config = read_config(&config_path(app)?)?;
    Ok(config.enabled && config.apps.iter().any(|a| a.enabled && a.directory == directory))
}
