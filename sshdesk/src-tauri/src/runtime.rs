//! Installed code is data until the desktop launches a permission-bound webview.
//! This is the app boundary; the SSH/SFTP implementations remain in core.
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::{Duration, Instant}};
use tauri::{Emitter, Manager, Webview, WebviewUrl, webview::{WebviewBuilder, NewWindowResponse}};

const LIMIT: usize = 16 * 1024 * 1024;
const PERMISSIONS: &[&str] = &["remote.files.read", "remote.files.write", "remote.exec", "remote.sudo", "remote.dbus", "remote.system", "remote.tunnels", "desktop.openUrl", "desktop.embed", "network"];
const RESERVED: &[&str] = &["desk", "files", "editor", "terminal", "settings", "packages", "image"];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub icon: String,
    #[serde(default)] pub permissions: Vec<String>,
    #[serde(flatten)] pub extra: serde_json::Map<String, Value>,
}
#[derive(Clone, Serialize)]
pub struct CatalogEntry {
    pub name: String, pub dir: String,
    pub manifest: Option<Manifest>, pub error: Option<String>,
}
#[derive(Clone)]
struct Package {
    dir: String, manifest: Manifest, source: String, style: String,
    digest: String, identity: String, grant: String, developer: bool,
}
struct Prepared { package: Arc<Package>, host: String, created: Instant }
struct Session {
    package: Arc<Package>, host: String, win_id: String, context: Mutex<Value>, props: Value,
    watching: AtomicBool, alive: AtomicBool, in_flight: AtomicUsize, rate: Mutex<(Instant, u32)>,
    // One pending desktop interaction per app; flooding prompts is not allowed.
    interaction: Mutex<Option<(String, Instant)>>,
    // Desktop-facing events that could be abused by repetition.
    throttle: Mutex<HashMap<&'static str, Instant>>,
    forwards: Mutex<HashMap<String, u16>>,
    embedded: Mutex<Option<String>>,
}
impl Session {
    fn new(package: Arc<Package>, host: String, win_id: String, props: Value, context: Value) -> Self {
        Session { package, host, win_id, props, context: Mutex::new(context), watching: AtomicBool::new(false), alive: AtomicBool::new(true), in_flight: AtomicUsize::new(0),
            rate: Mutex::new((Instant::now(), 0)), interaction: Mutex::new(None), throttle: Mutex::new(HashMap::new()), forwards: Mutex::new(HashMap::new()), embedded: Mutex::new(None) }
    }
}
// Recheck a queued request after the shared SSH host lock is acquired. A
// closed app cannot leave work queued behind another app's slow operation.
thread_local! { static REQUEST: std::cell::RefCell<Option<std::sync::Weak<Session>>> = const { std::cell::RefCell::new(None) }; }
struct RequestScope(Option<std::sync::Weak<Session>>);
impl RequestScope {
    fn enter(s: &Arc<Session>) -> Self { Self(REQUEST.with(|r| r.replace(Some(Arc::downgrade(s))))) }
}
impl Drop for RequestScope { fn drop(&mut self) { REQUEST.with(|r| r.replace(self.0.take())); } }
pub fn ensure_request_alive() -> Result<(), String> {
    REQUEST.with(|r| match r.borrow().as_ref() {
        Some(s) if !s.upgrade().is_some_and(|s| s.alive.load(Ordering::SeqCst)) => Err("App is closed".into()),
        _ => Ok(()),
    })
}
#[derive(Default)]
pub struct Runtimes {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    prepared: Mutex<HashMap<String, Prepared>>,
    grants_lock: Mutex<()>,
    // Serializes lease acquisition/release, including completion after close.
    tunnel_lock: Mutex<()>,
    leases: Mutex<HashMap<String, (HashSet<String>, bool)>>,
}
#[derive(Serialize)]
pub struct Preview { ticket: String, manifest: Manifest, digest: String, approved: bool, developer: bool }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo { label: String, app_id: String, name: String, directory: String, host: String, win_id: String }

fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> { m.lock().map_err(|_| "App runtime lock unavailable".into()) }
pub fn desktop(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("PermissionDenied: desktop-only operation".into()); }
    Ok(())
}
fn hash(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for part in parts { h.update((part.len() as u64).to_le_bytes()); h.update(part); }
    format!("{:x}", h.finalize())
}
fn read_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    if !meta.is_file() || meta.len() > limit as u64 { return Err(format!("{} exceeds the file limit", path.display())); }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > limit { return Err("File changed while reading".into()); }
    Ok(bytes)
}
pub fn manifest_at(dir: &Path) -> Result<Manifest, String> {
    let bytes = read_file(&dir.join("manifest.json"), 128 * 1024)
        .map_err(|_| "Add a static manifest.json beside index.js. Apps are no longer executed during discovery.".to_string())?;
    let m: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid manifest.json: {e}"))?;
    validate_manifest(&m)?;
    Ok(m)
}
fn validate_manifest(m: &Manifest) -> Result<(), String> {
    if m.schema_version != 1 { return Err("Unsupported manifest schemaVersion; expected 1".into()); }
    if m.id.is_empty() || m.id.len() > 80 || !m.id.as_bytes()[0].is_ascii_lowercase()
        || !m.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        || RESERVED.contains(&m.id.as_str()) { return Err("Invalid or reserved app ID".into()); }
    if m.name.trim().is_empty() || m.name.len() > 100 || m.version.trim().is_empty() || m.version.len() > 80 {
        return Err("App name and version are required (maximum 100 and 80 characters)".into());
    }
    if m.permissions.iter().any(|p| !PERMISSIONS.contains(&p.as_str())) { return Err("Manifest contains an unsupported permission".into()); }
    if m.permissions.len() > PERMISSIONS.len() || m.permissions.iter().collect::<HashSet<_>>().len() != m.permissions.len() { return Err("Duplicate or excessive permissions".into()); }
    if let Some(window) = m.extra.get("window") {
        if !window.is_object() { return Err("window must be an object".into()); }
        for key in ["w","h"] { if let Some(v) = window.get(key) { if !v.as_f64().is_some_and(|n| n > 0. && n <= 10000.) { return Err("Invalid window dimensions".into()); } } }
    }
    if let Some(opens) = m.extra.get("opens") {
        let list = opens.as_array().ok_or("opens must be an array")?;
        if list.len() > 100 || list.iter().any(|v| !v.as_str().is_some_and(|v| v.len() <= 200)) { return Err("Invalid file associations".into()); }
    }
    if let Some(reqs) = m.extra.get("requires") {
        let parsed: Vec<sshdesk_core::deps::Requirement> = serde_json::from_value(reqs.clone()).map_err(|e| format!("Invalid requirements: {e}"))?;
        if !parsed.is_empty() && !m.permissions.iter().any(|p| p == "remote.exec") { return Err("Apps with remote dependencies must declare remote.exec".into()); }
    }
    if let Some(tokens) = m.extra.get("tokens") {
        let tokens = tokens.as_object().ok_or("tokens must be an object")?;
        if tokens.len() > 100 { return Err("Too many appearance tokens".into()); }
        for (name, token) in tokens {
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') { return Err("Invalid token name".into()); }
            let kind = token["type"].as_str().ok_or("Token type is required")?;
            let value = token["default"].as_str().ok_or("Token default must be a string")?;
            if !token["label"].is_string() || value.len() > 1000 { return Err("Invalid token declaration".into()); }
            if !safe_token(kind, value) { return Err(format!("Unsafe appearance value for {name}")); }
        }
    }
    Ok(())
}
fn safe_token(kind: &str, value: &str) -> bool {
    if let Some(reference) = value.strip_prefix('@') { return reference.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)); }
    match kind {
        "icon" | "image" => !value.chars().any(|c| c.is_control()),
        "color" => {
            let v = value.trim();
            if v.bytes().all(|b| b.is_ascii_alphabetic()) { return true; }
            if let Some(hex) = v.strip_prefix('#') { return [3,4,6,8].contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit()); }
            ["rgb(","rgba(","hsl(","hsla(","oklch(","oklab(","lch(","lab("].iter().any(|prefix| v.starts_with(prefix))
                && v.bytes().all(|b| b.is_ascii_alphanumeric() || b" .,%-/+()".contains(&b))
        },
        "length" => {
            let at = value.find(|c: char| c.is_ascii_alphabetic() || c == '%').unwrap_or(value.len());
            value[..at].parse::<f64>().is_ok() && ["","px","rem","em","%","vh","vw"].contains(&&value[at..])
        },
        _ => false,
    }
}

