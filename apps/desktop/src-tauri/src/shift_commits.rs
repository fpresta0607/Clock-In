//! Shift-commit capture and local verification.
//!
//! Two sidecars, both JSON documents guarded by the spool's interprocess
//! lock (browser.rs's sidecar precedent — one lock file per subsystem, not
//! per file):
//!
//! - `shift-windows.json`: open shifts. A `Started` line opens a window
//!   here; the matching `Ended` line closes it and triggers git discovery.
//!   `Started` and `Ended` can drain in different uploader passes, so the
//!   window has to survive between them.
//! - `shift-commits.json`: the durable registry of captured commits, their
//!   verification state, and what has synced to the server. Unlike the
//!   spools this never truncates; entries are pruned once decided and synced.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::browser::write_if_changed_locked;
use crate::git_evidence::{self, Verification};
use crate::monitor::{iso8601, parse_iso8601, unix_now};
use crate::spool::{self, AgentEventKind, AgentSource};

/// How long an opened window waits for its `Ended` line before it counts as
/// abandoned (a crash, a forced quit) and is reaped.
const STALE_WINDOW_SECS: u64 = 7 * 24 * 60 * 60;

/// How long a decided, already-synced entry stays in the registry once it can
/// no longer change or need re-upload.
const REGISTRY_RETENTION_SECS: u64 = 90 * 24 * 60 * 60;

/// A permanently rejected entry is never re-uploaded and never re-verified,
/// so it only has to outlive the diagnosis of whatever rejected it. Without
/// its own window it is pending and unsynced by construction, which every
/// other rule reads as "keep forever".
const REJECTED_RETENTION_SECS: u64 = 30 * 24 * 60 * 60;

fn window_key(source: &AgentSource, external_session_id: &str) -> String {
    format!("{}|{external_session_id}", source.as_str())
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct ShiftWindow {
    started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    /// What `HEAD` pointed at when the shift opened; the capture range starts
    /// there. Absent on windows opened before this was recorded, and on a cwd
    /// that is not a repo - both record nothing rather than guessing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start_head: Option<String>,
    #[serde(default)]
    captured: bool,
}

/// One captured commit, from discovery through verification through upload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub client_id: String,
    pub source: AgentSource,
    pub external_session_id: String,
    pub repo_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub sha: String,
    pub subject: String,
    pub authored_at: String,
    pub verification: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
    #[serde(default)]
    pub synced: bool,
    #[serde(default)]
    pub rejected: bool,
}

fn read_json_sidecar<T: Default + serde::de::DeserializeOwned>(path: &Path) -> T {
    let Ok(bytes) = std::fs::read(path) else {
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            quarantine_corrupt(path, &bytes);
            T::default()
        }
    }
}

/// A sidecar that fails to parse is moved aside rather than left to fail
/// every future read; capture and verification resume from empty state
/// instead of stalling on a file nothing can repair.
fn quarantine_corrupt(path: &Path, bytes: &[u8]) {
    let mut name = path.as_os_str().to_owned();
    name.push(".corrupt");
    let _ = std::fs::write(PathBuf::from(name), bytes);
}

fn read_windows(path: &Path) -> HashMap<String, ShiftWindow> {
    read_json_sidecar(path)
}

fn write_windows(path: &Path, windows: &HashMap<String, ShiftWindow>) -> spool::SpoolResult<()> {
    let bytes = serde_json::to_vec(windows).map_err(std::io::Error::other)?;
    write_if_changed_locked(path, &bytes)
}

fn read_registry(path: &Path) -> Vec<CommitEntry> {
    read_json_sidecar(path)
}

fn write_registry(path: &Path, registry: &[CommitEntry]) -> spool::SpoolResult<()> {
    let bytes = serde_json::to_vec(registry).map_err(std::io::Error::other)?;
    write_if_changed_locked(path, &bytes)
}

fn reap_stale_windows(windows: &mut HashMap<String, ShiftWindow>, now: u64) {
    windows.retain(|_, window| now.saturating_sub(window.started_at) < STALE_WINDOW_SECS);
}

/// Drops registry rows that can no longer change or need re-upload: decided
/// and already synced, or permanently rejected, once they are old enough that
/// nobody is still looking at them.
fn prune_decided_and_synced(registry: &mut Vec<CommitEntry>, now: u64) {
    registry.retain(|entry| {
        if entry.rejected {
            let Some(authored_at) = parse_iso8601(&entry.authored_at) else {
                return true;
            };
            return now.saturating_sub(authored_at) < REJECTED_RETENTION_SECS;
        }
        if entry.verification == "pending" || !entry.synced {
            return true;
        }
        let Some(verified_at) = entry.verified_at.as_deref().and_then(parse_iso8601) else {
            return true;
        };
        now.saturating_sub(verified_at) < REGISTRY_RETENTION_SECS
    });
}

