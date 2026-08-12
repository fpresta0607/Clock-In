//! The Tauri host behind the React timer.
//!
//! Responsibilities the webview cannot hold safely: the Neon Auth session token
//! lives in the OS credential store, recovery state lives on disk without any
//! token in it, and stops that fail offline are queued for retry.

mod agent_runtimes;
mod api;
mod app_icons;
mod monitor;
mod quota;
mod recovery;
mod uploader;
// Shared with the `clock-in-hook` binary; the uploader drains it from here.
pub mod spool;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State,
};
use tokio::sync::Mutex;

use api::{
    ApiClient, ApiResult, BridgeError, ErrorKind, LeaderboardEntry, MeStats, Organization,
    TimerProject, TimerUser,
};
use monitor::{MonitorSettings, MonitorStatus, SettingsPatch};
use recovery::RecoveryState;

const KEYRING_SERVICE: &str = "clock-in";
const KEYRING_ACCOUNT: &str = "neon-auth-session";

/// Reads the session token the OS is holding for us, if any. A free function
/// so the monitor's upload task can mint tokens without borrowing `AppState`.
pub(crate) fn read_session_token() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

/// Persists recovery state so an unexpected exit cannot lose a recorded
/// session. Shared with the monitor, which updates it on every poll.
pub(crate) fn write_recovery_file(path: &Path, state: &RecoveryState) -> ApiResult<()> {
    let encoded = serde_json::to_vec(state)
        .map_err(|_| BridgeError::unknown("Could not record the session locally."))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| BridgeError::unknown("Could not record the session locally."))?;
    }
    std::fs::write(path, encoded)
        .map_err(|_| BridgeError::unknown("Could not record the session locally."))
}

/// Compiled in, not read at runtime. An empty value counts as unset so a CI
/// variable that was never defined falls back rather than yielding a bad URL;
/// build.rs refuses a release build that reaches that fallback.
fn compiled_url(value: Option<&str>, fallback: &str) -> String {
    match value {
        Some(url) if !url.trim().is_empty() => url.trim().to_string(),
        _ => fallback.to_string(),
    }
}

fn auth_base_url() -> String {
    compiled_url(
        option_env!("CLOCK_IN_AUTH_URL"),
        "http://localhost:4000/auth",
    )
}

fn api_base_url() -> String {
    compiled_url(option_env!("CLOCK_IN_API_URL"), "http://localhost:3977")
}

/// The `BootstrapSnapshot` union the React bridge decodes. Signed-out carries no
/// account; every other variant flattens the account beside its own fields.
#[derive(Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
// Built once per command and serialized immediately, so boxing the large variant
// would buy indirection and nothing else.
#[allow(clippy::large_enum_variant)]
enum Snapshot {
    SignedOut {
        kind: &'static str,
    },
    Account {
        kind: &'static str,
        user: TimerUser,
        projects: Vec<TimerProject>,
        /// Where time lands when nothing else names a project.
        default_project_id: Option<String>,
        /// The project the person pinned recording to, if they pinned one.
        selected_project_id: Option<String>,
    },
}

impl Snapshot {
    fn signed_out() -> Self {
        Self::SignedOut { kind: "signed-out" }
    }

    fn account(
        account: Account,
        default_project_id: Option<String>,
        selected_project_id: Option<String>,
    ) -> Self {
        Self::Account {
            kind: "ready",
            user: account.user,
            projects: account.projects,
            default_project_id,
            selected_project_id,
        }
    }
}

struct Account {
    user: TimerUser,
    projects: Vec<TimerProject>,
}

pub struct AppState {
    client: ApiClient,
    recovery: Arc<Mutex<RecoveryState>>,
    recovery_path: Mutex<PathBuf>,
    monitor: monitor::Monitor,
    /// Reads how much of each coding agent's plan is left, from the evidence
    /// those CLIs already keep on this machine. Never uploaded, never on the
    /// critical path: the command answers from cache and refreshes behind it.
    quota: quota::QuotaMonitor,
}

