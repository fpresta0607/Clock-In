//! The evidence uploader: one Tokio task that wakes every five minutes (and
//! on demand when a session finishes, when the UI asks to sync now, and once
//! more before exit), uploads buffered activity segments, drains the
//! agent-event spool, and keeps agent-activity tracking in step with the
//! session-boundary tracker.
//!
//! Durability posture, same as the pending-stop queue: any failure — auth or
//! transport — backs off to the next tick with both spools untouched, so the
//! retry replays identical, idempotent payloads. Only per-row server
//! rejections are dropped (a redacted count is logged, never the row).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

use crate::agent_usage;
use crate::api::{AgentUsageUpload, ApiClient, MappingKind, PathMapping, ShiftCommitUpload};
use crate::monitor::{
    advance_sessions, iso8601, lock, parse_iso8601, unix_now, ActiveAgent, AgentTracking,
    MonitorShared, ObservedSession, SeenAgentEvent, SegmentRecord,
};
use crate::shift_commits;
use crate::spool::{self, AgentEventKind, SpoolEvent};

/// The server's batch bound for both upload routes.
const UPLOAD_BATCH_SIZE: usize = 500;

/// Five minutes: frequent enough to keep the server current without making
/// the monitor noisy. Local agent events are replayed on every monitor poll.
const UPLOAD_INTERVAL_SECONDS: u64 = 300;

/// Every path an upload pass touches, bundled so `upload_loop`/`upload_once`
/// take one argument instead of one per spool or sidecar.
pub struct UploadPaths {
    pub segments_path: PathBuf,
    pub agent_path: PathBuf,
    pub sessions_path: PathBuf,
    pub shift_windows_path: PathBuf,
    pub shift_commits_path: PathBuf,
    pub agent_usage_path: PathBuf,
}

pub async fn upload_loop(
    shared: Arc<Mutex<MonitorShared>>,
    client: ApiClient,
    paths: UploadPaths,
    upload_now: Arc<Notify>,
) {
    let mut tick = tokio::time::interval(Duration::from_secs(UPLOAD_INTERVAL_SECONDS));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = upload_now.notified() => {}
        }
        upload_once(&shared, &client, &paths).await;
    }
}

/// One upload pass. Returns as soon as anything is unreachable; whatever was
/// not acknowledged stays in its spool for the next pass. Also the exit
/// flush: the monitor runs one bounded pass before the process quits.
pub(crate) async fn upload_once(
    shared: &Arc<Mutex<MonitorShared>>,
    client: &ApiClient,
    paths: &UploadPaths,
) {
    // Signed out: leave both spools for a session that can upload them.
    let Some(session) = crate::read_session_token() else {
        return;
    };
    let Ok(token) = client.fetch_access_token(&session).await else {
        return;
    };

    // Turns any newly-closed shift into shift-commit rows before this pass
    // uploads them. Reads the agent spool without truncating it, so it never
    // races the agent-spool drain below.
    shift_commits::capture_from_spool(
        &paths.agent_path,
        &paths.shift_windows_path,
        &paths.shift_commits_path,
    )
    .await;

    // Same posture for token capture: the transcript reader tails what the
    // spool named, on every platform, from this same pass. The settings
    // opt-out stops the reader; counters already captured are kept.
    if lock(shared).settings.agent_usage_capture {
        agent_usage::capture_from_spool(&paths.agent_path, &paths.agent_usage_path);
    }

    let mut complete = upload_segments(client, &token, &paths.segments_path).await;

    // Refresh the local mapping cache before the drain resolves suggestions.
    // A failed refresh keeps last pass's cache — stale mappings beat none.
    if let Ok(mappings) = client.path_mappings(&token).await {
        crate::monitor::set_mappings(shared, mappings);
    } else {
        complete = false;
    }

    // Keep the browser collection admitted: the authorization expires after
    // ten minutes and this pass runs every five. Best-effort, like the rest of
    // the maintenance — a stale or absent collection just reports disabled.
    if let Err(error) = crate::browser::renew_collection_authorization(&spool::browser_dir()) {
        eprintln!(
            "clock-in: could not renew browser attribution: {}",
            error.message
        );
    }

    let agent_spool_drained = upload_agent_spool(client, &token, &paths.agent_path).await;
    let browser_spool_drained = upload_agent_spool(
        client,
        &token,
        &spool::browser_dir().join("browser-spool.jsonl"),
    )
    .await;
    complete &= agent_spool_drained;
    complete &= browser_spool_drained;
    complete &= upload_sessions(client, &token, &paths.sessions_path).await;

    // Shift commits reference an agent session by external id; uploading them
    // before both agent-spool drains have succeeded this pass would race a
    // session that has not reached the server yet. Usage counters carry the
    // same reference, so they wait on the same gate.
    if agent_spool_drained && browser_spool_drained {
        complete &= upload_shift_commits_spool(client, &token, &paths.shift_commits_path).await;
        complete &= upload_agent_usage_spool(client, &token, &paths.agent_usage_path).await;
    }

    if complete {
        lock(shared).last_upload_at = Some(iso8601(unix_now()));
    }
}

/// Uploads every buffered segment in batches, then truncates the acked
/// prefix. A mid-batch failure skips the truncation, so the whole spool
/// replays next pass — safe because `clientId` makes replays idempotent.
async fn upload_segments(client: &ApiClient, token: &str, path: &Path) -> bool {
    let Ok((records, acked_bytes)) = spool::read_pending_lines::<SegmentRecord>(path) else {
        return false;
    };
    if records.is_empty() {
        return true;
    }
    for chunk in records.chunks(UPLOAD_BATCH_SIZE) {
        match client.upload_segments(token, chunk).await {
            Ok(outcome) => {
                // Rejected rows failed permanent validation; retrying them
                // would reject forever, so they are dropped with the ack.
                if !outcome.rejected.is_empty() {
                    eprintln!(
                        "clock-in: the server rejected {} activity segment(s); dropping them",
                        outcome.rejected.len()
                    );
                }
            }
            Err(_) => return false,
        }
    }
    spool::truncate_acked(path, acked_bytes).is_ok()
}

