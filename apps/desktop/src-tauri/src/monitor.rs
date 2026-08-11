//! The OS activity monitor: signals in, coarse segments out, and the pure
//! away/auto-stop policy the stop flow and the UI both consume.
//!
//! Lightweight by construction: one Tokio task wakes every 30 seconds and asks
//! the OS two read-only questions (`GetLastInputInfo`, the foreground process
//! name — the name only, never a window title). Lock and suspend arrive as
//! broadcasts on a hidden window owned by a dedicated thread, so between
//! events the monitor costs nothing. There are no hooks, no injection, and no
//! per-keystroke cost.
//!
//! The signal stream folds into transition-based segments (`active`, `idle`,
//! `locked`, `suspended`), so a workday produces dozens of rows, not ticks.
//! Closed segments are appended to a local spool immediately (same durability
//! discipline as the agent spool) and the uploader in `uploader.rs` batches
//! them to the API. Everything above the `platform` module is pure logic with
//! an injected clock; the Win32 calls never run in tests.
//!
//! Monitoring is gated behind `MonitorSettings.enabled` (on by default for
//! new installs); disabling it aborts both tasks, so a paused monitor records
//! nothing.
//!
//! Tradeoff, documented: the event thread uses a real hidden top-level window
//! rather than a message-only one because Windows does not broadcast
//! `WM_POWERBROADCAST` to message-only windows. Session unlock and
//! resume-from-suspend deliberately raise no event — the next poll's
//! Active/Idle signal closes the span, which is the same code path a
//! transition would take.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::api::{ApiClient, ApiResult, BridgeError, ErrorKind, PathMapping};
use crate::recovery::RecoveryState;
use crate::spool;

/// How often the OS is polled. Coarser than this and short active bursts blur
/// into idle; finer buys nothing the server schema can store.
pub const POLL_INTERVAL_SECONDS: u64 = 30;

/// A poll reads "idle" once the last input is at least this old — one poll
/// interval, so a single quiet moment between ticks still reads as active.
// Only the Windows poll source reads this; non-Windows builds keep it for
// tests and documentation.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const IDLE_THRESHOLD_SECONDS: u32 = POLL_INTERVAL_SECONDS as u32;

/// How long an open agent session without a fresh event still counts as
/// active for the away override. Matches the server's staleness window.
pub const AGENT_ACTIVE_WINDOW_SECONDS: u64 = 6 * 3_600;

/// Closed segments stay in memory so stop-time idle math and the live session
/// view work offline; the cap bounds a process that runs for months. Spooled
/// segments are already on disk, so dropping the oldest here loses nothing.
const MAX_BUFFERED_SEGMENTS: usize = 10_000;

/// What the OS reports. `Locked` and `Suspended` are pushed by the event
/// thread; `Active` and `Idle` come from the 30-second poll.
// Constructors are Windows-only today (event thread + poll source); non-Windows
// builds only consume signals in tests.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActivitySignal {
    Active { process_name: Option<String> },
    Idle { idle_seconds: u32 },
    Locked,
    Suspended,
}

/// The read-only OS question the poll task asks. The Windows implementation
/// lives in `platform`; tests inject fakes and never touch the OS.
pub trait ActivitySource: Send {
    fn poll(&self) -> ActivitySignal;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SegmentKind {
    Active,
    Idle,
    Locked,
    Suspended,
}

/// One coarse activity span. Times are unix seconds; conversion to the ISO
/// shape the API expects happens in `SegmentRecord`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    pub kind: SegmentKind,
    pub process_name: Option<String>,
    pub started_at: u64,
    pub ended_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct OpenSegment {
    kind: SegmentKind,
    process_name: Option<String>,
    started_at: u64,
}

fn signal_kind(signal: &ActivitySignal) -> SegmentKind {
    match signal {
        ActivitySignal::Active { .. } => SegmentKind::Active,
        ActivitySignal::Idle { .. } => SegmentKind::Idle,
        ActivitySignal::Locked => SegmentKind::Locked,
        ActivitySignal::Suspended => SegmentKind::Suspended,
    }
}

fn signal_process_name(signal: &ActivitySignal) -> Option<String> {
    match signal {
        ActivitySignal::Active { process_name } => process_name.clone(),
        _ => None,
    }
}

/// Folds a timestamped signal stream into transition-based segments.
/// Transitions close the open span and open a new one; repeats coalesce.
#[derive(Default)]
pub struct SegmentBuilder {
    open: Option<OpenSegment>,
    closed: Vec<Segment>,
}

impl SegmentBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Folds one signal observed at `now` (unix seconds) and returns the
    /// segments the transition closed, for the caller to spool. An `Idle`
    /// signal backdates the transition: the active span ended when the last
    /// input happened (`now - idle_seconds`), not when the poll noticed.
    pub fn apply(&mut self, now: u64, signal: &ActivitySignal) -> Vec<Segment> {
        let kind = signal_kind(signal);
        let transition_at = match signal {
            ActivitySignal::Idle { idle_seconds } => now.saturating_sub(u64::from(*idle_seconds)),
            _ => now,
        };

        let mut closed_now = Vec::new();
        match &mut self.open {
            Some(open) if open.kind == kind => {
                // Same state continues; remember the latest foreground process.
                if let ActivitySignal::Active {
                    process_name: Some(name),
                } = signal
                {
                    open.process_name = Some(name.clone());
                }
            }
            Some(open) => {
                // Clamp into [open.started_at, now]: an idle span that predates
                // the open segment must not overlap what came before it.
                let boundary = transition_at.clamp(open.started_at, now);
                if boundary > open.started_at {
                    closed_now.push(Segment {
                        kind: open.kind,
                        process_name: open.process_name.take(),
                        started_at: open.started_at,
                        ended_at: boundary,
                    });
                }
                *open = OpenSegment {
                    kind,
                    process_name: signal_process_name(signal),
                    started_at: boundary,
                };
            }
            None => {
                self.open = Some(OpenSegment {
                    kind,
                    process_name: signal_process_name(signal),
                    started_at: transition_at.min(now),
                });
            }
        }

        if !closed_now.is_empty() {
            self.closed.extend(closed_now.iter().cloned());
            let overflow = self.closed.len().saturating_sub(MAX_BUFFERED_SEGMENTS);
            if overflow > 0 {
                self.closed.drain(..overflow);
            }
        }
        closed_now
    }

    /// The open span's kind and start, for the lock-aware auto-stop check.
    pub fn open_span(&self) -> Option<(SegmentKind, u64)> {
        self.open.as_ref().map(|open| (open.kind, open.started_at))
    }

    /// Everything recorded so far, with the open span closed at `now`. The
    /// fold's own view, used by tests to assert on spans the caller never
    /// sees individually.
    #[cfg(test)]
    pub fn snapshot(&self, now: u64) -> Vec<Segment> {
        let mut segments = self.closed.clone();
        if let Some(open) = &self.open {
            if now > open.started_at {
                segments.push(Segment {
                    kind: open.kind,
                    process_name: open.process_name.clone(),
                    started_at: open.started_at,
                    ended_at: now,
                });
            }
        }
        segments
    }

    /// Closes the open span at `now` and returns it for spooling. Used when
    /// monitoring stops, so no span is left dangling across a pause.
    pub fn flush(&mut self, now: u64) -> Option<Segment> {
        let open = self.open.take()?;
        if now <= open.started_at {
            return None;
        }
        Some(Segment {
            kind: open.kind,
            process_name: open.process_name,
            started_at: open.started_at,
            ended_at: now,
        })
    }
}

/// The persisted/uploaded form of a segment: exactly the
/// `/activity/segments` row shape, so spool lines upload without re-mapping.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentRecord {
    pub client_id: String,
    pub device_id: String,
    pub kind: SegmentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    pub started_at: String,
    pub ended_at: String,
}

impl SegmentRecord {
    pub fn from_segment(segment: &Segment, device_id: &str) -> Self {
        Self {
            // The client id makes uploads idempotent: a replayed spool line is
            // absorbed server-side instead of duplicated.
            client_id: uuid::Uuid::new_v4().to_string(),
            device_id: device_id.to_string(),
            kind: segment.kind,
            // The server caps process names at 200 chars; truncate rather than
            // hand it a row it must reject.
            process_name: segment
                .process_name
                .as_deref()
                .map(|name| name.chars().take(200).collect()),
            started_at: iso8601(segment.started_at),
            ended_at: iso8601(segment.ended_at),
        }
    }
}

/// The knobs the settings UI edits. Persisted as `settings.json` beside the
/// recovery file; every field defaults so older files keep parsing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorSettings {
    /// Consent. Off means no polling at all, and it is the only on/off the
    /// product has.
    pub enabled: bool,
    /// How long the machine must stay quiet before the open session ends.
    /// Shorter gaps stay inside it as trimmed idle.
    pub away_threshold_minutes: u32,
    /// Keep the session open through idle and lock while an agent session is
    /// running — an overnight agent run is legitimate unattended work.
    pub agent_override_enabled: bool,
    /// Stable per-install device id stamped on every segment; generated once.
    pub device_id: String,
}

impl Default for MonitorSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            away_threshold_minutes: 10,
            agent_override_enabled: true,
            device_id: String::new(),
        }
    }
}

impl MonitorSettings {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.away_threshold_minutes == 0 || self.away_threshold_minutes > 720 {
            return Err("The quiet-time limit must be between 1 and 720 minutes.");
        }
        Ok(())
    }

    pub fn away_threshold_seconds(&self) -> u64 {
        u64::from(self.away_threshold_minutes) * 60
    }

    pub fn patched(&self, patch: &SettingsPatch) -> Self {
        Self {
            enabled: patch.enabled.unwrap_or(self.enabled),
            away_threshold_minutes: patch
                .away_threshold_minutes
                .unwrap_or(self.away_threshold_minutes),
            agent_override_enabled: patch
                .agent_override_enabled
                .unwrap_or(self.agent_override_enabled),
            device_id: self.device_id.clone(),
        }
    }
}

/// What `settings_update` accepts: only the fields the UI sent change.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub enabled: Option<bool>,
    pub away_threshold_minutes: Option<u32>,
    pub agent_override_enabled: Option<bool>,
}

/// What the drain side reports about agent activity. In-memory only: after a
/// restart the override simply stays off until the next agent event drains.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentTracking {
    pub last_event_at: u64,
    /// Every currently running agent session. A source and its external
    /// session id identify the lifecycle independently, so ending one tool
    /// cannot clear another tool that is still running.
    pub active: BTreeMap<(String, String), ActiveAgent>,
    /// The latest event already applied per lifecycle. Finished sessions leave
    /// a small tombstone here so a failed upload replay cannot reopen them.
    pub seen: BTreeMap<(String, String), SeenAgentEvent>,
}

/// A currently running agent session. The ISO form the UI sees is produced at
/// status time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveAgent {
    pub source: String,
    pub external_session_id: String,
    pub started_at: u64,
    pub last_event_at: u64,
    pub project: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeenAgentEvent {
    pub occurred_at: u64,
    pub kind: crate::spool::AgentEventKind,
}

impl AgentTracking {
    pub fn is_active(&self, now: u64, override_enabled: bool) -> bool {
        override_enabled
            && self
                .active
                .values()
                .any(|agent| now.saturating_sub(agent.last_event_at) <= AGENT_ACTIVE_WINDOW_SECONDS)
    }

    pub fn effective_agent(&self, now: u64) -> Option<&ActiveAgent> {
        self.active
            .values()
            .filter(|agent| now.saturating_sub(agent.last_event_at) <= AGENT_ACTIVE_WINDOW_SECONDS)
            .max_by(|left, right| {
                (
                    left.last_event_at,
                    left.started_at,
                    &left.source,
                    &left.external_session_id,
                )
                    .cmp(&(
                        right.last_event_at,
                        right.started_at,
                        &right.source,
                        &right.external_session_id,
                    ))
            })
    }

