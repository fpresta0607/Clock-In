//! The evidence uploader: one Tokio task that wakes every five minutes (and
//! on demand at timer stop), uploads buffered activity segments, drains the
//! agent-event spool, and performs the drain's local side effects —
//! agent-activity tracking for the away override and suggested-start detection
//! from the cached path mappings.
//!
//! Durability posture, same as the pending-stop queue: any failure — auth or
//! transport — backs off to the next tick with both spools untouched, so the
//! retry replays identical, idempotent payloads. Only per-row server
//! rejections are dropped (a redacted count is logged, never the row).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

use crate::api::{ApiClient, ErrorKind, MappingKind, PathMapping};
use crate::monitor::{
    iso8601, lock, parse_iso8601, unix_now, ActiveAgent, AgentTracking, BrowserSpan,
    BrowserTracking, MonitorShared, PendingSuggestion, SegmentRecord,
};
use crate::recovery::RecoveryState;
use crate::spool::{self, AgentEventKind, AgentSource, SpoolEvent};

/// The server's batch bound for both upload routes.
const UPLOAD_BATCH_SIZE: usize = 500;

/// Five minutes: frequent enough that corroboration survives a crash, rare
/// enough that the monitor stays below notice.
const UPLOAD_INTERVAL_SECONDS: u64 = 300;

pub async fn upload_loop(
    shared: Arc<Mutex<MonitorShared>>,
    client: ApiClient,
    segments_path: PathBuf,
    agent_path: PathBuf,
    browser_dir: PathBuf,
    recovery: Arc<tokio::sync::Mutex<RecoveryState>>,
    upload_now: Arc<Notify>,
) {
    let browser_path = browser_dir.join("browser-spool.jsonl");
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
            &browser_dir,
            &browser_path,
            &recovery,
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
    browser_dir: &Path,
    browser_path: &Path,
    recovery: &Arc<tokio::sync::Mutex<RecoveryState>>,
) {
    let Some(session) = crate::read_session_token() else {
        if let Err(error) = crate::browser::revoke_collection(browser_dir) {
            eprintln!(
                "clock-in: could not revoke browser attribution: {}",
                error.message
            );
        }
        let _ = crate::browser::discard_collection(browser_dir);
        return;
    };
    let token = match client.fetch_access_token(&session).await {
        Ok(token) => token,
        Err(error) => {
            if error.kind == ErrorKind::Auth
                && crate::browser::revoke_collection(browser_dir).is_ok()
            {
                crate::clear_session_token();
                let _ = crate::browser::discard_collection(browser_dir);
            }
            return;
        }
    };
    if let Err(error) = crate::browser::renew_collection_authorization(browser_dir) {
        eprintln!(
            "clock-in: could not renew browser attribution: {}",
            error.message
        );
    }

    let mut complete = upload_segments(client, &token, segments_path).await;

    // Refresh the local mapping cache before the drain resolves suggestions.
    // A failed refresh keeps last pass's cache — stale mappings beat none.
    if let Ok(mappings) = client.path_mappings(&token).await {
        let changed = {
            let mut shared = lock(shared);
            let changed = shared.mappings != mappings;
            shared.mappings = mappings;
            changed
        };
        // The extension matches against the rules file, so a changed url_rule
        // set lands on disk here too (the writer skips unchanged content).
        if changed {
            let mappings = lock(shared).mappings.clone();
            if let Err(error) = crate::browser::write_rules_file(browser_dir, &mappings) {
                eprintln!("clock-in: could not write the browser rules file: {error}");
            }
        }
    } else {
        complete = false;
    }

    let timer_running = recovery.lock().await.running.is_some();
    complete &= drain_agent_spool(shared, client, &token, agent_path, timer_running).await;
    complete &= drain_browser_spool(shared, client, &token, browser_path, timer_running).await;

    if complete {
        lock(shared).last_upload_at = Some(iso8601(unix_now()));
    }
}

