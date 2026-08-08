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
//! Monitoring is off by default and gated behind `MonitorSettings.enabled`;
//! disabling it aborts both tasks, so a paused monitor records nothing.
//!
//! Tradeoff, documented: the event thread uses a real hidden top-level window
//! rather than a message-only one because Windows does not broadcast
//! `WM_POWERBROADCAST` to message-only windows. Session unlock and
//! resume-from-suspend deliberately raise no event — the next poll's
//! Active/Idle signal closes the span, which is the same code path a
//! transition would take.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::api::{ApiClient, ApiResult, BridgeError, ErrorKind, PathMapping};
use crate::recovery::{PendingStop, RecoveryState};
use crate::spool;

/// How often the OS is polled. Coarser than this and short active bursts blur
/// into idle; finer buys nothing the server schema can store.
pub const POLL_INTERVAL_SECONDS: u64 = 30;

/// A poll reads "idle" once the last input is at least this old — one poll
/// interval, so a single quiet moment between ticks still reads as active.
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

    /// Everything recorded so far, with the open span closed at `now`.
    /// Read-only: the builder keeps folding afterwards.
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
    /// Master switch. Off by default, and off means no polling at all.
    pub enabled: bool,
    pub away_threshold_minutes: u32,
    pub hard_away_limit_minutes: u32,
    pub auto_stop_on_lock: bool,
    /// Suppress away auto-stop and idle accrual while an agent session is
    /// active — an overnight agent run on a locked machine is legitimate work.
    pub agent_override_enabled: bool,
    /// Stable per-install device id stamped on every segment; generated once.
    pub device_id: String,
}

impl Default for MonitorSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            away_threshold_minutes: 10,
            hard_away_limit_minutes: 60,
            auto_stop_on_lock: false,
            agent_override_enabled: true,
            device_id: String::new(),
        }
    }
}

impl MonitorSettings {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.away_threshold_minutes == 0 || self.away_threshold_minutes > 720 {
            return Err("The away threshold must be between 1 and 720 minutes.");
        }
        if self.hard_away_limit_minutes == 0 || self.hard_away_limit_minutes > 1_440 {
            return Err("The hard away limit must be between 1 and 1440 minutes.");
        }
        if self.away_threshold_minutes >= self.hard_away_limit_minutes {
            return Err("The away threshold must be shorter than the hard away limit.");
        }
        Ok(())
    }

    pub fn policy(&self) -> Policy {
        Policy {
            away_threshold_seconds: u64::from(self.away_threshold_minutes) * 60,
            hard_away_limit_seconds: u64::from(self.hard_away_limit_minutes) * 60,
            auto_stop_on_lock: self.auto_stop_on_lock,
        }
    }

    pub fn patched(&self, patch: &SettingsPatch) -> Self {
        Self {
            enabled: patch.enabled.unwrap_or(self.enabled),
            away_threshold_minutes: patch
                .away_threshold_minutes
                .unwrap_or(self.away_threshold_minutes),
            hard_away_limit_minutes: patch
                .hard_away_limit_minutes
                .unwrap_or(self.hard_away_limit_minutes),
            auto_stop_on_lock: patch.auto_stop_on_lock.unwrap_or(self.auto_stop_on_lock),
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
    pub hard_away_limit_minutes: Option<u32>,
    pub auto_stop_on_lock: Option<bool>,
    pub agent_override_enabled: Option<bool>,
}

/// The policy inputs the pure decision functions take, already in seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub away_threshold_seconds: u64,
    pub hard_away_limit_seconds: u64,
    pub auto_stop_on_lock: bool,
}

/// Idle/locked/suspended seconds overlapping `[from, to]`, clamped to the
/// elapsed span — this is the `idleSeconds` the stop flow submits. While the
/// agent-active override holds, idle accrual is paused and this returns 0.
pub fn measured_idle_seconds(segments: &[Segment], from: u64, to: u64, agent_active: bool) -> u32 {
    if agent_active || to <= from {
        return 0;
    }
    let idle: u64 = segments
        .iter()
        .filter(|segment| segment.kind != SegmentKind::Active)
        .map(|segment| {
            let start = segment.started_at.max(from);
            let end = segment.ended_at.min(to);
            end.saturating_sub(start)
        })
        .sum();
    idle.min(to - from).min(u64::from(u32::MAX)) as u32
}