    pub fn effective_project(&self, now: u64) -> Option<&str> {
        self.active
            .values()
            .filter(|agent| now.saturating_sub(agent.last_event_at) <= AGENT_ACTIVE_WINDOW_SECONDS)
            .filter_map(|agent| agent.project.as_deref().map(|project| (agent, project)))
            .max_by(|(left, _), (right, _)| {
                (
                    left.last_event_at,
                    left.started_at,
                    &left.source,
                    &left.external_session_id,
                )
                    .cmp(&(
                        right.last_event_at,
                        right.started_at,
                        &right.source,
                        &right.external_session_id,
                    ))
            })
            .map(|(_, project)| project)
    }
}

/// How a session learned which project it belongs to. Mirrors the server's
/// `session_attribution` enum minus `manual`, which only the retired timer
/// could produce.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Attribution {
    /// The person picked this project to track into.
    Selected,
    /// An agent session's working directory resolved to it.
    Agent,
    /// Nothing named a project, so the user's default caught the time.
    Default,
}

/// The project a session belongs to, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProject {
    pub project_id: String,
    pub attribution: Attribution,
}

/// One finished session, in the exact shape `/sessions/observed` accepts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedSession {
    pub client_id: String,
    pub project_id: String,
    pub attribution: Attribution,
    pub started_at: String,
    pub stopped_at: String,
    pub idle_seconds: u32,
}

/// The session the tracker currently holds open, persisted so a crash cannot
/// swallow work that was already recorded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSession {
    pub client_id: String,
    pub project: SessionProject,
    pub started_at: u64,
    /// Idle runs that stayed under the threshold and so sit inside this
    /// session. They are reported so the server subtracts them from duration.
    pub idle_seconds: u64,
    /// The end of the most recent active span: where the session closes if the
    /// app quits rather than the machine going idle.
    pub last_active_at: u64,
}

/// Turns the monitor's own working/idle/locked/suspended boundaries into
/// sessions, with no human involvement anywhere in the loop.
///
/// A session opens on the first active span and closes when the machine goes
/// quiet for longer than the away threshold, when the screen locks, when the
/// machine suspends, when the attributed project changes, or when the app
/// quits. It always closes at the last-active boundary, never at "now", so
/// idle time is never counted inside a session; shorter idle gaps stay inside
/// and are reported as trimmed idle instead of fragmenting the day.
///
/// An open agent session holds a session open through idle and lock, the same
/// override the away policy has always applied: an overnight agent run is
/// unattended work, not an abandoned desk.
#[derive(Debug, Default)]
pub struct SessionTracker {
    open: Option<OpenSession>,
    previous: Option<(SegmentKind, u64)>,
    /// Last time an agent was active during the current open session. Used to
    /// exclude agent-covered idle from trimmed-idle accounting so overnight
    /// agent runs survive into the session duration instead of being subtracted.
    agent_seen_at: u64,
    /// When the agent first became active during the current idle period.
    /// Reset to 0 when the session enters an active span, so only idle-
    /// internal agent starts count for the resumed-idle coverage calculation.
    agent_first_in_idle: u64,
}

/// What the tracker needs to know about the world on each tick.
pub struct TrackerInput<'a> {
    pub now: u64,
    /// The segment span currently open, as the fold sees it.
    pub open_span: Option<(SegmentKind, u64)>,
    /// The project a new or continuing session belongs to; `None` means the
    /// host cannot attribute time yet (signed out, or no project resolved).
    pub project: Option<&'a SessionProject>,
    pub agent_active: bool,
    pub away_threshold_seconds: u64,
}

impl SessionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open_session(&self) -> Option<&OpenSession> {
        self.open.as_ref()
    }

    /// Folds one tick and returns whatever it finished. `new_client_id` mints
    /// the id for a session this tick opens; the caller supplies it so the
    /// tracker stays free of randomness and stays testable.
    pub fn apply(&mut self, input: TrackerInput<'_>, new_client_id: &str) -> Vec<ObservedSession> {
        let mut closed = Vec::new();
        let Some((kind, span_started_at)) = input.open_span else {
            self.previous = None;
            return closed;
        };

        let resumed_idle = match self.previous {
            Some((SegmentKind::Idle, idle_started_at)) if kind != SegmentKind::Idle => Some((
                idle_started_at,
                span_started_at.saturating_sub(idle_started_at),
            )),
            _ => None,
        };
        if let Some((idle_started_at, idle_seconds)) = resumed_idle {
            if idle_seconds >= input.away_threshold_seconds && !input.agent_active {
                // A long idle spell closes at its last active boundary: if an
                // agent was working during the idle, close where the agent
                // stopped; otherwise close at the first idle boundary.
                let close_boundary = if self.agent_seen_at >= idle_started_at {
                    self.agent_seen_at
                } else {
                    idle_started_at
                };
                // Idle before the first agent evidence is not covered.
                if let Some(open) = self.open.as_mut() {
                    if self.agent_first_in_idle > idle_started_at {
                        let uncovered = self.agent_first_in_idle.saturating_sub(idle_started_at);
                        open.idle_seconds += uncovered;
                    }
                }
                closed.extend(self.close_at(close_boundary));
            } else if let Some(open) = self.open.as_mut() {
                // Exclude any portion of the idle gap that was covered by an
                // active agent: that time counts as work, not trimmed idle.
                let agent_end = if input.agent_active {
                    span_started_at
                } else {
                    self.agent_seen_at
                };
                let agent_covered = if self.agent_first_in_idle >= idle_started_at
                    && self.agent_first_in_idle > 0
                {
                    // Agent became active mid-idle; cover from that point to the agent's last known moment.
                    agent_end.saturating_sub(self.agent_first_in_idle)
                } else if self.agent_first_in_idle > 0 {
                    // Agent was already active before idle began: full coverage.
                    idle_seconds
                } else {
                    0
                };
                let added = idle_seconds.saturating_sub(agent_covered);
                if added > 0 {
                    open.idle_seconds += added;
                }
            }
        }
        self.previous = Some((kind, span_started_at));

        // Nothing to attribute time to: close what is open and record nothing new.
        let Some(project) = input.project else {
            closed.extend(self.close_at(self.last_boundary(input.now)));
            return closed;
        };

        match kind {
            SegmentKind::Active => {
                // The project changed under an open session: the old one ends
                // where its work last showed, and the new one picks up there,
                // so no second of activity is dropped or counted twice.
                let mut opens_at = span_started_at.min(input.now);
                if self
                    .open
                    .as_ref()
                    .is_some_and(|open| &open.project != project)
                {
                    let boundary = self.last_boundary(input.now);
                    closed.extend(self.close_at(boundary));
                    // The new project cannot inherit a just-finished short
                    // idle gap as active work. It begins when activity resumed.
                    opens_at = resumed_idle.map_or(boundary, |_| span_started_at);
                }
                self.agent_first_in_idle = 0;
                match self.open.as_mut() {
                    Some(open) => open.last_active_at = input.now,
                    None => {
                        self.open = Some(OpenSession {
                            client_id: new_client_id.to_string(),
                            project: project.clone(),
                            started_at: opens_at,
                            idle_seconds: 0,
                            last_active_at: input.now,
                        });
                    }
                }
            }
            SegmentKind::Idle => {
                let quiet_for = input.now.saturating_sub(span_started_at);
                if quiet_for >= input.away_threshold_seconds && !input.agent_active {
                    let close_boundary = if self.agent_seen_at >= span_started_at {
                        self.agent_seen_at
                    } else {
                        span_started_at
                    };
                    // Idle before the first agent evidence is not covered.
                    if let Some(open) = self.open.as_mut() {
                        if self.agent_first_in_idle > span_started_at {
                            let uncovered =
                                self.agent_first_in_idle.saturating_sub(span_started_at);
                            open.idle_seconds += uncovered;
                        }
                    }
                    closed.extend(self.close_at(close_boundary));
                } else if input.agent_active {
                    if let Some(open) = self.open.as_mut() {
                        open.last_active_at = input.now;
                    }
                    if self.agent_first_in_idle == 0 {
                        self.agent_first_in_idle = input.now;
                    }
                    self.agent_seen_at = input.now;
                }
            }
            // The screen locked or the machine slept: the person left, and the
            // session ends where they stopped working — or where the agent
            // last reported, whichever is later.
            SegmentKind::Locked | SegmentKind::Suspended => {
                if !input.agent_active {
                    let boundary =
                        span_started_at.max(self.open.as_ref().map_or(0, |o| o.last_active_at));
                    closed.extend(self.close_at(boundary));
                } else if let Some(open) = self.open.as_mut() {
                    open.last_active_at = input.now;
                    if self.agent_first_in_idle == 0 {
                        self.agent_first_in_idle = input.now;
                    }
                    self.agent_seen_at = input.now;
                }
            }
        }
        closed
    }

    /// Closes whatever is open, for app shutdown or for recording being
    /// switched off. Nothing after the last active moment is ever billed.
    pub fn flush(&mut self, now: u64) -> Option<ObservedSession> {
        self.previous = None;
        self.close_at(self.last_boundary(now))
    }

    /// Where a session ends when the reason is not a boundary of its own: the
    /// last moment the machine was known to be in use.
    fn last_boundary(&self, now: u64) -> u64 {
        self.open
            .as_ref()
            .map_or(now, |open| open.last_active_at.min(now))
    }

    fn close_at(&mut self, stopped_at: u64) -> Option<ObservedSession> {
        let open = self.open.take()?;
        self.agent_seen_at = 0;
        self.agent_first_in_idle = 0;
        let stopped_at = stopped_at.max(open.started_at);
        // A session with no elapsed time is not evidence of anything.
        if stopped_at <= open.started_at {
            return None;
        }
        let elapsed = stopped_at - open.started_at;
        Some(ObservedSession {
            client_id: open.client_id,
            project_id: open.project.project_id,
            attribution: open.project.attribution,
            started_at: iso8601(open.started_at),
            stopped_at: iso8601(stopped_at),
            idle_seconds: open.idle_seconds.min(elapsed) as u32,
        })
    }
}

/// The state the poll task, the upload task, and the Tauri commands share.
pub struct MonitorShared {
    pub builder: SegmentBuilder,
    pub settings: MonitorSettings,
    /// Local cache of the user's path mappings, refreshed on each upload run.
    pub mappings: Vec<PathMapping>,
    pub agent: AgentTracking,
    pub last_upload_at: Option<String>,
    /// Turns activity boundaries into sessions; the whole recording model.
    pub tracker: SessionTracker,
    /// The user's fallback project, resolved once per sign-in.
    pub default_project: Option<String>,
    /// The account the monitor is currently allowed to record for. This is
    /// separate from the token so locally queued sessions retain their owner.
    pub account_id: Option<String>,
    /// An explicit choice to track into one project, which outranks the
    /// working directory an agent happens to be in.
    pub selected_project: Option<String>,
}

