//! Local key discovery returns names and paths, never key material.
use std::{fs, io::Read, path::{Path, PathBuf}};
use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey { name: String, path: String }

fn private_key(path: &Path) -> Result<bool, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Cannot access SSH key: {e}"))?;
    if !metadata.is_file() { return Err("Choose a private key file, not a folder or socket".into()); }
    let mut header = [0; 80];
    let count = fs::File::open(path).and_then(|mut file| file.read(&mut header))
        .map_err(|e| format!("Cannot read SSH key: {e}"))?;
    let first = header[..count].split(|b| *b == b'\n' || *b == b'\r').next().unwrap_or_default();
    Ok(["-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN DSA PRIVATE KEY-----",
        "-----BEGIN EC PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----", "-----BEGIN ENCRYPTED PRIVATE KEY-----"]
        .iter().any(|header| first == header.as_bytes()))
}

fn list(directory: &Path) -> Result<Vec<SshKey>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Couldn’t read ~/.ssh: {e}")),
    };
    let mut keys = vec![];
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if name.starts_with('.') || name.ends_with(".pub") || matches!(name.as_str(), "config" | "known_hosts" | "known_hosts.old" | "authorized_keys") { continue; }
        if !private_key(&path).unwrap_or(false) { continue; }
        if let Some(path) = path.to_str() { keys.push(SshKey { name, path: path.into() }); }
    }
    keys.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
    Ok(keys)
}

pub fn resolve(value: &str, home: &Path) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() || value.contains('\0') { return Err("Enter the path to your private SSH key".into()); }
    let path = if let Some(relative) = value.strip_prefix("~/") { home.join(relative) } else { PathBuf::from(value) };
    if !path.is_absolute() { return Err("Use an absolute key path or a path starting with ~/".into()); }
    if !private_key(&path)? { return Err("Choose a private SSH key, not a .pub public key or SSH configuration file".into()); }
    Ok(path)
}

#[tauri::command]
pub fn ssh_keys_list(app: tauri::AppHandle, webview: tauri::Webview) -> Result<Vec<SshKey>, String> {
    crate::runtime::desktop(&webview)?;
    list(&app.path().home_dir().map_err(|e| e.to_string())?.join(".ssh"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_only_returns_private_key_paths_and_custom_paths_support_tilde() {
        let home = std::env::temp_dir().join(format!("plydesk-key-test-{}", uuid::Uuid::new_v4()));
        let dir = home.join(".ssh"); fs::create_dir_all(&dir).unwrap();
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nTEST FIXTURE ONLY\n";
        fs::write(dir.join("work key"), key).unwrap();
        fs::write(dir.join("id_ed25519.pub"), "ssh-ed25519 PUBLIC KEY").unwrap();
        fs::write(dir.join("known_hosts"), "host key").unwrap();
        fs::write(dir.join("config"), "Host test\n  User somebody").unwrap();
        fs::create_dir(dir.join("folder")).unwrap();
        let keys = list(&dir).unwrap(); assert_eq!(keys.len(), 1); assert_eq!(keys[0].name, "work key");
        let serialized = serde_json::to_string(&keys).unwrap(); assert!(!serialized.contains("PRIVATE KEY"));
        assert_eq!(resolve("~/.ssh/work key", &home).unwrap(), dir.join("work key"));
        assert!(resolve("~/.ssh/id_ed25519.pub", &home).is_err());
        assert!(resolve("~/.ssh/folder", &home).is_err());
        assert!(resolve("~/.ssh/missing", &home).is_err());
        assert!(resolve("relative/key", &home).is_err());
        assert!(list(&home.join("absent")).unwrap().is_empty());
        fs::remove_dir_all(home).unwrap();
    }
}
