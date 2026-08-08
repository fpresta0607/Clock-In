//! HTTP access to Neon Auth and the Clock-In API.
//!
//! Two rules hold everywhere in this module: errors never carry a response body
//! or a URL (either can contain a token), and the caller always learns which
//! kind of failure it was so the UI can react without parsing strings.

use serde::{Deserialize, Serialize};

use crate::recovery::{PendingStop, RunningTimer, StartIntent};

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
    is_archived: bool,
}

#[derive(Deserialize)]
struct SessionEnvelope {
    session: Option<SessionPayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPayload {
    id: String,
    client_id: String,
    project_id: String,
    #[serde(default)]
    description: Option<String>,
    started_at: String,
}

impl From<SessionPayload> for RunningTimer {
    fn from(payload: SessionPayload) -> Self {
        Self {
            session_id: payload.id,
            client_id: payload.client_id,
            project_id: payload.project_id,
            description: payload.description.unwrap_or_default(),
            started_at: payload.started_at,
        }
    }
}

#[derive(Deserialize)]
struct AuthErrorBody {
    #[serde(default)]
    code: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
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
/// is the Clock-In API.
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

    pub async fn leaderboard(&self, access_token: &str) -> ApiResult<Vec<LeaderboardEntry>> {
        let body: LeaderboardResponse = self.get_json(access_token, "/reports/leaderboard").await?;
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
            })
            .collect())
    }

    pub async fn current_session(&self, access_token: &str) -> ApiResult<Option<RunningTimer>> {
        let body: SessionEnvelope = self.get_json(access_token, "/sessions/current").await?;
        Ok(body.session.map(RunningTimer::from))
    }

    /// Idempotent on `clientId`: replaying the identical payload after a timeout
    /// returns the session that was already created rather than a second one.
    pub async fn start_session(
        &self,
        access_token: &str,
        intent: &StartIntent,
    ) -> ApiResult<RunningTimer> {
        let response = self
            .http
            .post(format!("{}/sessions", self.api_base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({
                "clientId": intent.client_id,
                "projectId": intent.project_id,
                "description": intent.description,
                "startedAt": intent.started_at,
            }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if !response.status().is_success() {
            return Err(classify(response.status().as_u16()));
        }

        let body: SessionEnvelope = response
            .json()
            .await
            .map_err(|_| BridgeError::unknown("The session response could not be read."))?;
        body.session
            .map(RunningTimer::from)
            .ok_or_else(|| BridgeError::unknown("The server did not return a started session."))
    }

    pub async fn stop_session(&self, access_token: &str, stop: &PendingStop) -> ApiResult<()> {
        let response = self
            .http
            .post(format!(
                "{}/sessions/{}/stop",
                self.api_base_url, stop.session_id
            ))
            .bearer_auth(access_token)
            .json(&serde_json::json!({
                "stoppedAt": stop.stopped_at,
                "idleSeconds": stop.idle_seconds,
            }))
            .send()
            .await
            .map_err(|error| classify_transport(&error))?;

        if response.status().is_success() {
            return Ok(());
        }
        Err(classify(response.status().as_u16()))
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
            return Err(classify(response.status().as_u16()));
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
                {"id":"a","name":"Active","color":null,"isArchived":false},
                {"id":"b","name":"Archived","color":"#2563eb","isArchived":true}
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
    fn reads_a_running_session_and_defaults_a_null_description() {
        let body: SessionEnvelope = serde_json::from_str(
            r#"{"session":{"id":"s1","clientId":"c1","projectId":"p1","description":null,
                "status":"running","startedAt":"2026-08-06T14:00:00.000Z","stoppedAt":null,
                "idleSeconds":0,"durationSeconds":null}}"#,
        )
        .expect("session parses");
        let running: RunningTimer = body.session.expect("a session is present").into();

        assert_eq!(running.session_id, "s1");
        assert_eq!(running.client_id, "c1");
        assert_eq!(running.description, "");
    }

    #[test]
    fn reads_an_absent_current_session() {
        let body: SessionEnvelope =
            serde_json::from_str(r#"{"session":null}"#).expect("empty session parses");

        assert!(body.session.is_none());
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
}