pub fn catalog_entry(dir: &Path) -> CatalogEntry {
    let result = manifest_at(dir);
    CatalogEntry { name: dir.file_name().unwrap_or_default().to_string_lossy().into(), dir: dir.to_string_lossy().into(),
        manifest: result.as_ref().ok().cloned(), error: result.err() }
}
fn package_at(app: &tauri::AppHandle, directory: &str, host: &str) -> Result<Package, String> {
    let dir = fs::canonicalize(directory).map_err(|e| e.to_string())?;
    let directory = dir.to_string_lossy().into_owned();
    let developer = crate::developer::enabled_directory(app, &directory)?;
    let installed = crate::plugin_roots(app).iter().any(|root| fs::canonicalize(root).ok().as_deref() == dir.parent());
    if !developer && !installed { return Err("App is not installed or enabled in Developer settings".into()); }
    let manifest = manifest_at(&dir)?;
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    let source = String::from_utf8(read_file(&dir.join("index.js"), LIMIT)?).map_err(|e| e.to_string())?;
    let style = if dir.join("style.css").exists() { String::from_utf8(read_file(&dir.join("style.css"), LIMIT)?).map_err(|e| e.to_string())? } else { String::new() };
    // The snapshot, not mutable disk contents, is served for this runtime's lifetime.
    let digest = hash(&[&manifest_bytes, source.as_bytes(), style.as_bytes()]);
    let identity = hash(&[directory.as_bytes(), manifest.id.as_bytes()]);
    // Developer approval explicitly covers edits in this registered folder;
    // changing its manifest requires new consent. Published packages pin bytes.
    let grant = hash(&[identity.as_bytes(), host.as_bytes(), if developer { &manifest_bytes } else { digest.as_bytes() }]);
    Ok(Package { dir: directory, manifest, source, style, digest, identity, grant, developer })
}
fn grants_path(app: &tauri::AppHandle) -> Result<PathBuf, String> { Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("app-grants.json")) }
fn grants(app: &tauri::AppHandle) -> Result<HashMap<String, Value>, String> {
    let path = grants_path(app)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Cannot read app approvals: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(e.to_string()),
    }
}
fn save_grants(app: &tauri::AppHandle, value: &HashMap<String, Value>) -> Result<(), String> {
    let path = grants_path(app)?;
    fs::create_dir_all(path.parent().ok_or("Invalid approval path")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| e.to_string())
}
fn session(app: &tauri::AppHandle, label: &str) -> Result<Arc<Session>, String> {
    lock(&app.state::<Runtimes>().sessions)?.get(label).filter(|s| s.alive.load(Ordering::SeqCst)).cloned().ok_or("PermissionDenied: app runtime is closed".into())
}
fn info(label: &str, s: &Session) -> RuntimeInfo { RuntimeInfo { label: label.into(), app_id: s.package.manifest.id.clone(), name: s.package.manifest.name.clone(), directory: s.package.dir.clone(), host: s.host.clone(), win_id: s.win_id.clone() } }
fn changed(app: &tauri::AppHandle) { let _ = app.emit_to("main", "app-runtimes-changed", ()); }
fn require(s: &Session, permission: &str) -> Result<(), String> {
    if !s.package.manifest.permissions.iter().any(|p| p == permission) { return Err(format!("PermissionDenied: {permission}")); } Ok(())
}
fn evaluate(app: &tauri::AppHandle, label: &str, kind: &str, payload: Value) -> Result<(), String> {
    let view = app.get_webview(label).ok_or("App view is closed")?;
    let value = serde_json::to_string(&json!({"kind":kind,"payload":payload})).map_err(|e| e.to_string())?;
    view.eval(format!("window.dispatchEvent(new CustomEvent('sshdesk:runtime', {{detail:{value}}}))")).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn runtime_prepare(app: tauri::AppHandle, webview: Webview, directory: String, host: String) -> Result<Preview, String> {
    desktop(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !lock(&app.state::<crate::Hosts>().0)?.contains_key(&host) { return Err("Connect to a machine before opening an app".into()); }
        let package = Arc::new(package_at(&app, &directory, &host)?);
        let state = app.state::<Runtimes>();
        let _g = lock(&state.grants_lock)?;
        let approved = package.manifest.permissions.is_empty() || grants(&app)?.contains_key(&package.grant);
        let ticket = uuid::Uuid::new_v4().to_string();
        let result = Preview { ticket: ticket.clone(), manifest: package.manifest.clone(), digest: package.digest.clone(), approved, developer: package.developer };
        let mut prepared = lock(&state.prepared)?;
        prepared.retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
        prepared.insert(ticket, Prepared { package, host, created: Instant::now() });
        Ok(result)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn runtime_discard(app: tauri::AppHandle, webview: Webview, ticket: String) -> Result<(), String> {
    desktop(&webview)?; lock(&app.state::<Runtimes>().prepared)?.remove(&ticket); Ok(())
}
fn origin(identity: &str) -> String {
    #[cfg(any(windows, target_os = "android"))] { format!("http://appview.{identity}.localhost") }
    #[cfg(not(any(windows, target_os = "android")))] { format!("appview://{identity}") }
}
#[tauri::command]
pub async fn runtime_start(app: tauri::AppHandle, webview: Webview, ticket: String, approve: bool, win_id: String, props: Value, context: Value) -> Result<String, String> {
    desktop(&webview)?;
    let state = app.state::<Runtimes>();
    let prepared = lock(&state.prepared)?.remove(&ticket).ok_or("Launch expired; try opening the app again")?;
    if prepared.created.elapsed() > Duration::from_secs(600) { return Err("Launch expired; try again".into()); }
    // Recheck registration after a consent dialog (it may have been disabled).
    let p = &prepared.package;
    if p.developer && !crate::developer::enabled_directory(&app, &p.dir)? { return Err("Developer app is no longer enabled".into()); }
    {
        let _g = lock(&state.grants_lock)?;
        let mut g = grants(&app)?;
        if !p.manifest.permissions.is_empty() && !g.contains_key(&p.grant) {
            if !approve { return Err("PermissionDenied: approval required".into()); }
            g.insert(p.grant.clone(), json!({"identity":p.identity,"directory":p.dir,"appId":p.manifest.id,"version":p.manifest.version,"digest":p.digest,"host":prepared.host,"permissions":p.manifest.permissions,"developer":p.developer}));
            save_grants(&app, &g)?;
        }
    }
    let label = format!("app-{}", uuid::Uuid::new_v4());
    let url = format!("{}/runtime.html", origin(&p.identity));
    let s = Arc::new(Session::new(prepared.package, prepared.host, win_id, props, context));
    lock(&state.sessions)?.insert(label.clone(), s);
    let allowed = url.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.parse().map_err(|e| format!("Invalid runtime URL: {e}"))?))
        .on_navigation(move |url| url.as_str().split('#').next() == Some(allowed.as_str()))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .disable_drag_drop_handler();
    let window = app.get_window("main").ok_or("Desktop window is unavailable")?;
    match window.add_child(builder, tauri::LogicalPosition::new(-10000., -10000.), tauri::LogicalSize::new(1., 1.)) {
        Ok(view) => { let _ = view.hide(); changed(&app); Ok(label) }
        Err(e) => { lock(&state.sessions)?.remove(&label); Err(e.to_string()) }
    }
}
#[tauri::command]
pub fn runtime_bootstrap(app: tauri::AppHandle, webview: Webview) -> Result<Value, String> {
    let s = session(&app, webview.label())?; rate_limit(&s)?;
    Ok(json!({"manifest":s.package.manifest,"host":s.host,"props":s.props,"context":*lock(&s.context)?,"label":webview.label()}))
}
#[tauri::command]
pub fn runtime_list(app: tauri::AppHandle, webview: Webview) -> Result<Vec<RuntimeInfo>, String> {
    desktop(&webview)?;
    Ok(lock(&app.state::<Runtimes>().sessions)?.iter().map(|(l,s)| info(l,s)).collect())
}
#[tauri::command]
pub fn runtime_context(app: tauri::AppHandle, webview: Webview, label: String, context: Value) -> Result<(), String> {
    desktop(&webview)?; let s = session(&app, &label)?; *lock(&s.context)? = context.clone(); evaluate(&app, &label, "context", context)
}
#[tauri::command]
pub fn runtime_devtools(app: tauri::AppHandle, webview: Webview, label: String) -> Result<(), String> {
    desktop(&webview)?;
    if !crate::developer::mode_enabled(&app)? { return Err("Enable Developer mode to inspect apps".into()); }
    session(&app, &label)?;
    app.get_webview(&label).ok_or("App is closed")?.open_devtools(); Ok(())
}
/// A masked prompt is an administrator-password prompt whatever the app calls
/// it, so anything but an explicit `false` needs the sudo grant.
fn dialog_needs_sudo(payload: &Value) -> bool { !matches!(payload["options"]["password"], Value::Null | Value::Bool(false)) }
/// Only a file association crosses the boundary: a path for a viewer to show.
/// Arbitrary props would let one app drive another with that app's grants.
fn validate_open(payload: &Value) -> Result<(), String> {
    let id = payload["appId"].as_str().ok_or("Missing app ID")?;
    if id.is_empty() || id.len() > 80 { return Err("Invalid app ID".into()); }
    if let Some(props) = payload.get("props").filter(|p| !p.is_null()) {
        let props = props.as_object().ok_or("Invalid app props")?;
        if props.keys().any(|k| k != "path") || props.get("path").is_some_and(|v| !v.as_str().is_some_and(|p| p.len() <= 4096)) {
            return Err("PermissionDenied: apps may open another app with a path only".into());
        }
    }
    Ok(())
}
fn throttle(s: &Session, kind: &'static str, interval: Duration) -> Result<(), String> {
    let mut map = lock(&s.throttle)?;
    if map.get(kind).is_some_and(|last| last.elapsed() < interval) { return Err(format!("App {kind} requests are limited; retry shortly")); }
    map.insert(kind, Instant::now());
    Ok(())
}
const DIALOG_TIMEOUT: Duration = Duration::from_secs(600);
#[tauri::command]
pub fn runtime_event(app: tauri::AppHandle, webview: Webview, kind: String, payload: Value) -> Result<(), String> {
    let s = session(&app, webview.label())?;
    rate_limit(&s)?;
    if serde_json::to_vec(&payload).map_err(|e| e.to_string())?.len() > 64 * 1024 { return Err("App message exceeds 64 KB".into()); }
    let event = json!({"runtime":info(webview.label(), &s),"kind":kind,"payload":payload});
    match kind.as_str() {
        "ready" | "error" | "title" => {},
        "focus" => { throttle(&s, "focus", Duration::from_millis(250))?; return forward_focus(&app, &webview, event); },
        "dialog" => { if dialog_needs_sudo(&payload) { require(&s,"remote.sudo")?; }
            let id = payload["id"].as_str().ok_or("Missing request ID")?;
            let mut pending = lock(&s.interaction)?;
            // A desktop that never answered must not silence the app forever.
            if pending.as_ref().is_some_and(|(_, since)| since.elapsed() < DIALOG_TIMEOUT) { return Err("An app dialog is already open".into()); }
            *pending = Some((id.into(), Instant::now())); },
        // UI opening is mediated by the desktop, never a native command shortcut.
        "open" => { require(&s, "desktop.openUrl")?; validate_open(&payload)?; throttle(&s, "open", Duration::from_secs(1))?; },
        "fs:changed" => { require(&s, "remote.files.write")?; },
        _ => return Err("PermissionDenied: unsupported desktop event".into()),
    }
    app.emit_to("main", "app-runtime-event", event).map_err(|e| e.to_string())
}
/// Desktop focus follows the user's pointer, not an app's request: the event
/// is forwarded only while the view holds native keyboard focus.
fn forward_focus(app: &tauri::AppHandle, webview: &Webview, event: Value) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        extern "C" { fn sshdesk_runtime_focused(view: *mut std::ffi::c_void) -> bool; }
        let app = app.clone();
        webview.with_webview(move |platform| {
            if unsafe { sshdesk_runtime_focused(platform.inner().cast()) } { let _ = app.emit_to("main", "app-runtime-event", event); }
        }).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = webview; app.emit_to("main", "app-runtime-event", event).map_err(|e| e.to_string()) }
}
#[tauri::command]
pub fn runtime_reply(app: tauri::AppHandle, webview: Webview, label: String, id: String, value: Value) -> Result<(), String> {
    desktop(&webview)?; let s = session(&app, &label)?;
    let mut pending = lock(&s.interaction)?;
    if pending.as_ref().map(|(pending, _)| pending.as_str()) != Some(id.as_str()) { return Err("Dialog expired".into()); }
    *pending = None; drop(pending);
    evaluate(&app, &label, "reply", json!({"id":id,"value":value}))
}
fn rate_limit(s: &Session) -> Result<(), String> {
    let mut rate = lock(&s.rate)?;
    if rate.0.elapsed() >= Duration::from_secs(1) { *rate = (Instant::now(), 0); }
    rate.1 += 1; if rate.1 > 100 { return Err("App request limit reached; retry shortly".into()); } Ok(())
}
fn permission(command: &str, args: &Value) -> Result<&'static str, String> {
    Ok(match command {
        "list_directory" | "read_text" | "read_binary" | "disk_info" | "sftp_extensions" => "remote.files.read",
        "write_text" | "make_dir" | "rename_path" | "copy_path" | "remove_path" => "remote.files.write",
        "exec" if !args["password"].is_null() => "remote.sudo",
        "exec" => "remote.exec",
        "dbus_call" | "dbus_get" | "systemd_property" | "watch_units" => "remote.dbus",
        "snapshot" | "clock" => "remote.system",
        "forward_port" | "forward_socket" | "cancel_forward" | "cancel_forward_socket" | "list_forwards" => "remote.tunnels",
        "open_url" => "desktop.openUrl",
        _ => return Err(format!("PermissionDenied: {command} is not an app API")),
    })
}
fn authorize(s: &Session, command: &str, args: &Value) -> Result<(), String> {
    if !s.alive.load(Ordering::SeqCst) { return Err("App is closed".into()); }
    if let Some(target) = args.get("target") { if target.as_str() != Some(&s.host) { return Err("PermissionDenied: this app belongs to another machine".into()); } }
    require(s, permission(command, args)?)
}
fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| format!("Invalid {key}: {e}"))
}
fn result<T: Serialize>(value: Result<T, String>) -> Result<Value, String> { serde_json::to_value(value?).map_err(|e| e.to_string()) }
struct Flight(Arc<Session>);
impl Drop for Flight { fn drop(&mut self) { self.0.in_flight.fetch_sub(1, Ordering::SeqCst); } }
#[tauri::command]
pub async fn runtime_call(app: tauri::AppHandle, webview: Webview, command: String, args: Value) -> Result<Value, String> {
    let s = session(&app, webview.label())?;
    authorize(&s, &command, &args)?; rate_limit(&s)?;
    if serde_json::to_vec(&args).map_err(|e| e.to_string())?.len() > LIMIT { return Err("App request is too large".into()); }
    if s.in_flight.fetch_add(1, Ordering::SeqCst) >= 8 { s.in_flight.fetch_sub(1, Ordering::SeqCst); return Err("App already has eight requests in progress".into()); }
    let flight = Flight(s.clone()); let label = webview.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let _flight = flight;
        let _scope = RequestScope::enter(&s);
        authorize(&s, &command, &args)?;
        let hosts = app.state::<crate::Hosts>(); let host = s.host.clone();
        match command.as_str() {
            "list_directory" => result(crate::list_directory(hosts, host, arg(&args,"path")?)),
            "read_text" => result(crate::read_text(hosts, host, arg(&args,"path")?)),
            "read_binary" => result(crate::read_binary(hosts, host, arg(&args,"path")?, arg(&args,"maxBytes")?)),
            "disk_info" => result(crate::disk_info(hosts, host, arg(&args,"path")?)),
            "sftp_extensions" => result(crate::sftp_extensions(hosts, host)),
            "write_text" => result(crate::write_text(hosts, host, arg(&args,"path")?, arg(&args,"content")?)),
            "make_dir" => result(crate::make_dir(hosts, host, arg(&args,"path")?)),
            "rename_path" => result(crate::rename_path(hosts, host, arg(&args,"from")?, arg(&args,"to")?)),
            "copy_path" => result(crate::copy_path(hosts, host, arg(&args,"from")?, arg(&args,"to")?)),
            "remove_path" => result(crate::remove_path(hosts, host, arg(&args,"path")?, arg(&args,"recursive")?)),
            "exec" => result(crate::exec(hosts, host, arg(&args,"argv")?, arg(&args,"password")?)),
            "dbus_call" => result(crate::dbus_call(hosts, host, arg(&args,"dest")?, arg(&args,"path")?, arg(&args,"interface")?, arg(&args,"member")?, arg(&args,"signature")?, arg(&args,"args")?)),
            "dbus_get" => result(crate::dbus_get(hosts, host, arg(&args,"dest")?, arg(&args,"path")?, arg(&args,"interface")?, arg(&args,"property")?)),
            "systemd_property" => result(crate::systemd_property(hosts, host, arg(&args,"prop")?)),
            // The signal subscription belongs to this runtime and ends on close.
            "watch_units" => result(watch_units(&app, &label, &s)),
            "snapshot" => result(crate::snapshot(hosts, host)),
            "clock" => result(crate::clock(hosts, host)),
            "forward_port" | "forward_socket" | "cancel_forward" | "cancel_forward_socket" | "list_forwards" => tunnel_call(&app, &label, &s, &command, &args),
            "open_url" => { let url: String = arg(&args,"url")?; validate_forward_url(&s, &url)?; result(crate::open_url(url)) },
            _ => Err("PermissionDenied: unsupported operation".into()),
        }
    }).await.map_err(|e| e.to_string())?
}
fn tunnel_call(app: &tauri::AppHandle, label: &str, s: &Session, command: &str, args: &Value) -> Result<Value, String> {
    let state = app.state::<Runtimes>(); let _serial = lock(&state.tunnel_lock)?;
    if !s.alive.load(Ordering::SeqCst) { return Err("App is closed".into()); }
    if command == "list_forwards" {
        return Ok(Value::Object(lock(&s.forwards)?.iter().filter(|(k,_)| !k.starts_with("sock:")).map(|(k,v)| (k.clone(), json!(v))).collect()));
    }
    let socket = command.contains("socket");
    let spec = if socket { format!("sock:{}", arg::<String>(args,"remotePath")?) } else { arg::<u16>(args,"remotePort")?.to_string() };
    if command.starts_with("cancel") { release_tunnel(app, &state, label, s, &spec)?; return Ok(Value::Null); }
    let key = format!("{}:{spec}", s.host);
    let existing = lock(&app.state::<crate::Forwards>().0)?.contains_key(&key);
    let port = if socket { crate::forward_socket(app.state(), app.state(), s.host.clone(), arg(args,"remotePath")?, arg(args,"localPort")?)? }
        else { crate::forward_port(app.state(), app.state(), s.host.clone(), arg(args,"remotePort")?, arg(args,"localPort")?)? };
    lock(&s.forwards)?.insert(spec, port);
    lock(&state.leases)?.entry(key).or_insert_with(|| (HashSet::new(), !existing)).0.insert(label.into());
    Ok(json!(port))
}
fn release_tunnel(app: &tauri::AppHandle, state: &Runtimes, label: &str, s: &Session, spec: &str) -> Result<(), String> {
    if lock(&s.forwards)?.remove(spec).is_none() { return Ok(()); }
    let key = format!("{}:{spec}", s.host);
    let cancel = {
        let mut leases = lock(&state.leases)?;
        if let Some((owners, owned)) = leases.get_mut(&key) {
            owners.remove(label);
            if owners.is_empty() { let owned = *owned; leases.remove(&key); owned } else { false }
        } else { false }
    };
    if cancel {
        if let Some(path) = spec.strip_prefix("sock:") { crate::cancel_forward_socket(app.state(), app.state(), s.host.clone(), path.into())?; }
        else { crate::cancel_forward(app.state(), app.state(), s.host.clone(), spec.parse().map_err(|_| "Invalid tunnel")?)?; }
    }
    Ok(())
}
fn validate_forward_url(s: &Session, url: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = url.parse().map_err(|_| "Invalid URL")?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) || !url.username().is_empty() || url.password().is_some()
        || !lock(&s.forwards)?.values().any(|p| Some(*p) == url.port()) { return Err("PermissionDenied: URL must belong to this app's SSH tunnel".into()); }
    Ok(url)
}
#[tauri::command]
pub async fn runtime_embed(app: tauri::AppHandle, webview: Webview, url: String) -> Result<String, String> {
    let s = session(&app, webview.label())?; require(&s,"desktop.embed")?; rate_limit(&s)?;
    let parsed = validate_forward_url(&s, &url)?;
    let label = format!("content-{}", uuid::Uuid::new_v4());
    // Claim the slot, then release the lock: creating and closing native views
    // waits on the main thread, where the synchronous commands lock this too.
    let previous = { let mut embedded = lock(&s.embedded)?; if !s.alive.load(Ordering::SeqCst) { return Err("App is closed".into()); } embedded.replace(label.clone()) };
    if let Some(old) = previous { if let Some(view) = app.get_webview(&old) { let _ = view.close(); } }
    let allowed_origin = parsed.origin();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .on_navigation(move |url| url.origin() == allowed_origin)
        .on_new_window(|_, _| NewWindowResponse::Deny).disable_drag_drop_handler();
    let created = app.get_window("main").ok_or("Desktop unavailable")?.add_child(builder, tauri::LogicalPosition::new(-10000.,-10000.), tauri::LogicalSize::new(1.,1.));
    let mut embedded = lock(&s.embedded)?;
    match created {
        Ok(view) => {
            let _ = view.hide();
            if embedded.as_deref() != Some(label.as_str()) || !s.alive.load(Ordering::SeqCst) { drop(embedded); let _ = view.close(); return Err("Embedded view was replaced".into()); }
            Ok(label)
        }
        Err(e) => { if embedded.as_deref() == Some(label.as_str()) { *embedded = None; } Err(e.to_string()) }
    }
}
#[tauri::command]
pub fn runtime_embed_close(app: tauri::AppHandle, webview: Webview, label: String) -> Result<(), String> {
    let s = session(&app, webview.label())?; rate_limit(&s)?;
    let mut embedded = lock(&s.embedded)?;
    if embedded.as_deref() != Some(&label) { return Ok(()); }
    embedded.take();
    if let Some(view) = app.get_webview(&label) { let _ = view.close(); }
    app.emit_to("main", "app-runtime-event", json!({"runtime":info(webview.label(), &s),"kind":"embedded","payload":{"label":null}})).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn runtime_embed_bounds(app: tauri::AppHandle, webview: Webview, bounds: [f64;4]) -> Result<(), String> {
    let s = session(&app, webview.label())?; require(&s,"desktop.embed")?; rate_limit(&s)?;
    if !bounds.iter().all(|n| n.is_finite() && n.abs() <= 100000.) { return Err("Invalid embedded view bounds".into()); }
    // The desktop clamps and positions the child inside the app's own slot.
    app.emit_to("main", "app-runtime-event", json!({"runtime":info(webview.label(), &s),"kind":"embedded","payload":{"label":*lock(&s.embedded)?,"bounds":bounds}})).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn runtime_close(app: tauri::AppHandle, webview: Webview, label: String) -> Result<(), String> {
    desktop(&webview)?; close(&app, &label).await
}
async fn close(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let s = lock(&app.state::<Runtimes>().sessions)?.remove(label);
    if let Some(s) = s {
        s.alive.store(false, Ordering::SeqCst);
        if let Some(view) = app.get_webview(label) { let _ = view.close(); }
        if let Some(child) = lock(&s.embedded)?.take() { if let Some(view) = app.get_webview(&child) { let _ = view.close(); } }
        changed(app);
        let app = app.clone(); let label = label.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<Runtimes>(); let _serial = lock(&state.tunnel_lock)?;
            let specs = lock(&s.forwards)?.keys().cloned().collect::<Vec<_>>();
            // One forward that fails to cancel must not keep the others leased.
            let mut failure = None;
            for spec in specs { if let Err(e) = release_tunnel(&app, &state, &label, &s, &spec) { failure.get_or_insert(e); } }
            failure.map_or(Ok::<_,String>(()), Err)
        }).await.map_err(|e| e.to_string())??;
    }
    Ok(())
}
#[tauri::command]
pub async fn runtime_revoke(app: tauri::AppHandle, webview: Webview, directory: String) -> Result<(), String> {
    desktop(&webview)?;
    // Grants and sessions store the canonical folder; the catalog may not.
    let directory = fs::canonicalize(&directory).map(|p| p.to_string_lossy().into_owned()).unwrap_or(directory);
    {
        let state = app.state::<Runtimes>(); let _g = lock(&state.grants_lock)?;
        let mut g = grants(&app)?; g.retain(|_,v| v["directory"].as_str() != Some(&directory)); save_grants(&app,&g)?;
        lock(&state.prepared)?.retain(|_,p| p.package.dir != directory);
    }
    let labels = lock(&app.state::<Runtimes>().sessions)?.iter().filter(|(_,s)| s.package.dir == directory).map(|(l,_)| l.clone()).collect::<Vec<_>>();
    for label in labels { close(&app,&label).await?; }
    Ok(())
}

