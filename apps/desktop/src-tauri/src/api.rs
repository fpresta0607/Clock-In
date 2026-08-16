//! HTTP access to Neon Auth and the Clock-In API.
//!
//! Two rules hold everywhere in this module: errors never carry a response body
//! or a URL (either can contain a token), and the caller always learns which
//! kind of failure it was so the UI can react without parsing strings.

use serde::{Deserialize, Serialize};

use crate::monitor::{ObservedSession, SegmentRecord};
use crate::spool::{AgentEventKind, AgentSource, SpoolEvent};

/// Matches the `BridgeErrorKind` union the React bridge narrows on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    Auth,
    Transient,
    Conflict,
    Validation,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeError {
    pub kind: ErrorKind,
    pub message: String,
}

impl BridgeError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Auth, message)
    }

    pub fn transient(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Transient, message)
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unknown, message)
    }
}

pub type ApiResult<T> = Result<T, BridgeError>;

/// Maps a status code onto the kind the UI branches on, and onto a message that
/// describes the situation without echoing anything the server sent back.
pub fn classify(status: u16) -> BridgeError {
    match status {
        401 | 403 => BridgeError::auth("Your session expired. Sign in again."),
        409 => BridgeError::new(
            ErrorKind::Conflict,
            "A timer is already running for this account.",
        ),
        400 | 422 => BridgeError::new(
            ErrorKind::Validation,
            "The server rejected the request as invalid.",
        ),
        408 | 429 => BridgeError::transient("The server is busy. Retrying shortly."),
        500..=599 => BridgeError::transient("The server is unavailable. Retrying shortly."),
        _ => BridgeError::unknown("The request did not complete."),
    }
}

async fn classify_api_error(response: reqwest::Response) -> BridgeError {
    let status = response.status().as_u16();
    let server_message = response
        .json::<ApiErrorBody>()
        .await
        .ok()
        .map(|body| body.error.message)
        .filter(|message| !message.is_empty());
    match server_message {
        Some(message) => BridgeError::new(classify(status).kind, message),
        None => classify(status),
    }
}

/// Sign-up failures are worth naming precisely: "already registered" and "too
/// short" are both things the user can act on, unlike a generic rejection. The
/// code is matched from a known set rather than echoing the server's own text.
pub fn classify_signup(status: u16, code: Option<&str>) -> BridgeError {
    match code {
        Some("USER_ALREADY_EXISTS") => BridgeError::new(
            ErrorKind::Validation,
            "That email already has an account. Sign in instead.",
        ),
        Some("PASSWORD_TOO_SHORT") => BridgeError::new(
            ErrorKind::Validation,
            "Choose a password of at least 8 characters.",
        ),
        Some("INVALID_EMAIL") => {
            BridgeError::new(ErrorKind::Validation, "Enter a valid email address.")
        }
        _ => classify(status),
    }
}

/// A network-level failure is always transient: nothing reached the server, so
/// retrying the identical idempotent payload is safe.
pub fn classify_transport(error: &reqwest::Error) -> BridgeError {
    if error.is_timeout() {
        BridgeError::transient("The server did not respond in time.")
    } else {
        BridgeError::transient("Cannot reach the server. Check your connection.")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerUser {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(skip_serializing)]
    pub created_at: String,
}

#[derive(Deserialize)]
struct MeResponse {
    user: MeUser,
}

#[derive(Deserialize)]
struct MeUser {
    id: String,
    email: String,
    name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub invite_code: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardEntry {
    pub rank: u32,
    pub user: LeaderboardMember,
    pub duration_seconds: u64,
    pub session_count: u32,
    /// The active/agent split arrived with effort reporting; an API that
    /// predates it still decodes, the entry just carries no measured split.
    #[serde(default)]
    pub active_seconds: u64,
    #[serde(default)]
    pub agent_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardMember {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
struct OrganizationResponse {
    organization: Organization,
}

#[derive(Deserialize)]
struct LeaderboardResponse {
    entries: Vec<LeaderboardEntry>,
}

/// A roster agent's standing: everything starts anonymous, a member naming
/// it registers it, and retired is where merge losers and decommissioned
/// workers go.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Anonymous,
    Registered,
    Retired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsReportAgent {
    pub id: String,
    pub name: String,
    pub source: AgentSource,
    pub status: AgentStatus,
    pub owner: LeaderboardMember,
    #[serde(default)]
    pub project: Option<MeStatsProjectRef>,
}

/// One roster agent's row in the pay-run report: hours, shifts, and how its
/// commits held up. Agents with no activity in range still get a row, at
/// zero and a null held rate rather than absence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsReportRow {
    pub agent: AgentsReportAgent,
    pub agent_seconds: u64,
    pub shift_count: u32,
    pub commits_recorded: u32,
    pub commits_pending: u32,
    pub commits_merged: u32,
    pub commits_reverted: u32,
    pub commits_orphaned: u32,
    /// merged / decided; null while nothing has been decided yet.
    #[serde(default)]
    pub held_rate: Option<f64>,
    /// Distinct models this agent's shifts named in range; empty when none did.
    #[serde(default)]
    pub models: Vec<String>,
    /// Token totals over the range; absent on an API that predates token
    /// reporting, which the webview shows as absence rather than zeros.
    #[serde(default)]
    pub tokens: Option<AgentTokenTotals>,
    /// Whether any usage rows exist for this agent in range - rows, not nonzero sums.
    #[serde(default)]
    pub tokens_reported: bool,
}

/// The four token counters a runtime's own session logs report, summed over a
/// scope. Every counter is optional-with-default: the API deploys before any
/// installer can, so a counter added after this build must never break decode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTokenTotals {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
}

/// The roster's headcount. The API deploys before any installer can, and the
/// standing split was renamed after 0.1.7 shipped (`active` replaced
/// `anonymous` + `registered`), so an installer can meet either spelling.
/// Decoding accepts both and normalizes to `active`; a required field here is
/// how an installer generation once lost its Agents tab to a decode error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "AgentsReportHeadcountWire")]
pub struct AgentsReportHeadcount {
    pub total: u32,
    /// Everyone still on the clock: anonymous and registered alike.
    pub active: u32,
    pub retired: u32,
}

/// The headcount as a deployed API may actually send it: `active` today,
/// `anonymous` + `registered` before the rename. Additive fields are
/// optional-with-default; unknown future fields serde ignores on its own.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentsReportHeadcountWire {
    total: u32,
    #[serde(default)]
    active: Option<u32>,
    #[serde(default)]
    retired: u32,
    #[serde(default)]
    anonymous: Option<u32>,
    #[serde(default)]
    registered: Option<u32>,
}

impl From<AgentsReportHeadcountWire> for AgentsReportHeadcount {
    fn from(wire: AgentsReportHeadcountWire) -> Self {
        Self {
            total: wire.total,
            // The pre-rename API splits the active count in two; the rename
            // is a sum away.
            active: wire
                .active
                .unwrap_or(wire.anonymous.unwrap_or(0) + wire.registered.unwrap_or(0)),
            retired: wire.retired,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsReport {
    pub headcount: AgentsReportHeadcount,
    pub rows: Vec<AgentsReportRow>,
}

#[derive(Deserialize)]
struct ProjectListResponse {
    projects: Vec<ProjectListItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectListItem {
    id: String,
    name: String,
    #[serde(default)]
    color: Option<String>,
    created_at: String,
    is_archived: bool,
}

#[derive(Deserialize)]
struct AuthErrorBody {
    #[serde(default)]
    code: Option<String>,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    error: ApiErrorBodyError,
}

#[derive(Deserialize)]
struct ApiErrorBodyError {
    message: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
}

/// What `/sessions/observed` answers with. Only the refusals matter to the
/// caller, and a refusal is permanent.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedSessionBatchOutcome {
    pub rejected: Vec<SegmentRejection>,
}

/// The server's verdict on an uploaded activity-segment batch. Rejected rows
/// are dropped, not retried: the reason is a permanent validation failure.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentBatchOutcome {
    pub accepted: u32,
    pub rejected: Vec<SegmentRejection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentRejection {
    pub client_id: String,
    pub reason: String,
}

/// One captured commit, as `POST /shift-commits` accepts it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftCommitUpload {
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
}

/// The server's verdict on an uploaded shift-commit batch. `unknown_session`
/// is retryable (the shift may not have landed on the server yet); every
/// other rejection reason is permanent.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftCommitBatchOutcome {
    pub accepted: u32,
    pub rejected: Vec<SegmentRejection>,
}

/// Per-event verdict from `/agent-sessions`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventOutcome {
    pub external_session_id: String,
    pub accepted: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Deserialize)]