struct PendingCapture {
    key: String,
    source: AgentSource,
    external_session_id: String,
    cwd: String,
    start_head: String,
    started_at: u64,
    ended_at: u64,
}

struct CaptureResult {
    key: String,
    source: AgentSource,
    external_session_id: String,
    repo_root: Option<String>,
    branch: Option<String>,
    commits: Vec<git_evidence::CommitEvidence>,
}

/// Reads pending agent-spool lines without truncating them — the uploader's
/// own agent-spool drain owns truncation, and replaying the same lines here
/// is safe because every step is idempotent (window-open is a no-op once
/// open, capture is a no-op once `captured`).
///
/// `Started` opens a window. `Ended` closes it and, once per shift, runs git
/// discovery over the window: a non-repo cwd or a missing window (the
/// `Started` predates this feature) records nothing, which is the correct,
/// non-error outcome.
pub async fn capture_from_spool(
    agent_path: &Path,
    shift_windows_path: &Path,
    shift_commits_path: &Path,
) {
    let Ok(pending) = spool::read_pending(agent_path) else {
        return;
    };
    if pending.events.is_empty() {
        return;
    }

    let now = unix_now();

    let mut to_capture: Vec<PendingCapture> = Vec::new();
    let opened = spool::with_lock(shift_commits_path, || {
        let mut windows = read_windows(shift_windows_path);
        reap_stale_windows(&mut windows, now);

        for event in &pending.events {
            let key = window_key(&event.source, &event.external_session_id);
            match event.event {
                AgentEventKind::Started => {
                    if let Some(started_at) = parse_iso8601(&event.occurred_at) {
                        windows.entry(key).or_insert_with(|| ShiftWindow {
                            started_at,
                            cwd: event.cwd.clone(),
                            start_head: event.start_head.clone(),
                            captured: false,
                        });
                    }
                }
                AgentEventKind::Ended => {
                    let Some(ended_at) = parse_iso8601(&event.occurred_at) else {
                        continue;
                    };
                    let Some(window) = windows.get_mut(&key) else {
                        continue;
                    };
                    if window.captured {
                        continue;
                    }
                    match (window.cwd.clone(), window.start_head.clone()) {
                        (Some(cwd), Some(start_head)) => to_capture.push(PendingCapture {
                            key: key.clone(),
                            source: event.source.clone(),
                            external_session_id: event.external_session_id.clone(),
                            cwd,
                            start_head,
                            started_at: window.started_at,
                            ended_at,
                        }),
                        // No working directory, or a shift that opened before
                        // its starting commit was recorded: there is nothing
                        // to look at, so the window closes captured instead of
                        // being re-examined every pass until it goes stale.
                        _ => window.captured = true,
                    }
                }
                AgentEventKind::Heartbeat => {}
            }
        }
        write_windows(shift_windows_path, &windows)
    });
    if opened.is_err() || to_capture.is_empty() {
        return;
    }

    // Git discovery runs unlocked: it can take real time (up to the 10s
    // per-command timeout, per commit window), and nothing else needs the
    // sidecar lock held while it runs.
    let mut results = Vec::with_capacity(to_capture.len());
    for capture in to_capture {
        let repo = git_evidence::discover_repo(Path::new(&capture.cwd)).await;
        let (repo_root, branch, commits) = match repo {
            Some(location) => {
                let commits = git_evidence::commits_in_window(
                    &location.root,
                    &capture.start_head,
                    capture.started_at,
                    capture.ended_at,
                )
                .await;
                (
                    Some(location.root.to_string_lossy().into_owned()),
                    location.branch,
                    commits,
                )
            }
            None => (None, None, Vec::new()),
        };
        results.push(CaptureResult {
            key: capture.key,
            source: capture.source,
            external_session_id: capture.external_session_id,
            repo_root,
            branch,
            commits,
        });
    }

    let _ = spool::with_lock(shift_commits_path, || {
        let mut windows = read_windows(shift_windows_path);
        let mut registry = read_registry(shift_commits_path);
        for result in &results {
            let Some(window) = windows.get_mut(&result.key) else {
                continue;
            };
            if window.captured {
                // A concurrent pass already discovered this shift.
                continue;
            }
            window.captured = true;
            let Some(repo_root) = &result.repo_root else {
                continue;
            };
            for commit in &result.commits {
                let already_recorded = registry.iter().any(|entry| {
                    entry.source == result.source
                        && entry.external_session_id == result.external_session_id
                        && entry.sha == commit.sha
                });
                if already_recorded {
                    continue;
                }
                registry.push(CommitEntry {
                    client_id: uuid::Uuid::new_v4().to_string(),
                    source: result.source.clone(),
                    external_session_id: result.external_session_id.clone(),
                    repo_root: repo_root.clone(),
                    branch: result.branch.clone(),
                    sha: commit.sha.clone(),
                    subject: commit.subject.clone(),
                    authored_at: commit.authored_at.clone(),
                    verification: "pending".to_string(),
                    verified_at: None,
                    synced: false,
                    rejected: false,
                });
            }
        }
        prune_decided_and_synced(&mut registry, now);
        write_windows(shift_windows_path, &windows)?;
        write_registry(shift_commits_path, &registry)
    });
}