impl MonitorShared {
    /// Precedence: what the person chose, then what an agent's working
    /// directory resolved to, then the default project that catches the rest.
    pub fn current_project(&self, now: u64) -> Option<SessionProject> {
        if let Some(project_id) = &self.selected_project {
            return Some(SessionProject {
                project_id: project_id.clone(),
                attribution: Attribution::Selected,
            });
        }
        if let Some(project_id) = self.agent.effective_project(now) {
            return Some(SessionProject {
                project_id: project_id.to_string(),
                attribution: Attribution::Agent,
            });
        }
        self.default_project
            .as_ref()
            .map(|project_id| SessionProject {
                project_id: project_id.clone(),
                attribution: Attribution::Default,
            })
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Session events the event thread pushes between polls. Bounded so a monitor
/// left disabled cannot grow it; lock/suspend events are rare, so the cap
/// never bites in practice.
pub struct PlatformEvents {
    queue: Mutex<VecDeque<(u64, ActivitySignal)>>,
}

impl PlatformEvents {
    fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn push(&self, at: u64, signal: ActivitySignal) {
        let mut queue = lock(&self.queue);
        if queue.len() >= 1_024 {
            queue.pop_front();
        }
        queue.push_back((at, signal));
    }

    fn drain(&self) -> Vec<(u64, ActivitySignal)> {
        lock(&self.queue).drain(..).collect()
    }
}

/// Per-CLI hook registration status, detected by a plain substring check for
/// the hook binary name inside the CLI's own config file. Cheap and read-only,
/// and honest about being a heuristic: it cannot tell a live registration
/// from a commented-out one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRegistration {
    pub source: String,
    pub detected: bool,
    pub config_path: String,
}

pub struct HookProbe {
    pub source: &'static str,
    pub config_path: PathBuf,
}

const HOOK_BINARY_NAME: &str = "clock-in-hook";

/// Where each CLI keeps the config a hook registration lands in.
pub fn default_hook_probes() -> Vec<HookProbe> {
    let Some(home) = std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
    else {
        return Vec::new();
    };
    vec![
        HookProbe {
            source: "claude_code",
            config_path: home.join(".claude").join("settings.json"),
        },
        HookProbe {
            source: "codex",
            config_path: home.join(".codex").join("config.toml"),
        },
        HookProbe {
            source: "kimi_code",
            config_path: home.join(".kimi").join("config.toml"),
        },
        HookProbe {
            source: "cursor",
            config_path: home.join(".cursor").join("hooks.json"),
        },
    ]
}

pub fn detect_hooks(probes: &[HookProbe]) -> Vec<HookRegistration> {
    probes
        .iter()
        .map(|probe| {
            let detected = std::fs::read_to_string(&probe.config_path)
                .map(|content| content.contains(HOOK_BINARY_NAME))
                .unwrap_or(false);
            HookRegistration {
                source: probe.source.to_string(),
                detected,
                config_path: probe.config_path.to_string_lossy().into_owned(),
            }
        })
        .collect()
}

/// The outcome of an opt-in `hook_register` call. Claude Code's settings.json
/// and Cursor's hooks.json hook arrays are merged in place; CLIs whose hook
/// mechanism the host cannot edit safely get the exact snippet to paste
/// instead of a guessed rewrite.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum HookRegisterResult {
    Registered {
        config_path: String,
    },
    AlreadyRegistered {
        config_path: String,
    },
    Manual {
        config_path: String,
        snippet: String,
    },
}

/// The two Claude Code lifecycle events the hook reports on; the arrays these
/// name are what registration merges into.
const CLAUDE_HOOK_EVENTS: [&str; 2] = ["SessionStart", "SessionEnd"];

/// Cursor's sessionStart/sessionEnd hooks (IDE-only; cloud agents never fire
/// them), paired with the `--event` flag each registered command passes, so
/// the binary knows the event without parsing Cursor's stdin payload.
const CURSOR_HOOKS: [(&str, &str); 2] = [
    ("sessionStart", "session-start"),
    ("sessionEnd", "session-end"),
];

fn hook_binary_file_name() -> &'static str {
    if cfg!(windows) {
        "clock-in-hook.exe"
    } else {
        HOOK_BINARY_NAME
    }
}

/// The command a registered hook invokes: the `clock-in-hook` binary installed
/// next to the running app, quoted so a path with spaces survives the CLI's
/// shell. A missing binary fails the whole registration — a hook pointing at
/// nothing is worse than none.
fn hook_binary_command() -> ApiResult<String> {
    let exe = std::env::current_exe()
        .map_err(|_| BridgeError::unknown("Could not locate the Clock-In app."))?;
    let binary = exe
        .parent()
        .map(|dir| dir.join(hook_binary_file_name()))
        .filter(|binary| binary.exists())
        .ok_or_else(|| BridgeError::unknown("The hook helper is missing from the install."))?;
    Ok(format!("\"{}\"", binary.to_string_lossy()))
}

/// Performs the opt-in registration the settings UI offers per CLI. Unknown
/// sources are rejected, and every file failure surfaces before anything
/// writes — registration never leaves a config half-edited.
pub fn register_hook(source: &str) -> ApiResult<HookRegisterResult> {
    let probe = default_hook_probes()
        .into_iter()
        .find(|probe| probe.source == source)
        .ok_or_else(|| BridgeError::new(ErrorKind::Validation, "Unknown agent CLI."))?;
    let command = hook_binary_command()?;
    match source {
        "claude_code" => register_claude_code(&probe.config_path, &command),
        "cursor" => register_cursor(&probe.config_path, &command),
        // Codex fires only a turn-completion `notify`, and Kimi Code's hook
        // coverage is unconfirmed against the installed version: both get an
        // honest paste-it-yourself snippet rather than a guessed TOML rewrite.
        _ => Ok(HookRegisterResult::Manual {
            config_path: probe.config_path.to_string_lossy().into_owned(),
            snippet: manual_snippet(source, &command),
        }),
    }
}

/// The paste-it-yourself text for CLIs the host will not rewrite. Only what
/// the design confirms appears here: Codex's documented `notify` argv key,
/// and for Kimi Code the hook command line to wire wherever its hooks land.
fn manual_snippet(source: &str, command: &str) -> String {
    let path = command.trim_matches('"');
    match source {
        "codex" => format!(
            "# Codex fires `notify` on each completed turn; Clock-In records these\n\
             # as heartbeats and infers session boundaries from the gaps.\n\
             notify = [\"{path}\", \"--source\", \"codex\", \"--event\", \"heartbeat\", \"--session-id\", \"codex\", \"--cwd\", \".\"]"
        ),
        _ => format!(
            "# Kimi Code hooks live in config.toml, but their event coverage is\n\
             # unconfirmed. Wire its session events to the hook binary, e.g.:\n\
             #   \"{path}\" --source kimi-code --event session-start --session-id <session> --cwd <dir>"
        ),
    }
}

/// Merges the hook into Claude Code's SessionStart/SessionEnd arrays. Strictly
/// parse-then-merge: an unparseable file or an unexpected shape fails loudly
/// and leaves the file untouched, the untouched original is backed up once
/// beside it (`.bak`), and the write is a temp file plus rename.
fn register_claude_code(config_path: &Path, command: &str) -> ApiResult<HookRegisterResult> {
    let mut settings = read_json_object(config_path)?;
    if claude_hook_present(&settings) {
        return Ok(HookRegisterResult::AlreadyRegistered {
            config_path: config_path.to_string_lossy().into_owned(),
        });
    }

    let hooks = json_object_entry(&mut settings, "hooks")?;
    for event in CLAUDE_HOOK_EVENTS {
        json_array_entry(hooks, event)?.push(serde_json::json!({
            "hooks": [{ "type": "command", "command": command }]
        }));
    }

    write_json_atomically(config_path, &settings)?;
    Ok(HookRegisterResult::Registered {
        config_path: config_path.to_string_lossy().into_owned(),
    })
}

/// Merges the hook into Cursor's sessionStart/sessionEnd arrays in
/// `~/.cursor/hooks.json`, with the same discipline as the Claude merge:
/// parse-then-merge, an unparseable file or an unexpected shape (including a
/// declared schema version other than 1) fails loudly, the untouched original
/// is backed up once beside it (`.bak`), and the write is a temp file plus
/// rename. Each entry is argv-disambiguated (`--source cursor --event …`), so
/// the binary knows the event without relying on Cursor's payload shape.
fn register_cursor(config_path: &Path, command: &str) -> ApiResult<HookRegisterResult> {
    let mut config = read_json_object(config_path)?;
    if cursor_hook_present(&config) {
        return Ok(HookRegisterResult::AlreadyRegistered {
            config_path: config_path.to_string_lossy().into_owned(),
        });
    }

    // Clock-In writes the version-1 flat schema; a file declaring another
    // version is a shape this merge will not guess at.
    match config.get("version") {
        None => {
            config.insert("version".to_string(), serde_json::json!(1));
        }
        Some(version) if version == &serde_json::json!(1) => {}
        Some(_) => return Err(unexpected_settings_shape()),
    }

    let hooks = json_object_entry(&mut config, "hooks")?;
    for (key, event) in CURSOR_HOOKS {
        json_array_entry(hooks, key)?.push(serde_json::json!({
            "command": format!("{command} --source cursor --event {event}")
        }));
    }

    write_json_atomically(config_path, &config)?;
    Ok(HookRegisterResult::Registered {
        config_path: config_path.to_string_lossy().into_owned(),
    })
}

/// Reads a JSON config file as an object; a missing file reads as empty.
/// Anything present but unparseable is an error: a merge never clobbers.
fn read_json_object(path: &Path) -> ApiResult<serde_json::Map<String, serde_json::Value>> {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(serde_json::Value::Object(map)) => Ok(map),
            _ => Err(BridgeError::unknown(
                "The CLI's settings file could not be parsed; fix it by hand first.",
            )),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(_) => Err(BridgeError::unknown(
            "The CLI's settings file could not be read.",
        )),
    }
}

/// The named entry as a mutable object, created when absent. A present entry
/// of any other shape stops the merge rather than being overwritten.
fn json_object_entry<'a>(
    map: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> ApiResult<&'a mut serde_json::Map<String, serde_json::Value>> {
    map.entry(key)
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(unexpected_settings_shape)
}

/// The named entry as a mutable array, with the same merge discipline as
/// `json_object_entry`.
fn json_array_entry<'a>(
    map: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> ApiResult<&'a mut Vec<serde_json::Value>> {
    map.entry(key)
        .or_insert_with(|| serde_json::Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(unexpected_settings_shape)
}

fn unexpected_settings_shape() -> BridgeError {
    BridgeError::unknown("The CLI's settings file has an unexpected shape; leaving it untouched.")
}

/// True when any SessionStart/SessionEnd entry already mentions the hook
/// binary — the same substring heuristic detection uses, so a registration
/// detection would later find reads as already registered here.
fn claude_hook_present(settings: &serde_json::Map<String, serde_json::Value>) -> bool {
    hook_arrays_mention_hook(settings, &CLAUDE_HOOK_EVENTS)
}

/// True when any sessionStart/sessionEnd entry already mentions the hook
/// binary — same heuristic as `claude_hook_present`, on Cursor's keys.
fn cursor_hook_present(config: &serde_json::Map<String, serde_json::Value>) -> bool {
    hook_arrays_mention_hook(config, &["sessionStart", "sessionEnd"])
}

fn hook_arrays_mention_hook(
    settings: &serde_json::Map<String, serde_json::Value>,
    events: &[&str],
) -> bool {
    let Some(hooks) = settings.get("hooks").and_then(|hooks| hooks.as_object()) else {
        return false;
    };
    events
        .iter()
        .filter_map(|event| hooks.get(*event))
        .any(value_mentions_hook)
}

fn value_mentions_hook(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(text) => text.contains(HOOK_BINARY_NAME),
        serde_json::Value::Array(items) => items.iter().any(value_mentions_hook),
        serde_json::Value::Object(map) => map.values().any(value_mentions_hook),
        _ => false,
    }
}

/// Pretty-prints the merged config beside the original. The untouched file is
/// copied to `.bak` once (the pristine original stays pristine across later
/// runs), then the new content lands via a sibling temp file and rename, so a
/// crash mid-write cannot leave a half-written config.
fn write_json_atomically(
    path: &Path,
    settings: &serde_json::Map<String, serde_json::Value>,
) -> ApiResult<()> {
    let failure = || BridgeError::unknown("Could not update the CLI's settings file.");
    let encoded = serde_json::to_vec_pretty(&serde_json::Value::Object(settings.clone()))
        .map_err(|_| failure())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| failure())?;
    }
    if path.exists() {
        let mut backup = path.as_os_str().to_os_string();
        backup.push(".bak");
        if !Path::new(&backup).exists() {
            std::fs::copy(path, &backup).map_err(|_| failure())?;
        }
    }
    let mut temp = path.as_os_str().to_os_string();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, encoded).map_err(|_| failure())?;
    if std::fs::rename(&temp, path).is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err(failure());
    }
    Ok(())
}

/// The agent session holding the open session through quiet time, surfaced so
/// the panel can say why recording did not stop.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActive {
    pub source: String,
    pub since: String,
}