struct AgentEventBatchResponse {
    results: Vec<AgentEventOutcome>,
}

/// What `POST /agent-sessions` accepts, borrowed field-by-field from a spool
/// event. The spool line carries capture-only fields (`transcript_path`,
/// cumulative `tokens`) that the server's strict schema would reject - and a
/// transcript path is not ours to send - so the upload projects explicitly
/// instead of serializing the spool event itself. `skip_serializing` on the
/// spool struct is not an option: the same serde impl writes the spool file,
/// where those fields must survive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventUpload<'a> {
    pub source: &'a AgentSource,
    pub external_session_id: &'a str,
    pub event: AgentEventKind,
    pub occurred_at: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<&'a str>,
}

impl<'a> From<&'a SpoolEvent> for AgentEventUpload<'a> {
    fn from(event: &'a SpoolEvent) -> Self {
        Self {
            source: &event.source,
            external_session_id: &event.external_session_id,
            event: event.event,
            occurred_at: &event.occurred_at,
            cwd: event.cwd.as_deref(),
            model: event.model.as_deref(),
            rule_id: event.rule_id.as_deref(),
        }
    }
}

/// One session's token counters for one hour bucket, as `POST /agent-usage`
/// accepts it. Counters are cumulative totals per (bucket, model, sidechain),
/// restated upward; the server upserts monotonically, so a replayed batch is
/// always safe to resend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageUpload {
    pub client_id: String,
    pub source: AgentSource,
    pub external_session_id: String,
    pub bucket_start_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub sidechain: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

/// The server's verdict on an uploaded agent-usage batch. `unknown_session`
/// is retryable (the shift may not have landed on the server yet); every
/// other rejection reason is permanent.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageBatchOutcome {
    pub accepted: u32,
    pub rejected: Vec<SegmentRejection>,
}

/// A per-user path prefix → project mapping, as `/path-mappings` returns it.
/// Read-only from the desktop: the host uses these to file an agent's work by
/// the folder it ran in. There is no longer a screen for editing them by hand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMapping {
    pub id: String,
    /// How the mapping matches: a filesystem path prefix (agent cwds), or a
    /// browser URL rule (extension span verdicts). The two kinds share the
    /// list endpoint but answer different questions, so the desktop must tell
    /// them apart rather than running one matcher over both.
    #[serde(default)]
    pub kind: MappingKind,
    pub path_prefix: String,
    #[serde(default)]
    pub repo_url: Option<String>,
    pub project_id: String,
}

/// The two mapping kinds the server models. Kept beside `PathMapping` because
/// the desktop reads both kinds from the one endpoint and filters per use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MappingKind {
    /// Matches an agent working directory by longest path-prefix.
    #[default]
    PathPrefix,
    /// Matches a browser tab by URL-rule pattern; never a filesystem path.
    UrlRule,
}

#[derive(Deserialize)]
struct PathMappingListResponse {
    mappings: Vec<PathMapping>,
}

/// Active time split by how many agents ran at once, plus agent runtime that
/// fell outside the member's presence entirely.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsConcurrency {
    pub t0_seconds: u64,
    pub t1_seconds: u64,
    pub t2_seconds: u64,
    pub t3_plus_seconds: u64,
    pub away_seconds: u64,
}

/// One agent runtime's share of agent time; sums to agent time, never to active time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsAgentSplit {
    pub source: String,
    #[serde(default)]
    pub model: Option<String>,
    pub duration_seconds: u64,
}

/// The dashboard view state both surfaces share. Only `scope` is synchronised:
/// the two surfaces offer different ranges on purpose (this app's "this week"
/// is a calendar week, the dashboard's "7d" is a rolling one), so each keeps
/// its own while the project scope follows you between them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPreferences {
    pub scope: String,
    pub range: String,
}

/// What deleting a project takes with it, as `/projects/:id/usage` reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub session_count: u64,
    pub duration_seconds: u64,
    pub agent_session_count: u64,
}