/// Every entry the uploader has not yet gotten a permanent verdict for.
pub fn unsynced(shift_commits_path: &Path) -> Vec<CommitEntry> {
    spool::with_lock(shift_commits_path, || {
        Ok(read_registry(shift_commits_path)
            .into_iter()
            .filter(|entry| !entry.synced && !entry.rejected)
            .collect())
    })
    .unwrap_or_default()
}

/// Marks the given client ids accepted by the server (a permanent, terminal
/// outcome for upload purposes even while `verification` is still pending).
pub fn mark_synced(shift_commits_path: &Path, client_ids: &[String]) {
    let _ = spool::with_lock(shift_commits_path, || {
        let mut registry = read_registry(shift_commits_path);
        for entry in registry.iter_mut() {
            if client_ids.iter().any(|id| id == &entry.client_id) {
                entry.synced = true;
            }
        }
        write_registry(shift_commits_path, &registry)
    });
}

/// Marks the given client ids permanently rejected by the server — anything
/// other than the retryable `unknown_session` reason, which the caller keeps
/// unsynced instead.
pub fn mark_rejected(shift_commits_path: &Path, client_ids: &[String]) {
    let _ = spool::with_lock(shift_commits_path, || {
        let mut registry = read_registry(shift_commits_path);
        for entry in registry.iter_mut() {
            if client_ids.iter().any(|id| id == &entry.client_id) {
                entry.rejected = true;
            }
        }
        write_registry(shift_commits_path, &registry)
    });
}

fn verification_label(verification: Verification) -> &'static str {
    match verification {
        Verification::Merged => "merged",
        Verification::Reverted => "reverted",
        Verification::Orphaned => "orphaned",
        Verification::Pending => "pending",
    }
}