impl AppState {
    /// Reads the session token the OS is holding for us, if any.
    fn session_token(&self) -> Option<String> {
        read_session_token()
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

    /// Removes a recovered open session only after it has been handed to the
    /// matching account's scoped session spool.
    async fn clear_recovery_for(&self, user_id: &str) -> ApiResult<()> {
        let path = self.recovery_path.lock().await.clone();
        let mut recovery = self.recovery.lock().await;
        recovery.open_sessions.remove(user_id);
        write_recovery_file(&path, &recovery)?;
        Ok(())
    }

    async fn start_recording_for_account(&self) -> ApiResult<()> {
        let user_id = self
            .monitor
            .account_id()
            .ok_or_else(|| BridgeError::unknown("Could not prepare recording for this account."))?;
        let carried = self.read_recovery().await;
        self.monitor.carry_over(&carried, &user_id);
        self.clear_recovery_for(&user_id).await?;
        self.monitor.ensure_running().await;
        Ok(())
    }

    /// Builds the snapshot the UI boots from, given a valid access token.
    /// Establishing the default project is part of booting: without one there
    /// is nowhere for automatic time to land.
    async fn snapshot(&self, access_token: &str) -> ApiResult<Snapshot> {
        let account = self.load_account(access_token).await?;
        // `/projects` is alphabetized for people. The automatic fallback is
        // the oldest project, using its creation time explicitly.
        self.monitor.begin_account(&account.user.id);
        let default_project_id = oldest_project_id(&account.projects);
        self.monitor.cache_mappings(
            self.client
                .path_mappings(access_token)
                .await
                .unwrap_or_default(),
        );
        self.monitor.set_default_project(default_project_id.clone());
        let selected_project_id = self.monitor.status().await.selected_project_id;
        Ok(Snapshot::account(
            account,
            default_project_id,
            selected_project_id,
        ))
    }
}

fn oldest_project_id(projects: &[TimerProject]) -> Option<String> {
    projects
        .iter()
        .min_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        })
        .map(|project| project.id.clone())
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
    let snapshot = state.snapshot(&access_token).await?;
    state.start_recording_for_account().await?;
    Ok(snapshot)
}

#[tauri::command]
async fn auth_login(state: State<'_, AppState>, input: LoginInput) -> ApiResult<Snapshot> {
    state.monitor.stop().await;
    let session = state.client.sign_in(&input.email, &input.password).await?;
    state.store_session_token(&session)?;
    let access_token = state.client.fetch_access_token(&session).await?;
    let snapshot = state.snapshot(&access_token).await?;
    state.start_recording_for_account().await?;
    Ok(snapshot)
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
    #[serde(default)]
    invite_code: Option<String>,
}

