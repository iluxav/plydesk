//! Interactive terminal sessions.
//!
//! Everything else in plydesk is request/response over one persistent shell.
//! A terminal is not: it needs a real PTY so that `vim`, `top`, job control and
//! colours behave, plus continuous output in both directions.
//!
//! So each session allocates a *local* PTY and runs `ssh -tt` inside it against
//! the existing ControlMaster socket. Giving ssh a real tty is what makes window
//! resizes propagate to the remote — ssh forwards SIGWINCH as a window-change
//! request. It also costs no extra authentication, because the connection is
//! already open.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, ChildKiller};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Mutex, Arc, atomic::{AtomicU32, Ordering}};
use tauri::{AppHandle, Emitter, Manager};

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    target: String,
    remote_pid: Arc<AtomicU32>,
}

#[derive(Default)]
pub struct Terminals(pub Mutex<HashMap<String, Session>>);

#[derive(Clone, Serialize)]
struct Chunk {
    id: String,
    /// base64 — raw PTY bytes are not guaranteed to split on UTF-8 boundaries.
    b64: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: String,
    code: Option<i32>,
}

/// Start the user's login shell in a folder without injecting input into its PTY.
pub fn directory_command(cwd: &str) -> Result<String, String> {
    if !cwd.starts_with('/') || cwd.len() > 4096 || cwd.contains('\0') {
        return Err("Choose an absolute remote directory path".into());
    }
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let script = format!("cd -- {} || exit $?; exec \"${{SHELL:-/bin/sh}}\" -l", quote(cwd));
    Ok(format!("exec /bin/sh -c {}", quote(&script)))
}

// A one-time, per-session handshake identifies the remote shell. Reading its
// /proc cwd works with bash, zsh and fish without changing users' startup files.
struct ShellHandshake { prefix: Vec<u8>, pending: Vec<u8>, done: bool }
impl ShellHandshake {
    fn new(token: &str) -> Self {
        Self { prefix: format!("\x1b]777;plydesk={token};").into_bytes(), pending: vec![], done: false }
    }
    fn feed(&mut self, bytes: &[u8]) -> Option<u32> {
        if self.done { return None; }
        self.pending.extend_from_slice(bytes);
        if let Some(start) = self.pending.windows(self.prefix.len()).position(|part| part == self.prefix) {
            let digits = &self.pending[start + self.prefix.len()..];
            if let Some(end) = digits.iter().position(|b| *b == 7) {
                self.done = true;
                let pid = std::str::from_utf8(&digits[..end]).ok()?.parse::<u32>().ok()?;
                return (pid > 0).then_some(pid);
            }
        }
        if self.pending.len() > 512 { self.pending.drain(..self.pending.len() - 512); }
        None
    }
}

fn tracked_command(command: Option<&str>, token: &str) -> String {
    let script = format!("printf '\\033]777;plydesk={token};%s\\007' \"$$\"; {}",
        command.unwrap_or("exec \"${SHELL:-/bin/sh}\" -l"));
    format!("exec /bin/sh -c '{}'", script.replace('\'', "'\\''"))
}

pub fn location_source(terms: &Terminals, id: &str) -> Result<Option<(String, u32)>, String> {
    let sessions = terms.0.lock().map_err(|e| e.to_string())?;
    Ok(sessions.get(id).and_then(|s| {
        let pid = s.remote_pid.load(Ordering::Relaxed);
        (pid > 0).then(|| (s.target.clone(), pid))
    }))
}