/// A run of consecutive non-active time, in seconds, for the away prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AwaySpan {
    pub started_at: u64,
    pub seconds: u64,
    /// Still open at `now`: the user is away right now.
    pub ongoing: bool,
}

/// Contiguous idle/locked/suspended runs overlapping `[from, to]`, merged so
/// an idle span that becomes a lock reads as one away period. Times clamped
/// into the window.
fn away_runs(segments: &[Segment], from: u64, to: u64) -> Vec<(u64, u64)> {
    let mut runs: Vec<(u64, u64)> = Vec::new();
    for segment in segments {
        if segment.kind == SegmentKind::Active {
            continue;
        }
        let start = segment.started_at.max(from);
        let end = segment.ended_at.min(to);
        if end <= start {
            continue;
        }
        match runs.last_mut() {
            Some(last) if last.1 >= start => last.1 = last.1.max(end),
            _ => runs.push((start, end)),
        }
    }
    runs
}

/// The most recent away run longer than the threshold, if any — what the UI
/// prompts about on return ("you were away N minutes — discard or keep?").
pub fn latest_away_span(
    segments: &[Segment],
    from: u64,
    now: u64,
    threshold_seconds: u64,
) -> Option<AwaySpan> {
    let (start, end) = away_runs(segments, from, now).into_iter().next_back()?;
    let seconds = end - start;
    if seconds < threshold_seconds {
        return None;
    }
    Some(AwaySpan {
        started_at: start,
        seconds,
        ongoing: end == now,
    })
}

/// Start of the away run that is still open at `now`, if the user is away.
fn current_away_since(segments: &[Segment], from: u64, now: u64) -> Option<u64> {
    let (start, end) = away_runs(segments, from, now).into_iter().next_back()?;
    (end == now).then_some(start)
}

/// Whether the timer should auto-stop, and at what timestamp. Always stops at
/// the last-active boundary (the away run's start), never at "now", so the
/// recorded session excludes the unattended tail. The agent-active override
/// suppresses every automatic stop.
pub fn decide_auto_stop(
    now: u64,
    away_since: Option<u64>,
    locked_since: Option<u64>,
    policy: &Policy,
    agent_active: bool,
) -> Option<u64> {
    if agent_active {
        return None;
    }
    if policy.auto_stop_on_lock {
        if let Some(since) = locked_since {
            return Some(since.min(now));
        }
    }
    let away = away_since?;
    if now.saturating_sub(away) >= policy.hard_away_limit_seconds {
        Some(away)
    } else {
        None
    }
}

/// What the drain side reports about agent activity. In-memory only: after a
/// restart the override simply stays off until the next agent event drains,
/// which fails toward the manual-timer behavior Phase 1 already had.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentTracking {
    pub open: bool,
    pub last_event_at: u64,
    /// The session behind `open`: which CLI and when it began. Cleared with
    /// `open`; drives the `agentActive` status field.
    pub active: Option<ActiveAgent>,
    pub suggestion: Option<PendingSuggestion>,
}

/// The agent session currently holding the tracking open, in unix seconds.
/// The ISO form the UI sees is produced at status time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveAgent {
    pub source: String,
    pub started_at: u64,
}

impl AgentTracking {
    pub fn is_active(&self, now: u64, override_enabled: bool) -> bool {
        override_enabled
            && self.open
            && now.saturating_sub(self.last_event_at) <= AGENT_ACTIVE_WINDOW_SECONDS
    }
}

/// "An agent started in a mapped directory while no timer runs" — the one
/// prompt the monitor raises locally; the server stays authoritative.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSuggestion {
    pub project_id: String,
    pub source: String,
    pub since: String,
}