/// Uploads finished sessions in batches, then truncates the acked prefix. A
/// mid-batch failure skips the truncation, so the spool replays next pass —
/// safe because the server ignores client ids it already stored.
async fn upload_sessions(client: &ApiClient, token: &str, path: &Path) -> bool {
    let Ok((sessions, acked_bytes)) = spool::read_pending_lines::<ObservedSession>(path) else {
        return false;
    };
    if sessions.is_empty() {
        return true;
    }
    for chunk in sessions.chunks(UPLOAD_BATCH_SIZE) {
        match client.upload_observed_sessions(token, chunk).await {
            Ok(rejected) => {
                // A rejected row failed permanent validation; retrying it would
                // reject forever, so it is dropped with the ack.
                if rejected > 0 {
                    eprintln!("clock-in: the server rejected {rejected} session(s); dropping them");
                }
            }
            Err(_) => return false,
        }
    }
    spool::truncate_acked(path, acked_bytes).is_ok()
}

async fn upload_agent_spool(client: &ApiClient, token: &str, path: &Path) -> bool {
    let pending = match spool::read_pending(path) {
        Ok(pending) => pending,
        Err(_) => return false,
    };
    if pending.events.is_empty() {
        return true;
    }

    // `startHead` is a spool-local field the shift-capture sidecar reads; the
    // server's agent-session contract has no such field, so it never leaves
    // the machine.
    let mut events = pending.events;
    for event in &mut events {
        event.start_head = None;
    }

    for chunk in events.chunks(UPLOAD_BATCH_SIZE) {
        match client.upload_agent_events(token, chunk).await {
            Ok(results) => {
                let rejected = results.iter().filter(|result| !result.accepted).count();
                if rejected > 0 {
                    eprintln!("clock-in: the server rejected {rejected} agent event(s)");
                }
            }
            Err(_) => return false,
        }
    }
    spool::truncate_acked(path, pending.acked_bytes).is_ok()
}

/// Uploads every unsynced shift commit in batches. Accepted rows (including
/// duplicates the server already had) are marked synced; a permanent
/// rejection is marked rejected and dropped; `unknown_session` is retryable
/// and left alone entirely, so it uploads again once the shift itself has
/// landed. A transport failure marks nothing, so the whole batch replays
/// identically next pass.
async fn upload_shift_commits_spool(
    client: &ApiClient,
    token: &str,
    shift_commits_path: &Path,
) -> bool {
    let pending = shift_commits::unsynced(shift_commits_path);
    if pending.is_empty() {
        return true;
    }
    for chunk in pending.chunks(UPLOAD_BATCH_SIZE) {
        let uploads: Vec<ShiftCommitUpload> = chunk.iter().map(to_shift_commit_upload).collect();
        let outcome = match client.upload_shift_commits(token, &uploads).await {
            Ok(outcome) => outcome,
            Err(_) => return false,
        };
        let rejected_ids: std::collections::HashSet<&str> = outcome
            .rejected
            .iter()
            .map(|rejection| rejection.client_id.as_str())
            .collect();
        let permanent: Vec<String> = outcome
            .rejected
            .iter()
            .filter(|rejection| rejection.reason != "unknown_session")
            .map(|rejection| rejection.client_id.clone())
            .collect();
        if !permanent.is_empty() {
            eprintln!(
                "clock-in: the server rejected {} shift commit(s)",
                permanent.len()
            );
        }
        let accepted: Vec<String> = chunk
            .iter()
            .map(|entry| entry.client_id.clone())
            .filter(|client_id| !rejected_ids.contains(client_id.as_str()))
            .collect();
        shift_commits::mark_synced(shift_commits_path, &accepted);
        shift_commits::mark_rejected(shift_commits_path, &permanent);
    }
    true
}

fn to_shift_commit_upload(entry: &crate::shift_commits::CommitEntry) -> ShiftCommitUpload {
    ShiftCommitUpload {
        client_id: entry.client_id.clone(),
        source: entry.source.clone(),
        external_session_id: entry.external_session_id.clone(),
        repo_root: entry.repo_root.clone(),
        branch: entry.branch.clone(),
        sha: entry.sha.clone(),
        subject: entry.subject.clone(),
        authored_at: entry.authored_at.clone(),
        verification: entry.verification.clone(),
        verified_at: entry.verified_at.clone(),
    }
}

/// Uploads every unsynced usage entry in batches, under the same verdict
/// rules as shift commits: accepted rows are marked synced, a permanent
/// rejection is marked rejected and dropped, `unknown_session` is retryable
/// and left alone entirely, and a transport failure marks nothing so the
/// whole batch replays identically next pass.
async fn upload_agent_usage_spool(
    client: &ApiClient,
    token: &str,
    agent_usage_path: &Path,
) -> bool {
    let pending = agent_usage::unsynced(agent_usage_path);
    if pending.is_empty() {
        return true;
    }
    for chunk in pending.chunks(UPLOAD_BATCH_SIZE) {
        let uploads: Vec<AgentUsageUpload> = chunk.iter().map(to_agent_usage_upload).collect();
        let outcome = match client.upload_agent_usage(token, &uploads).await {
            Ok(outcome) => outcome,
            Err(_) => return false,
        };
        let rejected_ids: std::collections::HashSet<&str> = outcome
            .rejected
            .iter()
            .map(|rejection| rejection.client_id.as_str())
            .collect();
        let permanent: Vec<String> = outcome
            .rejected
            .iter()
            .filter(|rejection| rejection.reason != "unknown_session")
            .map(|rejection| rejection.client_id.clone())
            .collect();
        if !permanent.is_empty() {
            eprintln!(
                "clock-in: the server rejected {} agent usage row(s)",
                permanent.len()
            );
        }
        let accepted: Vec<String> = chunk
            .iter()
            .map(|entry| entry.client_id.clone())
            .filter(|client_id| !rejected_ids.contains(client_id.as_str()))
            .collect();
        agent_usage::mark_synced(agent_usage_path, &accepted);
        agent_usage::mark_rejected(agent_usage_path, &permanent);
    }
    true
}