/// Checks every pending, unrejected entry whose repo is still on disk against
/// the repo's current state, and records whatever git decides. A missing
/// repo directory leaves the entry untouched — pending is a legitimate
/// steady state, not a failure. A decided entry is marked unsynced so the
/// next upload pass replays it with its new verdict.
pub async fn run_verification_pass(shift_commits_path: &Path) {
    let candidates: Vec<CommitEntry> = spool::with_lock(shift_commits_path, || {
        Ok(read_registry(shift_commits_path)
            .into_iter()
            .filter(|entry| {
                entry.verification == "pending"
                    && !entry.rejected
                    && Path::new(&entry.repo_root).is_dir()
            })
            .collect())
    })
    .unwrap_or_default();
    if candidates.is_empty() {
        return;
    }

    let mut decisions: Vec<(String, Verification)> = Vec::new();
    for entry in &candidates {
        let outcome =
            git_evidence::verify(Path::new(&entry.repo_root), &entry.sha, &entry.authored_at).await;
        if outcome != Verification::Pending {
            decisions.push((entry.client_id.clone(), outcome));
        }
    }
    if decisions.is_empty() {
        return;
    }

    let now = unix_now();
    let _ = spool::with_lock(shift_commits_path, || {
        let mut registry = read_registry(shift_commits_path);
        for (client_id, outcome) in &decisions {
            if let Some(entry) = registry
                .iter_mut()
                .find(|entry| &entry.client_id == client_id)
            {
                if entry.verification != "pending" {
                    // Already decided by a concurrent pass.
                    continue;
                }
                entry.verification = verification_label(*outcome).to_string();
                entry.verified_at = Some(iso8601(now));
                entry.synced = false;
            }
        }
        prune_decided_and_synced(&mut registry, now);
        write_registry(shift_commits_path, &registry)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spool::SpoolEvent;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "clock-in-shift-commits-{name}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir creates");
        dir
    }

    fn unique_suffix() -> u64 {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn source() -> AgentSource {
        AgentSource::parse("claude_code").expect("canonical source parses")
    }

    fn event(kind: AgentEventKind, occurred_at: &str, cwd: Option<&str>) -> SpoolEvent {
        SpoolEvent {
            source: source(),
            external_session_id: "session-1".to_string(),
            event: kind,
            occurred_at: occurred_at.to_string(),
            cwd: cwd.map(str::to_string),
            start_head: None,
            model: None,
            rule_id: None,
        }
    }

    fn started_event(occurred_at: &str, cwd: &str, start_head: Option<&str>) -> SpoolEvent {
        SpoolEvent {
            source: source(),
            external_session_id: "session-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: occurred_at.to_string(),
            cwd: Some(cwd.to_string()),
            start_head: start_head.map(str::to_string),
            model: None,
            rule_id: None,
        }
    }

    async fn git(dir: &Path, args: &[&str]) {
        let status = tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .expect("git runs");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    async fn init_repo(dir: &Path) {
        git(dir, &["init", "--quiet"]).await;
        git(dir, &["config", "user.email", "shift@example.test"]).await;
        git(dir, &["config", "user.name", "Shift Test"]).await;
        git(dir, &["config", "commit.gpgsign", "false"]).await;
    }

    async fn commit_in_repo(dir: &Path, message: &str, unix_time: u64) {
        let date = iso8601(unix_time);
        let status = tokio::process::Command::new("git")
            .args(["commit", "--quiet", "--allow-empty", "-m", message])
            .current_dir(dir)
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .expect("git commit runs");
        assert!(status.success());
    }

    #[tokio::test]
    async fn a_started_line_with_no_matching_ended_records_nothing() {
        let dir = temp_dir("open-only");
        let agent_path = dir.join("agent-spool.jsonl");
        let windows_path = dir.join("shift-windows.json");
        let commits_path = dir.join("shift-commits.json");
        spool::append(
            &agent_path,
            &event(
                AgentEventKind::Started,
                "2026-08-06T10:00:00Z",
                Some("/tmp"),
            ),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &windows_path, &commits_path).await;

        assert!(read_registry(&commits_path).is_empty());
        assert_eq!(read_windows(&windows_path).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_ended_line_whose_started_predates_the_feature_records_nothing() {
        let dir = temp_dir("no-window");
        let agent_path = dir.join("agent-spool.jsonl");
        let windows_path = dir.join("shift-windows.json");
        let commits_path = dir.join("shift-commits.json");
        spool::append(
            &agent_path,
            &event(AgentEventKind::Ended, "2026-08-06T11:00:00Z", Some("/tmp")),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &windows_path, &commits_path).await;

        assert!(read_registry(&commits_path).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_shift_over_a_real_repo_captures_its_commit_exactly_once_on_replay() {
        let dir = temp_dir("capture");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).expect("repo dir creates");
        init_repo(&repo).await;
        // A live shift, not a historical one: a window older than the stale
        // bound is reaped rather than closed.
        let started_at = unix_now() - 600;
        commit_in_repo(&repo, "work from before the shift", started_at - 60).await;

        let agent_path = dir.join("agent-spool.jsonl");
        let windows_path = dir.join("shift-windows.json");
        let commits_path = dir.join("shift-commits.json");
        let cwd = repo.to_string_lossy().into_owned();

        // The hook records HEAD when it writes the Started line, so a shift
        // that opens and closes inside one upload interval is still bounded to
        // the HEAD that existed before the shift's own commit landed.
        let start_head = crate::git_evidence::head_sha(&repo).expect("the repo has a HEAD");
        spool::append(
            &agent_path,
            &started_event(&iso8601(started_at), &cwd, Some(&start_head)),
        )
        .expect("append succeeds");
        commit_in_repo(&repo, "did work", started_at + 60).await;
        spool::append(
            &agent_path,
            &event(
                AgentEventKind::Ended,
                &iso8601(started_at + 300),
                Some(&cwd),
            ),
        )
        .expect("append succeeds");

        // Started and Ended drain in the same pass — the sub-5-minute shift
        // that used to lose its commit because HEAD was read after it landed.
        capture_from_spool(&agent_path, &windows_path, &commits_path).await;
        let first_pass = read_registry(&commits_path);
        assert_eq!(
            first_pass
                .iter()
                .map(|entry| entry.subject.as_str())
                .collect::<Vec<_>>(),
            ["did work"],
        );

        // The uploader has not truncated the spool yet, so a second pass
        // (retry, restart) replays the identical lines.
        capture_from_spool(&agent_path, &windows_path, &commits_path).await;
        let second_pass = read_registry(&commits_path);
        assert_eq!(second_pass, first_pass);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A shift that opened before its starting commit was ever recorded has
    /// nothing to bound a capture with, so it closes rather than being
    /// re-examined on every pass until it goes stale seven days later.
    #[tokio::test]
    async fn a_shift_with_no_starting_commit_closes_without_capturing() {
        let dir = temp_dir("no-start-head");
        let agent_path = dir.join("agent-spool.jsonl");
        let windows_path = dir.join("shift-windows.json");
        let commits_path = dir.join("shift-commits.json");
        spool::append(
            &agent_path,
            &event(AgentEventKind::Started, &iso8601(1_700_000_000), None),
        )
        .expect("append succeeds");
        spool::append(
            &agent_path,
            &event(AgentEventKind::Ended, &iso8601(1_700_001_000), None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &windows_path, &commits_path).await;

        assert!(read_registry(&commits_path).is_empty());
        assert!(
            read_windows(&windows_path)
                .values()
                .next()
                .expect("the window exists")
                .captured
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_shift_over_a_non_repo_cwd_captures_nothing() {
        let dir = temp_dir("non-repo-shift");
        let not_a_repo = dir.join("not-a-repo");
        std::fs::create_dir_all(&not_a_repo).expect("scratch dir creates");
        let agent_path = dir.join("agent-spool.jsonl");
        let windows_path = dir.join("shift-windows.json");
        let commits_path = dir.join("shift-commits.json");
        let cwd = not_a_repo.to_string_lossy().into_owned();
        spool::append(
            &agent_path,
            &event(AgentEventKind::Started, &iso8601(1_700_000_000), Some(&cwd)),
        )
        .expect("append succeeds");
        spool::append(
            &agent_path,
            &event(AgentEventKind::Ended, &iso8601(1_700_001_000), Some(&cwd)),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &windows_path, &commits_path).await;

        assert!(read_registry(&commits_path).is_empty());
        assert!(
            read_windows(&windows_path)
                .values()
                .next()
                .unwrap()
                .captured
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_registry_is_quarantined_and_reads_as_empty() {
        let dir = temp_dir("corrupt-registry");
        let commits_path = dir.join("shift-commits.json");
        std::fs::write(&commits_path, b"{not json").expect("corrupt write succeeds");

        let registry = read_registry(&commits_path);

        assert!(registry.is_empty());
        assert!(
            std::fs::read_to_string(dir.join("shift-commits.json.corrupt"))
                .expect("quarantine reads")
                .contains("not json")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_windows_sidecar_is_quarantined_and_reads_as_empty() {
        let dir = temp_dir("corrupt-windows");
        let windows_path = dir.join("shift-windows.json");
        std::fs::write(&windows_path, b"not json at all").expect("corrupt write succeeds");

        let windows = read_windows(&windows_path);

        assert!(windows.is_empty());
        assert!(
            std::fs::read_to_string(dir.join("shift-windows.json.corrupt"))
                .expect("quarantine reads")
                .contains("not json")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writers_serialize_through_the_sidecar_lock() {
        let dir = temp_dir("lock-contention");
        let commits_path = dir.join("shift-commits.json");
        let path_a = commits_path.clone();
        let path_b = commits_path.clone();

        let writer = |path: PathBuf, tag: &'static str| {
            move || {
                let _ = spool::with_lock(&path, || {
                    let mut registry = read_registry(&path);
                    registry.push(CommitEntry {
                        client_id: format!("{tag}-client"),
                        source: source(),
                        external_session_id: "session-1".to_string(),
                        repo_root: "C:/repo".to_string(),
                        branch: None,
                        sha: "a".repeat(40),
                        subject: tag.to_string(),
                        authored_at: iso8601(1_700_000_000),
                        verification: "pending".to_string(),
                        verified_at: None,
                        synced: false,
                        rejected: false,
                    });
                    write_registry(&path, &registry)
                });
            }
        };

        let handle_a = std::thread::spawn(writer(path_a, "a"));
        let handle_b = std::thread::spawn(writer(path_b, "b"));
        handle_a.join().expect("writer a joins");
        handle_b.join().expect("writer b joins");

        assert_eq!(read_registry(&commits_path).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mark_synced_and_mark_rejected_update_only_the_named_entries() {
        let dir = temp_dir("mark");
        let commits_path = dir.join("shift-commits.json");
        let base = CommitEntry {
            client_id: "one".to_string(),
            source: source(),
            external_session_id: "session-1".to_string(),
            repo_root: "C:/repo".to_string(),
            branch: None,
            sha: "a".repeat(40),
            subject: "did work".to_string(),
            authored_at: iso8601(1_700_000_000),
            verification: "pending".to_string(),
            verified_at: None,
            synced: false,
            rejected: false,
        };
        let mut other = base.clone();
        other.client_id = "two".to_string();
        other.sha = "b".repeat(40);
        write_registry(&commits_path, &[base, other]).expect("write succeeds");

        mark_synced(&commits_path, &["one".to_string()]);
        mark_rejected(&commits_path, &["two".to_string()]);

        let registry = read_registry(&commits_path);
        let one = registry
            .iter()
            .find(|entry| entry.client_id == "one")
            .unwrap();
        let two = registry
            .iter()
            .find(|entry| entry.client_id == "two")
            .unwrap();
        assert!(one.synced && !one.rejected);
        assert!(two.rejected && !two.synced);

        assert_eq!(unsynced(&commits_path), Vec::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A rejected entry is pending and unsynced by construction, so without a
    /// window of its own every other retention rule reads it as "keep
    /// forever" and the registry grows without a ceiling.
    #[test]
    fn a_rejected_entry_is_pruned_once_its_retention_window_passes() {
        let now = 1_800_000_000;
        let mut fresh = pending_entry("fresh", "C:/repo".to_string(), "a".repeat(40));
        fresh.rejected = true;
        fresh.authored_at = iso8601(now - 60);
        let mut stale = pending_entry("stale", "C:/repo".to_string(), "b".repeat(40));
        stale.rejected = true;
        stale.authored_at = iso8601(now - REJECTED_RETENTION_SECS - 60);
        let mut registry = vec![
            fresh,
            stale,
            pending_entry("pending", "C:/repo".to_string(), "c".repeat(40)),
        ];

        prune_decided_and_synced(&mut registry, now);

        assert_eq!(
            registry
                .iter()
                .map(|entry| entry.client_id.as_str())
                .collect::<Vec<_>>(),
            ["fresh", "pending"],
        );
    }

    fn pending_entry(client_id: &str, repo_root: String, sha: String) -> CommitEntry {
        CommitEntry {
            client_id: client_id.to_string(),
            source: source(),
            external_session_id: "session-1".to_string(),
            repo_root,
            branch: None,
            sha,
            subject: "did work".to_string(),
            authored_at: iso8601(1_700_000_000),
            verification: "pending".to_string(),
            verified_at: None,
            synced: true,
            rejected: false,
        }
    }

    #[tokio::test]
    async fn a_verification_pass_leaves_a_deleted_repo_directory_untouched() {
        let dir = temp_dir("deleted-dir");
        let commits_path = dir.join("shift-commits.json");
        let entry = pending_entry(
            "c1",
            dir.join("gone").to_string_lossy().into_owned(),
            "a".repeat(40),
        );
        write_registry(&commits_path, std::slice::from_ref(&entry)).expect("registry writes");

        run_verification_pass(&commits_path).await;

        assert_eq!(read_registry(&commits_path), vec![entry]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_verification_pass_only_touches_entries_it_actually_decides() {
        let dir = temp_dir("flip-once");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).expect("repo dir creates");
        init_repo(&repo).await;
        commit_in_repo(&repo, "did work", 1_700_000_000).await;

        let commits_path = dir.join("shift-commits.json");
        let entry = pending_entry("c1", repo.to_string_lossy().into_owned(), "f".repeat(40));
        write_registry(&commits_path, &[entry]).expect("registry writes");

        run_verification_pass(&commits_path).await;
        let after_first = read_registry(&commits_path);
        assert_eq!(after_first[0].verification, "orphaned");
        assert!(
            !after_first[0].synced,
            "a genuine decision flips synced to false so it replays"
        );
        assert!(after_first[0].verified_at.is_some());

        run_verification_pass(&commits_path).await;
        let after_second = read_registry(&commits_path);
        assert_eq!(
            after_second, after_first,
            "an already-decided entry is untouched by a later pass"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