/// The `monitor_status` payload: the answer to "is it actually working?"
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStatus {
    pub enabled: bool,
    pub running: bool,
    pub last_upload_at: Option<String>,
    pub segment_backlog: u32,
    pub agent_backlog: u32,
    pub session_backlog: u32,
    pub hooks: Vec<HookRegistration>,
    /// The agent session holding the open session through quiet time, if any.
    pub agent_active: Option<AgentActive>,
    /// The session recording right now, which exists whenever the machine is
    /// in use and recording is on.
    pub current_session: Option<CurrentSession>,
    /// Every project the caller could pick, so the UI can offer the override
    /// without a second round trip.
    pub selected_project_id: Option<String>,
}

/// The open session, as the UI shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentSession {
    pub project_id: String,
    pub attribution: Attribution,
    pub since: String,
    /// Quiet time already sitting inside this session, which the server
    /// subtracts from its duration.
    pub idle_seconds: u32,
}

/// Lines (≈ pending rows) in a spool file, for the backlog counters.
fn count_lines(path: &Path) -> u32 {
    std::fs::read(path)
        .map(|bytes| bytes.iter().filter(|byte| **byte == b'\n').count() as u32)
        .unwrap_or(0)
}

pub struct MonitorConfig {
    pub client: ApiClient,
    pub settings_path: PathBuf,
    pub segments_path: PathBuf,
    pub agent_path: PathBuf,
    pub sessions_path: PathBuf,
    pub recovery_path: PathBuf,
    pub recovery: Arc<tokio::sync::Mutex<RecoveryState>>,
}

struct MonitorTasks {
    /// No poll task on non-Windows builds (no `ActivitySource` ships there);
    /// the upload task still drains the agent spool.
    poll: Option<tokio::task::JoinHandle<()>>,
    upload: tokio::task::JoinHandle<()>,
}

/// Owns the monitor's tasks and shared state. Constructed at app start; the
/// tasks run only while monitoring is enabled and a session is signed in.
pub struct Monitor {
    shared: Arc<Mutex<MonitorShared>>,
    #[cfg_attr(not(windows), allow(dead_code))]
    events: Arc<PlatformEvents>,
    settings_path: PathBuf,
    segments_path: PathBuf,
    agent_path: PathBuf,
    sessions_path: Mutex<PathBuf>,
    sessions_path_base: PathBuf,
    client: ApiClient,
    // Written by the Windows-gated poll task, which persists the open session.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    recovery_path: PathBuf,
    recovery: Arc<tokio::sync::Mutex<RecoveryState>>,
    tasks: tokio::sync::Mutex<Option<MonitorTasks>>,
    upload_now: Arc<Notify>,
    #[cfg_attr(not(windows), allow(dead_code))]
    event_thread_once: std::sync::Once,
}

impl Monitor {
    pub fn new(config: MonitorConfig) -> Self {
        let settings = load_settings(&config.settings_path);
        Self {
            shared: Arc::new(Mutex::new(MonitorShared {
                builder: SegmentBuilder::new(),
                settings,
                mappings: Vec::new(),
                agent: AgentTracking::default(),
                last_upload_at: None,
                tracker: SessionTracker::new(),
                default_project: None,
                account_id: None,
                selected_project: None,
            })),
            events: Arc::new(PlatformEvents::new()),
            settings_path: config.settings_path,
            segments_path: config.segments_path,
            agent_path: config.agent_path,
            sessions_path: Mutex::new(config.sessions_path.clone()),
            sessions_path_base: config.sessions_path,
            client: config.client,
            recovery_path: config.recovery_path,
            recovery: config.recovery,
            tasks: tokio::sync::Mutex::new(None),
            upload_now: Arc::new(Notify::new()),
            event_thread_once: std::sync::Once::new(),
        }
    }

    pub fn is_enabled(&self) -> bool {
        lock(&self.shared).settings.enabled
    }

    pub async fn is_running(&self) -> bool {
        self.tasks.lock().await.is_some()
    }

    /// Starts the poll and upload tasks. Idempotent; a no-op when running.
    pub async fn start(&self) {
        let mut guard = self.tasks.lock().await;
        if guard.is_some() {
            return;
        }

        #[cfg(windows)]
        let poll = {
            self.event_thread_once.call_once(|| {
                platform::spawn_event_thread(Arc::clone(&self.events));
            });
            Some(tokio::spawn(poll_loop(
                Arc::clone(&self.shared),
                Arc::clone(&self.events),
                self.segments_path.clone(),
                self.agent_path.clone(),
                self.session_spool_path(),
                self.recovery_path.clone(),
                Arc::clone(&self.recovery),
            )))
        };
        #[cfg(not(windows))]
        let poll: Option<tokio::task::JoinHandle<()>> = None;

        let upload = tokio::spawn(crate::uploader::upload_loop(
            Arc::clone(&self.shared),
            self.client.clone(),
            self.segments_path.clone(),
            self.agent_path.clone(),
            self.session_spool_path(),
            Arc::clone(&self.upload_now),
        ));
        *guard = Some(MonitorTasks { poll, upload });
    }

    /// Stops all polling and uploading, closing the open segment where
    /// recording stopped. The spooled backlog stays on disk and uploads when
    /// monitoring is re-enabled — disabling never silently uploads.
    pub async fn stop(&self) {
        if let Some(tasks) = self.tasks.lock().await.take() {
            if let Some(poll) = tasks.poll {
                poll.abort();
            }
            tasks.upload.abort();
        }
        let now = unix_now();
        let (closed, finished, device_id, account_id) = {
            let mut shared = lock(&self.shared);
            let device_id = shared.settings.device_id.clone();
            let account_id = shared.account_id.clone();
            let segment = shared.builder.flush(now);
            // Recording stopping is a session boundary like any other: the work
            // already done is written down, not discarded.
            let session = shared.tracker.flush(now);
            (segment, session, device_id, account_id)
        };
        if let Some(segment) = closed {
            append_segment_line(&self.segments_path, &segment, &device_id);
        }
        if let Some(session) = finished {
            if account_id.is_some() {
                append_session_line(&self.session_spool_path(), &session);
            }
        }
        self.persist_open_session(account_id.as_deref(), None).await;
    }

    /// Starts the tasks when the setting is on; called after a successful
    /// bootstrap or sign-in. Recording while signed out would attribute this
    /// machine's evidence to whoever signs in next, so setup never starts it.
    pub async fn ensure_running(&self) {
        if self.is_enabled() {
            self.start().await;
        }
    }

    pub fn settings(&self) -> MonitorSettings {
        lock(&self.shared).settings.clone()
    }

    /// Validates, persists, and applies new settings, starting or stopping the
    /// tasks when `enabled` flips.
    pub async fn apply_patch(&self, patch: &SettingsPatch) -> ApiResult<MonitorSettings> {
        let next = self.settings().patched(patch);
        if let Err(reason) = next.validate() {
            return Err(BridgeError::new(ErrorKind::Validation, reason));
        }
        let was_running = self.is_running().await;
        lock(&self.shared).settings = next.clone();
        persist_settings(&self.settings_path, &next)?;
        match (next.enabled, was_running) {
            (true, false) => self.start().await,
            (false, true) => self.stop().await,
            _ => {}
        }
        Ok(next)
    }

    pub fn cache_mappings(&self, mappings: Vec<PathMapping>) {
        lock(&self.shared).mappings = mappings;
    }

    pub async fn status(&self) -> MonitorStatus {
        let running = self.is_running().await;
        let now = unix_now();
        let shared = lock(&self.shared);
        let agent_active = if shared
            .agent
            .is_active(now, shared.settings.agent_override_enabled)
        {
            shared.agent.effective_agent(now).map(|active| AgentActive {
                source: active.source.clone(),
                since: iso8601(active.started_at),
            })
        } else {
            None
        };

        MonitorStatus {
            enabled: shared.settings.enabled,
            running,
            last_upload_at: shared.last_upload_at.clone(),
            segment_backlog: count_lines(&self.segments_path),
            agent_backlog: count_lines(&self.agent_path),
            session_backlog: count_lines(&self.session_spool_path()),
            hooks: detect_hooks(&default_hook_probes()),
            agent_active,
            current_session: shared.tracker.open_session().map(|open| CurrentSession {
                project_id: open.project.project_id.clone(),
                attribution: open.project.attribution,
                since: iso8601(open.started_at),
                idle_seconds: open.idle_seconds as u32,
            }),
            selected_project_id: shared.selected_project.clone(),
        }
    }

    /// Points recording at one project until the person clears it. The change
    /// closes the open session at its last active moment, so the switch never
    /// backdates work into the newly chosen project.
    pub fn select_project(&self, project_id: Option<String>) {
        let mut shared = lock(&self.shared);
        shared.selected_project = project_id;
    }

    /// Establishes the project that catches time nothing else names.
    pub fn set_default_project(&self, project_id: Option<String>) {
        lock(&self.shared).default_project = project_id;
    }

    /// Starts a clean account-bound recording context. Callers stop the old
    /// context first, so no session can survive into a different account.
    pub fn begin_account(&self, user_id: &str) {
        let mut shared = lock(&self.shared);
        shared.mappings.clear();
        shared.agent = AgentTracking::default();
        shared.tracker = SessionTracker::new();
        shared.default_project = None;
        shared.selected_project = None;
        shared.account_id = Some(user_id.to_string());
        *lock(&self.sessions_path) = scoped_sessions_path(&self.sessions_path_base, user_id);
    }

    /// Removes account-bound in-memory state after its sessions have been
    /// flushed, so a later sign-in cannot inherit a project or agent source.
    pub fn clear_account(&self) {
        let mut shared = lock(&self.shared);
        shared.mappings.clear();
        shared.agent = AgentTracking::default();
        shared.tracker = SessionTracker::new();
        shared.default_project = None;
        shared.selected_project = None;
        shared.account_id = None;
    }

    pub fn account_id(&self) -> Option<String> {
        lock(&self.shared).account_id.clone()
    }

    /// Closes whatever the previous run left open, so a crash or a forced
    /// shutdown still reports the work it had already recorded.
    pub fn carry_over(&self, state: &RecoveryState, user_id: &str) {
        if let Some(session) = crate::recovery::close_carried_session(state, user_id) {
            append_session_line(&self.session_spool_path(), &session);
        }
    }

    fn session_spool_path(&self) -> PathBuf {
        lock(&self.sessions_path).clone()
    }

    async fn persist_open_session(&self, user_id: Option<&str>, open_session: Option<OpenSession>) {
        persist_open_session(&self.recovery_path, &self.recovery, user_id, open_session).await;
    }
}

fn scoped_sessions_path(base: &Path, user_id: &str) -> PathBuf {
    let stem = base
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("sessions");
    base.with_file_name(format!("{stem}-{user_id}.jsonl"))
}

async fn persist_open_session(
    path: &Path,
    recovery: &Arc<tokio::sync::Mutex<RecoveryState>>,
    user_id: Option<&str>,
    open_session: Option<OpenSession>,
) {
    let Some(user_id) = user_id else {
        return;
    };
    let mut state = recovery.lock().await;
    match open_session {
        Some(open_session) => {
            state
                .open_sessions
                .insert(user_id.to_string(), open_session);
        }
        None => {
            state.open_sessions.remove(user_id);
        }
    }
    let _ = crate::write_recovery_file(path, &state);
}

pub fn load_settings(path: &Path) -> MonitorSettings {
    let mut settings = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<MonitorSettings>(&bytes).ok())
        .unwrap_or_default();
    if settings.device_id.is_empty() {
        // First launch: mint the stable device id and persist it immediately.
        settings.device_id = uuid::Uuid::new_v4().to_string();
        let _ = persist_settings(path, &settings);
    }
    settings
}

pub(crate) fn persist_settings(path: &Path, settings: &MonitorSettings) -> ApiResult<()> {
    let encoded = serde_json::to_vec_pretty(settings)
        .map_err(|_| BridgeError::unknown("Could not save the settings."))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| BridgeError::unknown("Could not save the settings."))?;
    }
    std::fs::write(path, encoded).map_err(|_| BridgeError::unknown("Could not save the settings."))
}