/// One hour of the caller's local calendar for the line graph: active time
/// and agent runtime bucketed to the hour, plus the token counters the hour's
/// usage buckets reported. Token fields are null - never zero - when nothing
/// in the hour reported tokens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsHourlyBucket {
    pub hour_start: String,
    pub active_seconds: u64,
    pub agent_seconds: u64,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
}

/// The `GET /me/stats` response: the reporting service's attribution totals
/// scoped to the caller.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStats {
    pub filters: MeStatsFilters,
    /// Union of the member's working intervals - never exceeds wall clock.
    /// These four ride through to the webview, whose decoder requires them:
    /// a field missing here is a hard `invalidResponse()` over there.
    pub active_seconds: u64,
    /// Summed agent runtime; exceeding `active_seconds` is leverage, not an error.
    pub agent_seconds: u64,
    pub concurrency: MeStatsConcurrency,
    pub by_agent: Vec<MeStatsAgentSplit>,
    pub total_duration_seconds: u64,
    pub attributed_seconds: u64,
    pub unattributed_seconds: u64,
    pub projects: Vec<MeStatsProject>,
    // Without this field serde silently drops the array and the TS bridge
    // rejects the whole response as invalid.
    pub apps: Vec<MeStatsApp>,
    /// Hourly series for the line graph. Defaulted so an API from before the
    /// field shipped still parses; the webview reads an empty series as "no
    /// graph", exactly as it already does.
    #[serde(default)]
    pub hourly: Vec<MeStatsHourlyBucket>,
    /// The caller's own agent activity in range, decoded only as far as the
    /// charts need. Defaulted so an API from before the field shipped still
    /// parses; the webview reads an empty list as "nothing to name".
    #[serde(default)]
    pub agents: Vec<MeStatsAgentActivity>,
}

/// One agent's activity slice in `/me/stats`: the runtime it ran under, its
/// shift count, and whether it reported tokens (`None` on an API that
/// predates the field, which the webview refuses to read as "no").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsAgentActivity {
    pub agent: MeStatsAgentActivityRef,
    pub shift_count: u32,
    #[serde(default)]
    pub tokens_reported: Option<bool>,
}

/// The runtime identity inside an activity row; the rest of the roster agent
/// is the web dashboard's business.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsAgentActivityRef {
    pub id: String,
    pub source: AgentSource,
}

/// One week of an agent's paystub trend: hours, shifts, and how the week's
/// commits held up (`None` while nothing has been decided).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPaystubTrendBucket {
    pub period_start_at: String,
    pub agent_seconds: u64,
    pub shift_count: u32,
    #[serde(default)]
    pub held_rate: Option<f64>,
}

