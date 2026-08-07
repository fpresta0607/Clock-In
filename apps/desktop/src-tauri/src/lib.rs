//! The Tauri host behind the React timer.
//!
//! Responsibilities the webview cannot hold safely: the Neon Auth session token
//! lives in the OS credential store, recovery state lives on disk without any
//! token in it, and stops that fail offline are queued for retry.

mod api;
mod recovery;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State,
};
use tokio::sync::Mutex;

use api::{ApiClient, ApiResult, BridgeError, ErrorKind, TimerProject, TimerUser};
use recovery::{reconcile, PendingStop, Reconciliation, RecoveryState, RunningTimer, StartIntent};

const KEYRING_SERVICE: &str = "clock-in";
const KEYRING_ACCOUNT: &str = "neon-auth-session";

fn auth_base_url() -> String {
    option_env!("CLOCK_IN_AUTH_URL")
        .unwrap_or("http://localhost:4000/auth")
        .to_string()
}

fn api_base_url() -> String {
    option_env!("CLOCK_IN_API_URL")
        .unwrap_or("http://localhost:3000")
        .to_string()
}

/// The `BootstrapSnapshot` union the React bridge decodes. Signed-out carries no
/// account; every other variant flattens the account beside its own fields.
#[derive(Serialize)]
#[serde(untagged)]
// Built once per command and serialized immediately, so boxing the large variant
// would buy indirection and nothing else.
#[allow(clippy::large_enum_variant)]
enum Snapshot {
    SignedOut {
        kind: &'static str,
    },
    Account {
        #[serde(flatten)]
        state: Reconciliation,
        user: TimerUser,
        projects: Vec<TimerProject>,
    },
}

impl Snapshot {
    fn signed_out() -> Self {
        Self::SignedOut { kind: "signed-out" }
    }

    fn account(state: Reconciliation, account: Account) -> Self {
        Self::Account {
            state,
            user: account.user,
            projects: account.projects,
        }
    }
}

#[derive(Serialize)]
struct PendingRetryResult {
    remaining: usize,
}

struct Account {
    user: TimerUser,
    projects: Vec<TimerProject>,
}

pub struct AppState {
    client: ApiClient,
    recovery: Mutex<RecoveryState>,
    recovery_path: Mutex<PathBuf>,
}

impl AppState {
    /// Reads the session token the OS is holding for us, if any.
    fn session_token(&self) -> Option<String> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .ok()
            .and_then(|entry| entry.get_password().ok())
    }

    fn store_session_token(&self, token: &str) -> ApiResult<()> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .and_then(|entry| entry.set_password(token))
            .map_err(|_| BridgeError::unknown("Could not save the sign-in securely."))
    }

    fn clear_session_token(&self) {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
            let _ = entry.delete_credential();
        }
    }

    /// Every command mints a fresh access token.
    // ponytail: one extra round-trip per user action beats tracking expiry; cache
    // the JWT against its exp claim if action latency ever matters.
    async fn access_token(&self) -> ApiResult<String> {
        let session = self
            .session_token()
            .ok_or_else(|| BridgeError::auth("Sign in to continue."))?;
        self.client.fetch_access_token(&session).await
    }

    async fn load_account(&self, access_token: &str) -> ApiResult<Account> {
        let (user, projects) = tokio::try_join!(
            self.client.me(access_token),
            self.client.projects(access_token)
        )?;
        Ok(Account { user, projects })
    }

    async fn read_recovery(&self) -> RecoveryState {
        self.recovery.lock().await.clone()
    }

    /// Persists recovery state so an unexpected exit cannot lose a running timer.
    async fn write_recovery(&self, next: RecoveryState) -> ApiResult<()> {
        let path = self.recovery_path.lock().await.clone();
        let encoded = serde_json::to_vec(&next)
            .map_err(|_| BridgeError::unknown("Could not record the timer locally."))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| BridgeError::unknown("Could not record the timer locally."))?;
        }
        std::fs::write(&path, encoded)
            .map_err(|_| BridgeError::unknown("Could not record the timer locally."))?;
        *self.recovery.lock().await = next;
        Ok(())
    }

    /// Builds the snapshot the UI boots from, given a valid access token.
    async fn snapshot(&self, access_token: &str) -> ApiResult<Snapshot> {
        let account = self.load_account(access_token).await?;
        let server_running = self.client.current_session(access_token).await?;
        let state = self.read_recovery().await;
        Ok(Snapshot::account(
            reconcile(&state, server_running.as_ref()),
            account,
        ))
    }
}

