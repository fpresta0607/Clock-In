//! The append-only spool that `siqshift-hook` writes and the desktop drains.
//! `siqshift-browser-host` shares the same machinery for its own spool file.
//!
//! Several agent CLIs can fire hooks at the same moment, so every append runs
//! under an interprocess lock: an OS advisory lock (`File::try_lock`) on a
//! sibling `.lock` sentinel, retried briefly and then failed loudly. The OS
//! releases the lock if a holder dies mid-append, so there is no stale-lock
//! breaking and no delete/recreate race; the sentinel itself is never removed.
//!
//! Draining is two-phase — `read_pending` then `truncate_acked` — so the
//! uploader acknowledges only after the server confirms, and a crash mid-upload
//! replays rather than loses evidence. Replay is safe because the server's
//! idempotency keys absorb re-uploaded events. Bytes that can never be
//! uploaded — a partial tail from a crashed append, a line that fails to
//! parse — are quarantined to sibling files instead of failing the drain.

use std::cell::RefCell;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Rotation threshold for a single spool file.
pub const MAX_SPOOL_BYTES: u64 = 10 * 1024 * 1024;

pub const MAX_PENDING_SPOOL_BYTES: u64 = 5 * MAX_SPOOL_BYTES;

pub const MAX_SPOOL_RECORD_BYTES: usize = 256 * 1024;

/// Overrides the spool location; tests and support setups use this.
pub const SPOOL_ENV_VAR: &str = "SIQSHIFT_SPOOL";

const LOCK_RETRY_DELAY: Duration = Duration::from_millis(10);
const LOCK_WAIT_LIMIT: Duration = Duration::from_secs(5);
const MAX_RETAINED_NAMESPACES: usize = 8;
const NAMESPACE_RESERVATION_FILE: &str = ".namespace-reservation.json";
const WORKSPACE_MOVE_FILE: &str = "workspace-move.json";

pub type SpoolResult<T> = Result<T, io::Error>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceIdentity {
    pub account_id: String,
    pub organization_id: String,
}