/// Everything else, including direct calls to exec/config/developer commands,
/// is rejected before reaching the existing command handlers.
pub fn allow_invoke(invoke: &tauri::ipc::Invoke<tauri::Wry>) -> bool {
    if invoke.message.webview_ref().label() == "main" { return true; }
    matches!(invoke.message.command(), "runtime_bootstrap" | "runtime_call" | "runtime_event" | "runtime_embed" | "runtime_embed_close" | "runtime_embed_bounds")
}

/// `tauri dev` serves the desktop from Vite instead of embedding it, so app
/// origins fetch the runtime page from that server too. Only the transport
/// differs: apps keep their own scheme, origin, and content security policy.
fn dev_server(app: &tauri::AppHandle) -> Option<(String, u16)> {
    if !tauri::is_dev() { return None; }
    let url = app.config().build.dev_url.clone()?;
    Some((url.host_str()?.to_string(), url.port_or_known_default()?))
}
fn dev_fetch(host: &str, port: u16, target: &str) -> Result<(Vec<u8>, String), String> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect((host, port)).map_err(|e| format!("The development server is not running: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(15))).map_err(|e| e.to_string())?;
    // HTTP/1.0: one reply, then the server closes the socket.
    stream.write_all(format!("GET {target} HTTP/1.0\r\nHost: {host}:{port}\r\nAccept: */*\r\n\r\n").as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse_http_response(&raw)
}
fn parse_http_response(raw: &[u8]) -> Result<(Vec<u8>, String), String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("Malformed development server response")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.lines();
    let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).ok_or("Malformed development server response")?;
    if status != "200" { return Err(format!("The development server answered {status}")); }
    let (mut mime, mut chunked) = ("application/octet-stream".to_string(), false);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-type" => mime = value.trim().to_string(),
            "transfer-encoding" => chunked = value.to_ascii_lowercase().contains("chunked"),
            _ => {}
        }
    }
    let body = &raw[split + 4..];
    Ok((if chunked { dechunk(body)? } else { body.to_vec() }, mime))
}
fn dechunk(body: &[u8]) -> Result<Vec<u8>, String> {
    let (mut out, mut at) = (Vec::new(), 0);
    loop {
        let rest = body.get(at..).ok_or("Truncated chunked response")?;
        let end = at + rest.windows(2).position(|w| w == b"\r\n").ok_or("Malformed chunked response")?;
        let size = std::str::from_utf8(&body[at..end]).ok().and_then(|s| usize::from_str_radix(s.split(';').next().unwrap_or("").trim(), 16).ok()).ok_or("Malformed chunk size")?;
        if size == 0 { return Ok(out); }
        let start = end + 2;
        out.extend_from_slice(body.get(start..start + size).ok_or("Truncated chunked response")?);
        at = start + size + 2;
    }
}