/// The state the poll task, the upload task, and the Tauri commands share.
pub struct MonitorShared {
    pub builder: SegmentBuilder,
    pub settings: MonitorSettings,
    /// Local cache of the user's path mappings, refreshed on each upload run.
    pub mappings: Vec<PathMapping>,
    pub agent: AgentTracking,
    pub last_upload_at: Option<String>,
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

/// The away data the UI prompts with, carried by `monitor_status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwayInfo {
    pub started_at: String,
    pub seconds: u64,
    pub ongoing: bool,
    pub exceeds_hard_limit: bool,
}

/// The agent session currently holding the away override open, surfaced so
/// the UI can explain why idle trimming is paused.
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
    pub hooks: Vec<HookRegistration>,
    pub pending_suggestion: Option<PendingSuggestion>,
    /// The agent session holding the away override open, if any — explains to
    /// the user why `session_idle_seconds` is frozen.
    pub agent_active: Option<AgentActive>,
    /// Idle trimmed from the running session so far, when a timer runs.
    pub session_idle_seconds: Option<u32>,
    pub away: Option<AwayInfo>,
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
    pub recovery: Arc<tokio::sync::Mutex<RecoveryState>>,
    pub recovery_path: PathBuf,
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
    client: ApiClient,
    recovery: Arc<tokio::sync::Mutex<RecoveryState>>,
    // Read only by the Windows-gated poll/auto-stop path today.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    recovery_path: PathBuf,
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
            })),
            events: Arc::new(PlatformEvents::new()),
            settings_path: config.settings_path,
            segments_path: config.segments_path,
            agent_path: config.agent_path,
            client: config.client,
            recovery: config.recovery,
            recovery_path: config.recovery_path,
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
                Arc::clone(&self.recovery),
                self.recovery_path.clone(),
                Arc::clone(&self.upload_now),
            )))
        };
        #[cfg(not(windows))]
        let poll: Option<tokio::task::JoinHandle<()>> = None;

        let upload = tokio::spawn(crate::uploader::upload_loop(
            Arc::clone(&self.shared),
            self.client.clone(),
            self.segments_path.clone(),
            self.agent_path.clone(),
            Arc::clone(&self.recovery),
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
        let (closed, device_id) = {
            let mut shared = lock(&self.shared);
            let device_id = shared.settings.device_id.clone();
            (shared.builder.flush(unix_now()), device_id)
        };
        if let Some(segment) = closed {
            append_segment_line(&self.segments_path, &segment, &device_id);
        }
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

    pub fn clear_suggestion(&self) {
        lock(&self.shared).agent.suggestion = None;
    }

    pub fn cache_mappings(&self, mappings: Vec<PathMapping>) {
        lock(&self.shared).mappings = mappings;
    }

    /// Asks the upload task to run now instead of at the next 5-minute tick
    /// (timer stop, an auto-stop enqueue). Coalesces with a run in flight.
    pub fn request_upload(&self) {
        self.upload_now.notify_one();
    }

    /// The measured `idleSeconds` for a stop, when monitoring was watching
    /// this session. Returns `None` when the monitor is off, the session is
    /// not the one we recorded as running, or the clock data is unusable —
    /// the caller then keeps whatever the UI sent.
    pub async fn measured_idle_for_stop(&self, session_id: &str, stopped_at: u64) -> Option<u32> {
        if !self.is_running().await {
            return None;
        }
        let running = self.recovery.lock().await.running.clone()?;
        if running.session_id != session_id {
            return None;
        }
        let started = parse_iso8601(&running.started_at)?;
        let shared = lock(&self.shared);
        let segments = shared.builder.snapshot(stopped_at);
        let agent_active = shared
            .agent
            .is_active(stopped_at, shared.settings.agent_override_enabled);
        Some(measured_idle_seconds(
            &segments,
            started,
            stopped_at,
            agent_active,
        ))
    }

    pub async fn status(&self) -> MonitorStatus {
        let running = self.is_running().await;
        let timer_started = {
            let recovery = self.recovery.lock().await;
            recovery
                .running
                .as_ref()
                .and_then(|timer| parse_iso8601(&timer.started_at))
        };
        let now = unix_now();
        let shared = lock(&self.shared);
        let policy = shared.settings.policy();
        let agent_active = if shared
            .agent
            .is_active(now, shared.settings.agent_override_enabled)
        {
            shared.agent.active.as_ref().map(|active| AgentActive {
                source: active.source.clone(),
                since: iso8601(active.started_at),
            })
        } else {
            None
        };

        let (session_idle_seconds, away) = match timer_started {
            Some(started) => {
                let segments = shared.builder.snapshot(now);
                let agent_active = shared
                    .agent
                    .is_active(now, shared.settings.agent_override_enabled);
                let idle = measured_idle_seconds(&segments, started, now, agent_active);
                let away = latest_away_span(&segments, started, now, policy.away_threshold_seconds)
                    .map(|span| AwayInfo {
                        started_at: iso8601(span.started_at),
                        seconds: span.seconds,
                        ongoing: span.ongoing,
                        exceeds_hard_limit: span.seconds >= policy.hard_away_limit_seconds,
                    });
                (Some(idle), away)
            }
            None => (None, None),
        };

        MonitorStatus {
            enabled: shared.settings.enabled,
            running,
            last_upload_at: shared.last_upload_at.clone(),
            segment_backlog: count_lines(&self.segments_path),
            agent_backlog: count_lines(&self.agent_path),
            hooks: detect_hooks(&default_hook_probes()),
            pending_suggestion: shared.agent.suggestion.clone(),
            agent_active,
            session_idle_seconds,
            away,
        }
    }
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
    recovery: Arc<tokio::sync::Mutex<RecoveryState>>,
    recovery_path: PathBuf,
    upload_now: Arc<Notify>,
) {
    let source = platform::Poller::new();
    let mut tick = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECONDS));
    // A slept machine replays missed ticks one at a time, not in a burst.
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let now = unix_now();
        let pushed = events.drain();

        let mut closed = Vec::new();
        let device_id = {
            let mut shared = lock(&shared);
            // Event timestamps come from when the OS broadcast fired, which
            // can be long ago (a suspend/resume pair spanning the night).
            for (at, signal) in pushed {
                closed.extend(shared.builder.apply(at, &signal));
            }
            let signal = source.poll();
            closed.extend(shared.builder.apply(now, &signal));
            shared.settings.device_id.clone()
        };
        for segment in &closed {
            append_segment_line(&segments_path, segment, &device_id);
        }

        enforce_auto_stop(&shared, &recovery, &recovery_path, &upload_now, now).await;
    }
}

