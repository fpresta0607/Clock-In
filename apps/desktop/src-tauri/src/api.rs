//! HTTP access to Neon Auth and the Clock-In API.
//!
//! Two rules hold everywhere in this module: errors never carry a response body
//! or a URL (either can contain a token), and the caller always learns which
//! kind of failure it was so the UI can react without parsing strings.

use serde::{Deserialize, Serialize};

use crate::monitor::{ObservedSession, SegmentRecord};
use crate::spool::{AgentSource, SpoolEvent};

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
    pub active_seconds: u64,
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

    /// Uploads one drained agent-event batch (at most 500 rows; the caller chunks).
    pub async fn upload_agent_events(
        &self,
        access_token: &str,
        events: &[SpoolEvent],
    ) -> ApiResult<Vec<AgentEventOutcome>> {
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
        // Re-serialized to the webview in the camelCase the decoder reads.
        let echoed = serde_json::to_value(&stats).expect("stats serialize");
        assert_eq!(echoed["activeSeconds"], 7_000);
        assert_eq!(echoed["concurrency"]["t3PlusSeconds"], 0);
        assert_eq!(echoed["byAgent"][0]["durationSeconds"], 7_200);

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
