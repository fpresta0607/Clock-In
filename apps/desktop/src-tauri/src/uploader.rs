//! The evidence uploader: one Tokio task that wakes every five minutes (and
//! on demand at timer stop), uploads buffered activity segments, drains the
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

use crate::api::{ApiClient, PathMapping};
use crate::monitor::{
    advance_sessions, iso8601, lock, parse_iso8601, unix_now, ActiveAgent, AgentTracking,
    MonitorShared, ObservedSession, SeenAgentEvent, SegmentRecord,
};
use crate::spool::{self, AgentEventKind, AgentSource, SpoolEvent};

/// The server's batch bound for both upload routes.
const UPLOAD_BATCH_SIZE: usize = 500;

/// Five minutes: frequent enough to keep the server current without making
/// the monitor noisy. Local agent events are replayed on every monitor poll.
const UPLOAD_INTERVAL_SECONDS: u64 = 300;

pub async fn upload_loop(
    shared: Arc<Mutex<MonitorShared>>,
    client: ApiClient,
    segments_path: PathBuf,
    agent_path: PathBuf,
    sessions_path: PathBuf,
    upload_now: Arc<Notify>,
) {
    let mut tick = tokio::time::interval(Duration::from_secs(UPLOAD_INTERVAL_SECONDS));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = upload_now.notified() => {}
        }
        upload_once(
            &shared,
            &client,
            &segments_path,
            &agent_path,
            &sessions_path,
        )
        .await;
    }
}

/// One upload pass. Returns as soon as anything is unreachable; whatever was
/// not acknowledged stays in its spool for the next pass.
async fn upload_once(
    shared: &Arc<Mutex<MonitorShared>>,
    client: &ApiClient,
    segments_path: &Path,
    agent_path: &Path,
    sessions_path: &Path,
) {
    // Signed out: leave both spools for a session that can upload them.
    let Some(session) = crate::read_session_token() else {
        return;
    };
    let Ok(token) = client.fetch_access_token(&session).await else {
        return;
    };

    let mut complete = upload_segments(client, &token, segments_path).await;

    // Refresh the local mapping cache before the drain resolves suggestions.
    // A failed refresh keeps last pass's cache — stale mappings beat none.
    if let Ok(mappings) = client.path_mappings(&token).await {
        lock(shared).mappings = mappings;
    } else {
        complete = false;
    }

    complete &= upload_agent_spool(client, &token, agent_path).await;
    complete &= upload_sessions(client, &token, sessions_path).await;

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

    for chunk in pending.events.chunks(UPLOAD_BATCH_SIZE) {
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
            source_name(left.source),
            &left.external_session_id,
            event_rank(left.event),
        )
            .cmp(&(
                right_at,
                source_name(right.source),
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
            source_name(left.source),
            &left.external_session_id,
            event_rank(left.event),
        )
            .cmp(&(
                right_at,
                source_name(right.source),
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
        source_name(event.source).to_string(),
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
    let source = source_name(event.source).to_string();
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

pub fn source_name(source: AgentSource) -> &'static str {
    match source {
        AgentSource::ClaudeCode => "claude_code",
        AgentSource::Codex => "codex",
        AgentSource::KimiCode => "kimi_code",
        AgentSource::Cursor => "cursor",
        AgentSource::Browser => "browser",
        AgentSource::Other => "other",
    }
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
    use super::*;

    fn mapping(id: &str, prefix: &str, project: &str) -> PathMapping {
        PathMapping {
            id: id.to_string(),
            path_prefix: prefix.to_string(),
            repo_url: None,
            project_id: project.to_string(),
        }
    }

    fn event(kind: AgentEventKind, cwd: &str, occurred_at: &str) -> SpoolEvent {
        event_for(AgentSource::ClaudeCode, "s1", kind, cwd, occurred_at)
    }

    fn event_for(
        source: AgentSource,
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
            rule_id: None,
        }
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
                    AgentSource::ClaudeCode,
                    "one",
                    AgentEventKind::Started,
                    "C:/one",
                    "2026-08-07T10:00:00Z",
                ),
                event_for(
                    AgentSource::Cursor,
                    "two",
                    AgentEventKind::Started,
                    "C:/two",
                    "2026-08-07T10:01:00Z",
                ),
                event_for(
                    AgentSource::ClaudeCode,
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
