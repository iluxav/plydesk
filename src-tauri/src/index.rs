//! A name index of the remote home directory, held on this Mac so the
//! launcher can match as you type with no round trip.
//!
//! The listing runs over its own multiplexed ssh channel rather than the
//! persistent shell: a large home takes seconds to walk, and nothing else on
//! that machine should wait behind it.
use serde::Serialize;
use std::{collections::HashMap, io::{BufRead, BufReader}, process::{Command, Stdio}, sync::Mutex, time::Instant};
use tauri::State;

pub const CAP: usize = 200_000;
/// Build output and dependency trees: enormous, and never what anyone searches for.
const PRUNE: &[&str] = &["node_modules", ".git", ".cache", ".npm", ".cargo", ".rustup", ".venv", "__pycache__", ".Trash"];

#[derive(Clone, Debug, PartialEq)]
pub struct Entry { path: String, dir: bool, lower: String, base: usize }
#[derive(Default)]
pub struct HostIndex { entries: Vec<Entry>, built: Option<Instant>, building: bool, error: Option<String>, truncated: bool }
#[derive(Default)]
pub struct Indexes(Mutex<HashMap<String, HostIndex>>);
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status { building: bool, count: usize, truncated: bool, error: Option<String>, age_secs: Option<u64> }
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Hit { pub path: String, pub name: String, pub dir: bool }

fn lock(m: &Mutex<HashMap<String, HostIndex>>) -> Result<std::sync::MutexGuard<'_, HashMap<String, HostIndex>>, String> {
    m.lock().map_err(|_| "Search index unavailable".to_string())
}
impl HostIndex {
    fn status(&self) -> Status {
        Status { building: self.building, count: self.entries.len(), truncated: self.truncated, error: self.error.clone(), age_secs: self.built.map(|t| t.elapsed().as_secs()) }
    }
    /// A failed walk keeps the previous entries: stale beats empty.
    fn finish(&mut self, result: Result<(Vec<Entry>, bool), String>) {
        self.building = false;
        match result {
            Ok((entries, truncated)) => { self.entries = entries; self.truncated = truncated; self.built = Some(Instant::now()); self.error = None; }
            Err(e) => self.error = Some(e),
        }
    }
}

/// The remote side. GNU find prints a type letter per entry in one pass;
/// anything else gets two plain passes, directories first.
pub fn script() -> String {
    let prune = PRUNE.iter().map(|n| format!("-name {n}")).collect::<Vec<_>>().join(" -o ");
    let prune = format!("\\( {prune} \\) -prune");
    format!(
        "cd \"$HOME\" || exit 1; printf \"H %s\\n\" \"$PWD\"; \
         if find . -maxdepth 0 -printf \"\" 2>/dev/null; then find . -mindepth 1 {prune} -o -printf \"%y %P\\n\" 2>/dev/null; \
         else find . -mindepth 1 {prune} -o -type d -print 2>/dev/null | sed \"s|^\\./|d |\"; find . -mindepth 1 {prune} -o ! -type d -print 2>/dev/null | sed \"s|^\\./|f |\"; fi; exit 0"
    )
}

/// Turn the listing into entries. Malformed lines (a file name containing a
/// newline produces one) are skipped, and the cap stops the walk early.
pub fn parse(lines: impl Iterator<Item = String>, cap: usize) -> (Vec<Entry>, bool) {
    let mut home = String::new();
    let mut entries = Vec::new();
    for line in lines {
        let Some((kind, rest)) = line.split_once(' ') else { continue };
        match kind {
            "H" => { home = rest.trim_end_matches('/').to_string(); continue }
            "d" | "f" | "l" if !home.is_empty() && !rest.is_empty() => {
                if entries.len() >= cap { return (entries, true); }
                let path = format!("{home}/{rest}");
                let base = path.rfind('/').map_or(0, |i| i + 1);
                entries.push(Entry { lower: path.to_lowercase(), path, dir: kind == "d", base });
            }
            _ => continue,
        }
    }
    (entries, false)
}