#[tauri::command]
async fn auth_signup(state: State<'_, AppState>, input: SignupInput) -> ApiResult<Snapshot> {
    state.monitor.stop().await;
    let session = state
        .client
        .sign_up(&input.email, &input.password, &input.name)
        .await?;
    state.store_session_token(&session)?;
    let access_token = state.client.fetch_access_token(&session).await?;

    // Provision explicitly and first: any other authenticated call would create a
    // personal workspace before the invite code could be applied.
    let code = input
        .invite_code
        .as_deref()
        .map(str::trim)
        .filter(|code| !code.is_empty());
    state.client.provision_account(&access_token, code).await?;

    let snapshot = state.snapshot(&access_token).await?;
    state.start_recording_for_account().await?;
    Ok(snapshot)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrganizationOverview {
    organization: Organization,
    entries: Vec<LeaderboardEntry>,
}

#[tauri::command]
async fn org_join(state: State<'_, AppState>, input: JoinInput) -> ApiResult<OrganizationOverview> {
    let access_token = state.access_token().await?;
    state
        .client
        .join_organization(&access_token, input.invite_code.trim())
        .await?;
    // Return the new workspace so the window updates without a reload.
    let (organization, entries) = tokio::try_join!(
        state.client.organization(&access_token),
        state.client.leaderboard(&access_token)
    )?;
    Ok(OrganizationOverview {
        organization,
        entries,
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinInput {
    invite_code: String,
}

#[tauri::command]
async fn org_overview(state: State<'_, AppState>) -> ApiResult<OrganizationOverview> {
    let access_token = state.access_token().await?;
    let (organization, entries) = tokio::try_join!(
        state.client.organization(&access_token),
        state.client.leaderboard(&access_token)
    )?;
    Ok(OrganizationOverview {
        organization,
        entries,
    })
}

#[tauri::command]
async fn auth_logout(state: State<'_, AppState>) -> ApiResult<()> {
    // Signing out stops the monitor: nothing is recorded while there is no
    // account the evidence could belong to.
    state.monitor.stop().await;
    state.clear_session_token();
    state.monitor.clear_account();
    Ok(())
}

/// Pins recording to one project, or clears the pin so agent working
/// directories and the default project decide again. The open session closes
/// at its last active moment on the next tick, so a switch never backdates
/// work into the project just chosen.
#[tauri::command]
async fn session_select_project(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> ApiResult<MonitorStatus> {
    state.monitor.select_project(project_id);
    Ok(state.monitor.status().await)
}

#[tauri::command]
async fn monitor_status(state: State<'_, AppState>) -> ApiResult<MonitorStatus> {
    Ok(state.monitor.status().await)
}

/// Opt-in hook registration for one agent CLI, triggered from the settings
/// UI. Never silent: the user clicks, and the result says whether the CLI's
/// config was merged or a paste-it-yourself snippet came back.
#[tauri::command]
async fn hook_register(source: String) -> ApiResult<monitor::HookRegisterResult> {
    monitor::register_hook(&source)
}

#[tauri::command]
async fn monitor_set_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> ApiResult<MonitorSettings> {
    state
        .monitor
        .apply_patch(&SettingsPatch {
            enabled: Some(enabled),
            ..SettingsPatch::default()
        })
        .await
}

#[tauri::command]
async fn settings_get(state: State<'_, AppState>) -> ApiResult<MonitorSettings> {
    Ok(state.monitor.settings())
}

#[tauri::command]
async fn settings_update(
    state: State<'_, AppState>,
    input: SettingsPatch,
) -> ApiResult<MonitorSettings> {
    state.monitor.apply_patch(&input).await
}

#[tauri::command]
async fn me_stats(
    state: State<'_, AppState>,
    from_at: Option<String>,
    to_exclusive_at: Option<String>,
    user_id: Option<String>,
) -> ApiResult<MeStats> {
    let access_token = state.access_token().await?;
    state
        .client
        .me_stats(
            &access_token,
            from_at.as_deref(),
            to_exclusive_at.as_deref(),
            user_id.as_deref(),
        )
        .await
}

/// How much of each coding agent's plan is left, read from what those CLIs
/// already store on this machine. Answers from cache immediately; a stale
/// reading refreshes on a background thread rather than holding the UI.
#[tauri::command]
fn quota_status(state: State<'_, AppState>) -> quota::QuotaSnapshot {
    state.quota.snapshot()
}

/// Real OS icons for the executables the usage meter lists, as PNG data URIs
/// keyed by the names the caller sent. Total by design: a name that cannot be
/// resolved maps to `None`, never an error for the batch. Extraction reads
/// the process table, the registry, and disk, so it runs on the blocking
/// pool; results are cached for the process lifetime.
#[tauri::command]
async fn app_icons(process_names: Vec<String>) -> HashMap<String, Option<String>> {
    tauri::async_runtime::spawn_blocking(move || app_icons::lookup(process_names))
        .await
        .unwrap_or_default()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateInput {
    name: String,
}

#[tauri::command]
async fn project_create(
    state: State<'_, AppState>,
    input: ProjectCreateInput,
) -> ApiResult<TimerProject> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(BridgeError::new(
            ErrorKind::Validation,
            "Project names must be 1 to 80 characters.",
        ));
    }
    let access_token = state.access_token().await?;
    state.client.create_project(&access_token, name).await
}

/// Set once the exit flush starts. `AppHandle::exit` itself re-triggers
/// `RunEvent::ExitRequested`, and this is what tells that second request —
/// ours — apart from the user's, so it is let through instead of starting
/// another flush.
static EXIT_FLUSH_STARTED: AtomicBool = AtomicBool::new(false);

/// Stops the monitor (flushing and spooling the open activity segment) and
/// only then exits the process. Tauri's tray menu and run-event callbacks are
/// synchronous and cannot await, so the stop runs on the async runtime and the
/// exit happens once the segment is safely on disk. Only manually verifiable:
/// a test would need a live event loop. A force quit (Task Manager kill) still
/// runs no code at all — durability there is what is already spooled, so at
/// most the trailing open span since the last transition is lost.
fn flush_monitor_and_exit(app: &tauri::AppHandle, code: i32) {
    EXIT_FLUSH_STARTED.store(true, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        state.monitor.stop().await;
        // The session the flush just spooled reaches the server before the
        // process dies; otherwise it sits invisible until the next launch.
        // Offline, the pass gives up within its timeout and quit proceeds.
        state.monitor.upload_flush().await;
        app.exit(code);
    });
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
                "quit" => flush_monitor_and_exit(app, 0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/// How often the app looks for a new build after the launch check. Six hours
/// keeps a machine that is never restarted current without making the release
/// host answer on a loop.
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3_600);

/// Looks for a newer build and installs it, returning whether one was staged.
///
/// Silence is the whole contract here. A laptop on a plane, a blocked release
/// host, a half-written manifest: none of that is the person's problem, and
/// none of it may interrupt recording. Every failure path logs and returns,
/// because the next check is at most `UPDATE_CHECK_INTERVAL` away.
///
/// On Windows the NSIS installer replaces the app in place and Tauri restarts
/// it, so the download happens quietly in the background and only the final
/// swap is visible.
async fn install_available_update(handle: &tauri::AppHandle) -> bool {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match handle.updater() {
        Ok(updater) => updater,
        Err(error) => {
            eprintln!("clock-in: the updater is unavailable: {error}");
            return false;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        // No update, or the host could not be reached. Both are ordinary.
        Ok(None) => return false,
        Err(error) => {
            eprintln!("clock-in: could not check for an update: {error}");
            return false;
        }
    };

    // The one visible moment: the UI shows a banner while the download and
    // swap happen, so the restart that follows is announced, not a surprise.
    let _ = handle.emit("update-available", update.version.clone());

    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            eprintln!("clock-in: staged update {}", update.version);
            true
        }
        Err(error) => {
            eprintln!("clock-in: could not install the update: {error}");
            false
        }
    }
}

/// Checks at launch and then on a timer, for the lifetime of the app.
fn spawn_update_checks(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            // A staged update ends this loop: the app is about to be replaced,
            // and checking again from a process that is on its way out would
            // only race the installer.
            if install_available_update(&handle).await {
                return;
            }
            tokio::time::sleep(UPDATE_CHECK_INTERVAL).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            spawn_update_checks(app.handle().clone());
            let recovery_path = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("recovery.json"))
                .unwrap_or_else(|_| PathBuf::from("recovery.json"));
            let data_dir = recovery_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));
            let client = ApiClient::new(auth_base_url(), api_base_url())
                .map_err(|error| std::io::Error::other(error.message))?;
            let recovery = Arc::new(Mutex::new(load_recovery_from_disk(&recovery_path)));

            let monitor = monitor::Monitor::new(monitor::MonitorConfig {
                client: client.clone(),
                settings_path: data_dir.join("settings.json"),
                segments_path: data_dir.join("segments-spool.jsonl"),
                sessions_path: data_dir.join("sessions-spool.jsonl"),
                agent_path: spool::agent_spool_path(),
                recovery_path: recovery_path.clone(),
                recovery: Arc::clone(&recovery),
            });

            app.manage(AppState {
                client,
                recovery,
                recovery_path: Mutex::new(recovery_path),
                monitor,
                quota: quota::QuotaMonitor::new(),
            });
            build_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            timer_bootstrap,
            auth_login,
            auth_signup,
            auth_logout,
            org_overview,
            org_join,
            session_select_project,
            monitor_status,
            quota_status,
            hook_register,
            monitor_set_enabled,
            settings_get,
            settings_update,
            me_stats,
            app_icons,
            project_create,
        ])
        .build(tauri::generate_context!())
        .expect("the Clock-In desktop host failed to start")
        .run(|app_handle, event| {
            // Window close → exit and OS session end (logoff/shutdown) both
            // arrive here. The exit is held until the monitor's open segment
            // is flushed to the spool, then the process exits itself. The
            // `app.exit` that finishes the flush re-triggers this event; the
            // flag lets that one through instead of looping.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if EXIT_FLUSH_STARTED.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                flush_monitor_and_exit(app_handle, code.unwrap_or(0));
            }
        });
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
                created_at: "2026-08-10T12:00:00Z".to_string(),
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
    fn an_account_snapshot_carries_the_projects_and_where_time_lands() {
        let json = serde_json::to_value(Snapshot::account(account(), Some("p1".to_string()), None))
            .expect("snapshot serializes");

        assert_eq!(json["kind"], "ready");
        assert_eq!(json["user"]["email"], "alex@example.com");
        assert_eq!(json["projects"][0]["name"], "General");
        assert_eq!(json["defaultProjectId"], "p1");
        assert!(json["selectedProjectId"].is_null());
    }

    #[test]
    fn an_account_snapshot_reports_a_project_the_person_pinned() {
        let json = serde_json::to_value(Snapshot::account(
            account(),
            Some("p1".to_string()),
            Some("p2".to_string()),
        ))
        .expect("snapshot serializes");

        assert_eq!(json["selectedProjectId"], "p2");
    }

    #[test]
    fn the_default_project_is_the_oldest_not_the_first_alphabetical_result() {
        let projects = vec![
            TimerProject {
                id: "p-zebra".to_string(),
                name: "Zebra".to_string(),
                color: None,
                created_at: "2026-08-10T12:00:00Z".to_string(),
            },
            TimerProject {
                id: "p-alpha".to_string(),
                name: "Alpha".to_string(),
                color: None,
                created_at: "2026-08-09T12:00:00Z".to_string(),
            },
        ];

        assert_eq!(oldest_project_id(&projects).as_deref(), Some("p-alpha"));
    }

    #[test]
    fn recovery_state_round_trips_through_disk_without_holding_a_token() {
        let state = RecoveryState {
            open_sessions: [(
                "u1".to_string(),
                monitor::OpenSession {
                    client_id: "c1".to_string(),
                    project: monitor::SessionProject {
                        project_id: "p1".to_string(),
                        attribution: monitor::Attribution::Default,
                    },
                    started_at: 1_000,
                    idle_seconds: 60,
                    last_active_at: 2_000,
                },
            )]
            .into_iter()
            .collect(),
        };

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

    #[test]
    fn an_unset_or_empty_compiled_url_falls_back_instead_of_yielding_a_bad_one() {
        assert_eq!(
            compiled_url(None, "http://localhost:3977"),
            "http://localhost:3977"
        );
        assert_eq!(
            compiled_url(Some(""), "http://localhost:3977"),
            "http://localhost:3977"
        );
        assert_eq!(
            compiled_url(Some("   "), "http://localhost:3977"),
            "http://localhost:3977"
        );
        assert_eq!(
            compiled_url(
                Some(" https://api.clock-in.example "),
                "http://localhost:3977"
            ),
            "https://api.clock-in.example"
        );
    }
}