/// Appends one closed segment to the segment spool. Spool failures are
/// logged without the payload (paths and process names stay out of logs).
fn append_segment_line(path: &Path, segment: &Segment, device_id: &str) {
    let record = SegmentRecord::from_segment(segment, device_id);
    let mut line = match serde_json::to_vec(&record) {
        Ok(line) => line,
        Err(_) => return,
    };
    line.push(b'\n');
    if spool::append_line(path, &line, spool::MAX_SPOOL_BYTES).is_err() {
        eprintln!("clock-in: could not persist an activity segment");
    }
}

/// The 30-second poll task: drain pushed session events, poll the OS, fold
/// signals into segments, spool transitions, enforce the auto-stop policy.
#[cfg_attr(not(windows), allow(dead_code))]
async fn poll_loop(
    shared: Arc<Mutex<MonitorShared>>,
    events: Arc<PlatformEvents>,
    segments_path: PathBuf,
    agent_path: PathBuf,
    sessions_path: PathBuf,
    recovery_path: PathBuf,
    recovery: Arc<tokio::sync::Mutex<RecoveryState>>,
) {
    let source = platform::Poller::new();
    let mut tick = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECONDS));
    // A slept machine replays missed ticks one at a time, not in a burst.
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let now = unix_now();
        let pushed = events.drain();
        let replayed = crate::uploader::replay_agent_spool(&shared, &agent_path);

        let mut closed = Vec::new();
        let (device_id, finished, account_id, open_session) = {
            let mut shared = lock(&shared);
            // Event timestamps come from when the OS broadcast fired, which
            // can be long ago (a suspend/resume pair spanning the night).
            for (at, signal) in pushed {
                closed.extend(shared.builder.apply(at, &signal));
            }
            let signal = source.poll();
            closed.extend(shared.builder.apply(now, &signal));
            let device_id = shared.settings.device_id.clone();
            let mut finished = replayed;
            finished.extend(advance_sessions(&mut shared, now));
            let account_id = shared.account_id.clone();
            let open_session = shared.tracker.open_session().cloned();
            (device_id, finished, account_id, open_session)
        };
        for segment in &closed {
            append_segment_line(&segments_path, segment, &device_id);
        }
        for session in &finished {
            if account_id.is_some() {
                append_session_line(&sessions_path, session);
            }
        }
        // The open session goes to disk every tick: a crash then costs the gap
        // since the last tick, not the whole session.
        persist_open_session(
            &recovery_path,
            &recovery,
            account_id.as_deref(),
            open_session,
        )
        .await;
    }
}

/// Folds this tick's activity boundaries into sessions. Split out from the
/// poll task so it stays a plain function over shared state.
pub fn advance_sessions(shared: &mut MonitorShared, now: u64) -> Vec<ObservedSession> {
    let project = shared.current_project(now);
    let agent_active = shared
        .agent
        .is_active(now, shared.settings.agent_override_enabled);
    let away_threshold_seconds = shared.settings.away_threshold_seconds();
    let open_span = shared.builder.open_span();
    let client_id = uuid::Uuid::new_v4().to_string();
    shared.tracker.apply(
        TrackerInput {
            now,
            open_span,
            project: project.as_ref(),
            agent_active,
            away_threshold_seconds,
        },
        &client_id,
    )
}

/// Appends one finished session to its spool. Failures are logged without the
/// payload, exactly like segments.
fn append_session_line(path: &Path, session: &ObservedSession) {
    let mut line = match serde_json::to_vec(session) {
        Ok(line) => line,
        Err(_) => return,
    };
    line.push(b'\n');
    if spool::append_line(path, &line, spool::MAX_SPOOL_BYTES).is_err() {
        eprintln!("clock-in: could not persist a finished session");
    }
}

/// Current unix time in seconds; 0 if the clock is before the epoch.
pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Formats unix seconds in the ISO-8601 shape the API expects.
pub fn iso8601(unix: u64) -> String {
    spool::format_iso8601(unix)
}

/// Parses the ISO-8601 timestamps the API and the hook contract emit
/// (`YYYY-MM-DDTHH:MM:SS`, optional fraction, `Z` or `±HH:MM`) into unix
/// seconds. Anything else is rejected — callers fall back rather than guess.
pub fn parse_iso8601(value: &str) -> Option<u64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |start: usize, len: usize| value.get(start..start + len)?.parse::<u32>().ok();
    let year = i64::from(number(0, 4)?);
    let month = number(5, 2)?;
    let day = number(8, 2)?;
    let hour = number(11, 2)?;
    let minute = number(14, 2)?;
    let second = number(17, 2)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    let mut rest = &value[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(fraction.len());
        if digits == 0 {
            return None;
        }
        rest = &fraction[digits..];
    }

    let offset_seconds: i64 = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let (sign, hm) = match rest.as_bytes().first() {
                Some(b'+') => (1i64, &rest[1..]),
                Some(b'-') => (-1i64, &rest[1..]),
                _ => return None,
            };
            if hm.len() != 5 || hm.as_bytes()[2] != b':' {
                return None;
            }
            let hours = i64::from(hm.get(0..2)?.parse::<u32>().ok()?);
            let minutes = i64::from(hm.get(3..5)?.parse::<u32>().ok()?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            sign * (hours * 3_600 + minutes * 60)
        }
    };

    let days = days_from_civil(year, month, day);
    let unix = days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second)
        - offset_seconds;
    u64::try_from(unix).ok()
}

/// Days since the unix epoch for a civil date (Howard Hinnant's algorithm,
/// the inverse of the formatting in `spool.rs`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(windows)]
mod platform {
    //! Read-only Win32 access behind `ActivitySource`, plus the hidden-window
    //! thread that turns session lock and suspend broadcasts into signals.
    //! Tests never touch this module; everything above it is pure logic.

    use std::sync::Arc;

    use windows_sys::Win32::Foundation::{CloseHandle, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetForegroundWindow, GetMessageW,
        GetWindowLongPtrW, GetWindowThreadProcessId, RegisterClassW, SetWindowLongPtrW,
        TranslateMessage, CW_USEDEFAULT, GWLP_USERDATA, MSG, PBT_APMSUSPEND, WM_POWERBROADCAST,
        WM_WTSSESSION_CHANGE, WNDCLASSW, WS_POPUP, WTS_SESSION_LOCK,
    };

    use super::{unix_now, ActivitySignal, ActivitySource, PlatformEvents, IDLE_THRESHOLD_SECONDS};

    pub struct Poller;

    impl Poller {
        pub fn new() -> Self {
            Self
        }
    }

    impl ActivitySource for Poller {
        fn poll(&self) -> ActivitySignal {
            match idle_seconds() {
                Some(idle_seconds) if idle_seconds >= IDLE_THRESHOLD_SECONDS => {
                    ActivitySignal::Idle { idle_seconds }
                }
                // A failed read fails toward "active": a guessed idle span
                // would trim time that was actually worked.
                _ => ActivitySignal::Active {
                    process_name: foreground_process_name(),
                },
            }
        }
    }

    /// Seconds since the last keyboard or mouse input, per `GetLastInputInfo`.
    /// `GetTickCount` wraps at ~49.7 days; the wrapping subtraction absorbs it.
    fn idle_seconds() -> Option<u32> {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        unsafe {
            if GetLastInputInfo(&mut info) == 0 {
                return None;
            }
            Some(GetTickCount().wrapping_sub(info.dwTime) / 1_000)
        }
    }

    /// The executable name of the foreground window's process — the name only,
    /// never the window title. `None` when the OS won't say (no foreground
    /// window, access denied), which the segment simply records without one.
    fn foreground_process_name() -> Option<String> {
        unsafe {
            let window = GetForegroundWindow();
            if window.is_null() {
                return None;
            }
            let mut process_id = 0u32;
            GetWindowThreadProcessId(window, &mut process_id);
            if process_id == 0 {
                return None;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if process.is_null() {
                return None;
            }
            let mut buffer = [0u16; 260];
            let mut length = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
            CloseHandle(process);
            if ok == 0 || length == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buffer[..length as usize]);
            path.rsplit(['\\', '/'])
                .next()
                .filter(|name| !name.is_empty())
                .map(str::to_string)
        }
    }

    /// Publishes lock and suspend broadcasts into `events`. Runs for the
    /// process lifetime: the thread is created once, and between broadcasts
    /// it sleeps inside `GetMessageW` at zero background cost.
    pub fn spawn_event_thread(events: Arc<PlatformEvents>) {
        std::thread::spawn(move || unsafe { event_loop(events) });
    }

    unsafe fn event_loop(events: Arc<PlatformEvents>) {
        let instance: HINSTANCE = unsafe { GetModuleHandleW(std::ptr::null()) };
        if instance.is_null() {
            return;
        }
        let class_name: Vec<u16> = "ClockInMonitorEvents\0".encode_utf16().collect();
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: class_name.as_ptr(),
            ..unsafe { std::mem::zeroed() }
        };
        if unsafe { RegisterClassW(&class) } == 0 {
            return;
        }
        // A real (hidden) top-level window, not a message-only one: the
        // system does not broadcast WM_POWERBROADCAST to message-only windows.
        let window = unsafe {
            CreateWindowExW(
                0,
                class_name.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        };
        if window.is_null() {
            return;
        }
        // The window procedure finds the queue through GWLP_USERDATA. The Arc
        // is deliberately leaked: the window outlives any monitor start/stop.
        let leaked = Arc::into_raw(events);
        unsafe {
            SetWindowLongPtrW(window, GWLP_USERDATA, leaked as isize);
            WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION);
        }

        let mut message: MSG = unsafe { std::mem::zeroed() };
        while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    unsafe extern "system" fn window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let events = unsafe { GetWindowLongPtrW(window, GWLP_USERDATA) } as *const PlatformEvents;
        if !events.is_null() {
            let signal = match message {
                WM_WTSSESSION_CHANGE if wparam == WTS_SESSION_LOCK as usize => {
                    Some(ActivitySignal::Locked)
                }
                // Unlock and resume raise no event: the next poll's Active or
                // Idle signal closes the span the same way a transition would.
                WM_POWERBROADCAST if wparam == PBT_APMSUSPEND as usize => {
                    Some(ActivitySignal::Suspended)
                }
                _ => None,
            };
            if let Some(signal) = signal {
                unsafe { &*events }.push(unix_now(), signal);
            }
        }
        unsafe { DefWindowProcW(window, message, wparam, lparam) }
    }
}

#[cfg(not(windows))]
mod platform {
    //! No activity source ships for this OS yet (Phase 2 is Windows-only), so
    //! `Monitor::start` never spawns a poll task here and nothing is recorded.

    use super::{ActivitySignal, ActivitySource};

    pub struct Poller;

    impl Poller {
        pub fn new() -> Self {
            Self
        }
    }

    impl ActivitySource for Poller {
        fn poll(&self) -> ActivitySignal {
            ActivitySignal::Active { process_name: None }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active(name: &str) -> ActivitySignal {
        ActivitySignal::Active {
            process_name: Some(name.to_string()),
        }
    }

    fn idle(seconds: u32) -> ActivitySignal {
        ActivitySignal::Idle {
            idle_seconds: seconds,
        }
    }

    fn segment(kind: SegmentKind, start: u64, end: u64) -> Segment {
        Segment {
            kind,
            process_name: None,
            started_at: start,
            ended_at: end,
        }
    }

    fn settings() -> MonitorSettings {
        MonitorSettings {
            device_id: "device-1".to_string(),
            ..MonitorSettings::default()
        }
    }

    #[test]
    fn active_idle_active_folds_into_transition_segments() {
        let mut builder = SegmentBuilder::new();

        assert!(builder.apply(1_000, &active("code.exe")).is_empty());
        // Same kind coalesces; the latest foreground process is remembered.
        assert!(builder.apply(1_060, &active("msedge.exe")).is_empty());
        // Idle for 120s at t=1300: the active span ended at the last input.
        let closed = builder.apply(1_300, &idle(120));
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].kind, SegmentKind::Active);
        assert_eq!(closed[0].process_name.as_deref(), Some("msedge.exe"));
        assert_eq!((closed[0].started_at, closed[0].ended_at), (1_000, 1_180));
        // Idle continues: no new segment.
        assert!(builder.apply(1_360, &idle(300)).is_empty());
        // Back to work: the idle span closes at the transition.
        let closed = builder.apply(1_400, &active("code.exe"));
        assert_eq!(closed, vec![segment(SegmentKind::Idle, 1_180, 1_400)]);
    }