/// The slice of the paystub the desktop plots: the weekly trend buckets. The
/// shifts, models, and totals the paystub also carries are the web
/// dashboard's business, so serde drops them here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPaystubTrend {
    pub trend: Vec<AgentPaystubTrendBucket>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsApp {
    pub process_name: String,
    pub duration_seconds: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsFilters {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsProject {
    pub project: MeStatsProjectRef,
    pub duration_seconds: u64,
    pub attributed_seconds: u64,
    pub unattributed_seconds: u64,
    pub session_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeStatsProjectRef {
    pub id: String,
    pub name: String,
}

/// Neon Auth signs its session cookie: the value it honors on `/token` is
/// `token.signature` from Set-Cookie, not the bare token the JSON body returns
/// (the bare token gets a 401). Browsers store the Set-Cookie value verbatim —
/// still URL-encoded — so we keep it byte-for-byte and send it back untouched.
fn session_cookie_value(headers: &reqwest::header::HeaderMap) -> ApiResult<String> {
    const NAMES: [&str; 2] = [
        "__Secure-neon-auth.session_token=",
        "neon-auth.session_token=",
    ];
    for header in headers.get_all(reqwest::header::SET_COOKIE) {
        let Ok(header) = header.to_str() else {
            continue;
        };
        for name in NAMES {
            if let Some(rest) = header.strip_prefix(name) {
                let value = rest.split(';').next().unwrap_or_default();
                if !value.is_empty() {
                    return Ok(value.to_string());
                }
            }
        }
    }
    Err(BridgeError::unknown(
        "The sign-in response carried no session cookie.",
    ))
}

/// Talks to both services. `auth_base_url` is the Neon Auth base URL; `api_base_url`
/// is the Clock-In API. Cheap to clone: the inner HTTP client is reference-counted.
#[derive(Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    auth_base_url: String,
    /// Scheme and host only. Neon Auth rejects a state-changing call that has no
    /// Origin, and an origin is never a path.
    auth_origin: String,
    api_base_url: String,
}

impl ApiClient {
    pub fn new(auth_base_url: String, api_base_url: String) -> ApiResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|_| BridgeError::unknown("Could not start the network client."))?;
        let auth_origin = reqwest::Url::parse(&auth_base_url)
            .map_err(|_| BridgeError::unknown("The configured auth URL is not valid."))?
            .origin()
            .ascii_serialization();
        Ok(Self {
            http,
            auth_base_url: auth_base_url.trim_end_matches('/').to_string(),
            auth_origin,
            api_base_url: api_base_url.trim_end_matches('/').to_string(),
        })
    }

    /// Creates a Neon Auth account and returns its signed session cookie value.
    pub async fn sign_up(&self, email: &str, password: &str, name: &str) -> ApiResult<String> {
        let response = self
            .http
            .post(format!("{}/sign-up/email", self.auth_base_url))
            .header("origin", &self.auth_origin)
            .json(&serde_json::json!({ "email": email, "password": password, "name": name }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let code = response
                .json::<AuthErrorBody>()
                .await
                .ok()
                .and_then(|body| body.code);
            return Err(classify_signup(status, code.as_deref()));
        }

        session_cookie_value(response.headers())
    }

    /// Exchanges email and password for the long-lived Neon Auth session cookie.
    pub async fn sign_in(&self, email: &str, password: &str) -> ApiResult<String> {
        let response = self
            .http
            .post(format!("{}/sign-in/email", self.auth_base_url))
            .header("origin", &self.auth_origin)
            .json(&serde_json::json!({ "email": email, "password": password }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            // Neon Auth answers a bad password with 401; say so without echoing it back.
            return Err(match response.status().as_u16() {
                401 | 403 => BridgeError::auth("Incorrect email or password."),
                status => classify(status),
            });
        }

        session_cookie_value(response.headers())
    }

    /// Trades the session token for a short-lived JWT the API will accept.
    pub async fn fetch_access_token(&self, session_token: &str) -> ApiResult<String> {
        let response = self
            .http
            .get(format!("{}/token", self.auth_base_url))
            .header("origin", &self.auth_origin)
            .header(
                "cookie",
                format!("__Secure-neon-auth.session_token={session_token}"),
            )
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }

        let body: TokenResponse = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The access token could not be read."))?;
        Ok(body.token)
    }

    /// Sent once after sign-up. An invite code places the account in an existing
    /// organization; without one the API creates a personal workspace.
    pub async fn provision_account(
        &self,
        access_token: &str,
        invite_code: Option<&str>,
    ) -> ApiResult<TimerUser> {
        let response = self
            .http
            .post(format!("{}/accounts", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "inviteCode": invite_code }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                404 => BridgeError::new(
                    ErrorKind::Validation,
                    "That invite code does not match a workspace. Check it and try again.",
                ),
                status => classify(status),
            });
        }

        let body: MeResponse = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The account response could not be read."))?;
        Ok(TimerUser {
            id: body.user.id,
            email: body.user.email,
            name: body.user.name,
        })
    }

    /// Moves an existing account into a teammate's workspace.
    pub async fn join_organization(&self, access_token: &str, invite_code: &str) -> ApiResult<()> {
        let response = self
            .http
            .post(format!("{}/organization/join", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "inviteCode": invite_code }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if response.status().is_success() {
            return Ok(());
        }
        Err(match response.status().as_u16() {
            404 => BridgeError::new(
                ErrorKind::Validation,
                "That invite code does not match a workspace.",
            ),
            409 => BridgeError::new(
                ErrorKind::Validation,
                "This account already recorded time here, so it cannot move.",
            ),
            status => classify(status),
        })
    }

    pub async fn organization(&self, access_token: &str) -> ApiResult<Organization> {
        let body: OrganizationResponse = self.get_json(access_token, "/organization").await?;
        Ok(body.organization)
    }

    /// The workspace board for a range. Bounds arrive together or not at all;
    /// none means all time, exactly as `/reports/leaderboard` reads it.
    pub async fn leaderboard(
        &self,
        access_token: &str,
        from_at: Option<&str>,
        to_exclusive_at: Option<&str>,
        scope: Option<&str>,
    ) -> ApiResult<Vec<LeaderboardEntry>> {
        // ISO-8601 UTC instants and scope values (uuid / "all" / "unassigned")
        // contain no characters that need escaping in a query string, so they
        // are interpolated as-is.
        let mut query = match (from_at, to_exclusive_at) {
            (Some(from_at), Some(to_exclusive_at)) => {
                format!("?fromAt={from_at}&toExclusiveAt={to_exclusive_at}")
            }
            _ => String::new(),
        };
        if let Some(scope) = scope.filter(|scope| *scope != "all") {
            query.push(if query.is_empty() { '?' } else { '&' });
            query.push_str(&format!("scope={scope}"));
        }
        let body: LeaderboardResponse = self
            .get_json(access_token, &format!("/reports/leaderboard{query}"))
            .await?;
        Ok(body.entries)
    }

    /// The pay-run report: every roster agent's hours, shifts, and held share
    /// for a range. Bounds arrive together or not at all; none means all time.
    pub async fn agents_report(
        &self,
        access_token: &str,
        from_at: Option<&str>,
        to_exclusive_at: Option<&str>,
        scope: Option<&str>,
    ) -> ApiResult<AgentsReport> {
        let mut query = match (from_at, to_exclusive_at) {
            (Some(from_at), Some(to_exclusive_at)) => {
                format!("?fromAt={from_at}&toExclusiveAt={to_exclusive_at}")
            }
            _ => String::new(),
        };
        if let Some(scope) = scope.filter(|scope| *scope != "all") {
            query.push(if query.is_empty() { '?' } else { '&' });
            query.push_str(&format!("scope={scope}"));
        }
        self.get_json(access_token, &format!("/reports/agents{query}"))
            .await
    }

    /// One agent's paystub trend: six weekly buckets ending at the range's
    /// end (or now, unbounded), for the overlay's agents chart. Bounds arrive
    /// together or not at all; both absent asks for all time.
    pub async fn agent_paystub_trend(
        &self,
        access_token: &str,
        agent_id: &str,
        from_at: Option<&str>,
        to_exclusive_at: Option<&str>,
    ) -> ApiResult<AgentPaystubTrend> {
        let query = match (from_at, to_exclusive_at) {
            (Some(from_at), Some(to_exclusive_at)) => {
                format!("?fromAt={from_at}&toExclusiveAt={to_exclusive_at}")
            }
            _ => String::new(),
        };
        self.get_json(access_token, &format!("/agents/{agent_id}/paystub{query}"))
            .await
    }

    pub async fn me(&self, access_token: &str) -> ApiResult<TimerUser> {
        let body: MeResponse = self.get_json(access_token, "/me").await?;
        Ok(TimerUser {
            id: body.user.id,
            email: body.user.email,
            name: body.user.name,
        })
    }

    pub async fn projects(&self, access_token: &str) -> ApiResult<Vec<TimerProject>> {
        let body: ProjectListResponse = self.get_json(access_token, "/projects").await?;
        Ok(body
            .projects
            .into_iter()
            .filter(|project| !project.is_archived)
            .map(|project| TimerProject {
                id: project.id,
                name: project.name,
                color: project.color,
                created_at: project.created_at,
            })
            .collect())
    }

    /// Creates a project for the signed-in member; the API answers 201 with the
    /// created list item, the same shape `/projects` returns.
    pub async fn create_project(&self, access_token: &str, name: &str) -> ApiResult<TimerProject> {
        let response = self
            .http
            .post(format!("{}/projects", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        let body: ProjectListItem = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The project response could not be read."))?;
        Ok(TimerProject {
            id: body.id,
            name: body.name,
            color: body.color,
            created_at: body.created_at,
        })
    }

    /// Renames or archives a project via `PATCH /projects/:id`.
    pub async fn update_project(
        &self,
        access_token: &str,
        id: &str,
        name: Option<&str>,
        is_archived: Option<bool>,
    ) -> ApiResult<TimerProject> {
        let mut body = serde_json::Map::new();
        if let Some(name) = name {
            body.insert("name".into(), serde_json::json!(name));
        }
        if let Some(is_archived) = is_archived {
            body.insert("isArchived".into(), serde_json::json!(is_archived));
        }
        let response = self
            .http
            .patch(format!("{}/projects/{id}", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::Value::Object(body))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;
        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        let body: ProjectListItem = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The project response could not be read."))?;
        Ok(TimerProject {
            id: body.id,
            name: body.name,
            color: body.color,
            created_at: body.created_at,
        })
    }

    /// The shared dashboard view state.
    pub async fn view_preferences(&self, access_token: &str) -> ApiResult<ViewPreferences> {
        self.get_json(access_token, "/me/preferences").await
    }

    /// Writes the shared view state. Absent fields are left as they were, so
    /// this app can move the scope without claiming anything about the range
    /// the dashboard is showing.
    pub async fn set_view_preferences(
        &self,
        access_token: &str,
        scope: Option<&str>,
        range: Option<&str>,
    ) -> ApiResult<ViewPreferences> {
        let mut body = serde_json::Map::new();
        if let Some(scope) = scope {
            body.insert("scope".into(), serde_json::json!(scope));
        }
        if let Some(range) = range {
            body.insert("range".into(), serde_json::json!(range));
        }
        let response = self
            .http
            .put(format!("{}/me/preferences", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::Value::Object(body))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;
        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The preferences response could not be read."))
    }

    /// What deleting the project would take with it, for the confirm dialog.
    pub async fn project_usage(&self, access_token: &str, id: &str) -> ApiResult<ProjectUsage> {
        self.get_json(access_token, &format!("/projects/{id}/usage"))
            .await
    }

    /// Deletes a project; `reassign_to` moves its data to another project first.
    pub async fn delete_project(
        &self,
        access_token: &str,
        id: &str,
        reassign_to: Option<&str>,
    ) -> ApiResult<()> {
        let response = self
            .http
            .delete(format!("{}/projects/{id}", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "reassignTo": reassign_to }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;
        if response.status().is_success() {
            return Ok(());
        }
        Err(classify_api_error(response).await)
    }

    /// Uploads one batch of finished sessions (at most 500 rows; the caller
    /// chunks). Returns how many rows the server refused.
    pub async fn upload_observed_sessions(
        &self,
        access_token: &str,
        sessions: &[ObservedSession],
    ) -> ApiResult<usize> {
        let response = self
            .http
            .post(format!("{}/sessions/observed", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "sessions": sessions }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        let outcome: ObservedSessionBatchOutcome = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The session upload response could not be read."))?;
        Ok(outcome.rejected.len())
    }

    /// Uploads one activity-segment batch (at most 500 rows; the caller chunks).
    /// Idempotent on `clientId`, so a replayed batch counts as accepted.
    pub async fn upload_segments(
        &self,
        access_token: &str,
        segments: &[SegmentRecord],
    ) -> ApiResult<SegmentBatchOutcome> {
        let response = self
            .http
            .post(format!("{}/activity/segments", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "segments": segments }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The segment upload response could not be read."))
    }

    /// Uploads one shift-commit batch (at most 500 rows; the caller chunks).
    /// Idempotent on `clientId`; verification only ever advances forward, so a
    /// replayed batch is always safe to resend.
    pub async fn upload_shift_commits(
        &self,
        access_token: &str,
        commits: &[ShiftCommitUpload],
    ) -> ApiResult<ShiftCommitBatchOutcome> {
        let response = self
            .http
            .post(format!("{}/shift-commits", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "commits": commits }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        response.json().await.map_err(|_| {
            BridgeError::unknown("The shift-commit upload response could not be read.")
        })
    }

    /// Uploads one drained agent-event batch (at most 500 rows; the caller
    /// chunks). The wire shape is projected (`AgentEventUpload`): the spool
    /// line's capture-only fields never leave the machine.
    pub async fn upload_agent_events(
        &self,
        access_token: &str,
        events: &[SpoolEvent],
    ) -> ApiResult<Vec<AgentEventOutcome>> {
        let events: Vec<AgentEventUpload> = events.iter().map(AgentEventUpload::from).collect();
        let response = self
            .http
            .post(format!("{}/agent-sessions", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "events": events }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        let body: AgentEventBatchResponse = response.json().await.map_err(|_| {
            BridgeError::unknown("The agent-event upload response could not be read.")
        })?;
        Ok(body.results)
    }

    /// Uploads one agent-usage batch (at most 500 rows; the caller chunks).
    /// Idempotent on `clientId`; counters only restate upward, so a replayed
    /// batch is always safe to resend.
    pub async fn upload_agent_usage(
        &self,
        access_token: &str,
        usage: &[AgentUsageUpload],
    ) -> ApiResult<AgentUsageBatchOutcome> {
        let response = self
            .http
            .post(format!("{}/agent-usage", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "usage": usage }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The agent-usage upload response could not be read."))
    }

    /// Stats for a range, for the caller or for a named teammate.
    ///
    /// Instant bounds rather than calendar dates: the server reads a bare date
    /// as a UTC day, which would roll "today" over in the afternoon for anyone
    /// west of Greenwich. The caller sends its own local midnight instead.
    /// Omitting both bounds asks for all time.
    ///
    /// `user_id` opens a teammate's breakdown from the leaderboard. An id from
    /// outside the caller's workspace is refused as a stable not_found, the
    /// same answer the org report gives.
    pub async fn me_stats(
        &self,
        access_token: &str,
        from_at: Option<&str>,
        to_exclusive_at: Option<&str>,
        user_id: Option<&str>,
        scope: Option<&str>,
    ) -> ApiResult<MeStats> {
        let mut query: Vec<(&str, &str)> = Vec::new();
        if let (Some(from_at), Some(to_exclusive_at)) = (from_at, to_exclusive_at) {
            query.push(("fromAt", from_at));
            query.push(("toExclusiveAt", to_exclusive_at));
        }
        if let Some(user_id) = user_id {
            query.push(("userId", user_id));
        }
        if let Some(scope) = scope.filter(|scope| *scope != "all") {
            query.push(("scope", scope));
        }
        let response = self
            .http
            .get(format!("{}/me/stats", self.api_base_url))
            .query(&query)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The stats response could not be read."))
    }

    pub async fn path_mappings(&self, access_token: &str) -> ApiResult<Vec<PathMapping>> {
        let body: PathMappingListResponse = self.get_json(access_token, "/path-mappings").await?;
        Ok(body.mappings)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        access_token: &str,
        path: &str,
    ) -> ApiResult<T> {
        let response = self
            .http
            .get(format!("{}{}", self.api_base_url, path))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify_api_error(response).await);
        }
        response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The server response could not be read."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_status_codes_onto_the_kinds_the_ui_branches_on() {
        assert_eq!(classify(401).kind, ErrorKind::Auth);
        assert_eq!(classify(403).kind, ErrorKind::Auth);
        assert_eq!(classify(409).kind, ErrorKind::Conflict);
        assert_eq!(classify(400).kind, ErrorKind::Validation);
        assert_eq!(classify(422).kind, ErrorKind::Validation);
        assert_eq!(classify(429).kind, ErrorKind::Transient);
        assert_eq!(classify(503).kind, ErrorKind::Transient);
        assert_eq!(classify(418).kind, ErrorKind::Unknown);
    }

    #[test]
    fn error_messages_never_leak_a_token_url_or_server_body() {
        let secret = "eyJhbGciOiJFZERTQSJ9.payload.signature";
        for status in [400, 401, 403, 409, 422, 429, 500, 503, 418] {
            let message = classify(status).message;
            assert!(!message.contains(secret));
            assert!(!message.contains("http"));
            assert!(!message.contains("Bearer"));
            assert!(!message.is_empty());
        }
    }

    #[test]
    fn serializes_errors_in_the_shape_the_bridge_narrows_on() {
        let json =
            serde_json::to_value(BridgeError::auth("Sign in again.")).expect("error serializes");

        assert_eq!(json["kind"], "auth");
        assert_eq!(json["message"], "Sign in again.");
    }

    #[test]
    fn archived_projects_never_reach_the_picker() {
        let body: ProjectListResponse = serde_json::from_str(
            r##"{"projects":[
                {"id":"a","name":"Active","color":null,"createdAt":"2026-08-10T12:00:00Z","isArchived":false},
                {"id":"b","name":"Archived","color":"#2563eb","createdAt":"2026-08-11T12:00:00Z","isArchived":true}
            ]}"##,
        )
        .expect("project list parses");
        let visible: Vec<_> = body
            .projects
            .into_iter()
            .filter(|project| !project.is_archived)
            .map(|project| project.name)
            .collect();

        assert_eq!(visible, vec!["Active".to_string()]);
    }

    #[test]
    fn reads_a_created_project_without_a_color() {
        let body: ProjectListItem =
            serde_json::from_str(r#"{"id":"p1","name":"Field work","createdAt":"2026-08-10T12:00:00Z","isArchived":false}"#)
                .expect("created project parses");

        assert_eq!(body.name, "Field work");
        assert_eq!(body.color, None);
        assert!(!body.is_archived);
    }

    #[test]
    fn keeps_the_signed_session_cookie_verbatim_and_drops_its_attributes() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            "__Secure-neon-auth.session_token=abc123.XYZ%2Fsig%3D; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=None"
                .parse()
                .expect("header parses"),
        );

        assert_eq!(
            session_cookie_value(&headers).expect("cookie found"),
            "abc123.XYZ%2Fsig%3D"
        );
    }

    #[test]
    fn accepts_the_unprefixed_cookie_name_and_skips_unrelated_cookies() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            "other-cookie=nope; Path=/".parse().expect("header parses"),
        );
        headers.append(
            reqwest::header::SET_COOKIE,
            "neon-auth.session_token=tok.sig; Path=/"
                .parse()
                .expect("header parses"),
        );

        assert_eq!(
            session_cookie_value(&headers).expect("cookie found"),
            "tok.sig"
        );
    }

    #[test]
    fn errors_clearly_when_no_session_cookie_arrives() {
        let headers = reqwest::header::HeaderMap::new();

        let error = session_cookie_value(&headers).expect_err("no cookie, no session");
        assert_eq!(error.kind, ErrorKind::Unknown);
        assert!(error.message.contains("no session cookie"));
    }

    #[test]
    fn trims_trailing_slashes_so_paths_never_double_up() {
        let client = ApiClient::new(
            "https://auth.test/neondb/auth/".to_string(),
            "https://api.test/".to_string(),
        )
        .expect("client builds");

        assert_eq!(client.auth_base_url, "https://auth.test/neondb/auth");
        assert_eq!(client.api_base_url, "https://api.test");
        // The Origin header must be scheme and host only, never the base path.
        assert_eq!(client.auth_origin, "https://auth.test");
    }

    #[test]
    fn names_the_sign_up_failures_a_user_can_act_on() {
        assert!(classify_signup(422, Some("USER_ALREADY_EXISTS"))
            .message
            .contains("Sign in instead"));
        assert!(classify_signup(400, Some("PASSWORD_TOO_SHORT"))
            .message
            .contains("8 characters"));
        assert!(classify_signup(400, Some("INVALID_EMAIL"))
            .message
            .contains("valid email"));
        for error in [
            classify_signup(422, Some("USER_ALREADY_EXISTS")),
            classify_signup(400, Some("PASSWORD_TOO_SHORT")),
            classify_signup(400, Some("INVALID_EMAIL")),
        ] {
            assert_eq!(error.kind, ErrorKind::Validation);
        }
        // An unrecognized code falls back to the status mapping.
        assert_eq!(
            classify_signup(503, Some("SOMETHING_NEW")).kind,
            ErrorKind::Transient
        );
        assert_eq!(classify_signup(500, None).kind, ErrorKind::Transient);
    }

    #[test]
    fn reads_the_me_stats_response_shape() {
        let stats: MeStats = serde_json::from_str(
            r#"{
                "filters": {"from": "2026-08-01"},
                "totalDurationSeconds": 7200,
                "attributedSeconds": 5400,
                "unattributedSeconds": 1800,
                "projects": [{
                    "project": {"id": "p1", "name": "Clock-In"},
                    "durationSeconds": 7200,
                    "attributedSeconds": 5400,
                    "unattributedSeconds": 1800,
                    "sessionCount": 3
                }],
                "apps": [
                    {"processName": "Code.exe", "durationSeconds": 4800},
                    {"processName": "chrome.exe", "durationSeconds": 1200}
                ],
                "activeSeconds": 7000,
                "agentSeconds": 10800,
                "concurrency": {
                    "t0Seconds": 3400,
                    "t1Seconds": 0,
                    "t2Seconds": 3600,
                    "t3PlusSeconds": 0,
                    "awaySeconds": 3600
                },
                "byAgent": [
                    {"source": "claude_code", "model": null, "durationSeconds": 7200},
                    {"source": "codex", "model": "gpt-5", "durationSeconds": 3600}
                ],
                "hourly": [
                    {
                        "hourStart": "2026-08-06T09:00:00.000Z",
                        "activeSeconds": 3600,
                        "agentSeconds": 1800,
                        "inputTokens": 12000,
                        "outputTokens": 800,
                        "cacheCreationInputTokens": 400,
                        "cacheReadInputTokens": 60000
                    },
                    {
                        "hourStart": "2026-08-06T10:00:00.000Z",
                        "activeSeconds": 3600,
                        "agentSeconds": 0,
                        "inputTokens": null,
                        "outputTokens": null,
                        "cacheCreationInputTokens": null,
                        "cacheReadInputTokens": null
                    }
                ]
            }"#,
        )
        .expect("stats parse");

        // The measurement block must survive the round trip: the webview's
        // decoder rejects the whole reading if any of it is missing.
        assert_eq!(stats.active_seconds, 7_000);
        assert_eq!(stats.agent_seconds, 10_800);
        assert_eq!(stats.concurrency.t2_seconds, 3_600);
        assert_eq!(stats.concurrency.away_seconds, 3_600);
        assert_eq!(stats.by_agent[1].source, "codex");
        assert_eq!(stats.by_agent[1].model.as_deref(), Some("gpt-5"));
        // The hourly series rides through too, null token fields included: a
        // dropped field here is how the chart once shipped painting nothing.
        assert_eq!(stats.hourly.len(), 2);
        assert_eq!(stats.hourly[0].input_tokens, Some(12_000));
        assert_eq!(stats.hourly[1].input_tokens, None);
        // Re-serialized to the webview in the camelCase the decoder reads.
        let echoed = serde_json::to_value(&stats).expect("stats serialize");
        assert_eq!(echoed["activeSeconds"], 7_000);
        assert_eq!(echoed["concurrency"]["t3PlusSeconds"], 0);
        assert_eq!(echoed["byAgent"][0]["durationSeconds"], 7_200);
        assert_eq!(echoed["hourly"][0]["cacheReadInputTokens"], 60_000);
        assert_eq!(
            echoed["hourly"][1]["cacheReadInputTokens"],
            serde_json::Value::Null
        );

        assert_eq!(stats.filters.from.as_deref(), Some("2026-08-01"));
        assert_eq!(stats.filters.to, None);
        assert_eq!(stats.projects[0].project.name, "Clock-In");
        assert_eq!(stats.attributed_seconds, 5400);
        assert_eq!(stats.unattributed_seconds, 1_800);
        assert_eq!(stats.projects[0].attributed_seconds, 5400);
        assert_eq!(stats.projects[0].unattributed_seconds, 1_800);
        assert_eq!(stats.apps[0].process_name, "Code.exe");
        assert_eq!(stats.apps[0].duration_seconds, 4800);
    }

    #[test]
    fn reads_agents_report_rows_from_an_api_that_predates_token_fields() {
        let row: AgentsReportRow = serde_json::from_str(
            r#"{
                "agent": {
                    "id": "a1",
                    "name": "Claude Code @ Field work",
                    "source": "claude_code",
                    "status": "anonymous",
                    "owner": {"id": "u1", "name": "Alex"},
                    "project": {"id": "p1", "name": "Field work"}
                },
                "agentSeconds": 3600,
                "shiftCount": 1,
                "commitsRecorded": 0,
                "commitsPending": 0,
                "commitsMerged": 0,
                "commitsReverted": 0,
                "commitsOrphaned": 0,
                "heldRate": null,
                "models": []
            }"#,
        )
        .expect("row parse");

        // Absent token fields decode as absence, never as a measured zero.
        assert_eq!(row.tokens, None);
        assert!(!row.tokens_reported);
        let echoed = serde_json::to_value(&row).expect("row serialize");
        assert_eq!(echoed["tokens"], serde_json::Value::Null);
        assert_eq!(echoed["tokensReported"], false);

        let reported: AgentsReportRow = serde_json::from_str(
            r#"{
                "agent": {
                    "id": "a1",
                    "name": "Claude Code @ Field work",
                    "source": "claude_code",
                    "status": "registered",
                    "owner": {"id": "u1", "name": "Alex"},
                    "project": null
                },
                "agentSeconds": 3600,
                "shiftCount": 1,
                "commitsRecorded": 0,
                "commitsPending": 0,
                "commitsMerged": 0,
                "commitsReverted": 0,
                "commitsOrphaned": 0,
                "heldRate": null,
                "models": ["claude-fable-5"],
                "tokens": {"inputTokens": 12000, "outputTokens": 800, "cacheCreationInputTokens": 400, "cacheReadInputTokens": 60000},
                "tokensReported": true
            }"#,
        )
        .expect("row with tokens parses");
        assert_eq!(
            reported.tokens.map(|tokens| tokens.input_tokens),
            Some(12_000)
        );
        assert!(reported.tokens_reported);
    }

    #[test]
    fn reads_the_agents_report_as_the_previous_release_sent_it() {
        // The 0.1.7-era API spelled the headcount anonymous/registered and
        // sent no models or token fields. A required `active` here is what
        // dead-ended the Agents tab for every older installer.
        let report: AgentsReport = serde_json::from_str(
            r#"{
                "headcount": {"total": 3, "anonymous": 2, "registered": 1, "retired": 0},
                "rows": [
                    {
                        "agent": {
                            "id": "a1",
                            "name": "Claude Code @ Field work",
                            "source": "claude_code",
                            "status": "anonymous",
                            "owner": {"id": "u1", "name": "Alex"}
                        },
                        "agentSeconds": 3600,
                        "shiftCount": 1,
                        "commitsRecorded": 0,
                        "commitsPending": 0,
                        "commitsMerged": 0,
                        "commitsReverted": 0,
                        "commitsOrphaned": 0,
                        "heldRate": null
                    }
                ]
            }"#,
        )
        .expect("previous-release report parses");

        // The pre-rename split normalizes to the active count it always was.
        assert_eq!(report.headcount.active, 3);
        assert_eq!(report.headcount.total, 3);
        assert_eq!(report.headcount.retired, 0);
        assert_eq!(report.rows[0].models, Vec::<String>::new());
        assert_eq!(report.rows[0].tokens, None);
        assert!(!report.rows[0].tokens_reported);
        // And re-serializes in the current spelling the webview decodes.
        let echoed = serde_json::to_value(&report).expect("report serialize");
        assert_eq!(echoed["headcount"]["active"], 3);
        assert!(echoed["headcount"].get("anonymous").is_none());

        // The current spelling decodes too, and wins when both are present.
        let current: AgentsReportHeadcount = serde_json::from_str(
            r#"{"total": 3, "active": 2, "retired": 1, "anonymous": 9, "registered": 9}"#,
        )
        .expect("current headcount parses");
        assert_eq!(current.active, 2);
        assert_eq!(current.retired, 1);
    }

    #[test]
    fn reads_token_totals_with_a_counter_the_build_predates() {
        // Counters are optional-with-default inside the totals object: a
        // counter the API has not grown yet decodes to zero rather than
        // failing the whole row.
        let totals: AgentTokenTotals = serde_json::from_str(
            r#"{"inputTokens": 12000, "outputTokens": 800, "cacheCreationInputTokens": 400}"#,
        )
        .expect("partial totals parse");
        assert_eq!(totals.input_tokens, 12_000);
        assert_eq!(totals.cache_read_input_tokens, 0);
    }

    #[test]
    fn reads_leaderboard_entries_from_before_the_active_agent_split() {
        let body: LeaderboardResponse = serde_json::from_str(
            r#"{
                "entries": [
                    {
                        "rank": 1,
                        "user": {"id": "u1", "name": "Alex"},
                        "durationSeconds": 7200,
                        "sessionCount": 3
                    }
                ]
            }"#,
        )
        .expect("previous-release leaderboard parses");

        assert_eq!(body.entries[0].duration_seconds, 7_200);
        assert_eq!(body.entries[0].active_seconds, 0);
        assert_eq!(body.entries[0].agent_seconds, 0);
    }

    #[test]
    fn reads_the_paystub_trend_out_of_a_full_paystub_response() {
        let trend: AgentPaystubTrend = serde_json::from_str(
            r#"{
                "agent": {"id": "a1", "name": "Claude Code @ Field work"},
                "filters": {},
                "totals": {"agentSeconds": 5400, "shiftCount": 2},
                "models": [],
                "shifts": [{"id": "s1", "startedAt": "2026-08-06T10:00:00.000Z"}],
                "trend": [
                    {"periodStartAt": "2026-07-27T00:00:00.000Z", "agentSeconds": 3600, "shiftCount": 1, "heldRate": null},
                    {"periodStartAt": "2026-08-03T00:00:00.000Z", "agentSeconds": 1800, "shiftCount": 1, "heldRate": 0.5}
                ]
            }"#,
        )
        .expect("paystub trend parses");

        // The rest of the paystub is the web dashboard's business; only the
        // weekly buckets ride through to the webview.
        assert_eq!(trend.trend.len(), 2);
        assert_eq!(trend.trend[0].agent_seconds, 3_600);
        assert_eq!(trend.trend[0].held_rate, None);
        assert_eq!(trend.trend[1].held_rate, Some(0.5));
        let echoed = serde_json::to_value(&trend).expect("trend serialize");
        assert_eq!(
            echoed["trend"][1]["periodStartAt"],
            "2026-08-03T00:00:00.000Z"
        );
        assert_eq!(echoed["trend"][0]["heldRate"], serde_json::Value::Null);
    }

    #[test]
    fn reads_agent_activity_from_me_stats_and_survives_its_absence() {
        let stats: MeStats = serde_json::from_str(
            r#"{
                "filters": {},
                "totalDurationSeconds": 7200,
                "attributedSeconds": 5400,
                "unattributedSeconds": 1800,
                "activeSeconds": 7000,
                "agentSeconds": 3600,
                "concurrency": {"t0Seconds": 3400, "t1Seconds": 0, "t2Seconds": 0, "t3PlusSeconds": 0, "awaySeconds": 0},
                "byAgent": [],
                "projects": [],
                "apps": [],
                "agents": [
                    {"agent": {"id": "a1", "source": "claude_code"}, "shiftCount": 2, "tokensReported": true},
                    {"agent": {"id": "a2", "source": "codex"}, "shiftCount": 1}
                ]
            }"#,
        )
        .expect("stats parse");

        // A missing tokensReported stays unknown, never read as "reported none".
        assert_eq!(stats.agents.len(), 2);
        assert_eq!(stats.agents[0].tokens_reported, Some(true));
        assert_eq!(stats.agents[1].tokens_reported, None);
        let echoed = serde_json::to_value(&stats).expect("stats serialize");
        assert_eq!(
            echoed["agents"][1]["tokensReported"],
            serde_json::Value::Null
        );

        // An API from before the field shipped parses to an empty list.
        let older: MeStats = serde_json::from_str(
            r#"{
                "filters": {},
                "totalDurationSeconds": 7200,
                "attributedSeconds": 5400,
                "unattributedSeconds": 1800,
                "activeSeconds": 7000,
                "agentSeconds": 3600,
                "concurrency": {"t0Seconds": 3400, "t1Seconds": 0, "t2Seconds": 0, "t3PlusSeconds": 0, "awaySeconds": 0},
                "byAgent": [],
                "projects": [],
                "apps": []
            }"#,
        )
        .expect("older stats parse");
        assert!(older.agents.is_empty());
        assert!(older.hourly.is_empty());
    }

    #[test]
    fn reads_segment_and_agent_event_batch_outcomes() {
        let segments: SegmentBatchOutcome = serde_json::from_str(
            r#"{"accepted": 2, "rejected": [{"clientId": "c1", "reason": "endedAt must be after startedAt"}]}"#,
        )
        .expect("segment outcome parses");
        assert_eq!(segments.accepted, 2);
        assert_eq!(segments.rejected[0].client_id, "c1");

        let events: AgentEventBatchResponse = serde_json::from_str(
            r#"{"results": [{"externalSessionId": "s1", "accepted": true},
                            {"externalSessionId": "s2", "accepted": false, "reason": "stale"}]}"#,
        )
        .expect("agent outcome parses");
        assert!(events.results[0].accepted);
        assert_eq!(events.results[1].reason.as_deref(), Some("stale"));
    }
}