fn subsequence(needle: &str, hay: &str) -> bool {
    let mut chars = needle.chars();
    let mut next = chars.next();
    for c in hay.chars() {
        if Some(c) == next { next = chars.next(); if next.is_none() { return true; } }
    }
    next.is_none()
}
/// Higher is better. The first term decides the tier from the base name;
/// every term must appear somewhere in the path.
pub fn score(query: &str, e: &Entry) -> Option<i32> {
    let q = query.trim().to_lowercase();
    let mut terms = q.split_whitespace();
    let first = terms.next()?;
    let name = &e.lower[e.base..];
    let tier = if name == first { 1000 }
        else if name.starts_with(first) { 800 }
        else if name.match_indices(first).any(|(i, _)| i > 0 && matches!(name.as_bytes()[i - 1], b'-' | b'_' | b'.' | b' ')) { 700 }
        else if name.contains(first) { 600 }
        else if subsequence(first, name) { 400 }
        else if e.lower.contains(first) { 250 }
        else if subsequence(first, &e.lower) { 100 }
        else { return None };
    if !terms.all(|t| e.lower.contains(t)) { return None; }
    let depth = e.path.matches('/').count().min(20) as i32;
    let length = (name.len() as i32 - first.len() as i32).clamp(0, 50);
    // Depth and name length separate results within a tier; a directory only
    // breaks a tie.
    Some(tier - depth * 2 - length + if e.dir { 1 } else { 0 })
}
pub fn search(entries: &[Entry], query: &str, limit: usize) -> Vec<Hit> {
    if query.trim().is_empty() || limit == 0 { return Vec::new(); }
    let mut hits: Vec<(i32, &Entry)> = entries.iter().filter_map(|e| score(query, e).map(|s| (s, e))).collect();
    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.len().cmp(&b.1.path.len())).then_with(|| a.1.path.cmp(&b.1.path)));
    hits.into_iter().take(limit).map(|(_, e)| Hit { path: e.path.clone(), name: e.path[e.base..].to_string(), dir: e.dir }).collect()
}

/// Walk the home directory over a fresh channel on the existing master.
fn walk(control_path: &str, target: &str) -> Result<(Vec<Entry>, bool), String> {
    let mut child = Command::new("ssh")
        .args(["-S", control_path, "-o", "BatchMode=yes", target, &format!("sh -c '{}'", script())])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|e| format!("Cannot start the file index: {e}"))?;
    let stdout = child.stdout.take().ok_or("Cannot read the file index")?;
    let lines = BufReader::new(stdout).lines().map_while(Result::ok);
    let result = parse(lines, CAP);
    let _ = child.kill();
    let _ = child.wait();
    if result.0.is_empty() { return Err("The home directory could not be listed".into()); }
    Ok(result)
}

#[tauri::command]
pub async fn index_build(hosts: State<'_, crate::Hosts>, indexes: State<'_, Indexes>, target: String) -> Result<Status, String> {
    let connection = {
        let map = hosts.0.lock().map_err(|e| e.to_string())?;
        let h = map.get(&target).ok_or("not connected")?;
        (h.control_path().to_string(), h.target().to_string())
    };
    {
        let mut map = lock(&indexes.0)?;
        let index = map.entry(target.clone()).or_default();
        if index.building { return Ok(index.status()); }
        index.building = true;
    }
    let result = tauri::async_runtime::spawn_blocking(move || walk(&connection.0, &connection.1)).await.map_err(|e| e.to_string())?;
    let mut map = lock(&indexes.0)?;
    let index = map.entry(target).or_default();
    index.finish(result);
    Ok(index.status())
}
#[tauri::command]
pub fn index_search(indexes: State<Indexes>, target: String, query: String, limit: usize) -> Result<Vec<Hit>, String> {
    let map = lock(&indexes.0)?;
    Ok(map.get(&target).map(|i| search(&i.entries, &query, limit.min(100))).unwrap_or_default())
}
#[tauri::command]
pub fn index_status(indexes: State<Indexes>, target: String) -> Result<Status, String> {
    Ok(lock(&indexes.0)?.get(&target).map(HostIndex::status).unwrap_or_else(|| HostIndex::default().status()))
}
pub fn forget(indexes: &Indexes, target: &str) { if let Ok(mut map) = indexes.0.lock() { map.remove(target); } }

#[cfg(test)]
mod tests {
    use super::*;
    fn listing(lines: &[&str]) -> Vec<String> { lines.iter().map(|s| s.to_string()).collect() }
    fn names(hits: &[Hit]) -> Vec<&str> { hits.iter().map(|h| h.name.as_str()).collect() }