    #[test]
    fn an_idle_span_never_overlaps_what_came_before_it() {
        let mut builder = SegmentBuilder::new();
        builder.apply(1_000, &active("code.exe"));

        // The reported idle predates the active span: clamp, don't overlap.
        let closed = builder.apply(1_100, &idle(900));
        assert!(closed.is_empty(), "zero-length active span is dropped");
        let snapshot = builder.snapshot(1_100);
        assert_eq!(snapshot, vec![segment(SegmentKind::Idle, 1_000, 1_100)]);
    }

    #[test]
    fn lock_and_suspend_events_close_and_open_spans_at_event_time() {
        let mut builder = SegmentBuilder::new();
        builder.apply(1_000, &active("code.exe"));

        let closed = builder.apply(1_100, &ActivitySignal::Locked);
        assert_eq!(
            closed,
            vec![{
                let mut active = segment(SegmentKind::Active, 1_000, 1_100);
                active.process_name = Some("code.exe".to_string());
                active
            }]
        );
        assert_eq!(builder.open_span(), Some((SegmentKind::Locked, 1_100)));

        // Locked → Locked coalesces; suspend replaces lock; activity resumes.
        assert!(builder.apply(1_200, &ActivitySignal::Locked).is_empty());
        let closed = builder.apply(1_300, &ActivitySignal::Suspended);
        assert_eq!(closed, vec![segment(SegmentKind::Locked, 1_100, 1_300)]);
        // Woken at t=5000 with the last input 3600s ago: suspend ran to t=1400.
        let closed = builder.apply(5_000, &idle(3_600));
        assert_eq!(closed, vec![segment(SegmentKind::Suspended, 1_300, 1_400)]);

        let snapshot = builder.snapshot(5_000);
        assert_eq!(
            snapshot.last(),
            Some(&segment(SegmentKind::Idle, 1_400, 5_000))
        );
    }

    #[test]
    fn flush_closes_the_open_span_where_recording_stopped() {
        let mut builder = SegmentBuilder::new();
        builder.apply(1_000, &active("code.exe"));

        let flushed = builder.flush(1_500).expect("an open span flushes");
        assert_eq!(flushed.kind, SegmentKind::Active);
        assert_eq!((flushed.started_at, flushed.ended_at), (1_000, 1_500));
        assert!(builder.flush(1_600).is_none(), "nothing left open");
        assert!(builder.snapshot(1_600).is_empty());
    }

    #[test]
    fn iso8601_round_trips_through_the_parser() {
        for unix in [0, 1_704_067_200, 951_827_200, 1_786_000_000] {
            assert_eq!(parse_iso8601(&iso8601(unix)), Some(unix));
        }
        assert_eq!(iso8601(1_704_067_200), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn the_parser_accepts_fractions_and_offsets_and_rejects_garbage() {
        assert_eq!(
            parse_iso8601("2024-01-01T00:00:00.000Z"),
            Some(1_704_067_200)
        );
        assert_eq!(
            parse_iso8601("2024-01-01T02:00:00+02:00"),
            Some(1_704_067_200)
        );
        assert_eq!(
            parse_iso8601("2024-01-01T00:00:00.123-00:30"),
            Some(1_704_069_000)
        );
        for bad in [
            "",
            "not a date",
            "2024-13-01T00:00:00Z",
            "2024-01-32T00:00:00Z",
            "2024-01-01T25:00:00Z",
            "2024-01-01 00:00",
            "2024-01-01T00:00:00.Z",
        ] {
            assert_eq!(parse_iso8601(bad), None, "{bad} must not parse");
        }
    }

    fn project(id: &str, attribution: Attribution) -> SessionProject {
        SessionProject {
            project_id: id.to_string(),
            attribution,
        }
    }

    /// Drives the tracker the way the poll task does: one tick per call, with
    /// the fold's open span and the project the host would attribute to.
    fn tick(
        tracker: &mut SessionTracker,
        now: u64,
        open_span: Option<(SegmentKind, u64)>,
        project: Option<&SessionProject>,
        agent_active: bool,
    ) -> Vec<ObservedSession> {
        tracker.apply(
            TrackerInput {
                now,
                open_span,
                project,
                agent_active,
                away_threshold_seconds: 600,
            },
            &format!("client-{now}"),
        )
    }

    #[test]
    fn a_session_opens_on_activity_with_nobody_pressing_anything() {
        let mut tracker = SessionTracker::new();
        let project = project("p1", Attribution::Default);

        let closed = tick(
            &mut tracker,
            1_030,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );

        assert!(closed.is_empty(), "an opening session finishes nothing");
        let open = tracker.open_session().expect("a session is open");
        assert_eq!(open.started_at, 1_000, "it starts where the activity did");
        assert_eq!(open.project.project_id, "p1");
    }

    #[test]
    fn quiet_time_past_the_threshold_closes_the_session_where_work_stopped() {
        let mut tracker = SessionTracker::new();
        let project = project("p1", Attribution::Agent);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );

        // Nine minutes of quiet is not enough to end anything.
        let early = tick(
            &mut tracker,
            2_140,
            Some((SegmentKind::Idle, 1_600)),
            Some(&project),
            false,
        );
        assert!(early.is_empty());

        let closed = tick(
            &mut tracker,
            2_200,
            Some((SegmentKind::Idle, 1_600)),
            Some(&project),
            false,
        );

        let [session] = closed.as_slice() else {
            panic!("one session closed")
        };
        assert_eq!(session.started_at, iso8601(1_000));
        // At the last active moment, never at "now": idle is never inside it.
        assert_eq!(session.stopped_at, iso8601(1_600));
        assert_eq!(session.attribution, Attribution::Agent);
        assert!(tracker.open_session().is_none());
    }

    #[test]
    fn short_quiet_gaps_stay_inside_the_session_as_trimmed_idle() {
        let mut tracker = SessionTracker::new();
        let project = project("p1", Attribution::Default);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );
        // Four minutes idle, then back to work: one session, not two.
        tick(
            &mut tracker,
            1_300,
            Some((SegmentKind::Idle, 1_200)),
            Some(&project),
            false,
        );
        let closed = tick(
            &mut tracker,
            1_500,
            Some((SegmentKind::Active, 1_440)),
            Some(&project),
            false,
        );

        assert!(closed.is_empty(), "a short gap fragments nothing");
        assert_eq!(
            tracker.open_session().expect("still open").idle_seconds,
            240
        );

        let finished = tracker.flush(1_500).expect("the session closes");
        assert_eq!(finished.idle_seconds, 240);
        assert_eq!(finished.started_at, iso8601(1_000));
    }

    #[test]
    fn locking_or_sleeping_ends_the_session_at_that_moment() {
        for kind in [SegmentKind::Locked, SegmentKind::Suspended] {
            let mut tracker = SessionTracker::new();
            let project = project("p1", Attribution::Default);
            tick(
                &mut tracker,
                1_000,
                Some((SegmentKind::Active, 1_000)),
                Some(&project),
                false,
            );

            let closed = tick(
                &mut tracker,
                1_800,
                Some((kind, 1_700)),
                Some(&project),
                false,
            );

            let [session] = closed.as_slice() else {
                panic!("one session closed for {kind:?}")
            };
            assert_eq!(session.stopped_at, iso8601(1_700));
        }
    }

    #[test]
    fn an_open_agent_session_holds_the_session_through_quiet_time_and_lock() {
        let mut tracker = SessionTracker::new();
        let project = project("p1", Attribution::Agent);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );

        // Hours of quiet, but an agent is working: this is unattended work.
        let quiet = tick(
            &mut tracker,
            40_000,
            Some((SegmentKind::Idle, 1_600)),
            Some(&project),
            true,
        );
        let locked = tick(
            &mut tracker,
            44_000,
            Some((SegmentKind::Locked, 41_000)),
            Some(&project),
            true,
        );