fn to_agent_usage_upload(entry: &agent_usage::UsageEntry) -> AgentUsageUpload {
    AgentUsageUpload {
        client_id: entry.client_id.clone(),
        source: entry.source.clone(),
        external_session_id: entry.external_session_id.clone(),
        bucket_start_at: entry.bucket_start_at.clone(),
        model: entry.model.clone(),
        sidechain: entry.sidechain,
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_creation_input_tokens: entry.cache_creation_input_tokens,
        cache_read_input_tokens: entry.cache_read_input_tokens,
    }
}

/// Replays every unseen event at its own timestamp, bracketing the lifecycle
/// update with tracker ticks. A short agent run between uploader passes then
/// still creates the right project boundaries instead of collapsing to its
/// final state.
pub fn replay_agent_spool(shared: &Arc<Mutex<MonitorShared>>, path: &Path) -> Vec<ObservedSession> {
    let Ok(pending) = spool::read_pending(path) else {
        return Vec::new();
    };
    replay_agent_events(shared, &pending.events)
}

pub fn replay_agent_events(
    shared: &Arc<Mutex<MonitorShared>>,
    events: &[SpoolEvent],
) -> Vec<ObservedSession> {
    let mut ordered: Vec<(u64, &SpoolEvent)> = events
        .iter()
        .filter_map(|event| parse_iso8601(&event.occurred_at).map(|at| (at, event)))
        .collect();
    ordered.sort_by(|(left_at, left), (right_at, right)| {
        (
            left_at,
            left.source.as_str(),
            &left.external_session_id,
            event_rank(left.event),
        )
            .cmp(&(
                right_at,
                right.source.as_str(),
                &right.external_session_id,
                event_rank(right.event),
            ))
    });

    let mut finished = Vec::new();
    let mut shared = lock(shared);
    for (at, event) in ordered {
        if !agent_event_is_new(event, at, &shared.agent) {
            continue;
        }
        let can_replay_boundary = shared
            .tracker
            .open_session()
            .is_none_or(|open| at >= open.last_active_at);
        if can_replay_boundary {
            finished.extend(advance_sessions(&mut shared, at));
        }
        let mappings = shared.mappings.clone();
        track_agent_event(event, at, &mappings, &mut shared.agent);
        if can_replay_boundary {
            finished.extend(advance_sessions(&mut shared, at));
        }
    }
    finished
}

/// The drain's local bookkeeping. Replays are idempotent per agent lifecycle:
/// a source plus external session id owns exactly one active marker.
#[cfg(test)]
pub fn track_agent_events(
    events: &[SpoolEvent],
    mappings: &[PathMapping],
    tracking: &mut AgentTracking,
) {
    let mut ordered: Vec<(u64, &SpoolEvent)> = events
        .iter()
        .filter_map(|event| parse_iso8601(&event.occurred_at).map(|at| (at, event)))
        .collect();
    ordered.sort_by(|(left_at, left), (right_at, right)| {
        (
            left_at,
            left.source.as_str(),
            &left.external_session_id,
            event_rank(left.event),
        )
            .cmp(&(
                right_at,
                right.source.as_str(),
                &right.external_session_id,
                event_rank(right.event),
            ))
    });

    for (at, event) in ordered {
        track_agent_event(event, at, mappings, tracking);
    }
}

fn agent_key(event: &SpoolEvent) -> (String, String) {
    (
        event.source.as_str().to_string(),
        event.external_session_id.clone(),
    )
}

fn event_rank(kind: AgentEventKind) -> u8 {
    match kind {
        AgentEventKind::Started => 0,
        AgentEventKind::Heartbeat => 1,
        AgentEventKind::Ended => 2,
    }
}

fn agent_event_is_new(event: &SpoolEvent, at: u64, tracking: &AgentTracking) -> bool {
    let key = agent_key(event);
    tracking.seen.get(&key).is_none_or(|seen| {
        (at, event_rank(event.event)) > (seen.occurred_at, event_rank(seen.kind))
    })
}

fn track_agent_event(
    event: &SpoolEvent,
    at: u64,
    mappings: &[PathMapping],
    tracking: &mut AgentTracking,
) {
    if !agent_event_is_new(event, at, tracking) {
        return;
    }
    let key = agent_key(event);
    let source = event.source.as_str().to_string();
    tracking.last_event_at = tracking.last_event_at.max(at);
    match event.event {
        AgentEventKind::Started => {
            tracking.active.insert(
                key.clone(),
                ActiveAgent {
                    source,
                    external_session_id: event.external_session_id.clone(),
                    started_at: at,
                    last_event_at: at,
                    project: event
                        .cwd
                        .as_deref()
                        .and_then(|cwd| resolve_project(cwd, mappings)),
                },
            );
        }
        AgentEventKind::Heartbeat => {
            let resolved = event
                .cwd
                .as_deref()
                .and_then(|cwd| resolve_project(cwd, mappings));
            let active = tracking
                .active
                .entry(key.clone())
                .or_insert_with(|| ActiveAgent {
                    source,
                    external_session_id: event.external_session_id.clone(),
                    started_at: at,
                    last_event_at: at,
                    project: resolved.clone(),
                });
            active.last_event_at = at;
            if let Some(project) = resolved {
                active.project = Some(project);
            }
        }
        AgentEventKind::Ended => {
            tracking.active.remove(&key);
        }
    }
    tracking.seen.insert(
        key,
        SeenAgentEvent {
            occurred_at: at,
            kind: event.event,
        },
    );
}

/// Lowercases, unifies separators to `/`, and strips trailing separators —
/// the same normalization the server's attribution service applies, so a
/// local suggestion never names a project the server would reject.
pub fn normalize_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