    #[test]
    fn listing_becomes_absolute_entries_and_skips_what_it_cannot_trust() {
        let (entries, truncated) = parse(listing(&["H /home/pi", "d projects", "f projects/README.md", "l link", "s run/socket", "garbage", "f ", "f projects/new\nline"]).into_iter(), 10);
        assert!(!truncated);
        assert_eq!(entries.iter().map(|e| (e.path.as_str(), e.dir)).collect::<Vec<_>>(),
            vec![("/home/pi/projects", true), ("/home/pi/projects/README.md", false), ("/home/pi/link", false), ("/home/pi/projects/new\nline", false)]);
        assert_eq!(&entries[1].path[entries[1].base..], "README.md");
        // Nothing before the home line can be placed.
        assert!(parse(listing(&["f orphan", "H /home/pi"]).into_iter(), 10).0.is_empty());
    }
    #[test]
    fn the_cap_stops_the_walk_and_says_so() {
        let lines = std::iter::once("H /h".to_string()).chain((0..10).map(|i| format!("f file{i}")));
        let (entries, truncated) = parse(lines, 4);
        assert_eq!(entries.len(), 4);
        assert!(truncated);
    }
    #[test]
    fn matches_rank_by_name_then_depth_and_every_term_must_appear() {
        let (entries, _) = parse(listing(&["H /home/pi", "f README.md", "f docs/reader.txt", "f src/thread.rs", "f a/b/c/d/readme", "d projects/read-only", "f notes.txt"]).into_iter(), CAP);
        assert_eq!(names(&search(&entries, "read", 10)), ["README.md", "read-only", "reader.txt", "readme", "thread.rs"]);
        assert_eq!(names(&search(&entries, "src read", 10)), ["thread.rs"]);
        assert_eq!(names(&search(&entries, "rdm", 10)), ["README.md", "readme"]);
        assert_eq!(names(&search(&entries, "docs", 10)), ["reader.txt"]);
        assert!(search(&entries, "", 10).is_empty());
        assert!(search(&entries, "zzz", 10).is_empty());
        assert_eq!(search(&entries, "e", 2).len(), 2);
        let hit = &search(&entries, "read-only", 1)[0];
        assert_eq!((hit.path.as_str(), hit.dir), ("/home/pi/projects/read-only", true));
    }
    #[test]
    fn a_failed_rebuild_keeps_the_previous_index() {
        let mut index = HostIndex::default();
        index.building = true;
        index.finish(Ok((parse(listing(&["H /h", "f one"]).into_iter(), CAP).0, false)));
        assert_eq!((index.status().count, index.status().building, index.status().error), (1, false, None));
        index.building = true;
        index.finish(Err("ssh exited".into()));
        let status = index.status();
        assert_eq!((status.count, status.building, status.error.as_deref()), (1, false, Some("ssh exited")));
    }
    /// Needs a live ControlMaster:
    /// PLYDESK_TEST_HOST=user@host PLYDESK_TEST_CTL=~/.plydesk-user_host.sock cargo test walks_a_real_home -- --ignored --nocapture
    #[test]
    #[ignore]
    fn walks_a_real_home_when_a_host_is_given() {
        let target = std::env::var("PLYDESK_TEST_HOST").expect("PLYDESK_TEST_HOST=user@host");
        let ctl = std::env::var("PLYDESK_TEST_CTL").expect("PLYDESK_TEST_CTL=control socket path");
        let started = Instant::now();
        let (entries, truncated) = walk(&ctl, &target).unwrap();
        eprintln!("{} entries in {:?}, truncated={truncated}", entries.len(), started.elapsed());
        let sample = entries.iter().take(3).map(|e| format!("{}{}", e.path, if e.dir { "/" } else { "" })).collect::<Vec<_>>();
        eprintln!("first entries: {sample:?}");
        assert!(!entries.is_empty());
        assert!(entries.iter().all(|e| e.path.starts_with('/')));
        assert!(entries.iter().any(|e| e.dir) && entries.iter().any(|e| !e.dir));
        assert!(!entries.iter().any(|e| e.path.contains("/node_modules/")));
        let hits = search(&entries, "bash", 5);
        eprintln!("search 'bash': {:?}", hits.iter().map(|h| &h.path).collect::<Vec<_>>());
    }
    #[test]
    fn the_remote_script_prunes_dependency_trees_and_needs_no_single_quotes() {
        let s = script();
        assert!(s.contains("-name node_modules -o -name .git"));
        assert!(s.contains("-printf \"%y %P\\n\""));
        assert!(s.contains("! -type d -print"));
        assert!(!s.contains('\''), "the script is wrapped in single quotes for the remote shell");
    }
}
