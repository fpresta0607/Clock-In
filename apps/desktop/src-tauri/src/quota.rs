//! Coding-agent quota discovery.
//!
//! A session attributed to Claude Code, Codex, Cursor, Copilot, Grok, or Kimi
//! can say how much of that tool's plan is left. The evidence is already on the
//! machine — each CLI stores its own usage state — so this reads it locally and
//! never asks the API.
//!
//! **What a reading is bound to.** Each reading describes the account that is
//! *currently signed in to that provider on this machine* — the same credential
//! `quota-axi auth` reads — and not the account that happened to record some
//! past session. Nothing here is keyed by session or by time: every refresh
//! re-reads the live credential, so switching logins moves the dial at the next
//! refresh. `account` rides along so the UI can name whose plan it is showing.
//!
//! Two more rules shape the module. Quota is *advisory*: a missing tool, a
//! signed-out provider, or an unreadable file is an honest "unknown", never an
//! error the user has to dismiss. And it is *never on the critical path*: the
//! Tauri command hands back whatever the cache holds and refreshes behind the
//! UI, so a slow provider read cannot delay a timer or a session row.

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::spool::now_iso8601;

/// How long a reading counts as current. Plans move over minutes, not seconds,
/// and every refresh spawns a process — this is the honest middle.
pub const DEFAULT_TTL: Duration = Duration::from_secs(120);

/// A provider Clock-In can show a dial for, and the agent-session sources that
/// resolve to it. `sources` are the `source` values the hook contract and
/// `monitor_status` use, so the UI can look a dial up straight from a row's
/// attribution.
struct ProviderEntry {
    provider: &'static str,
    label: &'static str,
    sources: &'static [&'static str],
}

const PROVIDERS: [ProviderEntry; 6] = [
    ProviderEntry {
        provider: "claude",
        label: "Claude",
        sources: &["claude_code"],
    },
    ProviderEntry {
        provider: "codex",
        label: "Codex",
        sources: &["codex"],
    },
    ProviderEntry {
        provider: "cursor",
        label: "Cursor",
        sources: &["cursor"],
    },
    ProviderEntry {
        provider: "copilot",
        label: "GitHub Copilot",
        sources: &["copilot"],
    },
    ProviderEntry {
        provider: "grok",
        label: "Grok",
        sources: &["grok"],
    },
    ProviderEntry {
        provider: "kimi",
        label: "Kimi",
        sources: &["kimi_code"],
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuotaStatus {
    /// A percentage was read; the dial can draw an arc.
    Known,
    /// Nothing readable. The dial draws its unknown face and says why.
    Unknown,
}

/// The reading itself is fine, or every source failed and the whole feature is
/// dark. `Pending` is the very first call, before the first refresh lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotStatus {
    Pending,
    Ready,
    Unavailable,
}

/// One limit a provider reports — a rolling session window, a weekly window, or
/// a per-model bound. Providers report several at once and the smallest is what
/// actually binds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub percent_remaining: u8,
    pub resets_at: Option<String>,
}

/// Who is signed in to a provider on this machine right now. Read for display
/// only — it names whose plan the dial is showing and makes a login switch
/// visible. It is never uploaded; quota never leaves the device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaAccount {
    pub email: Option<String>,
    pub organization: Option<String>,
}

/// What the UI draws for one provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuota {
    pub provider: String,
    pub label: String,
    /// Agent-session sources this provider backs, so a row attributed to
    /// `claude_code` finds the `claude` dial without a second lookup table.
    pub sources: Vec<String>,
    pub status: QuotaStatus,
    /// The provider login this reading belongs to, when the provider names it.
    pub account: Option<QuotaAccount>,
    /// The subscription tier as the provider names it ("max", "pro", …).
    pub plan: Option<String>,
    /// Percent of the *binding* window left, which is the number on the dial.
    pub percent_remaining: Option<u8>,
    /// Which of `windows` is doing the binding.
    pub binding_window_id: Option<String>,
    pub windows: Vec<QuotaWindow>,
    /// Plain-language state for the user; set whenever the status is unknown.
    pub detail: Option<String>,
    /// The provider's own words for why it could not be read — a code like
    /// `sqlite3_unavailable` is useful in a tooltip and useless in a headline.
    pub reason: Option<String>,
    /// The reading came from a cache the provider itself already called stale.
    pub stale: bool,
}

impl AgentQuota {
    fn unknown(entry: &ProviderEntry, detail: &str) -> Self {
        Self {
            provider: entry.provider.to_string(),
            label: entry.label.to_string(),
            sources: entry.sources.iter().map(|s| (*s).to_string()).collect(),
            status: QuotaStatus::Unknown,
            account: None,
            plan: None,
            percent_remaining: None,
            binding_window_id: None,
            windows: Vec::new(),
            detail: Some(detail.to_string()),
            reason: None,
            stale: false,
        }
    }
}