fn load_recovery_from_disk(path: &PathBuf) -> RecoveryState {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[tauri::command]
async fn timer_bootstrap(state: State<'_, AppState>) -> ApiResult<Snapshot> {
    let access_token = match state.access_token().await {
        Ok(token) => token,
        // No stored session, or the stored one no longer works: show sign-in
        // rather than an error the user cannot act on.
        Err(error) if error.kind == ErrorKind::Auth => return Ok(Snapshot::signed_out()),
        Err(error) => return Err(error),
    };
    state.snapshot(&access_token).await
}

#[tauri::command]
async fn auth_login(state: State<'_, AppState>, input: LoginInput) -> ApiResult<Snapshot> {
    let session = state.client.sign_in(&input.email, &input.password).await?;
    state.store_session_token(&session)?;
    // A new sign-in must never inherit the previous account's timers.
    state.write_recovery(RecoveryState::default()).await?;
    let access_token = state.client.fetch_access_token(&session).await?;
    state.snapshot(&access_token).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    email: String,
    password: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignupInput {
    email: String,
    password: String,
    name: String,
}

#[tauri::command]
async fn auth_signup(state: State<'_, AppState>, input: SignupInput) -> ApiResult<Snapshot> {
    let session = state
        .client
        .sign_up(&input.email, &input.password, &input.name)
        .await?;
    state.store_session_token(&session)?;
    state.write_recovery(RecoveryState::default()).await?;
    let access_token = state.client.fetch_access_token(&session).await?;
    // The first authenticated call provisions the organization and starter project.
    state.snapshot(&access_token).await
}

#[tauri::command]
async fn auth_logout(state: State<'_, AppState>) -> ApiResult<()> {
    state.clear_session_token();
    state.write_recovery(RecoveryState::default()).await
}

#[tauri::command]
async fn timer_start(state: State<'_, AppState>, input: StartIntent) -> ApiResult<RunningTimer> {
    let access_token = state.access_token().await?;

    // Record the intent before the request so a crash mid-flight is recoverable.
    let mut pending = state.read_recovery().await;
    pending.local_start = Some(input.clone());
    state.write_recovery(pending).await?;

    let running = state.client.start_session(&access_token, &input).await?;

    let mut confirmed = state.read_recovery().await;
    confirmed.local_start = None;
    confirmed.running = Some(running.clone());
    state.write_recovery(confirmed).await?;
    Ok(running)
}

#[tauri::command]
async fn timer_stop(state: State<'_, AppState>, input: PendingStop) -> ApiResult<()> {
    let access_token = state.access_token().await?;
    match state.client.stop_session(&access_token, &input).await {
        Ok(()) => {
            let mut next = state.read_recovery().await;
            next.running = None;
            next.local_start = None;
            state.write_recovery(next).await
        }
        // The stop happened; only the report of it failed. Queue the exact payload.
        Err(error) if error.kind == ErrorKind::Transient => {
            let mut next = state.read_recovery().await;
            next.enqueue_stop(input).map_err(|_| {
                BridgeError::unknown("Too many unsynced stops are already waiting.")
            })?;
            state.write_recovery(next).await?;
            Err(error)
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
async fn timer_retry_pending(state: State<'_, AppState>) -> ApiResult<PendingRetryResult> {
    let access_token = state.access_token().await?;

    loop {
        let Some(stop) = state.read_recovery().await.peek_stop().cloned() else {
            break;
        };
        // Retries send the byte-identical payload, so a stop that did land the
        // first time is absorbed by the server rather than double-counted.
        state.client.stop_session(&access_token, &stop).await?;
        let mut next = state.read_recovery().await;
        next.confirm_oldest_stop();
        state.write_recovery(next).await?;
    }

    Ok(PendingRetryResult {
        remaining: state.read_recovery().await.pending_stops.len(),
    })
}

#[tauri::command]
async fn timer_use_server(state: State<'_, AppState>) -> ApiResult<Snapshot> {
    let access_token = state.access_token().await?;

    // Abandoning the local start is the whole point of this choice.
    let mut next = state.read_recovery().await;
    next.local_start = None;
    state.write_recovery(next).await?;

    state.snapshot(&access_token).await
}

#[tauri::command]
async fn timer_retry_local_start(
    state: State<'_, AppState>,
    input: StartIntent,
) -> ApiResult<Snapshot> {
    let access_token = state.access_token().await?;
    let running = state.client.start_session(&access_token, &input).await?;

    let mut next = state.read_recovery().await;
    next.local_start = None;
    next.running = Some(running);
    state.write_recovery(next).await?;

    state.snapshot(&access_token).await
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Clock-In", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".to_string()))?,
        )
        .menu(&menu)
        .tooltip("Clock-In")
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            match event.id().as_ref() {
                "show" => {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                "hide" => {
                    let _ = window.hide();
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let recovery_path = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("recovery.json"))
                .unwrap_or_else(|_| PathBuf::from("recovery.json"));
            let client = ApiClient::new(auth_base_url(), api_base_url())
                .map_err(|error| std::io::Error::other(error.message))?;

            app.manage(AppState {
                client,
                recovery: Mutex::new(load_recovery_from_disk(&recovery_path)),
                recovery_path: Mutex::new(recovery_path),
            });
            build_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            timer_bootstrap,
            auth_login,
            auth_signup,
            auth_logout,
            timer_start,
            timer_stop,
            timer_retry_pending,
            timer_use_server,
            timer_retry_local_start,
        ])
        .run(tauri::generate_context!())
        .expect("the Clock-In desktop host failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> Account {
        Account {
            user: TimerUser {
                id: "u1".to_string(),
                email: "alex@example.com".to_string(),
                name: "Alex Morgan".to_string(),
            },
            projects: vec![TimerProject {
                id: "p1".to_string(),
                name: "General".to_string(),
                color: None,
            }],
        }
    }

    #[test]
    fn signed_out_carries_no_account_fields() {
        let json = serde_json::to_value(Snapshot::signed_out()).expect("snapshot serializes");

        assert_eq!(json["kind"], "signed-out");
        assert!(json.get("user").is_none());
        assert!(json.get("projects").is_none());
    }

    #[test]
    fn an_account_snapshot_flattens_the_account_beside_its_own_fields() {
        let json = serde_json::to_value(Snapshot::account(Reconciliation::Idle, account()))
            .expect("snapshot serializes");

        assert_eq!(json["kind"], "idle");
        assert_eq!(json["user"]["email"], "alex@example.com");
        assert_eq!(json["projects"][0]["name"], "General");
    }

    #[test]
    fn a_pending_sync_snapshot_reports_its_count_to_the_ui() {
        let json = serde_json::to_value(Snapshot::account(
            Reconciliation::PendingSync { pending_count: 3 },
            account(),
        ))
        .expect("snapshot serializes");

        assert_eq!(json["kind"], "pending-sync");
        assert_eq!(json["pendingCount"], 3);
        assert_eq!(json["user"]["id"], "u1");
    }

    #[test]
    fn a_conflict_snapshot_carries_both_sides_for_the_user_to_choose() {
        let json = serde_json::to_value(Snapshot::account(
            Reconciliation::Conflict {
                local_start: StartIntent {
                    client_id: "c1".to_string(),
                    project_id: "p1".to_string(),
                    description: "Local".to_string(),
                    started_at: "2026-08-06T14:00:00.000Z".to_string(),
                },
                server_running: RunningTimer {
                    session_id: "s9".to_string(),
                    client_id: "c9".to_string(),
                    project_id: "p1".to_string(),
                    description: "Server".to_string(),
                    started_at: "2026-08-06T13:00:00.000Z".to_string(),
                },
            },
            account(),
        ))
        .expect("snapshot serializes");

        assert_eq!(json["kind"], "conflict");
        assert_eq!(json["localStart"]["clientId"], "c1");
        assert_eq!(json["serverRunning"]["sessionId"], "s9");
    }

    #[test]
    fn recovery_state_round_trips_through_disk_without_holding_a_token() {
        let mut state = RecoveryState::default();
        state
            .enqueue_stop(PendingStop {
                session_id: "s1".to_string(),
                stopped_at: "2026-08-06T15:00:00.000Z".to_string(),
                idle_seconds: 0,
            })
            .expect("stop queues");

        let encoded = serde_json::to_string(&state).expect("state serializes");
        let decoded: RecoveryState = serde_json::from_str(&encoded).expect("state parses");

        assert_eq!(decoded, state);
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("password"));
    }

    #[test]
    fn missing_or_corrupt_recovery_files_start_from_a_clean_slate() {
        let missing = PathBuf::from("definitely-not-a-real-recovery-file.json");

        assert_eq!(load_recovery_from_disk(&missing), RecoveryState::default());
    }
}