pub fn open(
    app: &AppHandle,
    terms: &Terminals,
    id: String,
    target: &str,
    control_path: &str,
    cols: u16,
    rows: u16,
    command: Option<&str>,
) -> Result<(), String> {
    let mut sessions = terms.0.lock().map_err(|e| e.to_string())?;
    if sessions.contains_key(&id) { return Err("Terminal session already exists".into()); }
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("ssh");
    // -tt forces a remote PTY even though our stdin is a pty we made, not a
    // terminal the user typed into.
    cmd.args(["-tt", "-S", control_path, "-o", "BatchMode=yes", target]);
    let token = uuid::Uuid::new_v4().to_string();
    cmd.arg(tracked_command(command, &token));
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let killer = child.clone_killer();
    let remote_pid = Arc::new(AtomicU32::new(0));
    sessions.insert(id.clone(), Session { master: pair.master, writer, killer,
        target: target.into(), remote_pid: remote_pid.clone() });
    drop(sessions);
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut handshake = ShellHandshake::new(&token);
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some(pid) = handshake.feed(&buf[..n]) { remote_pid.store(pid, Ordering::Relaxed); }
                    let _ = app2.emit_to(
                        "main", "term:data",
                        Chunk { id: id2.clone(), b64: plydesk_core::b64encode(&buf[..n]) },
                    );
                }
            }
        }
        let code = child.wait().ok().map(|status| status.exit_code() as i32);
        if let Ok(mut sessions) = app2.state::<Terminals>().0.lock() { sessions.remove(&id2); }
        let _ = app2.emit_to("main", "term:exit", Exit { id: id2, code });
    });

    Ok(())
}

pub fn write(terms: &Terminals, id: &str, data: &str) -> Result<(), String> {
    let mut map = terms.0.lock().map_err(|e| e.to_string())?;
    let s = map.get_mut(id).ok_or("no such terminal")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

pub fn resize(terms: &Terminals, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let map = terms.0.lock().map_err(|e| e.to_string())?;
    let s = map.get(id).ok_or("no such terminal")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

pub fn close(terms: &Terminals, id: &str) -> Result<(), String> {
    let mut map = terms.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = map.remove(id) {
        let _ = s.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};

    #[test]
    fn shell_handshake_survives_fragmented_output_and_is_bound_to_its_session() {
        let mut parser = ShellHandshake::new("test-session");
        assert_eq!(parser.feed(b"\x1b]777;plydesk=another-session;123\x07"), None);
        let marker = b"\x1b]777;plydesk=test-session;456\x07";
        for byte in &marker[..marker.len() - 1] { assert_eq!(parser.feed(&[*byte]), None); }
        assert_eq!(parser.feed(&[7]), Some(456));
        assert_eq!(parser.feed(b"\x1b]777;plydesk=test-session;789\x07"), None);
        let mut bounded = ShellHandshake::new("unused");
        bounded.feed(&vec![b'x'; 10000]); assert!(bounded.pending.len() <= 512);
    }

    #[test]
    fn tracking_preserves_the_shell_pid_and_command_exit_status() {
        let command = "exec /bin/sh -c 'printf \"PID:%s\" \"$$\"; exit 7'";
        let output = Command::new("/bin/sh").args(["-c", &tracked_command(Some(command), "fixture")]).output().unwrap();
        assert_eq!(output.status.code(), Some(7));
        let pid = ShellHandshake::new("fixture").feed(&output.stdout).unwrap();
        assert!(String::from_utf8(output.stdout).unwrap().ends_with(&format!("PID:{pid}")));
    }

    #[test]
    fn directory_launch_preserves_literal_paths_and_does_not_start_in_a_missing_folder() {
        let root = std::env::temp_dir().join(format!("plydesk-terminal-test-{}", uuid::Uuid::new_v4()));
        let folder = root.join("a folder ' $(printf injected) ; &\nwith newline");
        fs::create_dir_all(&folder).unwrap();
        let shell = root.join("login shell");
        fs::write(&shell, "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\"\n").unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
        let run = |path: &std::path::Path| Command::new("/bin/sh")
            .args(["-c", &directory_command(path.to_str().unwrap()).unwrap()])
            .env("SHELL", &shell).output().unwrap();
        let output = run(&folder);
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), format!("{}\n-l\n", folder.display()));
        let missing = run(&root.join("missing"));
        assert!(!missing.status.success());
        assert!(missing.stdout.is_empty(), "the shell must not launch in a fallback directory");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_launch_requires_an_absolute_path_without_nul_bytes() {
        for path in ["", "~", "relative/folder", "/tmp/bad\0path"] {
            assert!(directory_command(path).is_err());
        }
        assert!(directory_command("/").is_ok());
    }
}