impl EvidenceIdentity {
    pub fn new(account_id: impl AsRef<str>, organization_id: impl AsRef<str>) -> Option<Self> {
        let account_id = account_id.as_ref().trim();
        let organization_id = organization_id.as_ref().trim();
        if !identity_component_is_valid(account_id) || !identity_component_is_valid(organization_id)
        {
            return None;
        }
        Some(Self {
            account_id: account_id.to_string(),
            organization_id: organization_id.to_string(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidencePaths {
    pub agent_path: PathBuf,
    pub segments_path: PathBuf,
    pub browser_dir: PathBuf,
    pub recovery_path: PathBuf,
    pub shift_windows_path: PathBuf,
    pub shift_commits_path: PathBuf,
    pub agent_usage_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamespaceReservation {
    record: WorkspaceMoveRecord,
}

impl NamespaceReservation {
    pub fn source_identity(&self) -> &EvidenceIdentity {
        &self.record.source_identity
    }

    pub fn target_identity(&self) -> &EvidenceIdentity {
        &self.record.target_identity
    }

    pub fn extension_reservation_id(&self) -> Option<&str> {
        self.record.extension_reservation_id.as_deref()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceMoveRecovery {
    Rollback(NamespaceReservation),
    Complete(NamespaceReservation),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMoveRecord {
    source_identity: EvidenceIdentity,
    target_identity: EvidenceIdentity,
    token: String,
    state: WorkspaceMoveState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    extension_reservation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum WorkspaceMoveState {
    DesktopReserved,
    ExtensionReserved,
    ApiCommitted,
}

pub fn evidence_paths(identity: &EvidenceIdentity) -> EvidencePaths {
    evidence_paths_at(&evidence_root(), identity)
}

fn evidence_paths_at(root: &Path, identity: &EvidenceIdentity) -> EvidencePaths {
    let browser_dir = root
        .join(&identity.account_id)
        .join(&identity.organization_id);
    EvidencePaths {
        agent_path: browser_dir.join("agent-spool.jsonl"),
        segments_path: browser_dir.join("segments-spool.jsonl"),
        recovery_path: browser_dir.join("recovery.json"),
        shift_windows_path: browser_dir.join("shift-windows.json"),
        shift_commits_path: browser_dir.join("shift-commits.json"),
        agent_usage_path: browser_dir.join("agent-usage.json"),
        browser_dir,
    }
}

pub fn active_identity() -> Option<EvidenceIdentity> {
    let root = evidence_root();
    let active_path = active_identity_path();
    with_lock(&root, || {
        recover_rewrite_files_locked(&active_path)?;
        Ok(active_identity_at(&active_path))
    })
    .ok()
    .flatten()
}

fn active_identity_at(path: &Path) -> Option<EvidenceIdentity> {
    let bytes = std::fs::read(path).ok()?;
    let identity = serde_json::from_slice::<EvidenceIdentity>(&bytes).ok()?;
    EvidenceIdentity::new(&identity.account_id, &identity.organization_id)
}

pub fn activate_identity(identity: &EvidenceIdentity) -> SpoolResult<()> {
    activate_identity_at(&evidence_root(), &active_identity_path(), identity)
}

fn activate_identity_at(
    root: &Path,
    active_path: &Path,
    identity: &EvidenceIdentity,
) -> SpoolResult<()> {
    with_lock(root, || {
        recover_rewrite_files_locked(active_path)?;
        let active_dir = active_identity_at(active_path)
            .map(|identity| evidence_paths_at(root, &identity).browser_dir);
        reserve_namespace_slot_at_locked(root, Some(identity), active_dir.as_deref())?;
        let paths = evidence_paths_at(root, identity);
        std::fs::create_dir_all(&paths.browser_dir)?;
        let reservation_path = namespace_reservation_path(&paths.browser_dir);
        recover_rewrite_files_locked(&reservation_path)?;
        if namespace_reservation_record(&reservation_path)?.is_some() {
            return Err(io::Error::other(
                "evidence namespace is reserved for a workspace move",
            ));
        }
        std::fs::write(
            paths.browser_dir.join(".last-active"),
            unix_seconds().to_string(),
        )?;
        let body = serde_json::to_vec(identity).map_err(io::Error::other)?;
        rewrite(active_path, &body)?;
        remove_if_exists(&reservation_path)
    })
}

pub fn reserve_identity_namespace(
    source_identity: &EvidenceIdentity,
    target_identity: &EvidenceIdentity,
) -> SpoolResult<NamespaceReservation> {
    reserve_identity_namespace_at(
        &evidence_root(),
        &active_identity_path(),
        source_identity,
        target_identity,
    )
}

fn reserve_identity_namespace_at(
    root: &Path,
    active_path: &Path,
    source_identity: &EvidenceIdentity,
    target_identity: &EvidenceIdentity,
) -> SpoolResult<NamespaceReservation> {
    with_lock(root, || {
        recover_rewrite_files_locked(active_path)?;
        let move_path = workspace_move_path_for_root(root);
        recover_rewrite_files_locked(&move_path)?;
        if workspace_move_record(&move_path)?.is_some() {
            return Err(io::Error::other("a workspace move is already pending"));
        }
        let record = WorkspaceMoveRecord {
            source_identity: source_identity.clone(),
            target_identity: target_identity.clone(),
            token: Uuid::new_v4().to_string(),
            state: WorkspaceMoveState::DesktopReserved,
            extension_reservation_id: None,
        };
        let record_bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
        rewrite(&move_path, &record_bytes)?;
        let reservation = NamespaceReservation { record };
        let result = (|| {
            let paths = evidence_paths_at(root, target_identity);
            let reservation_path = namespace_reservation_path(&paths.browser_dir);
            recover_rewrite_files_locked(&reservation_path)?;
            if namespace_reservation_record(&reservation_path)?.is_some() {
                return Err(io::Error::other("target workspace is already reserved"));
            }
            let active_dir = active_identity_at(active_path)
                .map(|identity| evidence_paths_at(root, &identity).browser_dir);
            reserve_namespace_slot_at_locked(root, Some(target_identity), active_dir.as_deref())?;
            std::fs::create_dir_all(&paths.browser_dir)?;
            let bytes = serde_json::to_vec(&reservation.record).map_err(io::Error::other)?;
            rewrite(&reservation_path, &bytes)?;
            Ok(reservation)
        })();
        if result.is_err() {
            let _ = remove_if_exists(&move_path);
        }
        result
    })
}

pub fn record_workspace_move_extension_reservation(
    reservation: &NamespaceReservation,
    extension_reservation_id: &str,
) -> SpoolResult<()> {
    let root = evidence_root();
    record_workspace_move_extension_reservation_at(&root, reservation, extension_reservation_id)
}

fn record_workspace_move_extension_reservation_at(
    root: &Path,
    reservation: &NamespaceReservation,
    extension_reservation_id: &str,
) -> SpoolResult<()> {
    with_lock(root, || {
        let move_path = workspace_move_path_for_root(root);
        recover_rewrite_files_locked(&move_path)?;
        if extension_reservation_id.trim().is_empty() {
            return Err(io::Error::other(
                "workspace move extension reservation is unavailable",
            ));
        }
        let mut record = workspace_move_record(&move_path)?
            .ok_or_else(|| io::Error::other("workspace move reservation is unavailable"))?;
        ensure_matching_workspace_move(&record, reservation)?;
        if record.state == WorkspaceMoveState::ApiCommitted {
            return Err(io::Error::other("workspace move has already committed"));
        }
        record.state = WorkspaceMoveState::ExtensionReserved;
        record.extension_reservation_id = Some(extension_reservation_id.to_string());
        let bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
        rewrite(&move_path, &bytes)
    })
}

pub fn mark_workspace_move_committed(reservation: &NamespaceReservation) -> SpoolResult<()> {
    let root = evidence_root();
    mark_workspace_move_committed_at(&root, reservation)
}

fn mark_workspace_move_committed_at(
    root: &Path,
    reservation: &NamespaceReservation,
) -> SpoolResult<()> {
    with_lock(root, || {
        let move_path = workspace_move_path_for_root(root);
        recover_rewrite_files_locked(&move_path)?;
        let mut record = workspace_move_record(&move_path)?
            .ok_or_else(|| io::Error::other("workspace move reservation is unavailable"))?;
        ensure_matching_workspace_move(&record, reservation)?;
        if record.state != WorkspaceMoveState::ExtensionReserved
            || record.extension_reservation_id.is_none()
        {
            return Err(io::Error::other(
                "workspace move extension reservation is unavailable",
            ));
        }
        record.state = WorkspaceMoveState::ApiCommitted;
        let bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
        rewrite(&move_path, &bytes)
    })
}

pub fn workspace_move_recovery(
    current_identity: &EvidenceIdentity,
) -> SpoolResult<Option<WorkspaceMoveRecovery>> {
    let root = evidence_root();
    workspace_move_recovery_at(&root, current_identity)
}

fn workspace_move_recovery_at(
    root: &Path,
    current_identity: &EvidenceIdentity,
) -> SpoolResult<Option<WorkspaceMoveRecovery>> {
    with_lock(root, || {
        let move_path = workspace_move_path_for_root(root);
        recover_rewrite_files_locked(&move_path)?;
        let Some(record) = workspace_move_record(&move_path)? else {
            return Ok(None);
        };
        let reservation = NamespaceReservation { record };
        if current_identity == reservation.target_identity()
            && (current_identity != reservation.source_identity()
                || reservation.record.state == WorkspaceMoveState::ApiCommitted)
        {
            return match reservation.record.state {
                WorkspaceMoveState::DesktopReserved => Err(io::Error::other(
                    "workspace move reached an unreserved destination",
                )),
                WorkspaceMoveState::ExtensionReserved | WorkspaceMoveState::ApiCommitted => {
                    Ok(Some(WorkspaceMoveRecovery::Complete(reservation)))
                }
            };
        }
        if current_identity == reservation.source_identity() {
            return Ok(Some(WorkspaceMoveRecovery::Rollback(reservation)));
        }
        Ok(None)
    })
}

pub fn activate_reserved_identity(reservation: &NamespaceReservation) -> SpoolResult<()> {
    let root = evidence_root();
    let active_path = active_identity_path();
    activate_reserved_identity_at(&root, &active_path, reservation)
}

fn activate_reserved_identity_at(
    root: &Path,
    active_path: &Path,
    reservation: &NamespaceReservation,
) -> SpoolResult<()> {
    with_lock(root, || {
        recover_rewrite_files_locked(active_path)?;
        let move_path = workspace_move_path_for_root(root);
        recover_rewrite_files_locked(&move_path)?;
        let record = workspace_move_record(&move_path)?
            .ok_or_else(|| io::Error::other("workspace move reservation is unavailable"))?;
        ensure_matching_workspace_move(&record, reservation)?;
        let paths = evidence_paths_at(root, reservation.target_identity());
        let reservation_path = namespace_reservation_path(&paths.browser_dir);
        recover_rewrite_files_locked(&reservation_path)?;
        if let Some(namespace_record) = namespace_reservation_record(&reservation_path)? {
            ensure_matching_workspace_move(&namespace_record, reservation)?;
        } else if active_identity_at(active_path).as_ref() != Some(reservation.target_identity()) {
            return Err(io::Error::other(
                "workspace move reservation is unavailable",
            ));
        }
        let active_dir = active_identity_at(active_path)
            .map(|identity| evidence_paths_at(root, &identity).browser_dir);
        reserve_namespace_slot_at_locked(
            root,
            Some(reservation.target_identity()),
            active_dir.as_deref(),
        )?;
        std::fs::create_dir_all(&paths.browser_dir)?;
        std::fs::write(
            paths.browser_dir.join(".last-active"),
            unix_seconds().to_string(),
        )?;
        let body = serde_json::to_vec(reservation.target_identity()).map_err(io::Error::other)?;
        rewrite(active_path, &body)?;
        remove_if_exists(&reservation_path)?;
        remove_if_exists(&move_path)
    })
}

pub fn release_identity_namespace_reservation(
    reservation: &NamespaceReservation,
) -> SpoolResult<()> {
    let root = evidence_root();
    release_identity_namespace_reservation_at(&root, reservation)
}

fn release_identity_namespace_reservation_at(
    root: &Path,
    reservation: &NamespaceReservation,
) -> SpoolResult<()> {
    with_lock(root, || {
        let move_path = workspace_move_path_for_root(root);
        recover_rewrite_files_locked(&move_path)?;
        let record = workspace_move_record(&move_path)?
            .ok_or_else(|| io::Error::other("workspace move reservation is unavailable"))?;
        ensure_matching_workspace_move(&record, reservation)?;
        let paths = evidence_paths_at(root, reservation.target_identity());
        let reservation_path = namespace_reservation_path(&paths.browser_dir);
        recover_rewrite_files_locked(&reservation_path)?;
        if let Some(namespace_record) = namespace_reservation_record(&reservation_path)? {
            ensure_matching_workspace_move(&namespace_record, reservation)?;
            remove_if_exists(&reservation_path)?;
        }
        remove_if_exists(&move_path)
    })
}

fn ensure_matching_workspace_move(
    record: &WorkspaceMoveRecord,
    reservation: &NamespaceReservation,
) -> SpoolResult<()> {
    (record.source_identity == *reservation.source_identity()
        && record.target_identity == *reservation.target_identity()
        && record.token == reservation.record.token)
        .then_some(())
        .ok_or_else(|| io::Error::other("workspace move reservation is owned by another operation"))
}

fn workspace_move_path_for_root(root: &Path) -> PathBuf {
    root.parent()
        .map(|parent| parent.join(WORKSPACE_MOVE_FILE))
        .unwrap_or_else(|| PathBuf::from(WORKSPACE_MOVE_FILE))
}

fn workspace_move_record(path: &Path) -> SpoolResult<Option<WorkspaceMoveRecord>> {
    match std::fs::read(path) {
        Ok(bytes) => parse_workspace_move_record(&bytes).map(Some),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn parse_workspace_move_record(bytes: &[u8]) -> SpoolResult<WorkspaceMoveRecord> {
    let record = serde_json::from_slice::<WorkspaceMoveRecord>(bytes)
        .map_err(|_| io::Error::other("workspace move reservation is invalid"))?;
    let source = EvidenceIdentity::new(
        &record.source_identity.account_id,
        &record.source_identity.organization_id,
    );
    let target = EvidenceIdentity::new(
        &record.target_identity.account_id,
        &record.target_identity.organization_id,
    );
    if source.as_ref() != Some(&record.source_identity)
        || target.as_ref() != Some(&record.target_identity)
        || Uuid::parse_str(&record.token).is_err()
        || record
            .extension_reservation_id
            .as_ref()
            .is_some_and(|request_id| request_id.trim().is_empty())
    {
        return Err(io::Error::other("workspace move reservation is invalid"));
    }
    Ok(record)
}

pub fn ensure_identity_namespace_capacity(identity: &EvidenceIdentity) -> SpoolResult<()> {
    check_namespace_capacity(&evidence_root(), Some(identity))
}

pub fn ensure_new_identity_namespace_capacity() -> SpoolResult<()> {
    check_namespace_capacity(&evidence_root(), None)
}

pub fn clear_active_identity() -> SpoolResult<()> {
    let root = evidence_root();
    let active_path = active_identity_path();
    with_lock(&root, || {
        recover_rewrite_files_locked(&active_path)?;
        remove_if_exists(&active_path)
    })
}

pub fn active_agent_spool_path() -> Option<PathBuf> {
    active_identity().map(|identity| evidence_paths(&identity).agent_path)
}

/// The agent spool both sides of the handoff use: the hook appends here and the
/// desktop uploader drains here.
///
/// Evidence is namespaced per account and organization once an identity has
/// been activated, and falls back to the unpartitioned spool when none has —
/// which is every install that has not opted into namespaced evidence. Both
/// sides resolve it the same way through this one function, because the two
/// resolving it differently is exactly how an agent event goes missing: the
/// hook exits successfully, nothing is written where the uploader looks, and
/// the whole agent-attribution path reads as "no agents ran".
pub fn agent_spool_path() -> PathBuf {
    active_agent_spool_path().unwrap_or_else(default_spool_path)
}

pub fn active_browser_dir() -> Option<PathBuf> {
    active_identity().map(|identity| evidence_paths(&identity).browser_dir)
}

/// The browser directory both sides of the handoff use: the app writes the
/// rules file and drains the browser spool here, and `siqshift-browser-host`
/// reads rules and appends span verdicts here. Same identity-namespaced
/// resolution as `agent_spool_path`, so the host and the app cannot disagree
/// about where a browser span lives — exactly the class of bug where the host
/// exits 0, writes where the uploader never looks, and browser time vanishes.
pub fn browser_dir() -> PathBuf {
    active_browser_dir().unwrap_or_else(default_browser_dir)
}

pub fn active_shift_windows_path() -> Option<PathBuf> {
    active_identity().map(|identity| evidence_paths(&identity).shift_windows_path)
}

/// The shift-window sidecar both `Started` and `Ended` capture use: a
/// `Started` line opens a window here, and the matching `Ended` line closes
/// it and triggers git discovery. Same identity-namespaced resolution as
/// `agent_spool_path`, so a shift's open half and its close half never land
/// in different accounts' evidence.
pub fn shift_windows_path() -> PathBuf {
    active_shift_windows_path().unwrap_or_else(default_shift_windows_path)
}

pub fn default_shift_windows_path() -> PathBuf {
    default_browser_dir().join("shift-windows.json")
}

pub fn active_shift_commits_path() -> Option<PathBuf> {
    active_identity().map(|identity| evidence_paths(&identity).shift_commits_path)
}

/// The durable shift-commit registry: captured commits, their verification
/// state, and what has synced to the server. Unlike the spools it does not
/// truncate; entries are pruned once decided and synced.
pub fn shift_commits_path() -> PathBuf {
    active_shift_commits_path().unwrap_or_else(default_shift_commits_path)
}

pub fn default_shift_commits_path() -> PathBuf {
    default_browser_dir().join("shift-commits.json")
}

pub fn active_agent_usage_path() -> Option<PathBuf> {
    active_identity().map(|identity| evidence_paths(&identity).agent_usage_path)
}

/// The durable agent-usage registry: per-session transcript cursors and the
/// accumulated token counters, with what has synced to the server. Same
/// identity-namespaced resolution as `agent_spool_path`, so the counters a
/// shift earned land in the same account's evidence as the shift itself.
pub fn agent_usage_path() -> PathBuf {
    active_agent_usage_path().unwrap_or_else(default_agent_usage_path)
}

pub fn default_agent_usage_path() -> PathBuf {
    default_browser_dir().join("agent-usage.json")
}

/// Which agent runtime produced an event.
///
/// Deliberately not an enum. The roster in `agent_runtimes` decides what
/// SIQshift can *say* about a runtime — its name, its hooks, its quota dial —
/// never whether it may be recorded. Any id of the canonical shape is spooled
/// and uploaded under its own name, so a runtime nobody has declared yet is
/// still attributed instead of being dropped or collapsed into `other`.
///
/// The canonical form is snake_case, which is what the API stores; kebab-case
/// is accepted on input because that is how the hook contract spells them, and
/// `claude-code` and `claude_code` are therefore the same runtime.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AgentSource(String);

/// The shape both the wire contract and the API's check constraint enforce.
const MAX_AGENT_SOURCE_LEN: usize = 40;

impl AgentSource {
    /// Accepts a canonical or kebab-case id; anything outside the shape is
    /// rejected here rather than being sent on to fail server-side.
    pub fn parse(value: &str) -> Result<Self, String> {
        let canonical = value.trim().to_ascii_lowercase().replace('-', "_");
        if canonical.is_empty() || canonical.len() > MAX_AGENT_SOURCE_LEN {
            return Err(format!("unrecognized agent source \"{value}\""));
        }
        let mut characters = canonical.chars();
        let starts_with_letter = characters
            .next()
            .is_some_and(|first| first.is_ascii_lowercase());
        let rest_is_shape =
            characters.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        if !starts_with_letter || !rest_is_shape {
            return Err(format!("unrecognized agent source \"{value}\""));
        }
        Ok(Self(canonical))
    }

    /// Browser-extension span verdicts, written by `siqshift-browser-host`.
    pub fn browser() -> Self {
        Self("browser".to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Serde default helper: a session registry entry always sets its source
    /// before it exists, so the empty placeholder never serializes.
    pub(crate) fn is_empty_for_default(&self) -> bool {
        self.0.is_empty()
    }
}

impl Default for AgentSource {
    /// Only a serde placeholder for an absent field: `parse` still rejects an
    /// empty id on input, so this value is never constructed by hand.
    fn default() -> Self {
        Self(String::new())
    }
}

impl TryFrom<String> for AgentSource {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<AgentSource> for String {
    fn from(source: AgentSource) -> Self {
        source.0
    }
}

/// Lifecycle event kinds, with the same canonical/alias split as `AgentSource`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentEventKind {
    #[serde(rename = "started", alias = "session-start")]
    Started,
    #[serde(rename = "ended", alias = "session-end")]
    Ended,
    #[serde(rename = "heartbeat")]
    Heartbeat,
}

/// One canonical spool line: exactly the shape `/v1/agent-sessions` accepts, so
/// the uploader batches drained lines without re-mapping fields. Agent events
/// carry `cwd` and no `ruleId`; browser spans carry `ruleId` and no `cwd` —
/// exactly one of the two is set, matching the source-conditional contract.
///
/// `model` rides beside `source` and is never derived from it: `pi` driving
/// `deepseek-v4-pro` is the `pi` runtime, and a model name identifies no
/// runtime at all. It is absent whenever the hook did not say, because a
/// guessed model is worse than none.
///
/// `transcript_path` and `tokens` are capture-only: the transcript reader
/// tails the path for usage counters and the counters restate a session's
/// cumulative totals, but neither is the server's to see — the upload
/// projects them away (`api::AgentEventUpload`), because the strict
/// `/agent-sessions` schema would reject the extra keys, and a transcript
/// path is not ours to send.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolEvent {
    pub source: AgentSource,
    pub external_session_id: String,
    pub event: AgentEventKind,
    pub occurred_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// `HEAD` when a `Started` event was written, recorded by the hook so the
    /// uploader can bound the shift to its own commits. Only `Started` carries
    /// it; every other event kind leaves it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_head: Option<String>,
    /// The repository the working directory sits in, probed by the hook at the
    /// same moment as `start_head`. Unlike `start_head` this is contract data,
    /// not sidecar-local: it names the codebase the shift's identity is keyed
    /// on, so it rides all the way to the server. A cwd outside a repository,
    /// or a machine without git, records nothing rather than an error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
    /// The repository's `origin` remote, probed beside `repo_root`. Contract
    /// data too, and the one the server keys the agent identity on: two
    /// worktrees report two roots and one remote, so keying on the remote is
    /// what makes them one agent instead of one per path. Any embedded
    /// credential is stripped before it reaches here, deliberately and at the
    /// probe (`without_embedded_credentials` in git_evidence.rs), so a
    /// token-authenticated clone never puts its token on the spool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_remote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenCounters>,
}

/// Cumulative session token totals a hook reported (the `--input-tokens`
/// flag family): the session's totals so far, never per-turn deltas, so the
/// usage registry keeps the maximum restatement per counter. Each counter is
/// absent when the hook did not report it; an empty flag reads as absent,
/// exactly as `--model` does.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounters {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
}

/// The hook payload as agent CLIs send it (Claude Code pipe convention).
/// Unknown fields and an unknown `version` are rejected rather than guessed at.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookInput {
    pub version: u32,
    pub source: AgentSource,
    pub event: AgentEventKind,
    pub session_id: String,
    pub cwd: String,
    pub occurred_at: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub tokens: Option<TokenCounters>,
}

impl HookInput {
    pub fn parse(json: &str) -> Result<Self, String> {
        serde_json::from_str::<HookInput>(json)
            .map_err(|error| format!("invalid hook JSON: {error}"))?
            .validate()
    }

    /// The checks serde cannot express: the contract version this build
    /// understands, and identity fields that are present but empty.
    pub fn validate(self) -> Result<Self, String> {
        if self.version != 1 {
            return Err(format!("unsupported hook version {}", self.version));
        }
        if self.session_id.trim().is_empty() {
            return Err("sessionId must not be empty".to_string());
        }
        if self.cwd.trim().is_empty() {
            return Err("cwd must not be empty".to_string());
        }
        if self.occurred_at.trim().is_empty() {
            return Err("occurredAt must not be empty".to_string());
        }
        Ok(self)
    }

    pub fn into_event(self) -> SpoolEvent {
        SpoolEvent {
            source: self.source,
            external_session_id: self.session_id,
            event: self.event,
            occurred_at: self.occurred_at,
            cwd: Some(self.cwd),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            model: non_empty(self.model.as_deref()),
            rule_id: None,
            transcript_path: None,
            tokens: self.tokens,
        }
    }
}

/// Trims a payload string down to something worth recording; a blank model is
/// the same as no model at all.
fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Claude Code's native hook payload: its own snake_case field names, no
/// `version`, no timestamp. Extra fields (`source`, `reason`, …) are
/// tolerated; only the fields SIQshift needs are read. `transcript_path`
/// points at the session's own log, which the usage reader tails for token
/// counters; it never leaves the machine.
#[derive(Debug, Deserialize)]
struct ClaudeHookInput {
    hook_event_name: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    transcript_path: Option<String>,
}

/// The outcome of reading hook stdin: either one event to spool, or a payload
/// that was understood but carries an event SIQshift does not track.
// Built once per hook invocation and consumed immediately, so boxing the large
// variant would buy indirection and nothing else.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum HookStdin {
    Event(SpoolEvent),
    Ignored,
}

/// The event identity a hook command line supplies when the CLI's own payload
/// does not carry it. Registration passes `--source`/`--event`; the session id
/// and cwd are then extracted from the CLI's own stdin payload.
///
/// The source always wins from here, because the command line is the one place
/// that *knows* which runtime registered the hook. Codex pipes a payload shaped
/// exactly like Claude Code's, so without this a Codex session would be filed
/// as Claude Code — a runtime is identified by its registration, never guessed
/// from the shape of what it sends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArgvContext {
    pub source: AgentSource,
    pub event: AgentEventKind,
    /// Cumulative token totals passed as flags beside `--source`/`--event`;
    /// the CLI's own payload never carries them, so the flags are the only
    /// channel. `None` when no token flags were passed.
    pub tokens: Option<TokenCounters>,
}

/// Parses hook stdin, accepting the SIQshift contract first and falling back
/// to Claude Code's native payload. Claude pipes its own JSON to whatever
/// binary its hooks register, so the same binary serves both: known Claude
/// events are translated (`SessionStart` → started, `SessionEnd` → ended,
/// `PostToolUse` → heartbeat), any other Claude event is accepted and ignored
/// so future hook types never spam errors. Claude's payload has no timestamp,
/// so the current time is stamped here.
pub fn parse_stdin(json: &str) -> Result<HookStdin, String> {
    parse_stdin_with_context(json, None)
}

/// `parse_stdin` plus a third fallback when the command line supplied the
/// event identity: a CLI-native payload (no contract shape, no
/// `hook_event_name`) is mined best-effort for a session id, cwd, and model.
/// Field spellings differ between CLIs and are not all verified against a real
/// session, so every documented candidate is tried. A payload without a usable
/// session id or cwd is accepted and ignored — never an error, so a hook can
/// never spam the agent CLI.
pub fn parse_stdin_with_context(
    json: &str,
    context: Option<ArgvContext>,
) -> Result<HookStdin, String> {
    match HookInput::parse(json) {
        Ok(input) => Ok(HookStdin::Event(input.into_event())),
        // The contract says what went wrong; keep that message if the input
        // turns out to be neither a Claude-shaped payload nor (with argv
        // context) a CLI-native payload either.
        Err(contract_error) => {
            if let Ok(claude) = serde_json::from_str::<ClaudeHookInput>(json) {
                return translate_claude(claude, context.as_ref());
            }
            if let Some(context) = context {
                // With the identity on the command line, stdin is a
                // CLI-native payload: extract what is there and accept the
                // rest silently, so a hook can never spam the agent CLI.
                return Ok(match serde_json::from_str::<serde_json::Value>(json) {
                    Ok(value) if value.is_object() => translate_native(&value, &context),
                    _ => HookStdin::Ignored,
                });
            }
            Err(contract_error)
        }
    }
}

/// Claude Code's payload shape, which Codex's own `hooks.json` also speaks.
/// The event comes from `hook_event_name` because the payload names it
/// (`SessionStart` → started, `SessionEnd` → ended, `PostToolUse` → heartbeat;
/// any other event is accepted and ignored so future hook types never spam
/// errors). The runtime comes from the registration's argv when there is one,
/// and only falls back to Claude Code for registrations written before SIQshift
/// passed `--source`. The payload has no timestamp, so now is stamped here.
fn translate_claude(
    input: ClaudeHookInput,
    context: Option<&ArgvContext>,
) -> Result<HookStdin, String> {
    let event = match input.hook_event_name.as_str() {
        "SessionStart" => AgentEventKind::Started,
        "SessionEnd" => AgentEventKind::Ended,
        "PostToolUse" => AgentEventKind::Heartbeat,
        _ => return Ok(HookStdin::Ignored),
    };
    if input.session_id.trim().is_empty() {
        return Err("session_id must not be empty".to_string());
    }
    if input.cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }
    Ok(HookStdin::Event(SpoolEvent {
        source: context.map_or_else(
            || AgentSource::parse("claude_code").expect("the canonical id is well shaped"),
            |context| context.source.clone(),
        ),
        external_session_id: input.session_id,
        event,
        occurred_at: now_iso8601(),
        cwd: Some(input.cwd),
        start_head: None,
        repo_root: None,
        repo_remote: None,
        model: non_empty(input.model.as_deref()),
        rule_id: None,
        transcript_path: non_empty(input.transcript_path.as_deref()),
        tokens: context.and_then(|context| context.tokens),
    }))
}

/// Session-id spellings seen across CLI-native payloads, in priority order.
const NATIVE_SESSION_ID_KEYS: [&str; 5] = [
    "conversation_id",
    "session_id",
    "sessionId",
    "sessionID",
    "id",
];

/// Model spellings seen across CLI-native payloads. Only an explicit model
/// field counts: the runtime is never read off a model name, nor the reverse.
const NATIVE_MODEL_KEYS: [&str; 3] = ["model", "model_id", "modelId"];

/// Best-effort event building from a CLI-native payload. The source and event
/// kind always come from the argv context, so registration never depends on the
/// payload carrying an event name. Like Claude's payload, these carry no
/// contract timestamp, so the current time is stamped here. Anything without a
/// usable session id or cwd is accepted and ignored.
fn translate_native(value: &serde_json::Value, context: &ArgvContext) -> HookStdin {
    let session_id = NATIVE_SESSION_ID_KEYS
        .iter()
        .find_map(|key| value.get(key).and_then(|field| field.as_str()))
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let Some(session_id) = session_id else {
        return HookStdin::Ignored;
    };

    let cwd = value
        .get("cwd")
        .and_then(|field| field.as_str())
        .or_else(|| {
            ["workspace_roots", "workspaceRoots"]
                .iter()
                .find_map(|key| {
                    value
                        .get(key)
                        .and_then(|field| field.as_array())
                        .and_then(|roots| roots.first())
                        .and_then(|root| root.as_str())
                })
        })
        .map(str::trim)
        .filter(|dir| !dir.is_empty());
    let Some(cwd) = cwd else {
        return HookStdin::Ignored;
    };

    let model = NATIVE_MODEL_KEYS
        .iter()
        .find_map(|key| value.get(key).and_then(|field| field.as_str()));

    HookStdin::Event(SpoolEvent {
        source: context.source.clone(),
        external_session_id: session_id.to_string(),
        event: context.event,
        occurred_at: now_iso8601(),
        cwd: Some(cwd.to_string()),
        start_head: None,
        repo_root: None,
        repo_remote: None,
        model: non_empty(model),
        rule_id: None,
        transcript_path: None,
        tokens: context.tokens,
    })
}

/// What `read_pending` covered. `acked_bytes` is passed back to
/// `truncate_acked` once the server confirms the upload; corrupt lines are
/// already quarantined, so they count as acked and never block the drain.
pub struct PendingEvents {
    pub events: Vec<SpoolEvent>,
    pub acked_bytes: u64,
}

/// Appends one event as a single JSON line under the interprocess lock,
/// rotating the spool first if the line would push it past the cap. A partial
/// tail left by a crashed append is quarantined before the new line goes on, so
/// a complete line never gets glued onto a fragment.
pub fn append(path: &Path, event: &SpoolEvent) -> SpoolResult<()> {
    append_if(path, event, || true).map(|_| ())
}

pub fn append_if(
    path: &Path,
    event: &SpoolEvent,
    allowed: impl FnOnce() -> bool,
) -> SpoolResult<bool> {
    let mut line = serde_json::to_vec(event).map_err(io::Error::other)?;
    line.push(b'\n');
    with_lock(path, || {
        if !allowed() {
            return Ok(false);
        }
        append_line_locked(path, &line, MAX_SPOOL_BYTES, MAX_PENDING_SPOOL_BYTES)?;
        Ok(true)
    })
}

/// Reads every complete event without removing anything. A trailing partial
/// line (crash mid-append) is moved aside to `<spool>.partial`, and lines that
/// fail to parse go to `<spool>.corrupt`; neither fails the drain.
pub fn read_pending(path: &Path) -> SpoolResult<PendingEvents> {
    let (events, acked_bytes) = read_pending_lines(path)?;
    Ok(PendingEvents {
        events,
        acked_bytes,
    })
}

/// Returns every spool generation, oldest first.
pub fn pending_spool_paths(path: &Path) -> SpoolResult<Vec<PathBuf>> {
    with_lock(path, || {
        let mut paths = sealed_spool_paths_locked(path)?;
        if has_pending_bytes(path)? {
            paths.push(path.to_path_buf());
        }
        Ok(paths)
    })
}

pub fn seal_pending_spool_paths(path: &Path) -> SpoolResult<Vec<PathBuf>> {
    with_lock(path, || {
        let mut paths = sealed_spool_paths_locked(path)?;
        if has_pending_bytes(path)? {
            paths.push(rotate(path)?);
        }
        Ok(paths)
    })
}

/// The line-typed core of `read_pending`, shared with the segment spool the
/// activity monitor drains (same durability discipline, different row type).
pub(crate) fn read_pending_lines<T: serde::de::DeserializeOwned>(
    path: &Path,
) -> SpoolResult<(Vec<T>, u64)> {
    with_lock(path, || {
        let content = match std::fs::read(path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok((Vec::new(), 0));
            }
            Err(error) => return Err(error),
        };

        let complete_len = content
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        if complete_len < content.len() {
            quarantine(path, ".partial", &content[complete_len..])?;
            rewrite(path, &content[..complete_len])?;
        }

        let mut events = Vec::new();
        for line in content[..complete_len].split(|byte| *byte == b'\n') {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<T>(line) {
                Ok(event) => events.push(event),
                // A line that fails to parse is quarantined, not fatal. It still
                // counts toward acked_bytes, so it leaves the spool on truncate.
                Err(_) => quarantine(path, ".corrupt", line)?,
            }
        }
        Ok((events, complete_len as u64))
    })
}

/// Drops the acknowledged prefix once the server has confirmed it, keeping
/// anything appended since the read. A spool that was rotated or replaced in
/// between is left alone: replaying it is safe, truncating it could lose data.
pub fn truncate_acked(path: &Path, acked_bytes: u64) -> SpoolResult<()> {
    if acked_bytes == 0 {
        return Ok(());
    }
    with_lock(path, || {
        let content = match std::fs::read(path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if (content.len() as u64) < acked_bytes {
            return Ok(());
        }
        rewrite(path, &content[acked_bytes as usize..])
    })
}

/// Removes a spool and every generation and quarantine sibling, assuming the
/// caller already holds the interprocess lock. This is deliberate evidence
/// destruction — a browser collection being revoked, say — not a drain: the
/// whole spool goes, so a later re-enrollment cannot resurface stale spans.
pub fn discard_locked(path: &Path) -> SpoolResult<()> {
    for candidate in all_spool_paths_locked(path)? {
        remove_if_exists(&candidate)?;
    }
    for tag in [".partial", ".corrupt"] {
        remove_if_exists(&sibling(path, tag))?;
    }
    Ok(())
}

/// The data directory this app writes today.
const DATA_DIR_NAME: &str = "siqshift";

/// What the same directory was called before the SIQshift rename. An install
/// upgrading from Clock-In still has its spool here, and the spool is not a
/// cache: it holds activity already recorded and NOT yet uploaded. A fresh
/// `siqshift` directory would strand those records where nothing ever reads
/// them again, so the customer silently loses work that was captured.
const LEGACY_DATA_DIR_NAME: &str = "clock-in";

/// Pick the data directory, preferring the current name and adopting the
/// pre-rename one when it is the only one present.
///
/// Deliberately a READ, not a migration. Three binaries resolve this
/// independently — the app, `siqshift-hook`, and `siqshift-browser-host` — and
/// any of them can start at any moment, so moving files here would race a hook
/// mid-append for the one file that must never lose a line. Adopting in place
/// costs an upgraded machine nothing but a stale directory name on disk, which
/// no user sees.
fn resolve_data_dir(base: &Path, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let current = base.join(DATA_DIR_NAME);
    if exists(&current) {
        return current;
    }
    let legacy = base.join(LEGACY_DATA_DIR_NAME);
    if exists(&legacy) {
        return legacy;
    }
    current
}

fn app_data_dir() -> PathBuf {
    resolve_data_dir(&default_data_dir(), |path| path.exists())
}

/// Where the spool lives unless `SIQSHIFT_SPOOL` says otherwise:
/// `%APPDATA%/siqshift/agent-spool.jsonl` on Windows, the XDG data dir
/// elsewhere — or the pre-rename `clock-in` directory when this machine is
/// carrying one, see [`resolve_data_dir`].
pub fn default_spool_path() -> PathBuf {
    if let Some(override_path) = std::env::var_os(SPOOL_ENV_VAR).filter(|value| !value.is_empty()) {
        return PathBuf::from(override_path);
    }
    app_data_dir().join("agent-spool.jsonl")
}

/// The directory the browser spool, rules file, tally, and handshake marker
/// live in: beside the agent spool, so the `SIQSHIFT_SPOOL` override relocates
/// the whole set for tests and support setups.
pub fn default_browser_dir() -> PathBuf {
    default_spool_path()
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn active_identity_path() -> PathBuf {
    default_browser_dir().join("active-identity.json")
}

fn active_identity_path_for_root(root: &Path) -> PathBuf {
    root.parent()
        .map(|parent| parent.join("active-identity.json"))
        .unwrap_or_else(|| PathBuf::from("active-identity.json"))
}

fn evidence_root() -> PathBuf {
    default_browser_dir().join("evidence")
}

fn identity_component_is_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[cfg(test)]
fn reserve_namespace_slot_at(root: &Path, reserved: Option<&EvidenceIdentity>) -> SpoolResult<()> {
    with_lock(root, || {
        let active_path = active_identity_path_for_root(root);
        recover_rewrite_files_locked(&active_path)?;
        let active_dir = active_identity_at(&active_path)
            .map(|identity| evidence_paths_at(root, &identity).browser_dir);
        reserve_namespace_slot_at_locked(root, reserved, active_dir.as_deref())
    })
}

fn check_namespace_capacity(root: &Path, reserved: Option<&EvidenceIdentity>) -> SpoolResult<()> {
    let active_path = active_identity_path_for_root(root);
    with_lock(root, || {
        recover_rewrite_files_locked(&active_path)?;
        let active_dir = active_identity_at(&active_path)
            .map(|identity| evidence_paths_at(root, &identity).browser_dir);
        check_namespace_capacity_at_locked(root, reserved, active_dir.as_deref())
    })
}

fn check_namespace_capacity_at_locked(
    root: &Path,
    reserved: Option<&EvidenceIdentity>,
    active_dir: Option<&Path>,
) -> SpoolResult<()> {
    let reserved_dir = reserved.map(|identity| {
        root.join(&identity.account_id)
            .join(&identity.organization_id)
    });
    let mut candidates = Vec::new();
    let mut namespaces = 0usize;
    match std::fs::read_dir(root) {
        Ok(accounts) => {
            for account in accounts {
                let account = account?;
                if !account.file_type()?.is_dir() {
                    continue;
                }
                for organization in std::fs::read_dir(account.path())? {
                    let organization = organization?;
                    if !organization.file_type()?.is_dir() {
                        continue;
                    }
                    let path = organization.path();
                    namespaces += 1;
                    if active_dir.is_some_and(|active| path == active)
                        || reserved_dir
                            .as_ref()
                            .is_some_and(|reserved| path == *reserved)
                    {
                        continue;
                    }
                    candidates.push(path);
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let reserve_count = match &reserved_dir {
        Some(path) if path.is_dir() => 0,
        Some(_) => 1,
        None => 1,
    };
    let required_evictions = namespaces
        .saturating_add(reserve_count)
        .saturating_sub(MAX_RETAINED_NAMESPACES);
    if required_evictions == 0 {
        return Ok(());
    }
    let evictable = candidates.iter().try_fold(0usize, |count, path| {
        Ok::<_, io::Error>(count + usize::from(namespace_is_evictable_while_root_locked(path)?))
    })?;
    if evictable >= required_evictions {
        return Ok(());
    }
    Err(namespace_capacity_error())
}

fn reserve_namespace_slot_at_locked(
    root: &Path,
    reserved: Option<&EvidenceIdentity>,
    active_dir: Option<&Path>,
) -> SpoolResult<()> {
    let reserved_dir = reserved.map(|identity| {
        root.join(&identity.account_id)
            .join(&identity.organization_id)
    });
    let mut candidates = Vec::new();
    let mut namespaces = 0usize;
    match std::fs::read_dir(root) {
        Ok(accounts) => {
            for account in accounts {
                let account = account?;
                if !account.file_type()?.is_dir() {
                    continue;
                }
                for organization in std::fs::read_dir(account.path())? {
                    let organization = organization?;
                    if !organization.file_type()?.is_dir() {
                        continue;
                    }
                    let path = organization.path();
                    namespaces += 1;
                    if active_dir.is_some_and(|active| path == active)
                        || reserved_dir
                            .as_ref()
                            .is_some_and(|reserved| path == *reserved)
                    {
                        continue;
                    }
                    let touched = std::fs::read_to_string(path.join(".last-active"))
                        .ok()
                        .and_then(|value| value.trim().parse::<u64>().ok())
                        .or_else(|| {
                            std::fs::metadata(&path)
                                .ok()
                                .and_then(|metadata| metadata.modified().ok())
                                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                                .map(|duration| duration.as_secs())
                        })
                        .unwrap_or(0);
                    candidates.push((touched, path));
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let reserve_count = match &reserved_dir {
        Some(path) if path.is_dir() => 0,
        Some(_) => 1,
        None => 1,
    };
    candidates.sort_by_key(|(touched, _)| *touched);
    for (_, path) in candidates {
        if namespaces.saturating_add(reserve_count) <= MAX_RETAINED_NAMESPACES {
            break;
        }
        let Some(lease) = try_acquire_namespace_writer_lease_while_root_locked(&path)? else {
            continue;
        };
        let has_pending_evidence = namespace_has_pending_evidence_while_leased(&path)?;
        drop(lease);
        if !has_pending_evidence {
            std::fs::remove_dir_all(path)?;
            namespaces = namespaces.saturating_sub(1);
        }
    }
    if namespaces.saturating_add(reserve_count) > MAX_RETAINED_NAMESPACES {
        return Err(namespace_capacity_error());
    }
    Ok(())
}

fn namespace_capacity_error() -> io::Error {
    io::Error::other(
        "We saved unsynced work for another workspace. Sign back into that workspace and let SIQshift finish syncing before adding a new account.",
    )
}

fn namespace_reservation_path(dir: &Path) -> PathBuf {
    dir.join(NAMESPACE_RESERVATION_FILE)
}

fn namespace_reservation_record(path: &Path) -> SpoolResult<Option<WorkspaceMoveRecord>> {
    match std::fs::read(path) {
        Ok(bytes) => parse_workspace_move_record(&bytes)
            .map(Some)
            .map_err(|_| io::Error::other("evidence namespace reservation is invalid")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
fn namespace_has_pending_evidence(dir: &Path) -> SpoolResult<bool> {
    with_namespace_writer_lease(dir, || namespace_has_pending_evidence_while_leased(dir))
}

fn namespace_is_evictable_while_root_locked(dir: &Path) -> SpoolResult<bool> {
    let Some(lease) = try_acquire_namespace_writer_lease_while_root_locked(dir)? else {
        return Ok(false);
    };
    let evictable = !namespace_has_pending_evidence_while_leased(dir)?;
    drop(lease);
    Ok(evictable)
}

fn namespace_has_pending_evidence_while_leased(dir: &Path) -> SpoolResult<bool> {
    let reservation_path = namespace_reservation_path(dir);
    recover_rewrite_files_locked(&reservation_path)?;
    if namespace_reservation_record(&reservation_path)?.is_some() {
        return Ok(true);
    }
    for name in [
        "agent-spool.jsonl",
        "segments-spool.jsonl",
        "browser-spool.jsonl",
    ] {
        if !pending_spool_paths_while_leased(&dir.join(name))?.is_empty() {
            return Ok(true);
        }
    }
    match std::fs::read(dir.join("recovery.json")) {
        Ok(bytes) => match serde_json::from_slice::<crate::recovery::RecoveryState>(&bytes) {
            Ok(recovery) => {
                if !recovery.open_sessions.is_empty() {
                    return Ok(true);
                }
            }
            Err(_) => return Ok(true),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(shift_commits_have_unsynced_evidence(dir))
}

/// A commit still waiting on an upload verdict, decoded without depending on
/// `shift_commits`'s full row shape — unknown fields are ignored by serde, so
/// this stays correct as that shape grows. Read-only and best-effort: a
/// missing or unreadable file just means there is nothing pending yet.
#[derive(serde::Deserialize)]
struct PendingShiftCommitProbe {
    #[serde(default)]
    synced: bool,
    #[serde(default)]
    rejected: bool,
}

fn shift_commits_have_unsynced_evidence(dir: &Path) -> bool {
    let Ok(bytes) = std::fs::read(dir.join("shift-commits.json")) else {
        return false;
    };
    serde_json::from_slice::<Vec<PendingShiftCommitProbe>>(&bytes)
        .map(|entries| entries.iter().any(|entry| !entry.synced && !entry.rejected))
        .unwrap_or(false)
}

fn pending_spool_paths_while_leased(path: &Path) -> SpoolResult<Vec<PathBuf>> {
    with_lock_without_namespace_lease(path, || {
        let mut paths = sealed_spool_paths_locked(path)?;
        if has_pending_bytes(path)? {
            paths.push(path.to_path_buf());
        }
        Ok(paths)
    })
}

#[cfg(windows)]
fn default_data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

#[cfg(not(windows))]
fn default_data_dir() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return PathBuf::from(xdg);
    }
    if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
        return PathBuf::from(home).join(".local/share");
    }
    std::env::temp_dir()
}

/// The current time in the ISO-8601 form the hook contract expects, computed
/// by hand so the hook binary needs no datetime dependency.
pub fn now_iso8601() -> String {
    format_iso8601(unix_seconds())
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn format_iso8601(unix_secs: u64) -> String {
    let days = unix_secs / 86_400;
    let rem = unix_secs % 86_400;
    let (hour, minute, second) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);

    // Civil date from days since epoch (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// The locked whole-line append core, shared with the segment spool and the
/// browser host (whose lines are written via `append`, but a raw line is
/// exposed for writers with their own encoding).
pub fn append_line(path: &Path, line: &[u8], max_bytes: u64) -> SpoolResult<()> {
    append_line_with_pending_limit(path, line, max_bytes, MAX_PENDING_SPOOL_BYTES)
}

fn append_line_with_pending_limit(
    path: &Path,
    line: &[u8],
    max_bytes: u64,
    pending_limit: u64,
) -> SpoolResult<()> {
    with_lock(path, || {
        append_line_locked(path, line, max_bytes, pending_limit)
    })
}

pub fn write_atomically(path: &Path, content: &[u8]) -> SpoolResult<()> {
    with_lock(path, || rewrite(path, content))
}

pub fn ensure_namespace_directory(dir: &Path) -> SpoolResult<()> {
    let Some(location) = namespace_location(dir) else {
        return std::fs::create_dir_all(dir);
    };
    let root_guard = acquire_lock(&location.root)?;
    if !location.namespace.is_dir() {
        drop(root_guard);
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "evidence namespace is no longer active",
        ));
    }
    std::fs::create_dir_all(dir)
}

fn append_line_locked(
    path: &Path,
    line: &[u8],
    max_bytes: u64,
    pending_limit: u64,
) -> SpoolResult<()> {
    if line.len() > MAX_SPOOL_RECORD_BYTES {
        return Err(io::Error::other("spool record exceeds the maximum size"));
    }
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if size > 0 && !ends_with_newline(path)? {
        repair_partial_tail(path)?;
    }
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let pending_after_append = pending_spool_bytes_locked(path)?
        .checked_add(line.len() as u64)
        .ok_or_else(|| io::Error::other("spool pending evidence exceeds capacity"))?;
    if pending_after_append > pending_limit {
        return Err(io::Error::other(
            "SIQshift saved existing offline evidence and paused new capture until it syncs.",
        ));
    }
    if size > 0 && size + line.len() as u64 > max_bytes {
        rotate(path)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line)
}

fn pending_spool_bytes_locked(path: &Path) -> SpoolResult<u64> {
    all_spool_paths_locked(path)?
        .into_iter()
        .try_fold(0u64, |total, candidate| {
            [
                candidate.clone(),
                sibling(&candidate, ".partial"),
                sibling(&candidate, ".corrupt"),
            ]
            .into_iter()
            .try_fold(total, |total, candidate| {
                match std::fs::metadata(candidate) {
                    Ok(metadata) => total
                        .checked_add(metadata.len())
                        .ok_or_else(|| io::Error::other("spool pending evidence exceeds capacity")),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(total),
                    Err(error) => Err(error),
                }
            })
        })
}

fn ends_with_newline(path: &Path) -> io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = OpenOptions::new().read(true).open(path)?;
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    Ok(last[0] == b'\n')
}

/// Moves a fragment left by a crashed append aside so the next line starts clean.
fn repair_partial_tail(path: &Path) -> SpoolResult<()> {
    let content = std::fs::read(path)?;
    match content.iter().rposition(|byte| *byte == b'\n') {
        Some(index) => {
            quarantine(path, ".partial", &content[index + 1..])?;
            rewrite(path, &content[..index + 1])
        }
        None => {
            quarantine(path, ".partial", &content)?;
            rewrite(path, &[])
        }
    }
}

fn rotate(path: &Path) -> SpoolResult<PathBuf> {
    let target = next_generation_path_locked(path)?;
    std::fs::rename(path, &target)?;
    Ok(target)
}

fn legacy_rotated_path(path: &Path) -> PathBuf {
    path.with_extension("old.jsonl")
}

fn all_spool_paths_locked(path: &Path) -> SpoolResult<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let legacy = legacy_rotated_path(path);
    match std::fs::metadata(&legacy) {
        Ok(_) => paths.push(legacy),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    paths.extend(numbered_generation_paths_locked(path)?);
    paths.push(path.to_path_buf());
    Ok(paths)
}

fn sealed_spool_paths_locked(path: &Path) -> SpoolResult<Vec<PathBuf>> {
    all_spool_paths_locked(path)?
        .into_iter()
        .filter(|candidate| candidate != path)
        .filter_map(|candidate| match has_pending_bytes(&candidate) {
            Ok(true) => Some(Ok(candidate)),
            Ok(false) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn numbered_generation_paths_locked(path: &Path) -> SpoolResult<Vec<PathBuf>> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut generations = Vec::new();
    for entry in std::fs::read_dir(parent)? {
        let candidate = entry?.path();
        if let Some(number) = generation_number(path, &candidate) {
            generations.push((number, candidate));
        }
    }
    generations.sort_by_key(|(number, _)| *number);
    Ok(generations.into_iter().map(|(_, path)| path).collect())
}

fn recover_numbered_generation_rewrite_files_locked(path: &Path) -> SpoolResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut generations = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(parent)? {
        let candidate = entry?.path();
        if let Some((_, generation)) = numbered_generation_path(path, &candidate) {
            generations.insert(generation);
        }
    }
    for generation in generations {
        recover_rewrite_files_locked(&generation)?;
    }
    Ok(())
}

fn next_generation_path_locked(path: &Path) -> SpoolResult<PathBuf> {
    let highest_existing = numbered_generation_paths_locked(path)?
        .iter()
        .filter_map(|candidate| generation_number(path, candidate))
        .max()
        .unwrap_or(0);
    let sequence = match std::fs::read_to_string(generation_sequence_path(path)) {
        Ok(value) => value
            .trim()
            .parse::<u64>()
            .unwrap_or_else(|_| recovered_generation_sequence()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => recovered_generation_sequence(),
        Err(error) => return Err(error),
    };
    let next = sequence
        .max(highest_existing)
        .checked_add(1)
        .ok_or_else(|| io::Error::other("spool generation sequence is exhausted"))?;
    rewrite(&generation_sequence_path(path), next.to_string().as_bytes())?;
    Ok(path.with_extension(format!("generation-{next:020}.jsonl")))
}

fn recovered_generation_sequence() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| {
            duration
                .as_secs()
                .saturating_mul(1_000_000_000)
                .saturating_add(u64::from(duration.subsec_nanos()))
        })
        .unwrap_or(0)
}

fn generation_sequence_path(path: &Path) -> PathBuf {
    sibling(path, ".generation-sequence")
}

fn generation_number(path: &Path, candidate: &Path) -> Option<u64> {
    let stem = path.file_stem()?.to_str()?;
    let name = candidate.file_name()?.to_str()?;
    name.strip_prefix(&format!("{stem}.generation-"))?
        .strip_suffix(".jsonl")?
        .parse()
        .ok()
}

fn numbered_generation_path(path: &Path, candidate: &Path) -> Option<(u64, PathBuf)> {
    let name = candidate.file_name()?.to_str()?;
    let final_name = name
        .strip_suffix(".tmp")
        .or_else(|| name.strip_suffix(".bak"))
        .unwrap_or(name);
    let generation = candidate.with_file_name(final_name);
    Some((generation_number(path, &generation)?, generation))
}

fn has_pending_bytes(path: &Path) -> SpoolResult<bool> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len() > 0),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_if_exists(path: &Path) -> SpoolResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn quarantine(path: &Path, tag: &str, bytes: &[u8]) -> SpoolResult<()> {
    if bytes.is_empty() {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(sibling(path, tag))?;
    file.write_all(bytes)?;
    if !bytes.ends_with(b"\n") {
        file.write_all(b"\n")?;
    }
    Ok(())
}

/// Replaces the spool with `content` via a temp file, so a crash mid-rewrite
/// cannot leave a half-written spool behind.
fn rewrite(path: &Path, content: &[u8]) -> SpoolResult<()> {
    if content.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        };
    }
    let tmp = sibling(path, ".tmp");
    let backup = sibling(path, ".bak");
    remove_if_exists(&tmp)?;
    remove_if_exists(&backup)?;
    let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
    file.write_all(content)?;
    file.sync_all()?;
    drop(file);
    match std::fs::rename(path, &backup) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::rename(&tmp, path)?;
    remove_if_exists(&backup)
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Runs `action` under the spool's interprocess lock. Shared with writers
/// outside the append path (the browser files' temp-and-rename writes), which
/// face the same multi-process races as the spool itself.
pub fn with_lock<T>(path: &Path, action: impl FnOnce() -> SpoolResult<T>) -> SpoolResult<T> {
    with_namespace_writer_lease(path, || with_lock_without_namespace_lease(path, action))
}

fn with_lock_without_namespace_lease<T>(
    path: &Path,
    action: impl FnOnce() -> SpoolResult<T>,
) -> SpoolResult<T> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _guard = acquire_lock(path)?;
    recover_rewrite_files_locked(path)?;
    recover_numbered_generation_rewrite_files_locked(path)?;
    action()
}

#[derive(Clone)]
struct NamespaceLocation {
    root: PathBuf,
    namespace: PathBuf,
}

fn namespace_location(path: &Path) -> Option<NamespaceLocation> {
    let mut root = PathBuf::new();
    let mut components = path.components();
    while let Some(component) = components.next() {
        root.push(component.as_os_str());
        if component.as_os_str() != "evidence" {
            continue;
        }
        let account = components.next()?.as_os_str().to_owned();
        let organization = components.next()?.as_os_str().to_owned();
        let namespace = root.join(account).join(organization);
        return Some(NamespaceLocation { root, namespace });
    }
    None
}

fn namespace_writer_lease_path(namespace: &Path) -> PathBuf {
    namespace.join(".namespace-writer")
}

thread_local! {
    static HELD_NAMESPACE_LEASES: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
}

fn namespace_lease_is_held(namespace: &Path) -> bool {
    HELD_NAMESPACE_LEASES.with(|leases| leases.borrow().iter().any(|held| held == namespace))
}

struct NamespaceLeaseGuard {
    namespace: PathBuf,
    _lease: LockGuard,
}

impl Drop for NamespaceLeaseGuard {
    fn drop(&mut self) {
        HELD_NAMESPACE_LEASES.with(|leases| {
            let mut leases = leases.borrow_mut();
            if let Some(index) = leases.iter().rposition(|held| held == &self.namespace) {
                leases.remove(index);
            }
        });
    }
}

fn with_namespace_writer_lease<T>(
    path: &Path,
    action: impl FnOnce() -> SpoolResult<T>,
) -> SpoolResult<T> {
    let Some(location) = namespace_location(path) else {
        return action();
    };
    if namespace_lease_is_held(&location.namespace) {
        return action();
    }
    let root_guard = acquire_lock(&location.root)?;
    if !location.namespace.is_dir() {
        drop(root_guard);
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "evidence namespace is no longer active",
        ));
    }
    let lease = acquire_lock(&namespace_writer_lease_path(&location.namespace))?;
    drop(root_guard);
    HELD_NAMESPACE_LEASES.with(|leases| leases.borrow_mut().push(location.namespace.clone()));
    let _guard = NamespaceLeaseGuard {
        namespace: location.namespace,
        _lease: lease,
    };
    action()
}

fn try_acquire_namespace_writer_lease_while_root_locked(
    namespace: &Path,
) -> SpoolResult<Option<LockGuard>> {
    if !namespace.is_dir() {
        return Ok(None);
    }
    try_acquire_lock(&namespace_writer_lease_path(namespace))
}

fn recover_rewrite_files_locked(path: &Path) -> SpoolResult<()> {
    let tmp = sibling(path, ".tmp");
    let backup = sibling(path, ".bak");
    let path_exists = path.exists();
    if !path_exists && tmp.exists() {
        std::fs::rename(&tmp, path)?;
    } else if !path_exists && backup.exists() {
        std::fs::rename(&backup, path)?;
    } else {
        remove_if_exists(&tmp)?;
    }
    if path.exists() {
        remove_if_exists(&backup)?;
    }
    Ok(())
}

fn acquire_lock(path: &Path) -> SpoolResult<LockGuard> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(sibling(path, ".lock"))?;
    let started = Instant::now();
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(LockGuard(lock)),
            Err(std::fs::TryLockError::WouldBlock) => {
                if started.elapsed() >= LOCK_WAIT_LIMIT {
                    return Err(io::Error::other("timed out waiting for the spool lock"));
                }
                thread::sleep(LOCK_RETRY_DELAY);
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error),
        }
    }
}

fn try_acquire_lock(path: &Path) -> SpoolResult<Option<LockGuard>> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(sibling(path, ".lock"))?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(LockGuard(lock))),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }
}

struct LockGuard(std::fs::File);

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    /// A canonical runtime id, since the tests name runtimes the same way
    /// the hook contract does.
    fn source(id: &str) -> AgentSource {
        AgentSource::parse(id).expect("the test names a well-shaped runtime")
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("siqshift-spool-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        dir
    }

    fn event(session: &str) -> SpoolEvent {
        SpoolEvent {
            source: source("claude_code"),
            external_session_id: session.to_string(),
            event: AgentEventKind::Started,
            occurred_at: "2026-08-07T12:00:00Z".to_string(),
            cwd: Some("C:/dev/SIQshift".to_string()),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            model: None,
            rule_id: None,
            transcript_path: None,
            tokens: None,
        }
    }

    fn spool_lines(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .expect("spool reads")
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn a_valid_hook_payload_maps_to_the_canonical_event() {
        let input = HookInput::parse(
            r#"{"version":1,"source":"claude-code","event":"session-start","sessionId":"s1","cwd":"C:/dev/SIQshift","occurredAt":"2026-08-07T12:00:00Z"}"#,
        )
        .expect("payload parses");

        assert_eq!(input.into_event(), event("s1"));
    }

    fn claude_event(json: &str) -> SpoolEvent {
        match parse_stdin(json).expect("claude payload translates") {
            HookStdin::Event(event) => event,
            HookStdin::Ignored => panic!("expected a translated event"),
        }
    }

    #[test]
    fn claude_session_start_and_end_translate_to_lifecycle_events() {
        let started = claude_event(
            r#"{"session_id":"s1","transcript_path":"/tmp/t.jsonl","cwd":"C:/dev/SIQshift","hook_event_name":"SessionStart","source":"startup"}"#,
        );
        assert_eq!(started.source, source("claude_code"));
        assert_eq!(started.event, AgentEventKind::Started);
        assert_eq!(started.external_session_id, "s1");
        assert_eq!(started.cwd.as_deref(), Some("C:/dev/SIQshift"));
        // Claude's payload has no timestamp; the hook stamps the current time.
        assert!(started.occurred_at.ends_with('Z'));

        let ended = claude_event(
            r#"{"session_id":"s1","transcript_path":"/tmp/t.jsonl","cwd":"C:/dev/SIQshift","hook_event_name":"SessionEnd","reason":"clear"}"#,
        );
        assert_eq!(ended.event, AgentEventKind::Ended);
        assert_eq!(ended.source, source("claude_code"));
    }

    #[test]
    fn claude_post_tool_use_translates_to_a_heartbeat() {
        let heartbeat = claude_event(
            r#"{"session_id":"s1","transcript_path":"/tmp/t.jsonl","cwd":"/x","hook_event_name":"PostToolUse","tool_name":"Bash"}"#,
        );

        assert_eq!(heartbeat.event, AgentEventKind::Heartbeat);
        assert_eq!(heartbeat.source, source("claude_code"));
    }

    #[test]
    fn claude_transcript_path_lands_on_the_event_for_the_usage_reader() {
        let started = claude_event(
            r#"{"session_id":"s1","transcript_path":"/tmp/t.jsonl","cwd":"C:/dev/SIQshift","hook_event_name":"SessionStart","source":"startup"}"#,
        );
        assert_eq!(started.transcript_path.as_deref(), Some("/tmp/t.jsonl"));

        // The path is local evidence: it survives the spool round-trip so the
        // reader finds it again after a restart.
        let line = serde_json::to_string(&started).expect("event serializes");
        let value: serde_json::Value = serde_json::from_str(&line).expect("line parses");
        assert_eq!(value["transcriptPath"], "/tmp/t.jsonl");
        assert_eq!(
            serde_json::from_str::<SpoolEvent>(&line).expect("line round-trips"),
            started
        );
    }

    #[test]
    fn cumulative_token_counters_round_trip_on_the_spool_line() {
        let mut counted = event("s1");
        counted.tokens = Some(TokenCounters {
            input_tokens: Some(1200),
            output_tokens: Some(300),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: Some(45_000),
        });

        let line = serde_json::to_string(&counted).expect("event serializes");
        let value: serde_json::Value = serde_json::from_str(&line).expect("line parses");
        assert_eq!(value["tokens"]["inputTokens"], 1200);
        assert_eq!(value["tokens"]["cacheReadInputTokens"], 45_000);
        assert!(
            value["tokens"].get("cacheCreationInputTokens").is_none(),
            "an unreported counter stays absent"
        );
        assert_eq!(
            serde_json::from_str::<SpoolEvent>(&line).expect("line round-trips"),
            counted
        );

        // An event without capture-only fields gains no keys at all.
        let plain = serde_json::to_string(&event("s1")).expect("event serializes");
        let plain_value: serde_json::Value = serde_json::from_str(&plain).expect("line parses");
        assert!(plain_value.get("tokens").is_none());
        assert!(plain_value.get("transcriptPath").is_none());
    }

    #[test]
    fn other_claude_hook_events_are_accepted_and_ignored() {
        let outcome = parse_stdin(
            r#"{"session_id":"s1","cwd":"/x","hook_event_name":"Notification","message":"hi"}"#,
        )
        .expect("unknown claude events are not errors");

        assert!(matches!(outcome, HookStdin::Ignored));
    }

    #[test]
    fn claude_payloads_without_identity_fields_are_rejected() {
        let no_session = parse_stdin(r#"{"cwd":"/x","hook_event_name":"SessionStart"}"#);
        assert!(no_session.is_err());

        let empty_cwd =
            parse_stdin(r#"{"session_id":"s1","cwd":"  ","hook_event_name":"SessionEnd"}"#);
        assert!(empty_cwd.is_err());
    }

    #[test]
    fn the_contract_shape_wins_over_claude_translation() {
        // A contract payload is never mistaken for a Claude payload.
        let outcome = parse_stdin(
            r#"{"version":1,"source":"kimi-code","event":"session-end","sessionId":"s9","cwd":"/x","occurredAt":"2026-08-07T12:00:00Z"}"#,
        )
        .expect("contract payload parses");

        match outcome {
            HookStdin::Event(event) => {
                assert_eq!(event.source, source("kimi_code"));
                assert_eq!(event.occurred_at, "2026-08-07T12:00:00Z");
            }
            HookStdin::Ignored => panic!("contract payloads are never ignored"),
        }
    }

    #[test]
    fn non_claude_garbage_still_reports_the_contract_error() {
        let error = parse_stdin(
            r#"{"version":2,"source":"codex","event":"heartbeat","sessionId":"s1","cwd":"/x","occurredAt":"t"}"#,
        )
        .expect_err("still rejected");

        assert!(error.contains("version"));
    }

    fn cursor_context() -> ArgvContext {
        ArgvContext {
            source: source("cursor"),
            event: AgentEventKind::Started,
            tokens: None,
        }
    }

    fn cursor_event(json: &str) -> SpoolEvent {
        match parse_stdin_with_context(json, Some(cursor_context()))
            .expect("cursor payloads are never errors")
        {
            HookStdin::Event(event) => event,
            HookStdin::Ignored => panic!("expected an extracted event"),
        }
    }

    #[test]
    fn a_cursor_payload_extracts_session_id_and_cwd_under_the_argv_identity() {
        let event = cursor_event(r#"{"conversation_id":"c1","cwd":"/repo"}"#);

        assert_eq!(event.source, source("cursor"));
        assert_eq!(event.event, AgentEventKind::Started);
        assert_eq!(event.external_session_id, "c1");
        assert_eq!(event.cwd.as_deref(), Some("/repo"));
        // Cursor's payload has no contract timestamp; the hook stamps now.
        assert!(event.occurred_at.ends_with('Z'));
    }

    #[test]
    fn every_cursor_session_id_spelling_is_accepted_in_priority_order() {
        for json in [
            r#"{"session_id":"s1","cwd":"/repo"}"#,
            r#"{"sessionId":"s1","cwd":"/repo"}"#,
            r#"{"sessionID":"s1","cwd":"/repo"}"#,
        ] {
            assert_eq!(cursor_event(json).external_session_id, "s1");
        }

        // conversation_id wins when several spellings coexist.
        let event = cursor_event(r#"{"conversation_id":"c1","session_id":"s1","cwd":"/repo"}"#);
        assert_eq!(event.external_session_id, "c1");
    }

    #[test]
    fn the_cursor_cwd_falls_back_to_the_first_workspace_root() {
        let snake =
            cursor_event(r#"{"conversation_id":"c1","workspace_roots":["/repo","/other"]}"#);
        assert_eq!(snake.cwd.as_deref(), Some("/repo"));

        let camel = cursor_event(r#"{"conversation_id":"c1","workspaceRoots":["/repo"]}"#);
        assert_eq!(camel.cwd.as_deref(), Some("/repo"));
    }

    #[test]
    fn a_cursor_payload_without_identity_fields_is_accepted_and_ignored() {
        let no_session = parse_stdin_with_context(r#"{"cwd":"/repo"}"#, Some(cursor_context()))
            .expect("accepted, not an error");
        assert!(matches!(no_session, HookStdin::Ignored));

        let no_cwd =
            parse_stdin_with_context(r#"{"conversation_id":"c1"}"#, Some(cursor_context()))
                .expect("accepted, not an error");
        assert!(matches!(no_cwd, HookStdin::Ignored));
    }

    #[test]
    fn cursor_extraction_only_applies_with_argv_context() {
        // Without --source/--event the same payload keeps the old behaviour:
        // not a contract payload, not a Claude payload, so the contract error.
        let error = parse_stdin(r#"{"conversation_id":"c1","cwd":"/repo"}"#)
            .expect_err("no context, no cursor extraction");
        assert!(error.contains("invalid hook JSON"));
    }

    #[test]
    fn unparseable_stdin_is_accepted_and_ignored_in_argv_context_mode() {
        let outcome = parse_stdin_with_context("not json at all", Some(cursor_context()))
            .expect("accepted, not an error");

        assert!(matches!(outcome, HookStdin::Ignored));
    }

    #[test]
    fn cursor_serializes_as_the_canonical_source() {
        let line = serde_json::to_string(&SpoolEvent {
            source: source("cursor"),
            ..event("s1")
        })
        .expect("event serializes");

        assert!(line.contains("\"source\":\"cursor\""));
        // And the flag spelling round-trips.
        assert_eq!(
            serde_json::from_str::<AgentSource>("\"cursor\"").expect("source parses"),
            source("cursor")
        );
    }

    #[test]
    fn a_runtime_the_roster_never_heard_of_is_recorded_under_its_own_name() {
        // The roster is not an allowlist. Support for a new CLI must never wait
        // on a schema change, so an undeclared id round-trips untouched instead
        // of being rejected or quietly rewritten to `other`.
        let parsed = HookInput::parse(
            r#"{"version":1,"source":"muse","event":"started","sessionId":"s1","cwd":"/x","occurredAt":"2026-08-10T12:00:00Z"}"#,
        )
        .expect("an undeclared runtime is accepted");
        assert_eq!(parsed.source.as_str(), "muse");

        let brand_new = HookInput::parse(
            r#"{"version":1,"source":"agent_9","event":"started","sessionId":"s1","cwd":"/x","occurredAt":"2026-08-10T12:00:00Z"}"#,
        )
        .expect("a runtime nobody has declared is accepted");
        assert_eq!(brand_new.source.as_str(), "agent_9");
    }

    #[test]
    fn an_ill_shaped_source_is_rejected_here_rather_than_server_side() {
        for bad in [
            "",
            "  ",
            "9lives",
            "Claude Code",
            "pi;rm -rf /",
            &"x".repeat(41),
        ] {
            assert!(
                AgentSource::parse(bad).is_err(),
                "{bad:?} should not be a runtime id",
            );
        }
    }

    #[test]
    fn a_model_rides_beside_the_runtime_without_either_naming_the_other() {
        let parsed = HookInput::parse(
            r#"{"version":1,"source":"pi","event":"started","sessionId":"s1","cwd":"/x","occurredAt":"2026-08-10T12:00:00Z","model":"deepseek-v4-pro"}"#,
        )
        .expect("a model is accepted")
        .into_event();
        // pi driving deepseek-v4-pro is still the pi runtime.
        assert_eq!(parsed.source.as_str(), "pi");
        assert_eq!(parsed.model.as_deref(), Some("deepseek-v4-pro"));

        // And a runtime that names no model records none rather than a guess.
        let bare = HookInput::parse(
            r#"{"version":1,"source":"pi","event":"started","sessionId":"s2","cwd":"/x","occurredAt":"2026-08-10T12:00:00Z"}"#,
        )
        .expect("an absent model is fine")
        .into_event();
        assert_eq!(bare.model, None);
    }

    #[test]
    fn a_claude_shaped_payload_is_filed_under_the_runtime_that_registered_it() {
        // Codex pipes Claude Code's payload shape. Without the argv identity a
        // Codex session would be filed as Claude Code, so the registration —
        // not the shape — decides the runtime.
        let payload = r#"{"hook_event_name":"SessionStart","session_id":"c1","cwd":"/repo","model":"gpt-5.3-codex"}"#;
        let context = ArgvContext {
            source: source("codex"),
            event: AgentEventKind::Started,
            tokens: None,
        };
        let HookStdin::Event(event) = parse_stdin_with_context(payload, Some(context))
            .expect("a Claude-shaped payload parses")
        else {
            panic!("the payload names an event SIQshift tracks");
        };
        assert_eq!(event.source.as_str(), "codex");
        assert_eq!(event.event, AgentEventKind::Started);
        assert_eq!(event.model.as_deref(), Some("gpt-5.3-codex"));

        // A registration written before SIQshift passed --source still means
        // Claude Code, which is the only CLI that ever registered that way.
        let HookStdin::Event(legacy) =
            parse_stdin(payload).expect("a Claude-shaped payload parses")
        else {
            panic!("the payload names an event SIQshift tracks");
        };
        assert_eq!(legacy.source.as_str(), "claude_code");
    }

    #[test]
    fn a_native_payload_gives_up_its_model_under_every_documented_spelling() {
        for json in [
            r#"{"session_id":"s1","cwd":"/repo","model":"deepseek-v4-pro"}"#,
            r#"{"session_id":"s1","cwd":"/repo","model_id":"deepseek-v4-pro"}"#,
            r#"{"session_id":"s1","cwd":"/repo","modelId":"deepseek-v4-pro"}"#,
        ] {
            let context = ArgvContext {
                source: source("pi"),
                event: AgentEventKind::Started,
                tokens: None,
            };
            let HookStdin::Event(event) = parse_stdin_with_context(json, Some(context))
                .expect("native payloads are never errors")
            else {
                panic!("the payload carries a session id and cwd");
            };
            assert_eq!(event.source.as_str(), "pi");
            assert_eq!(event.model.as_deref(), Some("deepseek-v4-pro"));
        }
    }

    #[test]
    fn argv_token_flags_ride_the_event_whatever_shape_stdin_takes() {
        let tokens = TokenCounters {
            input_tokens: Some(900),
            output_tokens: Some(120),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
        };
        let context = || ArgvContext {
            source: source("pi"),
            event: AgentEventKind::Heartbeat,
            tokens: Some(tokens),
        };

        // A CLI-native payload: the flags are the only token channel.
        let HookStdin::Event(native) =
            parse_stdin_with_context(r#"{"session_id":"s1","cwd":"/repo"}"#, Some(context()))
                .expect("native payloads are never errors")
        else {
            panic!("the payload carries a session id and cwd");
        };
        assert_eq!(native.tokens, Some(tokens));

        // A Claude-shaped payload (Codex registration): same flags, same ride.
        let HookStdin::Event(claude) = parse_stdin_with_context(
            r#"{"hook_event_name":"PostToolUse","session_id":"s1","cwd":"/repo"}"#,
            Some(context()),
        )
        .expect("a Claude-shaped payload parses") else {
            panic!("PostToolUse translates to a heartbeat");
        };
        assert_eq!(claude.tokens, Some(tokens));
    }

    #[test]
    fn kebab_and_snake_case_spellings_both_parse() {
        let parsed = HookInput::parse(
            r#"{"version":1,"source":"kimi_code","event":"ended","sessionId":"s1","cwd":"/x","occurredAt":"t"}"#,
        )
        .expect("snake case parses");

        assert_eq!(parsed.source, source("kimi_code"));
        assert_eq!(parsed.event, AgentEventKind::Ended);
    }

    #[test]
    fn an_unknown_version_is_rejected() {
        let error = HookInput::parse(
            r#"{"version":2,"source":"codex","event":"heartbeat","sessionId":"s1","cwd":"/x","occurredAt":"t"}"#,
        )
        .expect_err("version 2 is unknown");

        assert!(error.contains("version"));
    }

    #[test]
    fn missing_empty_and_unknown_fields_are_rejected() {
        let missing =
            r#"{"version":1,"source":"codex","event":"heartbeat","cwd":"/x","occurredAt":"t"}"#;
        assert!(HookInput::parse(missing).is_err());

        let empty = r#"{"version":1,"source":"codex","event":"heartbeat","sessionId":"  ","cwd":"/x","occurredAt":"t"}"#;
        assert!(HookInput::parse(empty).is_err());

        let unknown_field = r#"{"version":1,"source":"codex","event":"heartbeat","sessionId":"s1","cwd":"/x","occurredAt":"t","extra":true}"#;
        assert!(HookInput::parse(unknown_field).is_err());
    }

    #[test]
    fn the_canonical_line_uses_the_server_shape() {
        let line = serde_json::to_string(&event("s1")).expect("event serializes");
        let value: serde_json::Value = serde_json::from_str(&line).expect("line parses");

        assert_eq!(value["source"], "claude_code");
        assert_eq!(value["event"], "started");
        assert_eq!(value["externalSessionId"], "s1");
        assert!(value.get("sessionId").is_none());
    }

    #[test]
    fn a_browser_line_carries_a_rule_id_and_no_cwd() {
        let line = SpoolEvent {
            source: AgentSource::browser(),
            external_session_id: "span-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: "2026-08-09T12:00:00Z".to_string(),
            cwd: None,
            start_head: None,
            repo_root: None,
            repo_remote: None,
            model: None,
            rule_id: Some("r1".to_string()),
            transcript_path: None,
            tokens: None,
        };
        let encoded = serde_json::to_string(&line).expect("event serializes");
        let value: serde_json::Value = serde_json::from_str(&encoded).expect("line parses");

        assert_eq!(value["source"], "browser");
        assert_eq!(value["ruleId"], "r1");
        assert!(value.get("cwd").is_none());

        // And it reads back losslessly; an agent line gains no ruleId key.
        assert_eq!(
            serde_json::from_str::<SpoolEvent>(&encoded).expect("line round-trips"),
            line
        );
        let agent = serde_json::to_string(&event("s1")).expect("event serializes");
        let agent_value: serde_json::Value = serde_json::from_str(&agent).expect("line parses");
        assert!(agent_value.get("ruleId").is_none());
        assert_eq!(agent_value["cwd"], "C:/dev/SIQshift");
    }

    #[test]
    fn concurrent_appends_produce_whole_lines() {
        let dir = temp_dir("concurrent");
        let path = Arc::new(dir.join("agent-spool.jsonl"));

        // Kept small on purpose: lock hand-off favours the thread that just
        // released, so writers effectively serialize, and a large burst can
        // outwait the lock patience on slow (virus-scanned) disks. Real hooks
        // contend two or three processes at a time, not hundreds of appends.
        let handles: Vec<_> = (0..4)
            .map(|thread_index| {
                let path = Arc::clone(&path);
                thread::spawn(move || {
                    for index in 0..15 {
                        append(&path, &event(&format!("t{thread_index}-{index}")))
                            .expect("append succeeds");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("writer thread finishes");
        }

        let lines = spool_lines(&path);
        assert_eq!(lines.len(), 60);
        for line in &lines {
            serde_json::from_str::<SpoolEvent>(line).expect("every line is a whole event");
        }
        assert!(sibling(&path, ".lock").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounded_generations_survive_an_outage_and_drain_in_order() {
        let dir = temp_dir("rotation");
        let path = dir.join("agent-spool.jsonl");
        let line = serde_json::to_vec(&event("s1")).expect("event serializes");
        // Room for roughly two lines per generation.
        let cap = (line.len() as u64) * 2 + 10;

        for index in 0..9 {
            let mut line =
                serde_json::to_vec(&event(&format!("s{index}"))).expect("event serializes");
            line.push(b'\n');
            append_line(&path, &line, cap).expect("append succeeds");
        }

        let pending = pending_spool_paths(&path).expect("generations enumerate");
        assert_eq!(pending.len(), 5);
        assert!(pending.iter().all(|generation| {
            std::fs::metadata(generation)
                .expect("generation exists")
                .len()
                <= cap
        }));
        assert_eq!(
            pending
                .iter()
                .map(|generation| generation.file_name().expect("name").to_owned())
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            pending.len(),
        );

        let mut sessions = Vec::new();
        let sealed = seal_pending_spool_paths(&path).expect("generations seal");
        let first_generation = sealed.first().expect("generation exists").clone();
        for generation in sealed {
            let pending = read_pending(&generation).expect("generation reads");
            sessions.extend(
                pending
                    .events
                    .iter()
                    .map(|event| event.external_session_id.clone()),
            );
            truncate_acked(&generation, pending.acked_bytes).expect("generation acknowledges");
        }
        assert_eq!(
            sessions,
            (0..9).map(|index| format!("s{index}")).collect::<Vec<_>>()
        );
        assert!(pending_spool_paths(&path)
            .expect("generations enumerate")
            .is_empty());

        let mut later = serde_json::to_vec(&event("s9")).expect("event serializes");
        later.push(b'\n');
        append_line(&path, &later, cap).expect("append succeeds");
        let later_generation = seal_pending_spool_paths(&path)
            .expect("generation seals")
            .pop()
            .expect("generation exists");
        assert_ne!(later_generation, first_generation);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn aggregate_pending_spool_limit_retains_existing_generations() {
        let dir = temp_dir("aggregate-spool-cap");
        let path = dir.join("agent-spool.jsonl");

        for line in [
            b"one\n".as_slice(),
            b"two\n".as_slice(),
            b"six\n".as_slice(),
        ] {
            append_line_with_pending_limit(&path, line, 4, 12)
                .expect("evidence fits within the aggregate cap");
        }

        let error = append_line_with_pending_limit(&path, b"four\n", 4, 12)
            .expect_err("new evidence is refused once retained generations fill the cap");
        assert!(error.to_string().contains("paused new capture"));
        assert_eq!(
            pending_spool_paths(&path)
                .expect("retained generations enumerate")
                .iter()
                .flat_map(|candidate| spool_lines(candidate))
                .collect::<Vec<_>>(),
            vec!["one", "two", "six"]
        );

        for generation in pending_spool_paths(&path).expect("retained generations enumerate") {
            let bytes = std::fs::metadata(&generation)
                .expect("retained generation metadata reads")
                .len();
            truncate_acked(&generation, bytes).expect("acknowledged evidence drains");
        }
        append_line_with_pending_limit(&path, b"four\n", 4, 12)
            .expect("draining retained evidence resumes capture");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_generation_sequence_recovers_without_reusing_a_generation() {
        let dir = temp_dir("sequence-recovery");
        let path = dir.join("agent-spool.jsonl");
        append_line(&path, b"first\n", 1).expect("first append succeeds");
        append_line(&path, b"second\n", 1).expect("first rotation succeeds");
        std::fs::write(generation_sequence_path(&path), b"partial")
            .expect("interrupted sequence writes");
        append_line(&path, b"third\n", 1).expect("rotation recovers");

        let pending = pending_spool_paths(&path).expect("generations enumerate");
        assert_eq!(pending.len(), 3);
        assert_eq!(
            pending
                .iter()
                .flat_map(|candidate| spool_lines(candidate))
                .collect::<Vec<_>>(),
            vec!["first", "second", "third"]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_completed_rewrite_temp_recovers_before_the_next_drain() {
        let dir = temp_dir("rewrite-recovery");
        let path = dir.join("agent-spool.jsonl");
        let mut encoded = serde_json::to_vec(&event("recovered")).expect("event serializes");
        encoded.push(b'\n');
        std::fs::write(sibling(&path, ".tmp"), encoded).expect("temp writes");

        let pending = read_pending(&path).expect("drain recovers temp");

        assert_eq!(pending.events, vec![event("recovered")]);
        assert!(!sibling(&path, ".tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn numbered_generation_rewrite_recovers_before_ordered_drain() {
        let dir = temp_dir("generation-rewrite-recovery");
        let path = dir.join("agent-spool.jsonl");
        let generation = path.with_extension("generation-00000000000000000001.jsonl");
        let mut remaining = serde_json::to_vec(&event("remaining")).expect("event serializes");
        remaining.push(b'\n');
        let mut live = serde_json::to_vec(&event("live")).expect("event serializes");
        live.push(b'\n');
        std::fs::write(sibling(&generation, ".tmp"), remaining).expect("temp writes");
        std::fs::write(sibling(&generation, ".bak"), b"acknowledged\n").expect("backup writes");
        std::fs::write(&path, live).expect("live writes");

        let pending = pending_spool_paths(&path).expect("pending paths recover generation");
        let sessions = pending
            .iter()
            .flat_map(|candidate| {
                read_pending(candidate)
                    .expect("pending generation reads")
                    .events
            })
            .map(|event| event.external_session_id)
            .collect::<Vec<_>>();

        assert_eq!(pending, vec![generation.clone(), path.clone()]);
        assert_eq!(sessions, vec!["remaining", "live"]);
        assert!(generation.exists());
        assert!(!sibling(&generation, ".tmp").exists());
        assert!(!sibling(&generation, ".bak").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_records_are_rejected_before_creating_a_spool() {
        let dir = temp_dir("oversized-record");
        let path = dir.join("agent-spool.jsonl");
        let line = vec![b'x'; MAX_SPOOL_RECORD_BYTES + 1];

        assert!(append_line(&path, &line, MAX_SPOOL_BYTES).is_err());
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_namespace_evidence_is_not_evictable() {
        let dir = temp_dir("namespace-retention");
        let pending = dir.join("pending");
        let drained = dir.join("drained");
        std::fs::create_dir_all(&pending).expect("pending namespace creates");
        std::fs::create_dir_all(&drained).expect("drained namespace creates");
        append(&pending.join("agent-spool.jsonl"), &event("pending"))
            .expect("pending evidence writes");

        assert!(namespace_has_pending_evidence(&pending).expect("pending namespace reads"));
        assert!(!namespace_has_pending_evidence(&drained).expect("drained namespace reads"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_identity_is_blocked_when_all_retained_namespaces_are_pending() {
        let dir = temp_dir("namespace-capacity");
        for index in 0..MAX_RETAINED_NAMESPACES {
            let namespace = dir
                .join(format!("account-{index}"))
                .join(format!("organization-{index}"));
            std::fs::create_dir_all(&namespace).expect("namespace creates");
            append(
                &namespace.join("agent-spool.jsonl"),
                &event(&format!("pending-{index}")),
            )
            .expect("pending evidence writes");
        }
        let next =
            EvidenceIdentity::new("new-account", "new-organization").expect("identity is valid");

        let error =
            reserve_namespace_slot_at(&dir, Some(&next)).expect_err("new namespace is blocked");

        assert!(error.to_string().contains("unsynced work"));
        assert!(dir
            .join("account-0")
            .join("organization-0")
            .join("agent-spool.jsonl")
            .exists());
        assert!(!dir.join("new-account").join("new-organization").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_retained_identity_remains_available_when_pending_namespaces_fill_the_cap() {
        let dir = temp_dir("namespace-return");
        for index in 0..MAX_RETAINED_NAMESPACES {
            let namespace = dir
                .join(format!("account-{index}"))
                .join(format!("organization-{index}"));
            std::fs::create_dir_all(&namespace).expect("namespace creates");
            append(
                &namespace.join("agent-spool.jsonl"),
                &event(&format!("pending-{index}")),
            )
            .expect("pending evidence writes");
        }
        let retained =
            EvidenceIdentity::new("account-3", "organization-3").expect("identity is valid");

        reserve_namespace_slot_at(&dir, Some(&retained))
            .expect("retained namespace remains available");

        assert!(dir
            .join("account-3")
            .join("organization-3")
            .join("agent-spool.jsonl")
            .exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activation_waits_for_the_root_capacity_lock() {
        let dir = temp_dir("namespace-root-lock");
        let root = dir.join("evidence");
        let active_path = active_identity_path_for_root(&root);
        std::fs::create_dir_all(&root).expect("evidence root creates");
        let identity =
            EvidenceIdentity::new("account-next", "organization-next").expect("identity is valid");
        let guard = acquire_lock(&root).expect("root lock acquires");
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
        let worker_root = root.clone();
        let worker_active_path = active_path.clone();
        let worker = std::thread::spawn(move || {
            result_tx
                .send(activate_identity_at(
                    &worker_root,
                    &worker_active_path,
                    &identity,
                ))
                .expect("activation result sends");
        });

        assert!(result_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(guard);
        result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("activation completes after the root lock releases")
            .expect("activation succeeds");
        worker.join().expect("activation worker joins");

        assert_eq!(
            active_identity_at(&active_path),
            Some(
                EvidenceIdentity::new("account-next", "organization-next")
                    .expect("identity is valid")
            )
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_identity_activation_keeps_retained_namespaces_bounded() {
        let dir = temp_dir("concurrent-namespace-capacity");
        let root = dir.join("evidence");
        let active_path = active_identity_path_for_root(&root);
        for index in 0..MAX_RETAINED_NAMESPACES - 1 {
            std::fs::create_dir_all(
                root.join(format!("account-{index}"))
                    .join(format!("organization-{index}")),
            )
            .expect("retained namespace creates");
        }
        let barrier = Arc::new(Barrier::new(3));
        let identities = [
            EvidenceIdentity::new("account-next-a", "organization-next-a")
                .expect("identity is valid"),
            EvidenceIdentity::new("account-next-b", "organization-next-b")
                .expect("identity is valid"),
        ];
        let workers: Vec<_> = identities
            .into_iter()
            .map(|identity| {
                let worker_root = root.clone();
                let worker_active_path = active_path.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    activate_identity_at(&worker_root, &worker_active_path, &identity)
                })
            })
            .collect();

        barrier.wait();
        for worker in workers {
            worker
                .join()
                .expect("activation worker joins")
                .expect("activation succeeds");
        }
        let retained = std::fs::read_dir(&root)
            .expect("evidence root reads")
            .filter_map(Result::ok)
            .filter(|account| account.file_type().is_ok_and(|kind| kind.is_dir()))
            .flat_map(|account| std::fs::read_dir(account.path()).expect("account reads"))
            .filter_map(Result::ok)
            .filter(|organization| organization.file_type().is_ok_and(|kind| kind.is_dir()))
            .count();

        assert_eq!(retained, MAX_RETAINED_NAMESPACES);
        assert!(root
            .join("account-next-a")
            .join("organization-next-a")
            .is_dir());
        assert!(root
            .join("account-next-b")
            .join("organization-next-b")
            .is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn namespace_reservation_blocks_cross_process_admission_until_rollback() {
        let child_root = std::env::var_os("SIQSHIFT_SPOOL_RESERVATION_TEST_ROOT");
        let child_result = std::env::var_os("SIQSHIFT_SPOOL_RESERVATION_TEST_RESULT");
        if let (Some(root), Some(result_path)) = (child_root, child_result) {
            let root = PathBuf::from(root);
            let source = EvidenceIdentity::new("account-source", "organization-source")
                .expect("source identity is valid");
            let target = EvidenceIdentity::new("account-target", "organization-target")
                .expect("target identity is valid");
            let result = reserve_identity_namespace_at(
                &root,
                &active_identity_path_for_root(&root),
                &source,
                &target,
            );
            std::fs::write(
                result_path,
                if result.is_err() {
                    "blocked"
                } else {
                    "admitted"
                },
            )
            .expect("child result writes");
            assert!(result.is_err());
            return;
        }

        let dir = temp_dir("namespace-reservation");
        let root = dir.join("evidence");
        let active_path = active_identity_path_for_root(&root);
        for index in 0..MAX_RETAINED_NAMESPACES - 1 {
            let pending = root
                .join(format!("account-{index}"))
                .join(format!("organization-{index}"))
                .join("agent-spool.jsonl");
            std::fs::create_dir_all(pending.parent().expect("pending namespace exists"))
                .expect("pending namespace creates");
            append(&pending, &event(&format!("pending-{index}"))).expect("pending evidence writes");
        }
        let source = EvidenceIdentity::new("account-source", "organization-source")
            .expect("source identity is valid");
        let target = EvidenceIdentity::new("account-target", "organization-target")
            .expect("target identity is valid");
        let reservation = reserve_identity_namespace_at(&root, &active_path, &source, &target)
            .expect("target namespace reserves");
        let competing = EvidenceIdentity::new("account-competing", "organization-competing")
            .expect("competing identity is valid");
        let result_path = dir.join("cross-process-result");
        let output = std::process::Command::new(std::env::current_exe().expect("test executable"))
            .arg("namespace_reservation_blocks_cross_process_admission_until_rollback")
            .arg("--nocapture")
            .env("SIQSHIFT_SPOOL_RESERVATION_TEST_ROOT", &root)
            .env("SIQSHIFT_SPOOL_RESERVATION_TEST_RESULT", &result_path)
            .output()
            .expect("child process starts");

        assert!(output.status.success());
        assert_eq!(
            std::fs::read_to_string(&result_path).expect("child result reads"),
            "blocked"
        );
        assert!(root
            .join("account-target")
            .join("organization-target")
            .is_dir());
        assert!(activate_identity_at(&root, &active_path, &competing).is_err());
        release_identity_namespace_reservation_at(&root, &reservation)
            .expect("rollback releases the target capacity");
        activate_identity_at(&root, &active_path, &competing)
            .expect("released target capacity admits the competing workspace");
        assert_eq!(active_identity_at(&active_path), Some(competing));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_activation_completes_its_namespace_reservation() {
        let dir = temp_dir("namespace-reservation-activation");
        let root = dir.join("evidence");
        let active_path = active_identity_path_for_root(&root);
        let source = EvidenceIdentity::new("account-source", "organization-source")
            .expect("source identity is valid");
        let target = EvidenceIdentity::new("account-target", "organization-target")
            .expect("target identity is valid");

        let reservation = reserve_identity_namespace_at(&root, &active_path, &source, &target)
            .expect("target namespace reserves");
        record_workspace_move_extension_reservation_at(&root, &reservation, "request-one")
            .expect("extension reservation records");
        mark_workspace_move_committed_at(&root, &reservation).expect("committed move records");
        let recovery = workspace_move_recovery_at(&root, &target)
            .expect("target recovery reads")
            .expect("target recovery exists");
        let WorkspaceMoveRecovery::Complete(reservation) = recovery else {
            panic!("target workspace must complete a committed move");
        };
        activate_reserved_identity_at(&root, &active_path, &reservation)
            .expect("target namespace activates");

        assert_eq!(active_identity_at(&active_path), Some(target.clone()));
        assert!(
            !namespace_reservation_path(&evidence_paths_at(&root, &target).browser_dir).exists()
        );
        assert!(workspace_move_recovery_at(&root, &target)
            .expect("completed move reads")
            .is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn destination_recovery_requires_a_persisted_extension_reservation() {
        let dir = temp_dir("workspace-move-destination-recovery");
        let root = dir.join("evidence");
        let active_path = active_identity_path_for_root(&root);
        let source = EvidenceIdentity::new("account-source", "organization-source")
            .expect("source identity is valid");
        let target = EvidenceIdentity::new("account-target", "organization-target")
            .expect("target identity is valid");
        let reservation = reserve_identity_namespace_at(&root, &active_path, &source, &target)
            .expect("target namespace reserves");

        let error = workspace_move_recovery_at(&root, &target)
            .expect_err("an unreserved destination cannot complete a workspace move");
        assert!(error.to_string().contains("unreserved destination"));

        record_workspace_move_extension_reservation_at(&root, &reservation, "request-one")
            .expect("extension reservation records");
        assert!(matches!(
            workspace_move_recovery_at(&root, &target).expect("reserved recovery reads"),
            Some(WorkspaceMoveRecovery::Complete(_))
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn foreign_workspace_move_does_not_block_identity_activation() {
        let dir = temp_dir("foreign-workspace-move");
        let root = dir.join("evidence");
        let active_path = active_identity_path_for_root(&root);
        let source = EvidenceIdentity::new("account-source", "organization-source")
            .expect("source identity is valid");
        let target = EvidenceIdentity::new("account-target", "organization-target")
            .expect("target identity is valid");
        let foreign = EvidenceIdentity::new("account-foreign", "organization-foreign")
            .expect("foreign identity is valid");
        let reservation = reserve_identity_namespace_at(&root, &active_path, &source, &target)
            .expect("source workspace move reserves its target");

        assert!(workspace_move_recovery_at(&root, &foreign)
            .expect("foreign recovery reads")
            .is_none());
        activate_identity_at(&root, &active_path, &foreign)
            .expect("foreign identity activates without consuming another account's move");
        assert_eq!(active_identity_at(&active_path), Some(foreign));
        assert!(matches!(
            workspace_move_recovery_at(&root, &source).expect("source recovery remains available"),
            Some(WorkspaceMoveRecovery::Rollback(_))
        ));

        release_identity_namespace_reservation_at(&root, &reservation)
            .expect("matching owner releases its reservation");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_precommit_reservation_releases_capacity_for_a_retry() {
        let dir = temp_dir("workspace-move-recovery");
        let root = dir.join("evidence");
        let active_path = active_identity_path_for_root(&root);
        let source = EvidenceIdentity::new("account-source", "organization-source")
            .expect("source identity is valid");
        let target = EvidenceIdentity::new("account-target", "organization-target")
            .expect("target identity is valid");
        let reservation = reserve_identity_namespace_at(&root, &active_path, &source, &target)
            .expect("target namespace reserves");

        let recovery = workspace_move_recovery_at(&root, &source)
            .expect("source recovery reads")
            .expect("source recovery exists");
        let WorkspaceMoveRecovery::Rollback(recovery) = recovery else {
            panic!("source workspace must roll back an uncommitted move");
        };
        release_identity_namespace_reservation_at(&root, &recovery)
            .expect("stale reservation releases");
        let retry = reserve_identity_namespace_at(&root, &active_path, &source, &target)
            .expect("released target capacity is available for retry");

        release_identity_namespace_reservation_at(&root, &retry)
            .expect("retry reservation releases");
        assert_ne!(reservation.record.token, retry.record.token);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn namespace_append_waits_for_the_root_admission_lock() {
        let dir = temp_dir("namespace-writer-root-lock");
        let root = dir.join("evidence");
        let path = root
            .join("account-writer")
            .join("organization-writer")
            .join("agent-spool.jsonl");
        std::fs::create_dir_all(path.parent().expect("writer parent exists"))
            .expect("writer namespace creates");
        let root_guard = acquire_lock(&root).expect("root lock acquires");
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
        let worker_path = path.clone();
        let writer = std::thread::spawn(move || {
            result_tx
                .send(append(&worker_path, &event("blocked-writer")))
                .expect("writer result sends");
        });

        assert!(result_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(root_guard);
        result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("writer completes after the root lock releases")
            .expect("writer preserves evidence");
        writer.join().expect("writer joins");
        assert_eq!(
            read_pending(&path).expect("writer spool reads").events,
            vec![event("blocked-writer")]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_leased_namespace_cannot_be_evicted_while_its_writer_is_in_flight() {
        let dir = temp_dir("namespace-writer-lease");
        let root = dir.join("evidence");
        let writer_path = root
            .join("account-writer")
            .join("organization-writer")
            .join("agent-spool.jsonl");
        std::fs::create_dir_all(writer_path.parent().expect("writer parent exists"))
            .expect("writer namespace creates");
        for index in 0..MAX_RETAINED_NAMESPACES - 1 {
            let path = root
                .join(format!("account-{index}"))
                .join(format!("organization-{index}"))
                .join("agent-spool.jsonl");
            std::fs::create_dir_all(path.parent().expect("pending namespace exists"))
                .expect("pending namespace creates");
            append(&path, &event(&format!("pending-{index}"))).expect("pending evidence writes");
        }

        let (leased_tx, leased_rx) = std::sync::mpsc::sync_channel(0);
        let (resume_tx, resume_rx) = std::sync::mpsc::sync_channel(0);
        let writer_path_for_thread = writer_path.clone();
        let writer = std::thread::spawn(move || {
            let lease_path = namespace_writer_lease_path(
                writer_path_for_thread
                    .parent()
                    .expect("writer parent exists"),
            );
            let lease = acquire_lock(&lease_path)?;
            leased_tx
                .send(())
                .map_err(|_| io::Error::other("test did not await writer lease"))?;
            resume_rx
                .recv()
                .map_err(|_| io::Error::other("test did not resume writer"))?;
            drop(lease);
            append(&writer_path_for_thread, &event("in-flight"))
        });

        leased_rx.recv().expect("writer lease acquires");
        let next =
            EvidenceIdentity::new("account-next", "organization-next").expect("identity is valid");
        let error = activate_identity_at(&root, &active_identity_path_for_root(&root), &next)
            .expect_err("a leased namespace is not evicted");
        assert!(error.to_string().contains("unsynced work"));
        assert!(writer_path.parent().expect("writer parent exists").is_dir());
        assert!(!root.join("account-next").join("organization-next").exists());

        resume_tx.send(()).expect("writer resumes");
        writer
            .join()
            .expect("writer joins")
            .expect("writer preserves the evidence");
        assert_eq!(
            read_pending(&writer_path)
                .expect("writer spool reads")
                .events,
            vec![event("in-flight")]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_partial_tail_is_quarantined_before_the_next_append() {
        let dir = temp_dir("partial-append");
        let path = dir.join("agent-spool.jsonl");
        std::fs::write(&path, b"{\"garbage").expect("partial writes");

        append(&path, &event("s1")).expect("append succeeds");

        assert_eq!(spool_lines(&path).len(), 1);
        let quarantined =
            std::fs::read_to_string(sibling(&path, ".partial")).expect("quarantine reads");
        assert!(quarantined.contains("garbage"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_pending_quarantines_a_trailing_partial_line() {
        let dir = temp_dir("partial-read");
        let path = dir.join("agent-spool.jsonl");
        append(&path, &event("s1")).expect("append succeeds");
        OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("spool opens")
            .write_all(b"{\"crashed")
            .expect("partial writes");

        let pending = read_pending(&path).expect("drain succeeds");

        assert_eq!(pending.events, vec![event("s1")]);
        assert!(std::fs::read_to_string(&path)
            .expect("spool reads")
            .ends_with('\n'));
        assert!(std::fs::read_to_string(sibling(&path, ".partial"))
            .expect("quarantine reads")
            .contains("crashed"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_line_is_quarantined_without_failing_the_drain() {
        let dir = temp_dir("corrupt");
        let path = dir.join("agent-spool.jsonl");
        append(&path, &event("s1")).expect("first append succeeds");
        OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("spool opens")
            .write_all(b"not json\n")
            .expect("corrupt line writes");
        append(&path, &event("s2")).expect("second append succeeds");

        let pending = read_pending(&path).expect("drain succeeds");

        assert_eq!(pending.events, vec![event("s1"), event("s2")]);
        assert!(std::fs::read_to_string(sibling(&path, ".corrupt"))
            .expect("quarantine reads")
            .contains("not json"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_crash_before_ack_replays_the_same_events() {
        let dir = temp_dir("replay");
        let path = dir.join("agent-spool.jsonl");
        append(&path, &event("s1")).expect("append succeeds");

        let first = read_pending(&path).expect("first drain succeeds");
        let second = read_pending(&path).expect("second drain succeeds");

        assert_eq!(first.events, second.events);
        assert_eq!(first.acked_bytes, second.acked_bytes);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncate_drops_only_acked_bytes_and_keeps_newer_appends() {
        let dir = temp_dir("truncate");
        let path = dir.join("agent-spool.jsonl");
        append(&path, &event("s1")).expect("append succeeds");

        let pending = read_pending(&path).expect("drain succeeds");
        append(&path, &event("s2")).expect("late append succeeds");
        truncate_acked(&path, pending.acked_bytes).expect("truncate succeeds");

        assert_eq!(
            read_pending(&path).expect("second drain succeeds").events,
            vec![event("s2")]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncate_ignores_a_spool_replaced_since_the_read() {
        let dir = temp_dir("truncate-replaced");
        let path = dir.join("agent-spool.jsonl");
        append(&path, &event("s1")).expect("append succeeds");
        let pending = read_pending(&path).expect("drain succeeds");

        // A rotation replaced the file with a shorter one before the ack landed.
        std::fs::write(&path, b"x\n").expect("replacement writes");
        truncate_acked(&path, pending.acked_bytes).expect("truncate is a no-op");

        assert_eq!(std::fs::read(&path).expect("spool reads"), b"x\n");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fully_acked_spool_disappears() {
        let dir = temp_dir("truncate-all");
        let path = dir.join("agent-spool.jsonl");
        append(&path, &event("s1")).expect("append succeeds");

        let pending = read_pending(&path).expect("drain succeeds");
        truncate_acked(&path, pending.acked_bytes).expect("truncate succeeds");

        assert!(!path.exists());
        assert!(read_pending(&path)
            .expect("empty drain succeeds")
            .events
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn known_timestamps_format_as_iso_8601() {
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_iso8601(1_704_067_200), "2024-01-01T00:00:00Z");
        // A leap day, mid-day.
        assert_eq!(format_iso8601(951_827_200), "2000-02-29T12:26:40Z");
    }

    #[test]
    fn the_env_override_wins_over_platform_defaults() {
        std::env::set_var(SPOOL_ENV_VAR, "C:/tmp/custom-spool.jsonl");
        assert_eq!(
            default_spool_path(),
            PathBuf::from("C:/tmp/custom-spool.jsonl")
        );
        std::env::remove_var(SPOOL_ENV_VAR);
    }

    // The rename moved the data directory. The spool is not a cache — it holds
    // activity recorded but not yet uploaded — so an upgraded install that
    // looked only at the new name would silently strand real customer work.

    #[test]
    fn a_fresh_install_writes_under_the_current_name() {
        let base = PathBuf::from("/base");
        assert_eq!(resolve_data_dir(&base, |_| false), base.join(DATA_DIR_NAME));
    }

    #[test]
    fn an_upgraded_install_adopts_its_pre_rename_directory() {
        let base = PathBuf::from("/base");
        let legacy = base.join(LEGACY_DATA_DIR_NAME);
        assert_eq!(
            resolve_data_dir(&base, |path| path == legacy),
            legacy,
            "an upgrade must keep reading the spool it already has"
        );
    }

    #[test]
    fn the_current_directory_wins_when_both_exist() {
        // Someone who ran a new build before this fix has both. The new one is
        // where the running app has been appending, so it is the live spool.
        let base = PathBuf::from("/base");
        assert_eq!(resolve_data_dir(&base, |_| true), base.join(DATA_DIR_NAME));
    }

    #[test]
    fn every_sidecar_follows_the_adopted_directory() {
        // The browser spool, rules, tally, handshake marker and evidence all
        // hang off the spool's parent. Adopting the spool but not its siblings
        // would split one install's state across two directories.
        let base = PathBuf::from("/base");
        let legacy = base.join(LEGACY_DATA_DIR_NAME);
        let adopted = resolve_data_dir(&base, |path| path == legacy);
        assert_eq!(adopted.join("agent-spool.jsonl").parent(), Some(&*adopted));
    }
}