/// Uploads every buffered segment in batches, then truncates the acked
/// prefix. A mid-batch failure skips the truncation, so the whole spool
/// replays next pass — safe because `clientId` makes replays idempotent.
async fn upload_segments(client: &ApiClient, token: &str, path: &Path) -> bool {
    let generations = match spool::pending_spool_paths(path) {
        Ok(generations) => generations,
        Err(_) => return false,
    };
    for generation in generations {
        if !upload_segment_generation(client, token, &generation).await {
            return false;
        }
    }
    spool::remove_empty_rotated(path).is_ok()
}

async fn upload_segment_generation(client: &ApiClient, token: &str, path: &Path) -> bool {
    let Ok((records, acked_bytes)) = spool::read_pending_lines::<SegmentRecord>(path) else {
        return false;
    };
    if records.is_empty() {
        return spool::truncate_acked(path, acked_bytes).is_ok();
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

/// Drains the agent spool: local tracking first (suggestions and the away
/// override work offline), then the upload, then the truncation.
async fn drain_agent_spool(
    shared: &Arc<Mutex<MonitorShared>>,
    client: &ApiClient,
    token: &str,
    path: &Path,
    timer_running: bool,
) -> bool {
    let generations = match spool::pending_spool_paths(path) {
        Ok(generations) => generations,
        Err(_) => return false,
    };
    for generation in generations {
        if !drain_agent_spool_generation(shared, client, token, &generation, timer_running).await {
            return false;
        }
    }
    spool::remove_empty_rotated(path).is_ok()
}

async fn drain_agent_spool_generation(
    shared: &Arc<Mutex<MonitorShared>>,
    client: &ApiClient,
    token: &str,
    path: &Path,
    timer_running: bool,
) -> bool {
    let pending = match spool::read_pending(path) {
        Ok(pending) => pending,
        Err(_) => return false,
    };
    if pending.events.is_empty() {
        return spool::truncate_acked(path, pending.acked_bytes).is_ok();
    }

    {
        let mut shared = lock(shared);
        let MonitorShared {
            mappings, agent, ..
        } = &mut *shared;
        track_agent_events(&pending.events, mappings, timer_running, agent);
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

/// Drains the browser spool on the same cadence and with the same
/// ack-before-truncate discipline as the agent spool. Browser spans feed the
/// suggested-start prompt, but never the away override — a focused tab says
/// nothing once the human leaves, so they bypass `AgentTracking` entirely.
async fn drain_browser_spool(
    shared: &Arc<Mutex<MonitorShared>>,
    client: &ApiClient,
    token: &str,
    path: &Path,
    timer_running: bool,
) -> bool {
    let generations = match spool::pending_spool_paths(path) {
        Ok(generations) => generations,
        Err(_) => return false,
    };
    for generation in generations {
        if !drain_browser_spool_generation(shared, client, token, &generation, timer_running).await {
            return false;
        }
    }
    spool::remove_empty_rotated(path).is_ok()
}

async fn drain_browser_spool_generation(
    shared: &Arc<Mutex<MonitorShared>>,
    client: &ApiClient,
    token: &str,
    path: &Path,
    timer_running: bool,
) -> bool {
    let pending = match spool::read_pending(path) {
        Ok(pending) => pending,
        Err(_) => return false,
    };
    if pending.events.is_empty() {
        return spool::truncate_acked(path, pending.acked_bytes).is_ok();
    }

    {
        let mut shared = lock(shared);
        let MonitorShared {
            mappings,
            agent,
            browser,
            ..
        } = &mut *shared;
        track_browser_events(
            &pending.events,
            mappings,
            timer_running,
            unix_now(),
            browser,
            &mut agent.suggestion,
        );
    }

    for chunk in pending.events.chunks(UPLOAD_BATCH_SIZE) {
        match client.upload_agent_events(token, chunk).await {
            Ok(results) => {
                let rejected = results.iter().filter(|result| !result.accepted).count();
                if rejected > 0 {
                    eprintln!("clock-in: the server rejected {rejected} browser event(s)");
                }
            }
            Err(_) => return false,
        }
    }
    spool::truncate_acked(path, pending.acked_bytes).is_ok()
}

/// A mapped browser span must survive a glance before it may prompt: sixty
/// seconds old, heartbeats included.
const BROWSER_SUGGESTION_MIN_AGE_SECONDS: u64 = 60;

/// The browser drain's local bookkeeping: resolve each span's `ruleId`
/// against the cached `url_rule` mappings, and when a mapped span on no
/// running timer is provably older than the glance threshold, raise the
/// suggested-start prompt with the project preselected. Pure apart from the
/// injected `now`; replays are safe because a suggestion is replaced only by
/// a strictly newer one and a dismissed span is never re-raised.
pub fn track_browser_events(
    events: &[SpoolEvent],
    mappings: &[PathMapping],
    timer_running: bool,
    _now: u64,
    tracking: &mut BrowserTracking,
    suggestion: &mut Option<PendingSuggestion>,
) {
    let mut ordered: Vec<(u64, &SpoolEvent)> = events
        .iter()
        .filter_map(|event| parse_iso8601(&event.occurred_at).map(|at| (at, event)))
        .collect();
    ordered.sort_by_key(|(at, _)| *at);

    for (at, event) in ordered {
        let span_id = &event.external_session_id;
        match event.event {
            AgentEventKind::Started => {
                let Some(rule_id) = event.rule_id.as_deref() else {
                    continue;
                };
                // A deleted or foreign rule resolves to nothing — the server
                // leaves the span unattributed, and no suggestion is raised.
                let Some(project_id) = resolve_rule(rule_id, mappings) else {
                    continue;
                };
                tracking.spans.insert(
                    span_id.clone(),
                    BrowserSpan {
                        started_at: at,
                        last_seen: at,
                        project_id,
                    },
                );
            }
            AgentEventKind::Heartbeat => {
                if let Some(span) = tracking.spans.get_mut(span_id) {
                    span.last_seen = span.last_seen.max(at);
                }
            }
            // A closed span cannot prompt: the moment to ask "working on this?"
            // passed when the user left the site.
            AgentEventKind::Ended => {
                tracking.spans.remove(span_id);
            }
        }
    }

    cap_browser_spans(tracking);

    // The suggestion question: the newest open mapped span old enough to not
    // be a glance, based only on lifecycle evidence observed from the browser.
    if timer_running {
        return;
    }
    let candidate = tracking
        .spans
        .iter()
        .filter(|(span_id, span)| {
            tracking.dismissed_span.as_ref() != Some(*span_id)
                && span.last_seen.saturating_sub(span.started_at)
                    >= BROWSER_SUGGESTION_MIN_AGE_SECONDS
        })
        .max_by_key(|(_, span)| span.started_at);
    let Some((span_id, span)) = candidate else {
        return;
    };
    let is_newer = suggestion
        .as_ref()
        .and_then(|current| parse_iso8601(&current.since))
        .is_none_or(|since| span.started_at >= since);
    if is_newer {
        *suggestion = Some(PendingSuggestion {
            project_id: span.project_id.clone(),
            source: source_name(AgentSource::Browser).to_string(),
            since: iso8601(span.started_at),
            span_id: Some(span_id.clone()),
        });
    }
}

fn cap_browser_spans(tracking: &mut BrowserTracking) {
    while tracking.spans.len() > 64 {
        let Some(oldest) = tracking
            .spans
            .iter()
            .min_by_key(|(_, span)| span.started_at)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        tracking.spans.remove(&oldest);
    }
}

/// A `ruleId` resolves to a project through the caller's own `url_rule`
/// mappings — the same attribution the server applies on ingest.
fn resolve_rule(rule_id: &str, mappings: &[PathMapping]) -> Option<String> {
    mappings
        .iter()
        .find(|mapping| mapping.kind == MappingKind::UrlRule && mapping.id == rule_id)
        .map(|mapping| mapping.project_id.clone())
}

/// The drain's local bookkeeping. Pure apart from the clocks inside the
/// timestamps: events are replayed on every failed upload, so everything here
/// is idempotent — timestamps only ever move forward, and a suggestion is
/// replaced only by a strictly newer one.
pub fn track_agent_events(
    events: &[SpoolEvent],
    mappings: &[PathMapping],
    timer_running: bool,
    tracking: &mut AgentTracking,
) {
    let mut ordered: Vec<(u64, &SpoolEvent)> = events
        .iter()
        .filter_map(|event| parse_iso8601(&event.occurred_at).map(|at| (at, event)))
        .collect();
    ordered.sort_by_key(|(at, _)| *at);

    for (at, event) in ordered {
        // Browser spans travel their own spool and never open the away
        // override; a stray one here is skipped rather than trusted.
        if event.source == AgentSource::Browser {
            continue;
        }
        tracking.last_event_at = tracking.last_event_at.max(at);
        match event.event {
            AgentEventKind::Started => {
                tracking.open = true;
                // Only a newer start moves the marker: replays never regress it.
                let is_newer = tracking
                    .active
                    .as_ref()
                    .is_none_or(|active| at >= active.started_at);
                if is_newer {
                    tracking.active = Some(ActiveAgent {
                        source: source_name(event.source).to_string(),
                        started_at: at,
                    });
                }
            }
            AgentEventKind::Heartbeat => {
                tracking.open = true;
                // A heartbeat without a seen start still opens the marker.
                if tracking.active.is_none() {
                    tracking.active = Some(ActiveAgent {
                        source: source_name(event.source).to_string(),
                        started_at: at,
                    });
                }
            }
            AgentEventKind::Ended => {
                tracking.open = false;
                tracking.active = None;
            }
        }
        // A started agent in a mapped directory while no timer runs is the one
        // prompt the desktop raises locally; the user confirms or dismisses.
        if event.event == AgentEventKind::Started && !timer_running {
            if let Some(project_id) = event
                .cwd
                .as_deref()
                .and_then(|cwd| resolve_project(cwd, mappings))
            {
                let is_newer = tracking
                    .suggestion
                    .as_ref()
                    .and_then(|suggestion| parse_iso8601(&suggestion.since))
                    .is_none_or(|since| at >= since);
                if is_newer {
                    tracking.suggestion = Some(PendingSuggestion {
                        project_id,
                        source: source_name(event.source).to_string(),
                        since: iso8601(at),
                        span_id: None,
                    });
                }
            }
        }
    }
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
        // URL rules match browser hosts, never working directories.
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
    use super::*;

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
        SpoolEvent {
            source: AgentSource::ClaudeCode,
            external_session_id: "s1".to_string(),
            event: kind,
            occurred_at: occurred_at.to_string(),
            cwd: Some(cwd.to_string()),
            rule_id: None,
        }
    }

    fn browser_event(
        kind: AgentEventKind,
        span: &str,
        rule: &str,
        occurred_at: &str,
    ) -> SpoolEvent {
        SpoolEvent {
            source: AgentSource::Browser,
            external_session_id: span.to_string(),
            event: kind,
            occurred_at: occurred_at.to_string(),
            cwd: None,
            rule_id: Some(rule.to_string()),
        }
    }

    fn rule(id: &str, pattern: &str, project: &str) -> PathMapping {
        PathMapping {
            id: id.to_string(),
            kind: MappingKind::UrlRule,
            path_prefix: pattern.to_string(),
            repo_url: None,
            project_id: project.to_string(),
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
            true,
            &mut tracking,
        );
        assert!(tracking.open);
        assert_eq!(
            tracking.last_event_at,
            parse_iso8601("2026-08-07T10:05:00Z").expect("timestamp parses")
        );
        assert_eq!(
            tracking.active,
            Some(ActiveAgent {
                source: "claude_code".to_string(),
                started_at: parse_iso8601("2026-08-07T10:00:00Z").expect("timestamp parses"),
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
            true,
            &mut tracking,
        );
        assert!(!tracking.open);
        assert_eq!(tracking.active, None, "an ended session clears the marker");
    }

    #[test]
    fn a_mapped_start_suggests_a_project_only_while_no_timer_runs() {
        let mappings = vec![mapping("m1", "C:/dev/clock-in", "p-clockin")];
        let mut tracking = AgentTracking::default();

        track_agent_events(
            &[event(
                AgentEventKind::Started,
                "C:/dev/clock-in",
                "2026-08-07T10:00:00Z",
            )],
            &mappings,
            true,
            &mut tracking,
        );
        assert!(
            tracking.suggestion.is_none(),
            "a running timer suppresses it"
        );

        track_agent_events(
            &[event(
                AgentEventKind::Started,
                "C:/dev/clock-in",
                "2026-08-07T12:00:00Z",
            )],
            &mappings,
            false,
            &mut tracking,
        );
        let suggestion = tracking.suggestion.clone().expect("a suggestion is raised");
        assert_eq!(suggestion.project_id, "p-clockin");
        assert_eq!(suggestion.source, "claude_code");
        assert_eq!(suggestion.since, "2026-08-07T12:00:00Z");

        // An unmapped or older start never displaces the pending suggestion.
        track_agent_events(
            &[
                event(
                    AgentEventKind::Started,
                    "D:/unmapped",
                    "2026-08-07T13:00:00Z",
                ),
                event(
                    AgentEventKind::Started,
                    "C:/dev/clock-in",
                    "2026-08-07T11:00:00Z",
                ),
            ],
            &mappings,
            false,
            &mut tracking,
        );
        assert_eq!(
            tracking.suggestion.as_ref().map(|s| s.since.as_str()),
            Some("2026-08-07T12:00:00Z")
        );

        // A newer mapped start replaces it.
        track_agent_events(
            &[event(
                AgentEventKind::Started,
                "c:/dev/clock-in",
                "2026-08-07T14:00:00Z",
            )],
            &mappings,
            false,
            &mut tracking,
        );
        assert_eq!(
            tracking.suggestion.as_ref().map(|s| s.since.as_str()),
            Some("2026-08-07T14:00:00Z")
        );
    }

    #[test]
    fn out_of_order_events_replay_without_moving_state_backwards() {
        let mut tracking = AgentTracking {
            open: true,
            last_event_at: parse_iso8601("2026-08-07T12:00:00Z").expect("timestamp parses"),
            active: None,
            suggestion: None,
        };
        // A replayed drain delivers the same older events; state must not regress.
        track_agent_events(
            &[event(
                AgentEventKind::Started,
                "C:/dev",
                "2026-08-07T10:00:00Z",
            )],
            &[],
            true,
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
            true,
            &mut fresh,
        );
        assert!(!fresh.open, "the end landed after the start in time order");
    }

    #[test]
    fn browser_events_never_open_the_agent_away_override() {
        // A browser line that somehow lands in the agent drain is skipped:
        // a focused tab must never suppress idle trimming or away auto-stop.
        let mut tracking = AgentTracking::default();
        track_agent_events(
            &[browser_event(
                AgentEventKind::Started,
                "span-1",
                "r1",
                "2026-08-09T10:00:00Z",
            )],
            &[],
            false,
            &mut tracking,
        );

        assert_eq!(tracking, AgentTracking::default());
    }

    const DRAIN_NOW: &str = "2026-08-09T12:10:00Z";

    fn drain_now() -> u64 {
        parse_iso8601(DRAIN_NOW).expect("timestamp parses")
    }

    #[test]
    fn a_mapped_browser_span_suggests_only_after_sixty_seconds() {
        let mappings = vec![rule("r1", "github.com/acme/*", "p-clockin")];
        let mut tracking = BrowserTracking::default();
        let mut suggestion = None;

        // A fresh span is a glance: no prompt.
        track_browser_events(
            &[browser_event(
                AgentEventKind::Started,
                "span-1",
                "r1",
                "2026-08-09T12:09:30Z",
            )],
            &mappings,
            false,
            drain_now(),
            &mut tracking,
            &mut suggestion,
        );
        assert!(suggestion.is_none(), "thirty seconds in is still a glance");

        // A heartbeat at the one-minute mark proves the dwell: prompt.
        track_browser_events(
            &[browser_event(
                AgentEventKind::Heartbeat,
                "span-1",
                "r1",
                "2026-08-09T12:10:30Z",
            )],
            &mappings,
            false,
            drain_now(),
            &mut tracking,
            &mut suggestion,
        );
        let raised = suggestion.clone().expect("the suggestion is raised");
        assert_eq!(raised.project_id, "p-clockin");
        assert_eq!(raised.source, "browser");
        assert_eq!(raised.since, "2026-08-09T12:09:30Z");
        assert_eq!(raised.span_id.as_deref(), Some("span-1"));
    }

    #[test]
    fn a_lone_stale_start_does_not_prove_browser_dwell() {
        let mappings = vec![rule("r1", "quickbooks.com", "p-books")];
        let mut tracking = BrowserTracking::default();
        let mut suggestion = None;

        track_browser_events(
            &[browser_event(
                AgentEventKind::Started,
                "span-1",
                "r1",
                "2026-08-09T12:08:00Z",
            )],
            &mappings,
            false,
            drain_now(),
            &mut tracking,
            &mut suggestion,
        );
        assert!(suggestion.is_none());
    }

    #[test]
    fn a_running_timer_or_an_ended_span_suppresses_the_browser_suggestion() {
        let mappings = vec![rule("r1", "quickbooks.com", "p-books")];
        let mut tracking = BrowserTracking::default();
        let mut suggestion = None;

        // Timer running: the prompt is for idle moments only.
        track_browser_events(
            &[browser_event(
                AgentEventKind::Started,
                "span-1",
                "r1",
                "2026-08-09T12:08:00Z",
            )],
            &mappings,
            true,
            drain_now(),
            &mut tracking,
            &mut suggestion,
        );
        assert!(suggestion.is_none());

        // A span that ended inside the dwell threshold is forgotten entirely.
        let mut tracking = BrowserTracking::default();
        track_browser_events(
            &[
                browser_event(
                    AgentEventKind::Started,
                    "span-2",
                    "r1",
                    "2026-08-09T12:09:00Z",
                ),
                browser_event(
                    AgentEventKind::Ended,
                    "span-2",
                    "r1",
                    "2026-08-09T12:09:20Z",
                ),
            ],
            &mappings,
            false,
            drain_now(),
            &mut tracking,
            &mut suggestion,
        );
        assert!(suggestion.is_none(), "a twenty-second visit never prompts");
        assert!(!tracking.spans.contains_key("span-2"));
    }

    #[test]
    fn browser_tracking_stays_bounded_while_a_timer_is_running() {
        let mappings = vec![rule("r1", "quickbooks.com", "p-books")];
        let mut tracking = BrowserTracking::default();
        let mut suggestion = None;
        let events = (0..65)
            .map(|index| {
                browser_event(
                    AgentEventKind::Started,
                    &format!("span-{index}"),
                    "r1",
                    &format!("2026-08-09T12:{:02}:{:02}Z", index / 60, index % 60),
                )
            })
            .collect::<Vec<_>>();

        track_browser_events(
            &events,
            &mappings,
            true,
            drain_now(),
            &mut tracking,
            &mut suggestion,
        );

        assert_eq!(tracking.spans.len(), 64);
        assert!(tracking.spans.contains_key("span-64"));
        assert!(suggestion.is_none());
    }

    #[test]
    fn an_unresolvable_rule_tracks_nothing_and_suggests_nothing() {
        let mut tracking = BrowserTracking::default();
        let mut suggestion = None;

        track_browser_events(
            &[browser_event(
                AgentEventKind::Started,
                "span-1",
                "deleted-rule",
                "2026-08-09T12:08:00Z",
            )],
            &[],
            false,
            drain_now(),
            &mut tracking,
            &mut suggestion,
        );

        assert!(tracking.spans.is_empty());
        assert!(suggestion.is_none());
    }

    #[test]
    fn a_dismissed_span_is_never_raised_again() {
        let mappings = vec![rule("r1", "quickbooks.com", "p-books")];
        let mut tracking = BrowserTracking {
            dismissed_span: Some("span-1".to_string()),
            ..BrowserTracking::default()
        };
        let mut suggestion = None;

        track_browser_events(
            &[browser_event(
                AgentEventKind::Started,
                "span-1",
                "r1",
                "2026-08-09T12:08:00Z",
            )],
            &mappings,
            false,
            drain_now(),
            &mut tracking,
            &mut suggestion,
        );

        assert!(
            suggestion.is_none(),
            "the dismissal is remembered for the span"
        );
    }
}