/// The `quota_status` payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub status: SnapshotStatus,
    pub checked_at: Option<String>,
    /// Why the whole snapshot is unavailable, when it is.
    pub detail: Option<String>,
    pub providers: Vec<AgentQuota>,
}

impl QuotaSnapshot {
    /// The answer before the first refresh finishes: every provider unknown,
    /// and the UI says it is still looking rather than that nothing is there.
    fn pending() -> Self {
        Self {
            status: SnapshotStatus::Pending,
            checked_at: None,
            detail: None,
            providers: catalog(),
        }
    }
}

/// Every known provider, all unknown. Readings overwrite entries in place, so
/// the snapshot always carries the same providers in the same order whether or
/// not the tool behind them answered.
fn catalog() -> Vec<AgentQuota> {
    PROVIDERS
        .iter()
        .map(|entry| AgentQuota::unknown(entry, "No quota reported for this tool."))
        .collect()
}

/// One way of learning what a coding agent has left.
///
/// `QuotaAxiSource` shells out to `quota-axi`, which already reads every
/// provider's local evidence. Native per-CLI discovery lands here too: add a
/// source that answers for the providers it knows and leave the rest alone.
/// Sources are asked in order and the first *known* reading per provider wins,
/// so a precise native reader can sit in front of the general one.
pub trait QuotaSource: Send + Sync {
    /// Identifies the source in failure detail. Never shown on its own.
    fn id(&self) -> &'static str;

    /// Reads whatever this source can see. `Err` is a source-level failure
    /// (binary missing, output unparseable) — a provider that is simply signed
    /// out is an `Ok` reading with an unknown status.
    fn read(&self) -> Result<Vec<AgentQuota>, String>;
}

/// Reads local quota evidence through the `quota-axi` CLI.
pub struct QuotaAxiSource {
    candidates: Vec<PathBuf>,
}

impl QuotaAxiSource {
    pub fn new() -> Self {
        Self {
            candidates: default_candidates(),
        }
    }
}

impl Default for QuotaAxiSource {
    fn default() -> Self {
        Self::new()
    }
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "quota-axi.exe"
    } else {
        "quota-axi"
    }
}

/// Where to look for the binary: an explicit override, then whatever `PATH`
/// resolves, then the user-local install directory the tool ships to.
fn default_candidates() -> Vec<PathBuf> {
    if let Some(explicit) = std::env::var_os("CLOCK_IN_QUOTA_AXI").filter(|v| !v.is_empty()) {
        return vec![PathBuf::from(explicit)];
    }
    let mut candidates = vec![PathBuf::from(binary_name())];
    if let Some(home) = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
    {
        candidates.push(
            PathBuf::from(home)
                .join(".local")
                .join("bin")
                .join(binary_name()),
        );
    }
    candidates
}

impl QuotaSource for QuotaAxiSource {
    fn id(&self) -> &'static str {
        "quota-axi"
    }

    fn read(&self) -> Result<Vec<AgentQuota>, String> {
        let providers = PROVIDERS
            .iter()
            .map(|entry| entry.provider)
            .collect::<Vec<_>>()
            .join(",");
        let mut last_error = "quota-axi is not installed on this machine.".to_string();
        for candidate in &self.candidates {
            // `--full` is what carries the signed-in account beside the plan;
            // without it the dial could not say whose quota it is showing.
            // A non-zero exit still carries a usable report when only some
            // providers failed, so the output is judged on its content.
            match Command::new(candidate)
                .arg("--json")
                .arg("--full")
                .arg("--provider")
                .arg(&providers)
                .output()
            {
                Ok(output) => match String::from_utf8(output.stdout) {
                    Ok(stdout) => match parse_quota_axi(&stdout) {
                        Ok(readings) => return Ok(readings),
                        Err(error) => last_error = error,
                    },
                    Err(_) => last_error = "quota-axi returned output we could not read.".into(),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => last_error = format!("quota-axi could not run: {error}"),
            }
        }
        Err(last_error)
    }
}

/// Turns one `quota-axi --json` report into a reading per known provider.
///
/// Deliberately tolerant: the report is another tool's output and gains fields
/// over time, so anything unrecognised is skipped rather than fatal. Only
/// output that is not a report at all fails.
pub fn parse_quota_axi(json: &str) -> Result<Vec<AgentQuota>, String> {
    let root: Value = serde_json::from_str(json.trim())
        .map_err(|_| "quota-axi did not return JSON.".to_string())?;
    let reported = root
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "quota-axi returned no provider report.".to_string())?;

    Ok(PROVIDERS
        .iter()
        .map(|entry| {
            reported
                .iter()
                .find(|value| value.get("provider").and_then(Value::as_str) == Some(entry.provider))
                .map_or_else(
                    || AgentQuota::unknown(entry, "No quota reported for this tool."),
                    |value| read_provider(entry, value),
                )
        })
        .collect())
}