/// Each installed identity has a distinct origin. Assets are served only to
/// the registered native caller; knowing another app's URL grants no access.
pub fn protocol(context: tauri::UriSchemeContext<'_, tauri::Wry>, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let response = || -> Result<(Vec<u8>, String, String), String> {
        let s = session(context.app_handle(), context.webview_label())?;
        let url: tauri::Url = request.uri().to_string().parse().map_err(|_| "Invalid asset URL")?;
        let expected = origin(&s.package.identity);
        // Wry presents the original custom scheme to protocol handlers.
        if url.host_str() != Some(s.package.identity.as_str()) && url.origin().ascii_serialization() != expected { return Err("Wrong app origin".into()); }
        let path = url.path().trim_start_matches('/');
        if path.contains("..") || path.contains('\\') { return Err("Invalid asset path".into()); }
        let dev = dev_server(context.app_handle());
        let network = s.package.manifest.permissions.iter().any(|p| p == "network");
        let net = if network { " http: https: ws: wss:" } else { "" };
        // Vite's client reconnects to its own server for hot reloads.
        let hmr = dev.as_ref().map(|(host, port)| format!(" http://{host}:{port} ws://{host}:{port}")).unwrap_or_default();
        // No frames, workers/service workers, external scripts, forms, or
        // object embeds. Network is an explicit, broad permission in v1.
        let csp = format!("default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:{net}; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost{net}{hmr}; media-src 'self' data: blob:{net}; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
        let embedded = |p: &str, missing: &str| context.app_handle().asset_resolver().get(p.into()).map(|a| (a.bytes, a.mime_type)).ok_or(missing.to_string());
        let (bytes,mime) = match path {
            "index.js" => (s.package.source.as_bytes().to_vec(), "text/javascript".into()),
            "style.css" => (s.package.style.as_bytes().to_vec(), "text/css".into()),
            _ if dev.is_some() => {
                let (host, port) = dev.as_ref().unwrap();
                let target = match url.query() { Some(q) => format!("{}?{q}", url.path()), None => url.path().to_string() };
                dev_fetch(host, *port, &target)?
            },
            _ if path.contains('%') => return Err("Invalid asset path".into()),
            "runtime.html" => embedded(path, "Build the frontend before starting app runtimes")?,
            _ if path.starts_with("assets/") => embedded(path, "Runtime asset is missing")?,
            _ => return Err("Unknown runtime asset".into()),
        };
        Ok((bytes,mime,csp))
    };
    match response() {
        Ok((bytes,mime,csp)) => tauri::http::Response::builder().header("Content-Type",mime).header("Content-Security-Policy",csp)
            .header("X-Content-Type-Options","nosniff").header("Cache-Control","no-store").header("Permissions-Policy","camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()")
            .body(bytes).unwrap(),
        Err(e) => tauri::http::Response::builder().status(403).header("Content-Type","text/plain").body(e.into_bytes()).unwrap(),
    }
}