        assert!(quiet.is_empty());
        assert!(locked.is_empty());
        assert!(tracker.open_session().is_some());
    }

    #[test]
    fn agent_evidence_advances_the_counted_boundary_on_lock() {
        // R10: an overnight agent run on a locked machine must count the
        // agent's working time as session duration, not trim it as idle.
        let mut tracker = SessionTracker::new();
        let project = project("p1", Attribution::Agent);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );

        // Machine locks; agent is still running.
        tick(
            &mut tracker,
            2_000,
            Some((SegmentKind::Locked, 2_000)),
            Some(&project),
            true,
        );
        let open = tracker.open_session().expect("session survives lock");
        assert_eq!(
            open.last_active_at, 2_000,
            "agent evidence advances the boundary past the lock"
        );

        // Agent keeps running while the machine stays locked.
        tick(
            &mut tracker,
            3_000,
            Some((SegmentKind::Locked, 2_000)),
            Some(&project),
            true,
        );
        let open = tracker.open_session().unwrap();
        assert_eq!(
            open.last_active_at, 3_000,
            "each agent event advances the boundary"
        );

        // Agent finishes; machine stays locked. Session closes at the last
        // agent boundary, not at the original lock moment.
        let closed = tick(
            &mut tracker,
            5_000,
            Some((SegmentKind::Locked, 2_000)),
            Some(&project),
            false,
        );
        let [session] = closed.as_slice() else {
            panic!("session closes when agent stops on a locked machine")
        };
        assert_eq!(session.started_at, iso8601(1_000));
        assert_eq!(session.stopped_at, iso8601(3_000));
        // The post-agent locked gap (3_000 to 5_000) is NOT inside the session.
        assert!(tracker.open_session().is_none());
    }

    #[test]
    fn agent_covered_idle_is_not_subtracted_from_session_duration() {
        // R10: idle time with an active agent must not be booked as trimmed
        // idle. The agent's working interval survives into the session.
        let mut tracker = SessionTracker::new();
        let project = project("p1", Attribution::Agent);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );

        // Person steps away; machine goes idle — short gap, under threshold.
        tick(
            &mut tracker,
            1_100,
            Some((SegmentKind::Idle, 1_100)),
            Some(&project),
            false,
        );

        // Agent runs while machine is idle: advances the boundary.
        tick(
            &mut tracker,
            1_300,
            Some((SegmentKind::Idle, 1_100)),
            Some(&project),
            true,
        );
        assert_eq!(tracker.open_session().unwrap().last_active_at, 1_300);

        tick(
            &mut tracker,
            1_500,
            Some((SegmentKind::Idle, 1_100)),
            Some(&project),
            true,
        );
        assert_eq!(tracker.open_session().unwrap().last_active_at, 1_500);

        // Person returns while agent is still running.
        tick(
            &mut tracker,
            1_600,
            Some((SegmentKind::Active, 1_600)),
            Some(&project),
            true,
        );

        let finished = tracker.flush(1_600).expect("session closes");
        assert_eq!(finished.started_at, iso8601(1_000));
        assert_eq!(finished.stopped_at, iso8601(1_600));
        // The idle gap from 1_100 to 1_600 had agent coverage, so only the
        // pre-agent portion (1_100–1_300 = 200 s) is trimmed idle.
        assert_eq!(finished.idle_seconds, 200);
    }

    #[test]
    fn agent_stops_during_idle_then_idle_continues_past_threshold() {
        // R10: when an agent runs during idle, then stops, and idle continues
        // past the away threshold, the session closes at the last agent
        // boundary — not at the original idle start.
        let mut tracker = SessionTracker::new();
        let project = project("p1", Attribution::Agent);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );

        // Person steps away; machine goes idle.
        tick(
            &mut tracker,
            1_100,
            Some((SegmentKind::Idle, 1_100)),
            Some(&project),
            false,
        );

        // Agent runs while machine is idle: advances the boundary.
        tick(
            &mut tracker,
            1_200,
            Some((SegmentKind::Idle, 1_100)),
            Some(&project),
            true,
        );
        tick(
            &mut tracker,
            1_500,
            Some((SegmentKind::Idle, 1_100)),
            Some(&project),
            true,
        );

        // Agent stops; machine stays idle. Idle continues past threshold.
        let closed = tick(
            &mut tracker,
            2_100,
            Some((SegmentKind::Idle, 1_100)),
            Some(&project),
            false,
        );
        let [session] = closed.as_slice() else {
            panic!("session closes when idle outlasts agent work")
        };
        // Session must close at the last agent boundary (1_500), not the
        // original idle start (1_100).
        assert_eq!(session.started_at, iso8601(1_000));
        assert_eq!(session.stopped_at, iso8601(1_500));
        // Pre-agent uncovered idle (1_100–1_200 = 100 s) is trimmed.
        assert_eq!(session.idle_seconds, 100);
    }

    #[test]
    fn a_changed_project_closes_one_session_and_opens_the_next() {
        let mut tracker = SessionTracker::new();
        let first = project("p1", Attribution::Default);
        let second = project("p2", Attribution::Agent);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&first),
            false,
        );
        tick(
            &mut tracker,
            1_500,
            Some((SegmentKind::Active, 1_000)),
            Some(&first),
            false,
        );

        let closed = tick(
            &mut tracker,
            1_800,
            Some((SegmentKind::Active, 1_000)),
            Some(&second),
            false,
        );

        let [session] = closed.as_slice() else {
            panic!("one session closed")
        };
        assert_eq!(session.project_id, "p1");
        // The first session keeps its own time; the second starts clean.
        assert_eq!(session.stopped_at, iso8601(1_500));
        let open = tracker.open_session().expect("the next session is open");
        assert_eq!(open.project.project_id, "p2");
        // It picks up exactly where the previous one stopped: no gap, no overlap.
        assert_eq!(open.started_at, 1_500);
    }

    #[test]
    fn a_project_change_after_a_short_idle_gap_starts_when_activity_resumes() {
        let mut tracker = SessionTracker::new();
        let first = project("p1", Attribution::Default);
        let second = project("p2", Attribution::Agent);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&first),
            false,
        );
        tick(
            &mut tracker,
            1_030,
            Some((SegmentKind::Active, 1_000)),
            Some(&first),
            false,
        );
        tick(
            &mut tracker,
            1_400,
            Some((SegmentKind::Idle, 1_200)),
            Some(&first),
            false,
        );

        let closed = tick(
            &mut tracker,
            1_500,
            Some((SegmentKind::Active, 1_500)),
            Some(&second),
            false,
        );

        let [session] = closed.as_slice() else {
            panic!("the first project closes");
        };
        assert_eq!(session.project_id, "p1");
        assert_eq!(session.idle_seconds, 30);
        let open = tracker.open_session().expect("the second project opens");
        assert_eq!(open.project.project_id, "p2");
        assert_eq!(open.started_at, 1_500);
    }

    #[test]
    fn nothing_is_recorded_while_no_project_can_be_named() {
        let mut tracker = SessionTracker::new();

        let nothing = tick(
            &mut tracker,
            1_030,
            Some((SegmentKind::Active, 1_000)),
            None,
            false,
        );

        assert!(nothing.is_empty());
        assert!(tracker.open_session().is_none());
    }

    #[test]
    fn a_signed_out_host_closes_what_it_had_already_recorded() {
        let mut tracker = SessionTracker::new();
        let project = project("p1", Attribution::Selected);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );
        tick(
            &mut tracker,
            1_600,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );

        let closed = tick(
            &mut tracker,
            1_900,
            Some((SegmentKind::Active, 1_000)),
            None,
            false,
        );

        let [session] = closed.as_slice() else {
            panic!("one session closed")
        };
        assert_eq!(session.stopped_at, iso8601(1_600));
    }

    #[test]
    fn flushing_never_bills_the_time_after_the_last_active_moment() {
        let mut tracker = SessionTracker::new();
        let project = project("p1", Attribution::Default);
        tick(
            &mut tracker,
            1_000,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );
        tick(
            &mut tracker,
            1_030,
            Some((SegmentKind::Active, 1_000)),
            Some(&project),
            false,
        );
        tick(
            &mut tracker,
            1_400,
            Some((SegmentKind::Idle, 1_200)),
            Some(&project),
            false,
        );

        let finished = tracker.flush(9_999).expect("the open session closes");

        // The last tick that saw the machine in use, not the moment of quitting.
        assert_eq!(finished.stopped_at, iso8601(1_030));
        assert!(
            tracker.flush(9_999).is_none(),
            "there is nothing left to close"
        );
    }

    #[test]
    fn the_pinned_project_outranks_an_agent_and_the_default() {
        let mut shared = MonitorShared {
            builder: SegmentBuilder::new(),
            settings: MonitorSettings::default(),
            mappings: Vec::new(),
            agent: AgentTracking::default(),
            last_upload_at: None,
            tracker: SessionTracker::new(),
            default_project: Some("default".to_string()),
            account_id: None,
            selected_project: None,
        };

        assert_eq!(
            shared.current_project(10_000),
            Some(project("default", Attribution::Default)),
        );

        shared.agent.active.insert(
            ("claude_code".to_string(), "s1".to_string()),
            ActiveAgent {
                source: "claude_code".to_string(),
                external_session_id: "s1".to_string(),
                started_at: 10_000,
                last_event_at: 10_000,
                project: Some("agent".to_string()),
            },
        );
        assert_eq!(
            shared.current_project(10_000),
            Some(project("agent", Attribution::Agent)),
        );

        shared.selected_project = Some("pinned".to_string());
        assert_eq!(
            shared.current_project(10_000),
            Some(project("pinned", Attribution::Selected)),
        );

        shared.default_project = None;
        shared.agent.active.clear();
        shared.selected_project = None;
        assert_eq!(shared.current_project(10_000), None);
    }

    #[test]
    fn agent_tracking_is_active_only_inside_the_staleness_window() {
        let mut tracking = AgentTracking::default();
        tracking.active.insert(
            ("claude_code".to_string(), "s1".to_string()),
            ActiveAgent {
                source: "claude_code".to_string(),
                external_session_id: "s1".to_string(),
                started_at: 10_000,
                last_event_at: 10_000,
                project: None,
            },
        );
        assert!(tracking.is_active(10_000 + AGENT_ACTIVE_WINDOW_SECONDS, true));
        assert!(!tracking.is_active(10_001 + AGENT_ACTIVE_WINDOW_SECONDS, true));
        assert!(!tracking.is_active(10_000, false), "the setting gates it");
        let mut closed = tracking.clone();
        closed.active.clear();
        assert!(!closed.is_active(10_000, true), "an ended session is over");
    }

    #[test]
    fn settings_default_to_the_recommended_config_and_survive_partial_files() {
        // These defaults only reach NEW installs: the first launch persists the
        // full struct, so a saved file always carries its own explicit values.
        let defaults = MonitorSettings::default();
        assert!(defaults.enabled);
        assert_eq!(defaults.away_threshold_minutes, 10);
        assert!(defaults.agent_override_enabled);

        let parsed: MonitorSettings =
            serde_json::from_str(r#"{"enabled": false}"#).expect("partial settings parse");
        assert!(!parsed.enabled);
        assert_eq!(parsed.away_threshold_minutes, 10);
    }

    #[test]
    fn settings_validation_enforces_the_quiet_time_bounds() {
        assert!(settings().validate().is_ok());

        let mut bad = settings();
        bad.away_threshold_minutes = 0;
        assert!(bad.validate().is_err());

        let mut bad = settings();
        bad.away_threshold_minutes = 721;
        assert!(bad.validate().is_err());
    }

    #[test]
    fn a_patch_changes_only_the_fields_it_sets() {
        let patched = settings().patched(&SettingsPatch {
            away_threshold_minutes: Some(15),
            ..SettingsPatch::default()
        });
        assert_eq!(patched.away_threshold_minutes, 15);
        assert!(patched.agent_override_enabled);
        assert!(patched.enabled);
        assert_eq!(patched.device_id, "device-1");
    }

    #[test]
    fn load_settings_mints_and_persists_a_device_id_once() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-monitor-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");

        let first = load_settings(&path);
        assert!(!first.device_id.is_empty());
        assert!(first.enabled, "monitoring defaults to on");

        let second = load_settings(&path);
        assert_eq!(first.device_id, second.device_id, "the id is stable");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn segment_records_serialize_in_the_server_shape() {
        let record = SegmentRecord::from_segment(
            &Segment {
                kind: SegmentKind::Active,
                process_name: Some("code.exe".to_string()),
                started_at: 1_704_067_200,
                ended_at: 1_704_067_260,
            },
            "device-1",
        );
        let json = serde_json::to_value(&record).expect("record serializes");
        assert_eq!(json["deviceId"], "device-1");
        assert_eq!(json["kind"], "active");
        assert_eq!(json["processName"], "code.exe");
        assert_eq!(json["startedAt"], "2024-01-01T00:00:00Z");
        assert_eq!(json["endedAt"], "2024-01-01T00:01:00Z");
        uuid::Uuid::parse_str(json["clientId"].as_str().expect("client id"))
            .expect("client id is a uuid");

        // No process name: the key is omitted, not null.
        let without = SegmentRecord::from_segment(
            &segment(SegmentKind::Idle, 1_704_067_200, 1_704_067_260),
            "device-1",
        );
        let json = serde_json::to_value(&without).expect("record serializes");
        assert!(json.get("processName").is_none());
        // And it round-trips through the spool's line reader.
        let line = serde_json::to_vec(&without).expect("record serializes");
        let parsed: SegmentRecord = serde_json::from_slice(&line).expect("record parses");
        assert_eq!(parsed, without);
    }

    #[test]
    fn hook_detection_matches_the_binary_name_in_config_files() {
        let dir = std::env::temp_dir().join(format!("clock-in-hook-detect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        let registered = dir.join("settings.json");
        let plain = dir.join("config.toml");
        std::fs::write(&registered, r#"{"hooks": ["C:/bin/clock-in-hook.exe"]}"#)
            .expect("config writes");
        std::fs::write(&plain, "model = \"default\"").expect("config writes");

        let probes = vec![
            HookProbe {
                source: "claude_code",
                config_path: registered,
            },
            HookProbe {
                source: "codex",
                config_path: plain,
            },
            HookProbe {
                source: "kimi_code",
                config_path: dir.join("missing.toml"),
            },
        ];
        let hooks = detect_hooks(&probes);
        assert_eq!(
            hooks.iter().map(|hook| hook.detected).collect::<Vec<_>>(),
            vec![true, false, false]
        );
        assert_eq!(hooks[0].source, "claude_code");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_stopped_monitor_reports_no_recording_and_no_open_session() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-monitor-idle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let client = ApiClient::new(
            "http://127.0.0.1:9/auth".to_string(),
            "http://127.0.0.1:9".to_string(),
        )
        .expect("client builds");
        let monitor = Monitor::new(MonitorConfig {
            client,
            settings_path: dir.join("settings.json"),
            segments_path: dir.join("segments-spool.jsonl"),
            agent_path: dir.join("agent-spool.jsonl"),
            sessions_path: dir.join("sessions-spool.jsonl"),
            recovery_path: dir.join("recovery.json"),
            recovery: Arc::new(tokio::sync::Mutex::new(RecoveryState::default())),
        });

        assert!(!monitor.is_running().await);
        assert!(monitor.is_enabled(), "recording defaults to on");

        let status = monitor.status().await;
        assert!(status.enabled);
        assert!(!status.running);
        assert!(status.current_session.is_none());
        assert!(status.agent_active.is_none());
        assert!(status.selected_project_id.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_spools_are_scoped_to_the_recording_account() {
        let base = PathBuf::from("sessions-spool.jsonl");
        assert_ne!(
            scoped_sessions_path(&base, "u1"),
            scoped_sessions_path(&base, "u2")
        );
        assert_eq!(
            scoped_sessions_path(&base, "u1")
                .file_name()
                .and_then(|name| name.to_str()),
            Some("sessions-spool-u1.jsonl"),
        );
    }

    #[test]
    fn changing_accounts_clears_the_previous_project_override() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-monitor-account-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let client = ApiClient::new(
            "http://127.0.0.1:9/auth".to_string(),
            "http://127.0.0.1:9".to_string(),
        )
        .expect("client builds");
        let monitor = Monitor::new(MonitorConfig {
            client,
            settings_path: dir.join("settings.json"),
            segments_path: dir.join("segments-spool.jsonl"),
            agent_path: dir.join("agent-spool.jsonl"),
            sessions_path: dir.join("sessions-spool.jsonl"),
            recovery_path: dir.join("recovery.json"),
            recovery: Arc::new(tokio::sync::Mutex::new(RecoveryState::default())),
        });

        monitor.begin_account("u1");
        monitor.set_default_project(Some("p-default-u1".to_string()));
        monitor.select_project(Some("p-selected-u1".to_string()));
        monitor.begin_account("u2");

        let state = lock(&monitor.shared);
        assert_eq!(state.account_id.as_deref(), Some("u2"));
        assert!(state.selected_project.is_none());
        assert!(state.default_project.is_none());
        assert!(state.mappings.is_empty());
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn status_reports_the_agent_session_holding_recording_open() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-monitor-agent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let client = ApiClient::new(
            "http://127.0.0.1:9/auth".to_string(),
            "http://127.0.0.1:9".to_string(),
        )
        .expect("client builds");
        let monitor = Monitor::new(MonitorConfig {
            client,
            settings_path: dir.join("settings.json"),
            segments_path: dir.join("segments-spool.jsonl"),
            agent_path: dir.join("agent-spool.jsonl"),
            sessions_path: dir.join("sessions-spool.jsonl"),
            recovery_path: dir.join("recovery.json"),
            recovery: Arc::new(tokio::sync::Mutex::new(RecoveryState::default())),
        });

        let now = unix_now();
        let mut tracking = AgentTracking::default();
        tracking.active.insert(
            ("kimi_code".to_string(), "s1".to_string()),
            ActiveAgent {
                source: "kimi_code".to_string(),
                external_session_id: "s1".to_string(),
                started_at: now - 600,
                last_event_at: now,
                project: None,
            },
        );
        lock(&monitor.shared).agent = tracking;

        let status = monitor.status().await;
        let active = status
            .agent_active
            .as_ref()
            .expect("the agent session is active");
        assert_eq!(active.source, "kimi_code");
        assert_eq!(active.since, iso8601(now - 600));
        // The payload uses the camelCase keys the bridge decodes.
        let json = serde_json::to_value(&status).expect("status serializes");
        assert_eq!(json["agentActive"]["source"], "kimi_code");

        // The override setting gates the indicator just like the override itself.
        lock(&monitor.shared).settings.agent_override_enabled = false;
        assert!(monitor.status().await.agent_active.is_none());

        lock(&monitor.shared).settings.agent_override_enabled = true;
        lock(&monitor.shared).agent.active.clear();
        assert!(
            monitor.status().await.agent_active.is_none(),
            "an ended session is over"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_registration_merges_without_clobbering_and_backs_up_once() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-hook-register-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        let config = dir.join("settings.json");
        let original = r#"{"model":"opus","hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"echo hi"}]}]}}"#;
        std::fs::write(&config, original).expect("config writes");

        let result = register_claude_code(&config, "\"C:/bin/clock-in-hook.exe\"")
            .expect("registration succeeds");
        assert!(
            matches!(result, HookRegisterResult::Registered { .. }),
            "first registration reports Registered"
        );

        let merged: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).expect("config reads"))
                .expect("merged config parses");
        assert_eq!(merged["model"], "opus", "existing keys survive");
        let starts = merged["hooks"]["SessionStart"]
            .as_array()
            .expect("SessionStart is an array");
        assert_eq!(starts.len(), 2, "the existing entry is kept, ours appended");
        assert_eq!(
            starts[1]["hooks"][0]["command"],
            "\"C:/bin/clock-in-hook.exe\""
        );
        assert_eq!(
            merged["hooks"]["SessionEnd"].as_array().map(Vec::len),
            Some(1),
            "SessionEnd gets the same entry"
        );

        // The untouched original was backed up beside the file.
        let backup = dir.join("settings.json.bak");
        assert_eq!(
            std::fs::read_to_string(&backup).expect("backup reads"),
            original
        );

        // A second run detects the hook and changes nothing, backup included.
        let before = std::fs::read_to_string(&config).expect("config reads");
        let result = register_claude_code(&config, "\"C:/bin/clock-in-hook.exe\"")
            .expect("re-registration succeeds");
        assert!(
            matches!(result, HookRegisterResult::AlreadyRegistered { .. }),
            "the hook is already there"
        );
        assert_eq!(
            std::fs::read_to_string(&config).expect("config reads"),
            before
        );
        assert_eq!(
            std::fs::read_to_string(&backup).expect("backup reads"),
            original,
            "the pristine backup is not overwritten"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_registration_starts_from_a_missing_file() {
        let dir = std::env::temp_dir().join(format!("clock-in-hook-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let config = dir.join("nested").join("settings.json");

        let result = register_claude_code(&config, "\"C:/bin/clock-in-hook.exe\"")
            .expect("registration succeeds");
        assert!(matches!(result, HookRegisterResult::Registered { .. }));

        let created: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).expect("config reads"))
                .expect("created config parses");
        for event in CLAUDE_HOOK_EVENTS {
            assert_eq!(created["hooks"][event][0]["hooks"][0]["type"], "command");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_registration_refuses_to_clobber_an_unparseable_file() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-hook-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        let config = dir.join("settings.json");
        std::fs::write(&config, "not json at all").expect("config writes");

        let error = register_claude_code(&config, "\"C:/bin/clock-in-hook.exe\"")
            .expect_err("an unparseable file fails loudly");
        assert_eq!(error.kind, ErrorKind::Unknown);
        assert_eq!(
            std::fs::read_to_string(&config).expect("config reads"),
            "not json at all",
            "the file is untouched"
        );
        assert!(
            !dir.join("settings.json.bak").exists(),
            "no write, no backup"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_registration_merges_without_clobbering_and_backs_up_once() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-cursor-register-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        let config = dir.join("hooks.json");
        let original = r#"{"version":1,"hooks":{"sessionStart":[{"command":"echo hi"}]}}"#;
        std::fs::write(&config, original).expect("config writes");

        let result = register_cursor(&config, "\"C:/bin/clock-in-hook.exe\"")
            .expect("registration succeeds");
        assert!(
            matches!(result, HookRegisterResult::Registered { .. }),
            "first registration reports Registered"
        );

        let merged: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).expect("config reads"))
                .expect("merged config parses");
        assert_eq!(merged["version"], 1, "the schema version survives");
        let starts = merged["hooks"]["sessionStart"]
            .as_array()
            .expect("sessionStart is an array");
        assert_eq!(starts.len(), 2, "the existing entry is kept, ours appended");
        assert_eq!(
            starts[1]["command"],
            "\"C:/bin/clock-in-hook.exe\" --source cursor --event session-start"
        );
        assert_eq!(
            merged["hooks"]["sessionEnd"][0]["command"],
            "\"C:/bin/clock-in-hook.exe\" --source cursor --event session-end"
        );

        // The untouched original was backed up beside the file.
        let backup = dir.join("hooks.json.bak");
        assert_eq!(
            std::fs::read_to_string(&backup).expect("backup reads"),
            original
        );

        // A second run detects the hook and changes nothing, backup included.
        let before = std::fs::read_to_string(&config).expect("config reads");
        let result = register_cursor(&config, "\"C:/bin/clock-in-hook.exe\"")
            .expect("re-registration succeeds");
        assert!(
            matches!(result, HookRegisterResult::AlreadyRegistered { .. }),
            "the hook is already there"
        );
        assert_eq!(
            std::fs::read_to_string(&config).expect("config reads"),
            before
        );
        assert_eq!(
            std::fs::read_to_string(&backup).expect("backup reads"),
            original,
            "the pristine backup is not overwritten"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_registration_starts_from_a_missing_file() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-cursor-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let config = dir.join("nested").join("hooks.json");

        let result = register_cursor(&config, "\"C:/bin/clock-in-hook.exe\"")
            .expect("registration succeeds");
        assert!(matches!(result, HookRegisterResult::Registered { .. }));

        let created: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).expect("config reads"))
                .expect("created config parses");
        assert_eq!(created["version"], 1, "the schema version is written");
        for (key, event) in CURSOR_HOOKS {
            assert_eq!(
                created["hooks"][key][0]["command"],
                format!("\"C:/bin/clock-in-hook.exe\" --source cursor --event {event}")
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_registration_refuses_to_clobber_an_unparseable_file() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-cursor-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        let config = dir.join("hooks.json");
        std::fs::write(&config, "not json at all").expect("config writes");

        let error = register_cursor(&config, "\"C:/bin/clock-in-hook.exe\"")
            .expect_err("an unparseable file fails loudly");
        assert_eq!(error.kind, ErrorKind::Unknown);
        assert_eq!(
            std::fs::read_to_string(&config).expect("config reads"),
            "not json at all",
            "the file is untouched"
        );
        assert!(!dir.join("hooks.json.bak").exists(), "no write, no backup");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_registration_refuses_an_unknown_schema_version() {
        let dir =
            std::env::temp_dir().join(format!("clock-in-cursor-version-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        let config = dir.join("hooks.json");
        let original = r#"{"version":2,"hooks":{}}"#;
        std::fs::write(&config, original).expect("config writes");

        let error = register_cursor(&config, "\"C:/bin/clock-in-hook.exe\"")
            .expect_err("an unknown schema version fails loudly");
        assert_eq!(error.kind, ErrorKind::Unknown);
        assert_eq!(
            std::fs::read_to_string(&config).expect("config reads"),
            original,
            "the file is untouched"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_sources_are_rejected_and_toml_clis_get_a_pasteable_snippet() {
        let error = register_hook("bogus").expect_err("an unknown source is rejected");
        assert_eq!(error.kind, ErrorKind::Validation);

        let codex = manual_snippet("codex", "\"C:/bin/clock-in-hook.exe\"");
        assert!(codex.contains("notify = [\"C:/bin/clock-in-hook.exe\""));
        let kimi = manual_snippet("kimi_code", "\"C:/bin/clock-in-hook.exe\"");
        assert!(kimi.contains("--source kimi-code"));
    }

    #[test]
    fn hook_results_serialize_in_the_shape_the_bridge_decodes() {
        let registered = serde_json::to_value(HookRegisterResult::Registered {
            config_path: "C:/Users/dev/.claude/settings.json".to_string(),
        })
        .expect("result serializes");
        assert_eq!(registered["status"], "registered");
        assert_eq!(
            registered["configPath"],
            "C:/Users/dev/.claude/settings.json"
        );

        let already = serde_json::to_value(HookRegisterResult::AlreadyRegistered {
            config_path: "C:/Users/dev/.claude/settings.json".to_string(),
        })
        .expect("result serializes");
        assert_eq!(already["status"], "already-registered");

        let manual = serde_json::to_value(HookRegisterResult::Manual {
            config_path: "C:/Users/dev/.codex/config.toml".to_string(),
            snippet: "notify = [...]".to_string(),
        })
        .expect("result serializes");
        assert_eq!(manual["status"], "manual");
        assert_eq!(manual["configPath"], "C:/Users/dev/.codex/config.toml");
        assert_eq!(manual["snippet"], "notify = [...]");
    }
}