fn read_provider(entry: &ProviderEntry, value: &Value) -> AgentQuota {
    let windows: Vec<QuotaWindow> = value
        .get("windows")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(read_window).collect())
        .unwrap_or_default();

    let (percent_remaining, binding_window_id) = match effective_availability(value) {
        Some((remaining, limiting)) => {
            let binding = limiting
                .filter(|id| windows.iter().any(|window| &window.id == id))
                .or_else(|| most_constrained(&windows).map(|window| window.id.clone()));
            (Some(remaining), binding)
        }
        None => match most_constrained(&windows) {
            Some(window) => (Some(window.percent_remaining), Some(window.id.clone())),
            None => (None, None),
        },
    };

    let state = value.get("state");
    let state_status = state
        .and_then(|state| state.get("status"))
        .and_then(Value::as_str);
    let reason = state
        .and_then(|state| state.get("error"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let label = value
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(entry.label)
        .to_string();
    let sources = entry.sources.iter().map(|s| (*s).to_string()).collect();
    let stale = state
        .and_then(|state| state.get("stale"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let account = read_account(value.get("account"));

    match percent_remaining {
        Some(remaining) => AgentQuota {
            provider: entry.provider.to_string(),
            label,
            sources,
            status: QuotaStatus::Known,
            account,
            plan: value
                .get("plan")
                .and_then(Value::as_str)
                .filter(|plan| !plan.trim().is_empty())
                .map(str::to_string),
            percent_remaining: Some(remaining),
            binding_window_id,
            windows,
            detail: None,
            reason,
            stale,
        },
        None => AgentQuota {
            detail: Some(unknown_detail(state_status).to_string()),
            reason,
            stale,
            label,
            sources,
            // A provider can name its login and still refuse a usable figure;
            // saying who is signed in is worth more than saying nothing.
            account,
            ..AgentQuota::unknown(entry, "")
        },
    }
}

/// The signed-in identity, when the provider reports one. An account block with
/// neither an email nor an organization names nobody and is dropped.
fn read_account(value: Option<&Value>) -> Option<QuotaAccount> {
    let value = value?;
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|found| !found.is_empty())
            .map(str::to_string)
    };
    let account = QuotaAccount {
        email: text("email"),
        organization: text("organization"),
    };
    (account.email.is_some() || account.organization.is_some()).then_some(account)
}

/// What to tell the user when a provider reports nothing usable. The provider's
/// own error code rides along in `reason`; this is the sentence beside the dial.
fn unknown_detail(state_status: Option<&str>) -> &'static str {
    match state_status {
        Some("auth_required") => "Sign in to this tool to read its quota.",
        Some("error") => "This tool's quota could not be read on this machine.",
        _ => "No quota reported for this tool.",
    }
}