fn watch_units(app: &tauri::AppHandle, label: &str, s: &Arc<Session>) -> Result<bool, String> {
    if s.watching.swap(true, Ordering::SeqCst) { return Ok(false); }
    let connected = crate::with_host(&app.state::<crate::Hosts>(), &s.host, |h| {
        h.bus()?; Ok((h.bus_path().to_string(), h.uid()))
    });
    let (sock, uid) = match connected { Ok(v) => v, Err(e) => { s.watching.store(false,Ordering::SeqCst); return Err(e); } };
    let app = app.clone(); let label = label.to_string(); let s = s.clone();
    std::thread::spawn(move || {
        let run = || -> Result<(), sshdesk_core::Error> {
            let mut bus = sshdesk_core::dbus::Dbus::connect(&sock, uid)?;
            sshdesk_core::subscribe_units(&mut bus)?;
            while s.alive.load(Ordering::SeqCst) {
                if let Some(sig) = bus.next_signal(Duration::from_secs(1))? {
                    if !s.alive.load(Ordering::SeqCst) { break; }
                    let payload = json!({"topic":"units:changed", "payload":{"target":s.host,"member":sig.member,"args":sig.args.iter().map(|v| v.to_json()).collect::<Vec<_>>()}});
                    let _ = evaluate(&app,&label,"bus",payload);
                }
            }
            Ok(())
        };
        let _ = run(); s.watching.store(false,Ordering::SeqCst);
        if s.alive.load(Ordering::SeqCst) { let _ = evaluate(&app,&label,"bus",json!({"topic":"units:stopped","payload":s.host})); }
    });
    Ok(true)
}