/// A prefix matches only on a path-segment boundary: `c:/dev/clock` matches
/// `c:/dev/clock` and `c:/dev/clock/src` but never `c:/dev/clock-in`.
fn matches_boundary(cwd: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return cwd.starts_with('/');
    }
    cwd == prefix
        || cwd
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Resolves a working directory to a project by normalized longest-prefix
/// match. Equal-length ties are ambiguous and resolve to nothing, unless
/// every winner names the same project — the server's rule, mirrored.
pub fn resolve_project(cwd: &str, mappings: &[PathMapping]) -> Option<String> {
    let cwd = normalize_path(cwd);
    let mut best: Vec<&PathMapping> = Vec::new();
    let mut best_length: Option<usize> = None;
    for mapping in mappings {
        // URL rules match browser tabs, never an agent's working directory;
        // running them through the path-prefix matcher would file `cwd` under
        // a website pattern. Only path-prefix mappings participate here.
        if mapping.kind != MappingKind::PathPrefix {
            continue;
        }
        let prefix = normalize_path(&mapping.path_prefix);
        if !matches_boundary(&cwd, &prefix) {
            continue;
        }
        match best_length {
            Some(length) if length > prefix.len() => {}
            Some(length) if length == prefix.len() => best.push(mapping),
            _ => {
                best_length = Some(prefix.len());
                best.clear();
                best.push(mapping);
            }
        }
    }
    let project_ids: std::collections::BTreeSet<&str> = best
        .iter()
        .map(|mapping| mapping.project_id.as_str())
        .collect();
    if project_ids.len() == 1 {
        best.first().map(|mapping| mapping.project_id.clone())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::monitor::SegmentKind;

    /// A scratch directory per test; spool paths must not collide.
    fn temp_dir(name: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "clock-in-uploader-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the scratch directory is creatable");
        dir
    }

    /// A loopback HTTP stub that serves exactly one request. The join handle
    /// yields the raw request, so a test can assert on the bytes the desktop
    /// actually put on the wire rather than on what it meant to send.
    async fn stub_server(
        status: u16,
        body: &'static str,
    ) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the loopback stub binds");
        let port = listener
            .local_addr()
            .expect("the stub has an address")
            .port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("the stub accepts");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4_096];
            loop {
                let read = stream.read(&mut buffer).await.expect("the stub reads");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                // Stop at the end of the body rather than at EOF: reqwest keeps
                // the connection open, so waiting for a close would hang.
                if let Some(head_end) = find_head_end(&request) {
                    let length = content_length(&request[..head_end]);
                    if request.len() >= head_end + length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status} STUB\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("the stub answers");
            stream.flush().await.expect("the stub flushes");
            String::from_utf8_lossy(&request).into_owned()
        });
        (port, handle)
    }

    /// Byte offset just past the blank line that ends the request head.
    fn find_head_end(request: &[u8]) -> Option<usize> {
        request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
    }

    fn content_length(head: &[u8]) -> usize {
        String::from_utf8_lossy(head)
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())?
            })
            .unwrap_or(0)
    }

    fn stub_client(port: u16) -> ApiClient {
        ApiClient::new(
            format!("http://127.0.0.1:{port}/auth"),
            format!("http://127.0.0.1:{port}"),
        )
        .expect("the stub client builds")
    }

    /// One spooled segment, exactly as `append_segment_line` writes it.
    fn spool_one_segment(path: &Path) {
        let record = SegmentRecord {
            client_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301".to_string(),
            device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".to_string(),
            kind: SegmentKind::Active,
            process_name: Some("chrome.exe".to_string()),
            started_at: "2026-08-11T15:38:00Z".to_string(),
            ended_at: "2026-08-11T15:40:00Z".to_string(),
        };
        let mut line = serde_json::to_vec(&record).expect("the record encodes");
        line.push(b'\n');
        spool::append_line(path, &line, spool::MAX_SPOOL_BYTES).expect("the spool accepts a line");
    }

    /// The link nothing covered: a spooled segment has to reach
    /// `/activity/segments` in the shape the contract accepts, and leave the
    /// spool only once the server has taken it.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_segment_reaches_the_activity_endpoint_and_leaves_the_spool() {
        let dir = temp_dir("accepted");
        let path = dir.join("segments-spool.jsonl");
        spool_one_segment(&path);

        let (port, server) = stub_server(200, r#"{"accepted":1,"rejected":[]}"#).await;
        assert!(
            upload_segments(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /activity/segments "),
            "the batch goes to the segment endpoint: {request}"
        );
        assert!(
            request.contains("\"deviceId\":\"7c9e6679-7425-40de-944b-e07fc1f90ae7\""),
            "the wire payload carries the device id: {request}"
        );
        assert!(
            request.contains("\"kind\":\"active\"")
                && request.contains("\"processName\":\"chrome.exe\""),
            "the wire payload carries the contract's field names: {request}"
        );

        let (pending, _) =
            spool::read_pending_lines::<SegmentRecord>(&path).expect("the spool reads");
        assert!(pending.is_empty(), "an accepted batch leaves the spool");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One spooled finished session, exactly as `append_session_line` writes it.
    fn spool_one_session(path: &Path) {
        let session = ObservedSession {
            client_id: "ac1da70b-d921-42ec-8f8f-03a0cdd5be01".to_string(),
            project_id: "2c8ce697-8011-4c66-9421-7fc83d39cb92".to_string(),
            attribution: crate::monitor::Attribution::Default,
            started_at: "2026-08-12T13:36:06Z".to_string(),
            stopped_at: "2026-08-12T13:36:36Z".to_string(),
            idle_seconds: 0,
        };
        let mut line = serde_json::to_vec(&session).expect("the session encodes");
        line.push(b'\n');
        spool::append_line(path, &line, spool::MAX_SPOOL_BYTES).expect("the spool accepts a line");
    }

    /// The regression that stranded a real session on disk: a finished
    /// session in the spool must reach `/sessions/observed` on the next pass
    /// and leave the spool once the server has taken it.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_session_reaches_the_observed_endpoint_and_leaves_the_spool() {
        let dir = temp_dir("session-accepted");
        let path = dir.join("sessions-spool.jsonl");
        spool_one_session(&path);

        let (port, server) = stub_server(200, r#"{"accepted":1,"rejected":[]}"#).await;
        assert!(
            upload_sessions(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /sessions/observed "),
            "the batch goes to the observed-session endpoint: {request}"
        );
        assert!(
            request.contains("\"attribution\":\"default\"")
                && request.contains("\"startedAt\":\"2026-08-12T13:36:06Z\""),
            "the wire payload carries the contract's field names: {request}"
        );

        let (pending, _) =
            spool::read_pending_lines::<ObservedSession>(&path).expect("the spool reads");
        assert!(pending.is_empty(), "an accepted batch leaves the spool");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refused session batch keeps the evidence for the next pass, exactly
    /// like segments.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_session_batch_stays_spooled() {
        let dir = temp_dir("session-refused");
        let path = dir.join("sessions-spool.jsonl");
        spool_one_session(&path);

        let (port, server) = stub_server(500, r#"{"code":"internal_error"}"#).await;
        assert!(
            !upload_sessions(&stub_client(port), "token", &path).await,
            "a refused batch reports failure"
        );
        let _ = server.await;

        let (pending, _) =
            spool::read_pending_lines::<ObservedSession>(&path).expect("the spool reads");
        assert_eq!(pending.len(), 1, "a refused batch stays spooled");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refusal must keep the evidence. This is also the shape of the silent
    /// stall: the spool grows, nothing reaches the server, and the only
    /// outward sign is the backlog counter.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_batch_keeps_every_segment_for_the_next_pass() {
        let dir = temp_dir("refused");
        let path = dir.join("segments-spool.jsonl");
        spool_one_segment(&path);

        let (port, server) = stub_server(400, r#"{"code":"validation_error"}"#).await;
        assert!(
            !upload_segments(&stub_client(port), "token", &path).await,
            "a refused batch reports failure"
        );
        let _ = server.await;

        let (pending, _) =
            spool::read_pending_lines::<SegmentRecord>(&path).expect("the spool reads");
        assert_eq!(pending.len(), 1, "a refused batch stays spooled");

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn source(id: &str) -> spool::AgentSource {
        spool::AgentSource::parse(id).expect("the test names a well-shaped runtime")
    }

    fn one_commit_entry(client_id: &str, sha: &str) -> crate::shift_commits::CommitEntry {
        crate::shift_commits::CommitEntry {
            client_id: client_id.to_string(),
            source: source("claude_code"),
            external_session_id: "s1".to_string(),
            repo_root: "C:/dev/clock-in".to_string(),
            branch: Some("main".to_string()),
            sha: sha.to_string(),
            subject: "did work".to_string(),
            authored_at: "2026-08-11T15:38:00Z".to_string(),
            verification: "pending".to_string(),
            verified_at: None,
            synced: false,
            rejected: false,
        }
    }

    fn spool_one_shift_commit(path: &Path, client_id: &str, sha: &str) {
        let entries = vec![one_commit_entry(client_id, sha)];
        let bytes = serde_json::to_vec(&entries).expect("the registry encodes");
        std::fs::write(path, bytes).expect("the registry writes");
    }

    fn read_shift_commits(path: &Path) -> Vec<crate::shift_commits::CommitEntry> {
        serde_json::from_slice(&std::fs::read(path).expect("the registry reads"))
            .expect("the registry decodes")
    }

    /// An accepted shift commit reaches `/shift-commits` in the contract's
    /// shape and is marked synced, dropping it from the unsynced set.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_shift_commit_reaches_the_endpoint_and_is_marked_synced() {
        let dir = temp_dir("shift-commit-accepted");
        let path = dir.join("shift-commits.json");
        let sha = "a".repeat(40);
        spool_one_shift_commit(&path, "client-1", &sha);

        let (port, server) = stub_server(200, r#"{"accepted":1,"rejected":[]}"#).await;
        assert!(
            upload_shift_commits_spool(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /shift-commits "),
            "the batch goes to the shift-commits endpoint: {request}"
        );
        assert!(
            request.contains("\"clientId\":\"client-1\"")
                && request.contains(&format!("\"sha\":\"{sha}\""))
                && request.contains("\"repoRoot\":\"C:/dev/clock-in\"")
                && request.contains("\"externalSessionId\":\"s1\""),
            "the wire payload carries the contract's field names: {request}"
        );

        assert!(
            shift_commits::unsynced(&path).is_empty(),
            "an accepted commit is marked synced"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `unknown_session` is retryable: the row stays unsynced (and
    /// unrejected) so it uploads again once the shift itself has landed.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unknown_session_rejection_survives_as_unsynced() {
        let dir = temp_dir("shift-commit-unknown-session");
        let path = dir.join("shift-commits.json");
        let sha = "b".repeat(40);
        spool_one_shift_commit(&path, "client-2", &sha);

        let (port, server) = stub_server(
            200,
            r#"{"accepted":0,"rejected":[{"clientId":"client-2","reason":"unknown_session"}]}"#,
        )
        .await;
        assert!(
            upload_shift_commits_spool(&stub_client(port), "token", &path).await,
            "the server responding at all is a completed pass"
        );
        let _ = server.await;

        let entries = read_shift_commits(&path);
        assert_eq!(entries.len(), 1);
        assert!(
            !entries[0].synced && !entries[0].rejected,
            "unknown_session leaves the row retryable"
        );
        assert_eq!(shift_commits::unsynced(&path).len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Any other rejection reason is permanent: the row is marked rejected
    /// and drops out of the unsynced set for good.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_permanent_rejection_is_marked_rejected_and_dropped_from_unsynced() {
        let dir = temp_dir("shift-commit-rejected");
        let path = dir.join("shift-commits.json");
        let sha = "c".repeat(40);
        spool_one_shift_commit(&path, "client-3", &sha);

        let (port, server) = stub_server(
            200,
            r#"{"accepted":0,"rejected":[{"clientId":"client-3","reason":"validation_error"}]}"#,
        )
        .await;
        assert!(upload_shift_commits_spool(&stub_client(port), "token", &path).await);
        let _ = server.await;

        let entries = read_shift_commits(&path);
        assert!(entries[0].rejected && !entries[0].synced);
        assert!(shift_commits::unsynced(&path).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A transport failure marks nothing, so the identical batch replays
    /// next pass.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_transport_failure_marks_nothing() {
        let dir = temp_dir("shift-commit-transport-error");
        let path = dir.join("shift-commits.json");
        let sha = "d".repeat(40);
        spool_one_shift_commit(&path, "client-4", &sha);

        let (port, server) = stub_server(500, r#"{"code":"internal_error"}"#).await;
        assert!(
            !upload_shift_commits_spool(&stub_client(port), "token", &path).await,
            "a server error reports failure"
        );
        let _ = server.await;

        let entries = read_shift_commits(&path);
        assert!(
            !entries[0].synced && !entries[0].rejected,
            "nothing is marked on failure"
        );
        assert_eq!(shift_commits::unsynced(&path).len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Seeds a usage registry the way a real pass does: a `Started` line
    /// naming a transcript lands on the agent spool, then capture runs beside
    /// it. Returns the registry path and the client id capture assigned, so a
    /// stub verdict can name the row.
    fn spool_one_usage_entry(dir: &Path) -> (PathBuf, String) {
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let line = serde_json::json!({
            "timestamp": "2026-08-06T10:15:00Z",
            "sessionId": "session-1",
            "isSidechain": false,
            "message": {
                "model": "claude-opus-4.1",
                "usage": {
                    "input_tokens": 150,
                    "output_tokens": 12,
                    "cache_creation_input_tokens": 3,
                    "cache_read_input_tokens": 4,
                },
            },
        });
        std::fs::write(&transcript, format!("{line}\n")).expect("the transcript writes");
        let event = SpoolEvent {
            source: source("claude_code"),
            external_session_id: "session-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: "2026-08-06T10:00:00Z".to_string(),
            cwd: Some("C:/dev/clock-in".to_string()),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            model: None,
            rule_id: None,
            transcript_path: Some(transcript.to_string_lossy().into_owned()),
            tokens: None,
        };
        spool::append(&agent_path, &event).expect("the spool accepts a line");
        agent_usage::capture_from_spool(&agent_path, &usage_path);
        let pending = agent_usage::unsynced(&usage_path);
        assert_eq!(pending.len(), 1, "capture produced one usage entry");
        (usage_path, pending[0].client_id.clone())
    }

    /// Capture feeds upload: a transcript's counters reach `/agent-usage` in
    /// the contract's shape on the same pass and are marked synced.
    #[tokio::test(flavor = "multi_thread")]
    async fn captured_usage_reaches_the_endpoint_and_is_marked_synced() {
        let dir = temp_dir("usage-accepted");
        let (path, client_id) = spool_one_usage_entry(&dir);

        let (port, server) = stub_server(200, r#"{"accepted":1,"rejected":[]}"#).await;
        assert!(
            upload_agent_usage_spool(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /agent-usage "),
            "the batch goes to the agent-usage endpoint: {request}"
        );
        assert!(
            request.contains(&format!("\"clientId\":\"{client_id}\""))
                && request.contains("\"bucketStartAt\":\"2026-08-06T10:00:00Z\"")
                && request.contains("\"externalSessionId\":\"session-1\"")
                && request.contains("\"model\":\"claude-opus-4.1\"")
                && request.contains("\"sidechain\":false")
                && request.contains("\"inputTokens\":150")
                && request.contains("\"outputTokens\":12")
                && request.contains("\"cacheCreationInputTokens\":3")
                && request.contains("\"cacheReadInputTokens\":4"),
            "the wire payload carries the contract's field names: {request}"
        );

        assert!(
            agent_usage::unsynced(&path).is_empty(),
            "an accepted row is marked synced"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `unknown_session` is retryable: the shift may not have landed on the
    /// server yet, so the row stays unsynced (and unrejected) and uploads
    /// again once it has.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unknown_session_rejection_keeps_the_usage_row_retryable() {
        let dir = temp_dir("usage-unknown-session");
        let (path, client_id) = spool_one_usage_entry(&dir);

        let (port, server) = stub_server(
            200,
            Box::leak(
                format!(
                    r#"{{"accepted":0,"rejected":[{{"clientId":"{client_id}","reason":"unknown_session"}}]}}"#
                )
                .into_boxed_str(),
            ),
        )
        .await;
        assert!(
            upload_agent_usage_spool(&stub_client(port), "token", &path).await,
            "the server responding at all is a completed pass"
        );
        let _ = server.await;

        assert_eq!(
            agent_usage::unsynced(&path).len(),
            1,
            "unknown_session leaves the row retryable"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Any other rejection reason is permanent: the row is marked rejected
    /// and drops out of the unsynced set for good.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_permanent_usage_rejection_is_marked_rejected_and_dropped() {
        let dir = temp_dir("usage-rejected");
        let (path, client_id) = spool_one_usage_entry(&dir);

        let (port, server) = stub_server(
            200,
            Box::leak(
                format!(
                    r#"{{"accepted":0,"rejected":[{{"clientId":"{client_id}","reason":"validation_error"}}]}}"#
                )
                .into_boxed_str(),
            ),
        )
        .await;
        assert!(upload_agent_usage_spool(&stub_client(port), "token", &path).await);
        let _ = server.await;

        assert!(
            agent_usage::unsynced(&path).is_empty(),
            "a permanent rejection leaves the unsynced set"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The wire trap the projection exists for: the spool line now carries
    /// capture-only fields (`transcriptPath`, `tokens`), and the strict
    /// `/agent-sessions` schema 400s on any key it does not declare. Pin the
    /// exact key set the upload sends.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_uploaded_agent_event_sends_only_the_contract_fields() {
        let dir = temp_dir("agent-wire-shape");
        let path = dir.join("agent-spool.jsonl");
        let event = SpoolEvent {
            source: source("claude_code"),
            external_session_id: "session-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: "2026-08-12T13:36:06Z".to_string(),
            cwd: Some("C:/dev/Clock-In".to_string()),
            start_head: Some("a".repeat(40)),
            repo_root: Some("C:/dev/Clock-In".to_string()),
            repo_remote: Some("git@github.com:fpresta0607/clock-in.git".to_string()),
            model: Some("claude-opus-4.1".to_string()),
            rule_id: None,
            transcript_path: Some("C:/Users/alex/.claude/projects/x/session-1.jsonl".to_string()),
            tokens: Some(spool::TokenCounters {
                input_tokens: Some(150),
                output_tokens: Some(12),
                cache_creation_input_tokens: Some(3),
                cache_read_input_tokens: Some(4),
            }),
        };
        spool::append(&path, &event).expect("the spool accepts a line");

        let (port, server) = stub_server(
            200,
            r#"{"results":[{"externalSessionId":"session-1","accepted":true}]}"#,
        )
        .await;
        assert!(
            upload_agent_spool(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /agent-sessions "),
            "the batch goes to the agent-sessions endpoint: {request}"
        );
        let head_end = find_head_end(request.as_bytes()).expect("the request has a head");
        let body: serde_json::Value =
            serde_json::from_str(&request[head_end..]).expect("the body parses");
        let event = body["events"][0].as_object().expect("one event object");
        let mut keys: Vec<&str> = event.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "cwd",
                "event",
                "externalSessionId",
                "model",
                "occurredAt",
                "repoRemote",
                "repoRoot",
                "source"
            ],
            "exactly the contract fields, no capture-only keys: {request}"
        );
        // repoRoot is contract data and rides through; startHead is
        // sidecar-local and must not, even though the hook writes them
        // together from the same probe.
        assert_eq!(event["repoRoot"], "C:/dev/Clock-In");
        // The remote rides through verbatim; the server normalizes it, and it
        // is what keys the identity, so losing it here would put every
        // worktree back on its own roster row.
        assert_eq!(
            event["repoRemote"],
            "git@github.com:fpresta0607/clock-in.git"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn mapping(id: &str, prefix: &str, project: &str) -> PathMapping {
        PathMapping {
            id: id.to_string(),
            kind: MappingKind::PathPrefix,
            path_prefix: prefix.to_string(),
            repo_url: None,
            project_id: project.to_string(),
        }
    }

    fn event(kind: AgentEventKind, cwd: &str, occurred_at: &str) -> SpoolEvent {
        event_for(source("claude_code"), "s1", kind, cwd, occurred_at)
    }

    fn event_for(
        source: spool::AgentSource,
        external_session_id: &str,
        kind: AgentEventKind,
        cwd: &str,
        occurred_at: &str,
    ) -> SpoolEvent {
        SpoolEvent {
            source,
            external_session_id: external_session_id.to_string(),
            event: kind,
            occurred_at: occurred_at.to_string(),
            cwd: Some(cwd.to_string()),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            model: None,
            rule_id: None,
            transcript_path: None,
            tokens: None,
        }
    }

    /// `startHead` is a spool-local field the shift-capture sidecar reads; the
    /// server's agent-session contract has no such field, so the uploaded
    /// event must not carry it.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_uploaded_agent_event_drops_the_spool_local_start_head() {
        let dir = temp_dir("agent-start-head");
        let path = dir.join("agent-spool.jsonl");
        let event = SpoolEvent {
            source: source("claude_code"),
            external_session_id: "session-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: "2026-08-12T13:36:06Z".to_string(),
            cwd: Some("C:/dev/Clock-In".to_string()),
            start_head: Some("a".repeat(40)),
            repo_root: None,
            repo_remote: None,
            model: None,
            rule_id: None,
            transcript_path: None,
            tokens: None,
        };
        let mut line = serde_json::to_vec(&event).expect("the event encodes");
        line.push(b'\n');
        spool::append_line(&path, &line, spool::MAX_SPOOL_BYTES).expect("the spool accepts a line");

        let (port, server) = stub_server(
            200,
            r#"{"results":[{"externalSessionId":"session-1","accepted":true}]}"#,
        )
        .await;
        assert!(
            upload_agent_spool(&stub_client(port), "token", &path).await,
            "an accepted batch reports success"
        );

        let request = server.await.expect("the stub finishes");
        assert!(
            request.starts_with("POST /agent-sessions "),
            "the batch goes to the agent-sessions endpoint: {request}"
        );
        assert!(
            request.contains("\"externalSessionId\":\"session-1\"")
                && request.contains("\"cwd\":\"C:/dev/Clock-In\""),
            "the wire payload carries the contract's field names: {request}"
        );
        assert!(
            !request.contains("startHead"),
            "startHead is a spool-local field and must not reach the server: {request}"
        );

        let (pending, _) = spool::read_pending_lines::<SpoolEvent>(&path).expect("the spool reads");
        assert!(pending.is_empty(), "an accepted batch leaves the spool");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_normalization_matches_the_server() {
        assert_eq!(normalize_path("C:\\Dev\\Clock-In\\"), "c:/dev/clock-in");
        assert_eq!(normalize_path("c:/dev/clock-in"), "c:/dev/clock-in");
        assert_eq!(normalize_path("/home/alex/project//"), "/home/alex/project");
    }

    #[test]
    fn prefixes_match_only_on_segment_boundaries() {
        assert!(matches_boundary("c:/dev/clock", "c:/dev/clock"));
        assert!(matches_boundary("c:/dev/clock/src", "c:/dev/clock"));
        assert!(!matches_boundary("c:/dev/clock-in-extra", "c:/dev/clock"));
        assert!(!matches_boundary("c:/dev", "c:/dev/clock"));
    }

    #[test]
    fn the_longest_matching_prefix_wins() {
        let mappings = vec![
            mapping("m1", "C:/dev", "p-general"),
            mapping("m2", "c:/DEV/clock-in", "p-clockin"),
        ];
        assert_eq!(
            resolve_project("C:\\dev\\Clock-In\\src", &mappings).as_deref(),
            Some("p-clockin")
        );
        assert_eq!(
            resolve_project("C:/dev/other", &mappings).as_deref(),
            Some("p-general")
        );
        assert_eq!(resolve_project("D:/elsewhere", &mappings), None);
    }

    #[test]
    fn equal_length_ties_are_ambiguous_unless_they_agree() {
        let tie = vec![
            mapping("m1", "C:/dev", "p-one"),
            mapping("m2", "c:/dev/", "p-two"),
        ];
        assert_eq!(resolve_project("c:/dev/clock-in", &tie), None);

        let agreement = vec![
            mapping("m1", "C:/dev", "p-one"),
            mapping("m2", "c:/dev/", "p-one"),
        ];
        assert_eq!(
            resolve_project("c:/dev/clock-in", &agreement).as_deref(),
            Some("p-one")
        );
    }

    #[test]
    fn started_events_open_tracking_and_ended_events_close_it() {
        let mut tracking = AgentTracking::default();

        track_agent_events(
            &[
                event(
                    AgentEventKind::Started,
                    "C:/dev/clock-in",
                    "2026-08-07T10:00:00Z",
                ),
                event(
                    AgentEventKind::Heartbeat,
                    "C:/dev/clock-in",
                    "2026-08-07T10:05:00Z",
                ),
            ],
            &[],
            &mut tracking,
        );
        assert_eq!(tracking.active.len(), 1);
        assert_eq!(
            tracking.last_event_at,
            parse_iso8601("2026-08-07T10:05:00Z").expect("timestamp parses")
        );
        assert_eq!(
            tracking
                .active
                .get(&("claude_code".to_string(), "s1".to_string())),
            Some(&ActiveAgent {
                source: "claude_code".to_string(),
                external_session_id: "s1".to_string(),
                started_at: parse_iso8601("2026-08-07T10:00:00Z").expect("timestamp parses"),
                last_event_at: parse_iso8601("2026-08-07T10:05:00Z").expect("timestamp parses"),
                project: None,
            }),
            "the start opens the marker; the heartbeat keeps the original start"
        );

        track_agent_events(
            &[event(
                AgentEventKind::Ended,
                "C:/dev/clock-in",
                "2026-08-07T11:00:00Z",
            )],
            &[],
            &mut tracking,
        );
        assert!(
            tracking.active.is_empty(),
            "an ended session clears its marker"
        );
    }

    #[test]
    fn a_mapped_start_names_the_project_the_open_session_belongs_to() {
        let mappings = vec![mapping("m1", "C:/dev/clock-in", "p-clockin")];
        let mut tracking = AgentTracking::default();

        track_agent_events(
            &[event(
                AgentEventKind::Started,
                "C:/dev/clock-in",
                "2026-08-07T10:00:00Z",
            )],
            &mappings,
            &mut tracking,
        );
        assert_eq!(
            tracking.effective_project(
                parse_iso8601("2026-08-07T10:00:00Z").expect("timestamp parses")
            ),
            Some("p-clockin")
        );

        // An unmapped directory names nothing, so the last name stands until
        // the session that carried it ends.
        track_agent_events(
            &[event(
                AgentEventKind::Heartbeat,
                "D:/unmapped",
                "2026-08-07T11:00:00Z",
            )],
            &mappings,
            &mut tracking,
        );
        assert_eq!(
            tracking.effective_project(
                parse_iso8601("2026-08-07T11:00:00Z").expect("timestamp parses")
            ),
            Some("p-clockin")
        );

        track_agent_events(
            &[event(
                AgentEventKind::Ended,
                "C:/dev/clock-in",
                "2026-08-07T12:00:00Z",
            )],
            &mappings,
            &mut tracking,
        );
        assert_eq!(
            tracking.effective_project(
                parse_iso8601("2026-08-07T12:00:00Z").expect("timestamp parses")
            ),
            None,
            "with no agent running, time falls back to the default project"
        );
    }

    #[test]
    fn ending_one_agent_keeps_an_overlapping_agent_active_and_attributed() {
        let mappings = vec![
            mapping("m1", "C:/one", "p-one"),
            mapping("m2", "C:/two", "p-two"),
        ];
        let mut tracking = AgentTracking::default();
        track_agent_events(
            &[
                event_for(
                    source("claude_code"),
                    "one",
                    AgentEventKind::Started,
                    "C:/one",
                    "2026-08-07T10:00:00Z",
                ),
                event_for(
                    source("cursor"),
                    "two",
                    AgentEventKind::Started,
                    "C:/two",
                    "2026-08-07T10:01:00Z",
                ),
                event_for(
                    source("claude_code"),
                    "one",
                    AgentEventKind::Ended,
                    "C:/one",
                    "2026-08-07T10:02:00Z",
                ),
            ],
            &mappings,
            &mut tracking,
        );

        let now = parse_iso8601("2026-08-07T10:02:00Z").expect("timestamp parses");
        assert!(tracking.is_active(now, true));
        assert_eq!(tracking.effective_project(now), Some("p-two"));
        assert!(tracking
            .active
            .contains_key(&("cursor".to_string(), "two".to_string())));
    }

    #[test]
    fn replaying_a_short_agent_session_splits_the_tracker_at_event_times() {
        let shared = Arc::new(Mutex::new(MonitorShared {
            builder: crate::monitor::SegmentBuilder::new(),
            settings: crate::monitor::MonitorSettings::default(),
            mappings: vec![mapping("m1", "C:/clock", "p-clock")],
            agent: AgentTracking::default(),
            last_upload_at: None,
            last_poll_at: None,
            tracker: crate::monitor::SessionTracker::new(),
            default_project: Some("p-default".to_string()),
            account_id: Some("u1".to_string()),
            selected_project: None,
        }));
        {
            let mut state = lock(&shared);
            state.builder.apply(
                1_000,
                &crate::monitor::ActivitySignal::Active { process_name: None },
            );
            advance_sessions(&mut state, 1_000);
        }

        let finished = replay_agent_events(
            &shared,
            &[
                event(AgentEventKind::Started, "C:/clock", "1970-01-01T00:16:50Z"),
                event(AgentEventKind::Ended, "C:/clock", "1970-01-01T00:17:00Z"),
            ],
        );

        let agent = finished
            .iter()
            .find(|session| session.project_id == "p-clock")
            .expect("the short agent interval becomes its own session");
        assert_eq!(agent.started_at, iso8601(1_010));
        assert_eq!(agent.stopped_at, iso8601(1_020));
    }

    #[test]
    fn out_of_order_events_replay_without_moving_state_backwards() {
        let mut tracking = AgentTracking::default();
        let newer = event(AgentEventKind::Heartbeat, "C:/dev", "2026-08-07T12:00:00Z");
        track_agent_events(&[newer], &[], &mut tracking);
        // A replayed drain delivers the same older events; state must not regress.
        track_agent_events(
            &[event(
                AgentEventKind::Started,
                "C:/dev",
                "2026-08-07T10:00:00Z",
            )],
            &[],
            &mut tracking,
        );
        assert_eq!(
            tracking.last_event_at,
            parse_iso8601("2026-08-07T12:00:00Z").expect("timestamp parses")
        );

        // Out-of-order delivery within one batch is tolerated by sorting.
        let mut fresh = AgentTracking::default();
        track_agent_events(
            &[
                event(AgentEventKind::Ended, "C:/dev", "2026-08-07T11:00:00Z"),
                event(AgentEventKind::Started, "C:/dev", "2026-08-07T10:00:00Z"),
            ],
            &[],
            &mut fresh,
        );
        assert!(
            fresh.active.is_empty(),
            "the end landed after the start in time order"
        );
    }
}