fn read_window(value: &Value) -> Option<QuotaWindow> {
    let id = value.get("id").and_then(Value::as_str)?.to_string();
    let remaining = percent(value.get("percentRemaining"))
        .or_else(|| percent(value.get("percentUsed")).map(|used| 100 - used))?;
    Some(QuotaWindow {
        label: value
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string(),
        kind: value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("window")
            .to_string(),
        id,
        percent_remaining: remaining,
        resets_at: value
            .get("resetsAt")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// The provider's own verdict on what is left across every window that bounds
/// an ordinary request, plus which window is doing the binding. Preferred over
/// picking a minimum ourselves — the provider knows how its windows compose.
fn effective_availability(value: &Value) -> Option<(u8, Option<String>)> {
    let entries = value
        .get("quotaSemantics")?
        .get("effectiveAvailability")?
        .as_array()?;
    let entry = entries
        .iter()
        .find(|entry| entry.get("scope").and_then(Value::as_str) == Some("all_models"))?;
    if entry.get("status").and_then(Value::as_str) != Some("known") {
        return None;
    }
    let remaining = percent(entry.get("effectivePercentRemaining"))?;
    let limiting = entry
        .get("limitingWindowIds")
        .and_then(Value::as_array)
        .and_then(|ids| ids.first())
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((remaining, limiting))
}

/// The window a user actually runs out of first. Per-model windows are an extra
/// bound on one model rather than on the account, so they only win when nothing
/// account-wide was reported.
fn most_constrained(windows: &[QuotaWindow]) -> Option<&QuotaWindow> {
    windows
        .iter()
        .filter(|window| window.kind != "model")
        .min_by_key(|window| window.percent_remaining)
        .or_else(|| windows.iter().min_by_key(|window| window.percent_remaining))
}

fn percent(value: Option<&Value>) -> Option<u8> {
    let number = value?.as_f64()?;
    if !number.is_finite() {
        return None;
    }
    Some(number.round().clamp(0.0, 100.0) as u8)
}

#[derive(Default)]
struct CacheState {
    snapshot: Option<QuotaSnapshot>,
    read_at: Option<Instant>,
    refreshing: bool,
}

/// Holds the last reading and refreshes it off the UI's path.
///
/// `snapshot` never runs a provider read itself: it answers from the cache and,
/// when that answer has aged past the TTL, starts one background refresh. The
/// worst a slow or hung `quota-axi` can do is leave the dial showing its last
/// value; it can never delay the session UI that asked.
pub struct QuotaMonitor {
    sources: Vec<Arc<dyn QuotaSource>>,
    ttl: Duration,
    state: Arc<Mutex<CacheState>>,
}

impl QuotaMonitor {
    pub fn new() -> Self {
        Self::with_sources(vec![Arc::new(QuotaAxiSource::new())], DEFAULT_TTL)
    }

    pub fn with_sources(sources: Vec<Arc<dyn QuotaSource>>, ttl: Duration) -> Self {
        Self {
            sources,
            ttl,
            state: Arc::new(Mutex::new(CacheState::default())),
        }
    }

    /// The current reading, immediately. Starts a background refresh when the
    /// held reading has aged out, and returns the pending snapshot the first
    /// time, before any source has answered.
    pub fn snapshot(&self) -> QuotaSnapshot {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let fresh = state
            .read_at
            .is_some_and(|read_at| read_at.elapsed() < self.ttl);
        if !fresh && !state.refreshing {
            state.refreshing = true;
            let sources = self.sources.clone();
            let shared = Arc::clone(&self.state);
            std::thread::spawn(move || {
                let next = read_sources(&sources);
                let mut state = shared.lock().unwrap_or_else(PoisonError::into_inner);
                state.snapshot = Some(next);
                state.read_at = Some(Instant::now());
                state.refreshing = false;
            });
        }
        state
            .snapshot
            .clone()
            .unwrap_or_else(QuotaSnapshot::pending)
    }

    /// Reads every source on this thread and caches the result. Used by tests
    /// and by anything that would rather wait than see a pending snapshot.
    pub fn refresh_blocking(&self) -> QuotaSnapshot {
        let next = read_sources(&self.sources);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.snapshot = Some(next.clone());
        state.read_at = Some(Instant::now());
        next
    }
}

impl Default for QuotaMonitor {
    fn default() -> Self {
        Self::new()
    }
}

/// Asks every source in order and keeps the first known reading per provider.
/// A snapshot is `Unavailable` only when no source answered at all — one source
/// failing while another works is not worth telling the user about.
fn read_sources(sources: &[Arc<dyn QuotaSource>]) -> QuotaSnapshot {
    let mut providers = catalog();
    let mut failures: Vec<String> = Vec::new();
    let mut answered = false;

    for source in sources {
        match source.read() {
            Ok(readings) => {
                answered = true;
                for reading in readings {
                    let slot = providers.iter_mut().find(|slot| {
                        slot.provider == reading.provider && slot.status == QuotaStatus::Unknown
                    });
                    if let Some(slot) = slot {
                        *slot = reading;
                    }
                }
            }
            Err(error) => failures.push(format!("{}: {error}", source.id())),
        }
    }

    QuotaSnapshot {
        status: if answered {
            SnapshotStatus::Ready
        } else {
            SnapshotStatus::Unavailable
        },
        checked_at: Some(now_iso8601()),
        detail: (!failures.is_empty()).then(|| failures.join("; ")),
        providers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trimmed `quota-axi --json` report in the shape the tool emits: two
    /// signed-in providers with several windows each, and three that cannot be
    /// read for the three reasons that actually happen.
    const REPORT: &str = r#"{
      "generatedAt": "2026-08-10T15:28:29.562Z",
      "schemaVersion": 3,
      "providers": [
        {
          "provider": "claude",
          "label": "Claude",
          "source": "oauth",
          "plan": "max",
          "account": {
            "accountId": "5105d966-912c-4d7f-a8ea-bc1615ff4419",
            "email": "dev@example.com",
            "organization": "Example Org",
            "identityStatus": "verified"
          },
          "windows": [
            { "id": "five_hour", "label": "session", "kind": "session", "percentUsed": 21,
              "resetsAt": "2026-08-10T19:30:00.443029+00:00", "percentRemaining": 79 },
            { "id": "seven_day", "label": "week", "kind": "weekly", "percentUsed": 28,
              "resetsAt": "2026-08-10T21:00:00.443051+00:00", "percentRemaining": 72 },
            { "id": "model:fable", "label": "Fable week", "kind": "model", "percentUsed": 26,
              "resetsAt": "2026-08-10T21:00:00.443235+00:00", "percentRemaining": 74 }
          ],
          "state": { "status": "fresh", "stale": false, "refreshedAt": "2026-08-10T15:28:30.020Z" },
          "quotaSemantics": {
            "status": "known",
            "effectiveAvailability": [
              { "scope": "all_models", "status": "known", "effectivePercentRemaining": 72,
                "boundedBy": ["five_hour", "seven_day"], "limitingWindowIds": ["seven_day"] },
              { "scope": "model:fable", "status": "known", "effectivePercentRemaining": 72,
                "limitingWindowIds": ["seven_day"] }
            ]
          }
        },
        {
          "provider": "codex",
          "label": "Codex",
          "plan": "pro",
          "account": { "email": "other-dev@example.com", "accountId": "3b4ddd13-4c9d-4848-82d3-370b76da00b8" },
          "windows": [
            { "id": "weekly", "label": "week", "kind": "weekly", "percentUsed": 96,
              "resetsAt": "2026-08-16T03:47:46.000Z", "percentRemaining": 4 },
            { "id": "model:codex_bengalfox:7d", "label": "GPT-5.3-Codex-Spark week", "kind": "model",
              "percentUsed": 0, "percentRemaining": 100 }
          ],
          "state": { "status": "fresh", "stale": false },
          "quotaSemantics": {
            "status": "known",
            "effectiveAvailability": [
              { "scope": "all_models", "status": "known", "effectivePercentRemaining": 4,
                "limitingWindowIds": ["weekly"] }
            ]
          }
        },
        {
          "provider": "cursor",
          "label": "Cursor",
          "source": "unavailable",
          "windows": [],
          "state": { "status": "error", "stale": false, "error": "sqlite3_unavailable" },
          "quotaSemantics": { "status": "unknown", "effectiveAvailability": [] }
        },
        {
          "provider": "copilot",
          "label": "GitHub Copilot",
          "source": "unavailable",
          "windows": [],
          "state": { "status": "auth_required", "stale": false, "error": "GitHub Copilot sign-in required" }
        },
        {
          "provider": "grok",
          "label": "Grok",
          "windows": [],
          "state": { "status": "auth_required", "stale": false, "error": "Grok sign-in required" }
        }
      ]
    }"#;

    fn reading<'a>(readings: &'a [AgentQuota], provider: &str) -> &'a AgentQuota {
        readings
            .iter()
            .find(|reading| reading.provider == provider)
            .expect("every known provider is present")
    }

    #[test]
    fn a_signed_in_provider_reports_its_plan_and_the_window_that_binds() {
        let readings = parse_quota_axi(REPORT).expect("the report parses");

        let claude = reading(&readings, "claude");
        assert_eq!(claude.status, QuotaStatus::Known);
        assert_eq!(claude.plan.as_deref(), Some("max"));
        // The weekly window at 72% binds, not the roomier 79% session window.
        assert_eq!(claude.percent_remaining, Some(72));
        assert_eq!(claude.binding_window_id.as_deref(), Some("seven_day"));
        assert_eq!(claude.detail, None);
        assert!(!claude.stale);
    }

    #[test]
    fn every_window_rides_along_for_the_expandable_detail() {
        let readings = parse_quota_axi(REPORT).expect("the report parses");

        let claude = reading(&readings, "claude");
        let ids: Vec<&str> = claude
            .windows
            .iter()
            .map(|window| window.id.as_str())
            .collect();
        assert_eq!(ids, ["five_hour", "seven_day", "model:fable"]);
        let session = &claude.windows[0];
        assert_eq!(session.label, "session");
        assert_eq!(session.kind, "session");
        assert_eq!(session.percent_remaining, 79);
        assert_eq!(
            session.resets_at.as_deref(),
            Some("2026-08-10T19:30:00.443029+00:00")
        );
    }

    #[test]
    fn a_nearly_spent_plan_reports_the_low_number_rather_than_the_roomy_model_window() {
        let readings = parse_quota_axi(REPORT).expect("the report parses");

        let codex = reading(&readings, "codex");
        assert_eq!(codex.percent_remaining, Some(4));
        assert_eq!(codex.binding_window_id.as_deref(), Some("weekly"));
        assert_eq!(codex.plan.as_deref(), Some("pro"));
    }

    #[test]
    fn an_unreadable_provider_is_unknown_with_its_own_reason_kept_for_the_tooltip() {
        let readings = parse_quota_axi(REPORT).expect("the report parses");

        let cursor = reading(&readings, "cursor");
        assert_eq!(cursor.status, QuotaStatus::Unknown);
        assert_eq!(cursor.percent_remaining, None);
        assert_eq!(
            cursor.detail.as_deref(),
            Some("This tool's quota could not be read on this machine.")
        );
        assert_eq!(cursor.reason.as_deref(), Some("sqlite3_unavailable"));
    }

    #[test]
    fn a_signed_out_provider_says_so_instead_of_reading_as_broken() {
        let readings = parse_quota_axi(REPORT).expect("the report parses");

        let copilot = reading(&readings, "copilot");
        assert_eq!(copilot.status, QuotaStatus::Unknown);
        assert_eq!(
            copilot.detail.as_deref(),
            Some("Sign in to this tool to read its quota.")
        );
        assert_eq!(
            copilot.reason.as_deref(),
            Some("GitHub Copilot sign-in required")
        );
    }

    #[test]
    fn a_provider_missing_from_the_report_is_unknown_rather_than_absent() {
        let readings = parse_quota_axi(REPORT).expect("the report parses");

        assert_eq!(readings.len(), PROVIDERS.len());
        let kimi = reading(&readings, "kimi");
        assert_eq!(kimi.status, QuotaStatus::Unknown);
        assert_eq!(
            kimi.detail.as_deref(),
            Some("No quota reported for this tool.")
        );
        assert_eq!(kimi.label, "Kimi");
    }

    #[test]
    fn a_reading_names_the_login_it_belongs_to() {
        let readings = parse_quota_axi(REPORT).expect("the report parses");

        // Two providers, two different logins on the same machine: the dial has
        // to be able to say which account each figure is about.
        let claude = reading(&readings, "claude").account.as_ref();
        assert_eq!(
            claude.and_then(|a| a.email.as_deref()),
            Some("dev@example.com")
        );
        assert_eq!(
            claude.and_then(|a| a.organization.as_deref()),
            Some("Example Org")
        );
        let codex = reading(&readings, "codex").account.as_ref();
        assert_eq!(
            codex.and_then(|a| a.email.as_deref()),
            Some("other-dev@example.com")
        );
        assert_eq!(codex.and_then(|a| a.organization.as_deref()), None);
        // Nobody signed in, nobody named.
        assert_eq!(reading(&readings, "cursor").account, None);
    }

    #[test]
    fn an_account_block_that_names_nobody_is_dropped() {
        let report = r#"{"providers":[{"provider":"claude","plan":"max",
            "account":{"accountId":"5105d966","email":"   "},
            "windows":[{"id":"seven_day","kind":"weekly","percentRemaining":30}]}]}"#;

        let readings = parse_quota_axi(report).expect("the report parses");
        assert_eq!(reading(&readings, "claude").account, None);
    }

    #[test]
    fn a_signed_out_provider_still_names_whoever_it_last_knew() {
        let report = r#"{"providers":[{"provider":"copilot",
            "account":{"email":"dev@example.com"},"windows":[],
            "state":{"status":"auth_required","error":"GitHub Copilot sign-in required"}}]}"#;

        let readings = parse_quota_axi(report).expect("the report parses");
        let copilot = reading(&readings, "copilot");
        assert_eq!(copilot.status, QuotaStatus::Unknown);
        assert_eq!(
            copilot.account.as_ref().and_then(|a| a.email.as_deref()),
            Some("dev@example.com")
        );
    }

    #[test]
    fn readings_carry_the_agent_sources_the_session_ui_attributes_by() {
        let readings = parse_quota_axi(REPORT).expect("the report parses");

        assert_eq!(reading(&readings, "claude").sources, ["claude_code"]);
        assert_eq!(reading(&readings, "kimi").sources, ["kimi_code"]);
    }

    #[test]
    fn without_the_providers_own_verdict_the_smallest_account_window_binds() {
        let report = r#"{"providers":[{"provider":"claude","windows":[
            {"id":"five_hour","label":"session","kind":"session","percentRemaining":40},
            {"id":"seven_day","label":"week","kind":"weekly","percentRemaining":15},
            {"id":"model:fable","label":"Fable week","kind":"model","percentRemaining":3}
        ],"state":{"status":"fresh"}}]}"#;

        let claude = parse_quota_axi(report).expect("the report parses");
        let claude = reading(&claude, "claude");
        assert_eq!(claude.percent_remaining, Some(15));
        assert_eq!(claude.binding_window_id.as_deref(), Some("seven_day"));
    }

    #[test]
    fn a_percentage_survives_a_report_that_only_states_what_was_used() {
        let report = r#"{"providers":[{"provider":"codex","windows":[
            {"id":"weekly","kind":"weekly","percentUsed":96.4}
        ]}]}"#;

        let readings = parse_quota_axi(report).expect("the report parses");
        let codex = reading(&readings, "codex");
        assert_eq!(codex.percent_remaining, Some(4));
        // No label of its own: the id stands in rather than an empty string.
        assert_eq!(codex.windows[0].label, "weekly");
    }

    #[test]
    fn an_unparseable_window_is_skipped_without_losing_the_rest() {
        let report = r#"{"providers":[{"provider":"claude","windows":[
            {"label":"nameless window","percentRemaining":5},
            {"id":"seven_day","kind":"weekly"},
            {"id":"five_hour","kind":"session","percentRemaining":66}
        ]}]}"#;

        let readings = parse_quota_axi(report).expect("the report parses");
        let claude = reading(&readings, "claude");
        assert_eq!(claude.windows.len(), 1);
        assert_eq!(claude.percent_remaining, Some(66));
    }

    #[test]
    fn output_that_is_not_a_report_fails_the_source_rather_than_the_app() {
        assert!(parse_quota_axi("not json at all").is_err());
        assert!(parse_quota_axi("{}").is_err());
        assert!(parse_quota_axi(r#"{"providers":"soon"}"#).is_err());
        // An empty report is valid; every provider simply reads unknown.
        let empty = parse_quota_axi(r#"{"providers":[]}"#).expect("an empty report parses");
        assert_eq!(empty.len(), PROVIDERS.len());
        assert!(empty
            .iter()
            .all(|reading| reading.status == QuotaStatus::Unknown));
    }

    struct StubSource {
        id: &'static str,
        result: Result<Vec<AgentQuota>, String>,
    }

    impl QuotaSource for StubSource {
        fn id(&self) -> &'static str {
            self.id
        }

        fn read(&self) -> Result<Vec<AgentQuota>, String> {
            self.result.clone()
        }
    }

    fn known(provider: &str, remaining: u8) -> AgentQuota {
        let entry = PROVIDERS
            .iter()
            .find(|entry| entry.provider == provider)
            .expect("a known provider");
        AgentQuota {
            status: QuotaStatus::Known,
            percent_remaining: Some(remaining),
            plan: Some("pro".to_string()),
            detail: None,
            ..AgentQuota::unknown(entry, "")
        }
    }

    fn monitor(sources: Vec<Arc<dyn QuotaSource>>) -> QuotaMonitor {
        QuotaMonitor::with_sources(sources, DEFAULT_TTL)
    }

    #[test]
    fn the_first_ask_answers_pending_without_waiting_on_a_provider_read() {
        let quota = monitor(vec![Arc::new(StubSource {
            id: "stub",
            result: Ok(vec![known("claude", 61)]),
        })]);

        let snapshot = quota.snapshot();

        assert_eq!(snapshot.status, SnapshotStatus::Pending);
        assert_eq!(snapshot.providers.len(), PROVIDERS.len());
        assert!(snapshot
            .providers
            .iter()
            .all(|reading| reading.status == QuotaStatus::Unknown));
    }

    #[test]
    fn a_completed_read_is_served_from_cache() {
        let quota = monitor(vec![Arc::new(StubSource {
            id: "stub",
            result: Ok(vec![known("claude", 61)]),
        })]);

        let refreshed = quota.refresh_blocking();
        assert_eq!(refreshed.status, SnapshotStatus::Ready);
        assert!(refreshed.checked_at.is_some());

        let snapshot = quota.snapshot();
        assert_eq!(snapshot, refreshed);
        let claude = reading(&snapshot.providers, "claude");
        assert_eq!(claude.percent_remaining, Some(61));
        // Providers the source said nothing about stay unknown, not missing.
        assert_eq!(
            reading(&snapshot.providers, "grok").status,
            QuotaStatus::Unknown
        );
    }

    #[test]
    fn a_source_that_cannot_run_leaves_every_provider_unknown_and_says_why() {
        let quota = monitor(vec![Arc::new(StubSource {
            id: "quota-axi",
            result: Err("quota-axi is not installed on this machine.".to_string()),
        })]);

        let snapshot = quota.refresh_blocking();

        assert_eq!(snapshot.status, SnapshotStatus::Unavailable);
        assert_eq!(
            snapshot.detail.as_deref(),
            Some("quota-axi: quota-axi is not installed on this machine.")
        );
        assert_eq!(snapshot.providers.len(), PROVIDERS.len());
        assert!(snapshot
            .providers
            .iter()
            .all(|reading| reading.status == QuotaStatus::Unknown));
    }

    #[test]
    fn the_first_source_that_knows_a_provider_wins_and_a_failure_does_not_hide_the_rest() {
        let quota = monitor(vec![
            Arc::new(StubSource {
                id: "native",
                result: Err("no native reader yet".to_string()),
            }),
            Arc::new(StubSource {
                id: "precise",
                result: Ok(vec![known("claude", 12)]),
            }),
            Arc::new(StubSource {
                id: "quota-axi",
                result: Ok(vec![known("claude", 99), known("codex", 44)]),
            }),
        ]);

        let snapshot = quota.refresh_blocking();

        assert_eq!(snapshot.status, SnapshotStatus::Ready);
        assert_eq!(
            reading(&snapshot.providers, "claude").percent_remaining,
            Some(12)
        );
        assert_eq!(
            reading(&snapshot.providers, "codex").percent_remaining,
            Some(44)
        );
        assert_eq!(
            snapshot.detail.as_deref(),
            Some("native: no native reader yet")
        );
    }

    /// Hands out a different reading each refresh, standing in for a machine
    /// whose provider login changed between them.
    struct SwitchingSource {
        readings: Mutex<Vec<Vec<AgentQuota>>>,
    }

    impl QuotaSource for SwitchingSource {
        fn id(&self) -> &'static str {
            "switching"
        }

        fn read(&self) -> Result<Vec<AgentQuota>, String> {
            let mut readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);
            Ok(if readings.len() > 1 {
                readings.remove(0)
            } else {
                readings.first().cloned().unwrap_or_default()
            })
        }
    }

    fn signed_in_as(email: &str, remaining: u8) -> AgentQuota {
        AgentQuota {
            account: Some(QuotaAccount {
                email: Some(email.to_string()),
                organization: None,
            }),
            ..known("claude", remaining)
        }
    }

    #[test]
    fn switching_the_signed_in_account_moves_the_dial_at_the_next_refresh() {
        let quota = monitor(vec![Arc::new(SwitchingSource {
            readings: Mutex::new(vec![
                vec![signed_in_as("dev@example.com", 61)],
                vec![signed_in_as("someone-else@example.com", 9)],
            ]),
        })]);

        let before = quota.refresh_blocking();
        let claude = reading(&before.providers, "claude");
        assert_eq!(
            claude.account.as_ref().and_then(|a| a.email.as_deref()),
            Some("dev@example.com")
        );
        assert_eq!(claude.percent_remaining, Some(61));

        // Nothing is keyed by session, by account, or by time: a refresh simply
        // re-reads whichever credential is live now, so the new login's figures
        // replace the old ones outright.
        let after = quota.refresh_blocking();
        let claude = reading(&after.providers, "claude");
        assert_eq!(
            claude.account.as_ref().and_then(|a| a.email.as_deref()),
            Some("someone-else@example.com")
        );
        assert_eq!(claude.percent_remaining, Some(9));
        // And that is what the UI's next ask gets back.
        assert_eq!(quota.snapshot(), after);
    }

    #[test]
    fn a_stale_reading_is_still_shown_and_still_says_it_is_stale() {
        let report = r#"{"providers":[{"provider":"claude","plan":"max","windows":[
            {"id":"seven_day","kind":"weekly","percentRemaining":30}
        ],"state":{"status":"fresh","stale":true}}]}"#;

        let readings = parse_quota_axi(report).expect("the report parses");
        let claude = reading(&readings, "claude");
        assert_eq!(claude.status, QuotaStatus::Known);
        assert_eq!(claude.percent_remaining, Some(30));
        assert!(claude.stale);
    }

    #[test]
    fn the_payload_the_ui_decodes_is_camel_cased_all_the_way_down() {
        let readings = parse_quota_axi(REPORT).expect("the report parses");
        let snapshot = QuotaSnapshot {
            status: SnapshotStatus::Ready,
            checked_at: Some("2026-08-10T15:28:29.562Z".to_string()),
            detail: None,
            providers: readings,
        };

        let json = serde_json::to_value(&snapshot).expect("the snapshot serializes");

        assert_eq!(json["status"], "ready");
        assert_eq!(json["checkedAt"], "2026-08-10T15:28:29.562Z");
        assert_eq!(json["providers"][0]["provider"], "claude");
        assert_eq!(json["providers"][0]["status"], "known");
        assert_eq!(json["providers"][0]["percentRemaining"], 72);
        assert_eq!(json["providers"][0]["bindingWindowId"], "seven_day");
        assert_eq!(json["providers"][0]["account"]["email"], "dev@example.com");
        assert_eq!(
            json["providers"][0]["account"]["organization"],
            "Example Org"
        );
        assert_eq!(json["providers"][0]["windows"][0]["percentRemaining"], 79);
        assert_eq!(json["providers"][2]["status"], "unknown");
        assert_eq!(json["providers"][2]["percentRemaining"], Value::Null);
    }
}