#[tauri::command]
pub async fn runtime_snapshot(app: tauri::AppHandle, webview: Webview, label: String) -> Result<String, String> {
    desktop(&webview)?; session(&app,&label)?;
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::{c_void, c_char, CStr}, sync::mpsc};
        extern "C" { fn sshdesk_runtime_snapshot(view: *mut c_void, context: *mut c_void, callback: extern "C" fn(*mut c_void, *const c_char)); }
        extern "C" fn receive(context: *mut c_void, value: *const c_char) {
            let sender = unsafe { Box::from_raw(context.cast::<mpsc::Sender<String>>()) };
            let value = unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned();
            let _ = sender.send(value);
        }
        let view = app.get_webview(&label).ok_or("App is closed")?;
        let (tx,rx) = mpsc::channel::<String>();
        view.with_webview(move |platform| {
            let context = Box::into_raw(Box::new(tx)).cast();
            unsafe { sshdesk_runtime_snapshot(platform.inner().cast(), context, receive); }
        }).map_err(|e| e.to_string())?;
        return tauri::async_runtime::spawn_blocking(move || {
            let value = rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "Preview unavailable")?;
            Ok(if value.is_empty() { value } else { format!("data:image/png;base64,{value}") })
        }).await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))] { Ok(String::new()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Manifest { serde_json::from_value(json!({"schemaVersion":1,"id":"test-app","name":"Test app","version":"1.0","permissions":[]})).unwrap() }
    fn session_with(permissions: &[&str]) -> Session {
        let mut m = manifest(); m.permissions = permissions.iter().map(|s| s.to_string()).collect();
        Session::new(Arc::new(Package { dir:"/test".into(), manifest:m, source:String::new(), style:String::new(), digest:"digest".into(), identity:"identity".into(), grant:"grant".into(), developer:false }), "user@machine-a".into(), "one".into(), Value::Null, Value::Null)
    }
    #[test]
    fn desktop_events_cannot_phish_passwords_drive_other_apps_or_steal_focus() {
        assert!(!dialog_needs_sudo(&json!({"options":{"title":"Confirm"}})));
        assert!(!dialog_needs_sudo(&json!({"options":{"password":false}})));
        assert!(dialog_needs_sudo(&json!({"options":{"password":true}})));
        assert!(dialog_needs_sudo(&json!({"options":{"password":"yes"}})));
        assert!(validate_open(&json!({"appId":"editor","props":{"path":"/etc/hosts"}})).is_ok());
        assert!(validate_open(&json!({"appId":"editor"})).is_ok());
        assert!(validate_open(&json!({"appId":"terminal","props":{"command":"rm -rf /"}})).is_err());
        assert!(validate_open(&json!({"appId":"editor","props":{"path":42}})).is_err());
        assert!(validate_open(&json!({"props":{"path":"/x"}})).is_err());
        let s = session_with(&["desktop.openUrl"]);
        assert!(throttle(&s, "open", Duration::from_secs(1)).is_ok());
        assert!(throttle(&s, "open", Duration::from_secs(1)).is_err());
        assert!(throttle(&s, "focus", Duration::from_secs(1)).is_ok());
    }
    #[test]
    fn a_stuck_dialog_expires_instead_of_silencing_the_app() {
        let s = session_with(&[]);
        *s.interaction.lock().unwrap() = Some(("old".into(), Instant::now() - DIALOG_TIMEOUT - Duration::from_secs(1)));
        let pending = s.interaction.lock().unwrap();
        assert!(!pending.as_ref().is_some_and(|(_, since)| since.elapsed() < DIALOG_TIMEOUT));
    }
    #[test]
    fn no_permissions_deny_machine_apis_even_with_a_claimed_identity() {
        let s = session_with(&[]);
        assert!(authorize(&s,"exec",&json!({"appId":"system","argv":["id"]})).is_err());
        assert!(authorize(&s,"read_text",&json!({"appId":"editor","path":"/etc/passwd"})).is_err());
        assert!(authorize(&s,"config_set",&json!({})).is_err());
        assert!(authorize(&s,"developer_apps_change",&json!({})).is_err());
    }
    #[test]
    fn grants_are_bound_to_the_native_host_and_operation() {
        let s = session_with(&["remote.files.read"]);
        assert!(authorize(&s,"read_text",&json!({"target":"user@machine-a"})).is_ok());
        assert!(authorize(&s,"read_text",&json!({"target":"user@machine-b"})).is_err());
        assert!(authorize(&s,"write_text",&json!({"target":"user@machine-a"})).is_err());
        s.alive.store(false,Ordering::SeqCst);
        assert!(authorize(&s,"read_text",&json!({})).is_err());
    }
    #[test]
    fn administrator_access_is_distinct_and_unknown_commands_fail_closed() {
        let s = session_with(&["remote.exec"]);
        assert!(authorize(&s,"exec",&json!({"argv":["id"]})).is_ok());
        assert!(authorize(&s,"exec",&json!({"argv":["id"],"password":"anything"})).is_err());
        assert!(authorize(&s,"upload_file",&json!({"local":"/private/secret"})).is_err());
    }
    #[test]
    fn queued_requests_are_cancelled_when_their_runtime_closes() {
        let s = Arc::new(session_with(&["remote.exec"]));
        { let _scope = RequestScope::enter(&s);
          assert!(ensure_request_alive().is_ok());
          s.alive.store(false,Ordering::SeqCst);
          assert!(ensure_request_alive().is_err()); }
        assert!(ensure_request_alive().is_ok()); // desktop calls remain independent
    }
    #[test]
    fn catalog_reads_metadata_without_loading_javascript_or_styles() {
        let dir = std::env::temp_dir().join(format!("sshdesk-catalog-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"),serde_json::to_vec(&manifest()).unwrap()).unwrap();
        fs::write(dir.join("index.js"),"throw new Error('discovery must not execute me')").unwrap();
        fs::write(dir.join("style.css"),"body { background: red }").unwrap();
        let entry = catalog_entry(&dir);
        assert!(entry.manifest.is_some());
        let serialized = serde_json::to_string(&entry).unwrap();
        assert!(!serialized.contains("throw new Error"));
        assert!(!serialized.contains("background"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn manifest_validation_rejects_privilege_and_style_injection() {
        let mut m = manifest(); m.permissions = vec!["anything".into()]; assert!(validate_manifest(&m).is_err());
        m = manifest(); m.id = "settings".into(); assert!(validate_manifest(&m).is_err());
        m = manifest(); m.extra.insert("tokens".into(),json!({"accent":{"type":"color","default":"red; } body { display:none", "label":"Attack"}}));
        assert!(validate_manifest(&m).is_err());
        assert!(!safe_token("color","url(//evil.example/x)"));
        assert!(safe_token("color","#ffffff0d"));
        assert!(safe_token("length","12px"));
    }
    #[test]
    fn package_fingerprints_change_with_any_approved_content() {
        let original = hash(&[b"manifest",b"code",b"css"]);
        for changed in [[b"changed".as_slice(),b"code",b"css"],[b"manifest",b"changed",b"css"],[b"manifest",b"code",b"changed"]] { assert_ne!(original,hash(&changed)); }
        assert_ne!(hash(&[b"app-a",b"host"]), hash(&[b"app-b",b"host"]));
    }
    #[test]
    fn embedded_urls_must_be_owned_tunnels_not_other_local_services() {
        let s = session_with(&["remote.tunnels","desktop.embed"]);
        s.forwards.lock().unwrap().insert("sock:/example".into(),23456);
        assert!(validate_forward_url(&s,"http://127.0.0.1:23456/?tkn=test").is_ok());
        assert!(validate_forward_url(&s,"http://127.0.0.1:1234/").is_err());
        assert!(validate_forward_url(&s,"http://evil.example:23456/").is_err());
        assert!(validate_forward_url(&s,"http://user@localhost:23456/").is_err());
    }
    #[test]
    fn every_gateway_operation_maps_to_a_declarable_permission() {
        let commands = ["list_directory","read_text","read_binary","disk_info","sftp_extensions","write_text","make_dir","rename_path","copy_path","remove_path",
            "exec","dbus_call","dbus_get","systemd_property","watch_units","snapshot","clock","forward_port","forward_socket","cancel_forward","cancel_forward_socket","list_forwards","open_url"];
        for command in commands {
            let granted = permission(command, &json!({})).unwrap();
            assert!(PERMISSIONS.contains(&granted), "{command} maps to the undeclared permission {granted}");
        }
        assert_eq!(permission("exec", &json!({"password":"x"})).unwrap(), "remote.sudo");
        for denied in ["connect","disconnect","service_action","kill_process","upload_file","download_file","config_set","developer_apps_change","term_open","open_web_window","runtime_start","index_search","index_build"] {
            assert!(permission(denied, &json!({})).is_err(), "{denied} must not be reachable from an app");
        }
    }
    #[test]
    fn development_assets_are_proxied_with_their_query_and_dechunked() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for (i, stream) in listener.incoming().enumerate() {
                let mut stream = stream.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0u8; 1];
                    if stream.read(&mut byte).unwrap() == 0 { break; }
                    request.push(byte[0]);
                }
                let request = String::from_utf8_lossy(&request).into_owned();
                let reply = if i == 0 { format!("HTTP/1.0 200 OK\r\nContent-Type: text/javascript\r\n\r\n// {}", request.lines().next().unwrap()) }
                    else { "HTTP/1.1 200 OK\r\nContent-Type: text/css\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nbody\r\n2\r\n{}\r\n0\r\n\r\n".to_string() };
                stream.write_all(reply.as_bytes()).unwrap();
                if i == 1 { break; }
            }
        });
        let (bytes, mime) = dev_fetch("127.0.0.1", port, "/src/ext/runtime.tsx?t=1").unwrap();
        assert_eq!(mime, "text/javascript");
        assert_eq!(String::from_utf8(bytes).unwrap(), "// GET /src/ext/runtime.tsx?t=1 HTTP/1.0");
        let (bytes, mime) = dev_fetch("127.0.0.1", port, "/style.css").unwrap();
        assert_eq!((bytes.as_slice(), mime.as_str()), (b"body{}".as_slice(), "text/css"));
        assert!(parse_http_response(b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnope").is_err());
        assert!(dechunk(b"5\r\nabc").is_err());
        assert!(dechunk(b"3\r\nabc").is_err());
        assert!(dechunk(b"zz\r\n").is_err());
    }
    #[test]
    fn a_noisy_app_has_a_bounded_request_budget() {
        let s = session_with(&[]);
        for _ in 0..100 { assert!(rate_limit(&s).is_ok()); }
        assert!(rate_limit(&s).is_err());
        assert_eq!(s.in_flight.fetch_add(1,Ordering::SeqCst),0);
    }
}