/// Auto-stops the running timer when the away policy says to. The stop queues
/// through the same pending-sync machinery a manual offline stop uses:
/// recorded locally first, uploaded when a connection allows, and surfaced to
/// the UI as a pending sync at next launch.
async fn enforce_auto_stop(
    shared: &Arc<Mutex<MonitorShared>>,
    recovery: &Arc<tokio::sync::Mutex<RecoveryState>>,
    recovery_path: &Path,
    upload_now: &Arc<Notify>,
    now: u64,
) {
    let running = recovery.lock().await.running.clone();
    let Some(running) = running else {
        return;
    };
    let Some(timer_started) = parse_iso8601(&running.started_at) else {
        return;
    };

    let decision = {
        let shared = lock(shared);
        let settings = &shared.settings;
        let policy = settings.policy();
        let segments = shared.builder.snapshot(now);
        let locked_since = match shared.builder.open_span() {
            Some((SegmentKind::Locked, started)) => Some(started),
            _ => None,
        };
        let agent_active = shared.agent.is_active(now, settings.agent_override_enabled);
        decide_auto_stop(
            now,
            current_away_since(&segments, timer_started, now),
            locked_since,
            &policy,
            agent_active,
        )
        .map(|stop_at| {
            (
                stop_at,
                measured_idle_seconds(&segments, timer_started, stop_at, agent_active),
            )
        })
    };
    let Some((stop_at, idle_seconds)) = decision else {
        return;
    };

    let mut state = recovery.lock().await;
    // The timer may have stopped between the decision and this lock.
    let Some(still_running) = state.running.clone() else {
        return;
    };
    if still_running.session_id != running.session_id {
        return;
    }
    let stop = PendingStop {
        session_id: running.session_id.clone(),
        stopped_at: iso8601(stop_at),
        idle_seconds,
    };
    if state.enqueue_stop(stop).is_err() {
        eprintln!("clock-in: could not queue an automatic stop; the queue is full");
        return;
    }
    if crate::write_recovery_file(recovery_path, &state).is_ok() {
        upload_now.notify_one();
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

    #[test]
    fn measured_idle_sums_non_active_overlap_and_clamps_to_elapsed() {
        let segments = vec![
            segment(SegmentKind::Active, 1_000, 1_200),
            segment(SegmentKind::Idle, 1_200, 1_500),
            segment(SegmentKind::Active, 1_500, 1_600),
            segment(SegmentKind::Locked, 1_600, 2_000),
        ];

        // Timer 1000..2000: idle 300 + locked 400.
        assert_eq!(measured_idle_seconds(&segments, 1_000, 2_000, false), 700);
        // Timer starts mid-idle: only the overlapping tail counts.
        assert_eq!(measured_idle_seconds(&segments, 1_300, 2_000, false), 600);
        // Stop before the locked span ends: clamped to the stop time.
        assert_eq!(measured_idle_seconds(&segments, 1_000, 1_800, false), 500);
        // The agent-active override pauses idle accrual entirely.
        assert_eq!(measured_idle_seconds(&segments, 1_000, 2_000, true), 0);
        // A zero-length window measures zero, not a panic.
        assert_eq!(measured_idle_seconds(&segments, 2_000, 1_000, false), 0);
    }

    #[test]
    fn away_runs_merge_contiguous_idle_lock_and_suspend() {
        let segments = vec![
            segment(SegmentKind::Active, 1_000, 1_200),
            segment(SegmentKind::Idle, 1_200, 1_500),
            segment(SegmentKind::Locked, 1_500, 1_800),
            segment(SegmentKind::Active, 1_800, 1_900),
            segment(SegmentKind::Suspended, 1_900, 2_500),
        ];
        assert_eq!(
            away_runs(&segments, 1_000, 2_500),
            vec![(1_200, 1_800), (1_900, 2_500)]
        );
    }

    #[test]
    fn the_latest_away_span_respects_the_threshold_and_marks_ongoing() {
        let segments = vec![
            segment(SegmentKind::Idle, 1_000, 1_300),
            segment(SegmentKind::Active, 1_300, 1_400),
            segment(SegmentKind::Idle, 1_400, 2_000),
        ];

        // 900s and 600s runs; a 10-minute threshold matches neither.
        assert_eq!(latest_away_span(&segments, 1_000, 2_000, 601), None);
        // At exactly 600s the ongoing run qualifies.
        let span = latest_away_span(&segments, 1_000, 2_000, 600).expect("span qualifies");
        assert_eq!(span.started_at, 1_400);
        assert_eq!(span.seconds, 600);
        assert!(span.ongoing);
        // Once activity resumes, the same run is no longer ongoing.
        let span = latest_away_span(&segments, 1_000, 2_100, 600).expect("span still qualifies");
        assert!(!span.ongoing);
    }

    #[test]
    fn auto_stop_fires_at_the_last_active_boundary_past_the_hard_limit() {
        let policy = Policy {
            away_threshold_seconds: 600,
            hard_away_limit_seconds: 3_600,
            auto_stop_on_lock: false,
        };

        assert_eq!(
            decide_auto_stop(4_599, Some(1_000), None, &policy, false),
            None
        );
        assert_eq!(
            decide_auto_stop(4_600, Some(1_000), None, &policy, false),
            Some(1_000)
        );
        // The agent-active override suppresses the stop no matter how long.
        assert_eq!(
            decide_auto_stop(99_000, Some(1_000), None, &policy, true),
            None
        );
        // Nobody is away: nothing to stop.
        assert_eq!(decide_auto_stop(9_000, None, None, &policy, false), None);
    }

    #[test]
    fn auto_stop_on_lock_only_fires_when_the_setting_is_on() {
        let off = Policy {
            away_threshold_seconds: 600,
            hard_away_limit_seconds: 3_600,
            auto_stop_on_lock: false,
        };
        let on = Policy {
            auto_stop_on_lock: true,
            ..off
        };

        assert_eq!(
            decide_auto_stop(2_000, Some(1_900), Some(1_900), &off, false),
            None
        );
        assert_eq!(
            decide_auto_stop(2_000, Some(1_900), Some(1_900), &on, false),
            Some(1_900)
        );
        // The override beats the lock setting too.
        assert_eq!(
            decide_auto_stop(2_000, Some(1_900), Some(1_900), &on, true),
            None
        );
    }

    #[test]
    fn agent_tracking_is_active_only_inside_the_staleness_window() {
        let tracking = AgentTracking {
            open: true,
            last_event_at: 10_000,
            active: None,
            suggestion: None,
        };
        assert!(tracking.is_active(10_000 + AGENT_ACTIVE_WINDOW_SECONDS, true));
        assert!(!tracking.is_active(10_001 + AGENT_ACTIVE_WINDOW_SECONDS, true));
        assert!(!tracking.is_active(10_000, false), "the setting gates it");
        let closed = AgentTracking {
            open: false,
            ..tracking.clone()
        };
        assert!(!closed.is_active(10_000, true), "an ended session is over");
    }

    #[test]
    fn settings_default_to_off_and_survive_partial_files() {
        let defaults = MonitorSettings::default();
        assert!(!defaults.enabled);
        assert_eq!(defaults.away_threshold_minutes, 10);
        assert_eq!(defaults.hard_away_limit_minutes, 60);
        assert!(!defaults.auto_stop_on_lock);
        assert!(defaults.agent_override_enabled);

        let parsed: MonitorSettings =
            serde_json::from_str(r#"{"enabled": true}"#).expect("partial settings parse");
        assert!(parsed.enabled);
        assert_eq!(parsed.away_threshold_minutes, 10);
    }

    #[test]
    fn settings_validation_enforces_bounds_and_ordering() {
        assert!(settings().validate().is_ok());

        let mut bad = settings();
        bad.away_threshold_minutes = 0;
        assert!(bad.validate().is_err());

        let mut bad = settings();
        bad.away_threshold_minutes = 60;
        bad.hard_away_limit_minutes = 60;
        assert!(bad.validate().is_err(), "threshold must be below the limit");

        let mut bad = settings();
        bad.hard_away_limit_minutes = 10_000;
        assert!(bad.validate().is_err());
    }

    #[test]
    fn a_patch_changes_only_the_fields_it_sets() {
        let patched = settings().patched(&SettingsPatch {
            away_threshold_minutes: Some(15),
            ..SettingsPatch::default()
        });
        assert_eq!(patched.away_threshold_minutes, 15);
        assert_eq!(patched.hard_away_limit_minutes, 60);
        assert!(!patched.enabled);
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
        assert!(!first.enabled, "monitoring defaults to off");

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
    async fn idle_measurement_is_none_while_the_monitor_is_stopped() {
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
            recovery: Arc::new(tokio::sync::Mutex::new(RecoveryState::default())),
            recovery_path: dir.join("recovery.json"),
        });

        assert!(!monitor.is_running().await);
        assert!(!monitor.is_enabled(), "monitoring defaults to off");
        assert_eq!(monitor.measured_idle_for_stop("s1", 1_000).await, None);

        let status = monitor.status().await;
        assert!(!status.enabled);
        assert!(!status.running);
        assert_eq!(status.session_idle_seconds, None);
        assert!(status.away.is_none());
        assert!(status.pending_suggestion.is_none());
        assert!(status.agent_active.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn status_reports_the_agent_session_behind_a_frozen_idle_trim() {
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
            recovery: Arc::new(tokio::sync::Mutex::new(RecoveryState::default())),
            recovery_path: dir.join("recovery.json"),
        });

        let now = unix_now();
        lock(&monitor.shared).agent = AgentTracking {
            open: true,
            last_event_at: now,
            active: Some(ActiveAgent {
                source: "kimi_code".to_string(),
                started_at: now - 600,
            }),
            suggestion: None,
        };

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
        lock(&monitor.shared).agent.open = false;
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
