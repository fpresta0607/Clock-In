//! The Tauri host behind the React timer.
//!
//! Responsibilities the webview cannot hold safely: the Neon Auth session token
//! lives in the OS credential store, recovery state lives on disk without any
//! token in it, and stops that fail offline are queued for retry.

mod api;
pub mod browser;
mod monitor;
mod recovery;
mod uploader;
// Shared with the `clock-in-hook` binary; the uploader drains it from here.
pub mod spool;
// Shared with the `clock-in-browser-host` binary: the stdio framing it serves.
pub mod native_messaging;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State,
};
use tokio::sync::Mutex;

use api::{
    ApiClient, ApiResult, BridgeError, ErrorKind, LeaderboardEntry, MeStats, Organization,
    PathMapping, PathMappingCreateInput, PathMappingUpdateInput, TimerProject, TimerUser,
};
use monitor::{MonitorSettings, MonitorStatus, SettingsPatch};
use recovery::{reconcile, PendingStop, Reconciliation, RecoveryState, RunningTimer, StartIntent};

const KEYRING_SERVICE: &str = "clock-in";
const KEYRING_ACCOUNT: &str = "neon-auth-session";

/// Reads the session token the OS is holding for us, if any. A free function
/// so the monitor's upload task can mint tokens without borrowing `AppState`.
pub(crate) fn read_session_token() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

pub(crate) fn clear_session_token() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

/// Persists recovery state so an unexpected exit cannot lose a running timer.
/// Shared with the monitor, whose auto-stop enqueues through the same file.
pub(crate) fn write_recovery_file(path: &Path, state: &RecoveryState) -> ApiResult<()> {
    let encoded = serde_json::to_vec(state)
        .map_err(|_| BridgeError::unknown("Could not record the timer locally."))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| BridgeError::unknown("Could not record the timer locally."))?;
    }
    std::fs::write(path, encoded)
        .map_err(|_| BridgeError::unknown("Could not record the timer locally."))
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
        #[serde(rename = "selectedProjectId")]
        selected_project_id: Option<String>,
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
            selected_project_id: account.selected_project_id,
        }
    }
}

#[derive(Serialize)]
struct PendingRetryResult {
    remaining: usize,
}

struct Account {
    user: TimerUser,
    identity: spool::EvidenceIdentity,
    projects: Vec<TimerProject>,
    selected_project_id: Option<String>,
}

pub struct AppState {
    client: ApiClient,
    recovery: Arc<Mutex<RecoveryState>>,
    recovery_path: Mutex<PathBuf>,
    active_identity: Mutex<Option<spool::EvidenceIdentity>>,
    monitor: monitor::Monitor,
    /// An update downloaded in the background, waiting to install on quit.
    /// Auto-update is silent end to end: a failed check or download leaves
    /// this empty and the user on the status quo.
    pending_update: std::sync::Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
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
        clear_session_token();
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
        let ((user, identity), selection) = tokio::try_join!(
            self.client.me_with_identity(access_token),
            self.client.projects(access_token)
        )?;
        Ok(Account {
            user,
            identity,
            projects: selection.projects,
            selected_project_id: selection.selected_project_id,
        })
    }

    async fn read_recovery(&self) -> RecoveryState {
        self.recovery.lock().await.clone()
    }

    /// Persists recovery state so an unexpected exit cannot lose a running timer.
    async fn write_recovery(&self, next: RecoveryState) -> ApiResult<()> {
        let path = self.recovery_path.lock().await.clone();
        write_recovery_file(&path, &next)?;
        *self.recovery.lock().await = next;
        Ok(())
    }

    async fn bind_identity(&self, identity: spool::EvidenceIdentity) -> ApiResult<()> {
        let previous = self.active_identity.lock().await.clone();
        if previous.as_ref() == Some(&identity) {
            return Ok(());
        }
        self.monitor.stop().await;
        let active = spool::active_identity();
        if previous.is_some() || active.as_ref() != Some(&identity) {
            let browser_dir = active
                .as_ref()
                .map(spool::evidence_paths)
                .map(|paths| paths.browser_dir)
                .unwrap_or_else(|| self.monitor.browser_dir());
            browser::deactivate_collection(&browser_dir)?;
        }
        spool::activate_identity(&identity)
            .map_err(|_| BridgeError::unknown("Could not prepare offline evidence."))?;
        let paths = spool::evidence_paths(&identity);
        *self.recovery.lock().await = load_recovery_from_disk(&paths.recovery_path);
        *self.recovery_path.lock().await = paths.recovery_path;
        self.monitor.activate_identity(identity.clone()).await;
        *self.active_identity.lock().await = Some(identity);
        Ok(())
    }

    async fn deactivate_identity(&self) -> ApiResult<()> {
        self.monitor.stop().await;
        let active = spool::active_identity();
        if self.active_identity.lock().await.take().is_some() || active.is_some() {
            let browser_dir = active
                .as_ref()
                .map(spool::evidence_paths)
                .map(|paths| paths.browser_dir)
                .unwrap_or_else(|| self.monitor.browser_dir());
            browser::deactivate_collection(&browser_dir)?;
        }
        spool::clear_active_identity()
            .map_err(|_| BridgeError::unknown("Could not secure offline evidence."))?;
        self.monitor.deactivate_identity().await;
        *self.recovery.lock().await = RecoveryState::default();
        Ok(())
    }

    async fn enable_active_collection(&self) -> ApiResult<()> {
        let identity = self.active_identity.lock().await.clone().ok_or_else(|| {
            BridgeError::unknown("Could not identify the signed-in account.")
        })?;
        browser::enable_collection_for_identity(&self.monitor.browser_dir(), &identity)
    }

    /// Builds the snapshot the UI boots from, given a valid access token.
    async fn snapshot(&self, access_token: &str) -> ApiResult<Snapshot> {
        let account = self.load_account(access_token).await?;
        self.bind_identity(account.identity.clone()).await?;
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
        Err(error) if error.kind == ErrorKind::Auth => {
            state.deactivate_identity().await?;
            state.clear_session_token();
            return Ok(Snapshot::signed_out());
        }
        Err(error) => return Err(error),
    };
    let snapshot = state.snapshot(&access_token).await?;
    state.enable_active_collection().await?;
    // A signed-in session is what starts the monitor: recording while signed
    // out would attribute this machine's evidence to whoever signs in next.
    state.monitor.ensure_running().await;
    Ok(snapshot)
}

#[tauri::command]
async fn auth_login(state: State<'_, AppState>, input: LoginInput) -> ApiResult<Snapshot> {
    state.deactivate_identity().await?;
    state.clear_session_token();
    let session = state.client.sign_in(&input.email, &input.password).await?;
    let access_token = state.client.fetch_access_token(&session).await?;
    let snapshot = state.snapshot(&access_token).await?;
    state.store_session_token(&session)?;
    state.enable_active_collection().await?;
    state.monitor.ensure_running().await;
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
    state.deactivate_identity().await?;
    state.clear_session_token();
    let session = state
        .client
        .sign_up(&input.email, &input.password, &input.name)
        .await?;
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
    state.store_session_token(&session)?;
    state.enable_active_collection().await?;
    state.monitor.ensure_running().await;
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
    let previous = state.active_identity.lock().await.clone();
    state.deactivate_identity().await?;
    if let Err(error) = state
        .client
        .join_organization(&access_token, input.invite_code.trim())
        .await
    {
        if let Some(identity) = previous {
            let _ = state.bind_identity(identity).await;
            let _ = state.enable_active_collection().await;
            state.monitor.ensure_running().await;
        }
        return Err(error);
    }
    state.bind_identity(state.client.identity(&access_token).await?).await?;
    state.enable_active_collection().await?;
    state.monitor.ensure_running().await;
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
    state.deactivate_identity().await?;
    state.clear_session_token();
    Ok(())
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
    // A started timer answers any pending suggested start.
    state.monitor.clear_suggestion();
    Ok(running)
}

/// What `timer_stop` accepts. `idleSeconds` is the UI's away-prompt decision:
/// `null` (or absent) asks the host to measure idle from its own segments,
/// while any number — including 0 — is authoritative and reaches the server
/// verbatim. Zero-as-authoritative is how "keep the away time, and there was
/// no other idle" stops trimming anything.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopInput {
    session_id: String,
    stopped_at: String,
    #[serde(default)]
    idle_seconds: Option<u32>,
}

#[tauri::command]
async fn timer_stop(state: State<'_, AppState>, input: StopInput) -> ApiResult<()> {
    let access_token = state.access_token().await?;

    // An explicit idle figure is the UI's away-prompt decision and wins; `null`
    // means "not decided", so fill it from the monitor's segments when the
    // monitor was watching this session. The server contract wants a concrete
    // number either way, so an unmeasurable stop resolves to 0.
    let idle_seconds = match input.idle_seconds {
        Some(decided) => decided,
        None => match monitor::parse_iso8601(&input.stopped_at) {
            Some(stopped_at) => state
                .monitor
                .measured_idle_for_stop(&input.session_id, stopped_at)
                .await
                .unwrap_or(0),
            None => 0,
        },
    };
    let stop = PendingStop {
        session_id: input.session_id,
        stopped_at: input.stopped_at,
        idle_seconds,
    };
    // A stop is the natural moment to flush buffered evidence.
    state.monitor.request_upload();

    match state.client.stop_session(&access_token, &stop).await {
        Ok(()) => {
            let mut next = state.read_recovery().await;
            next.running = None;
            next.local_start = None;
            state.write_recovery(next).await
        }
        // The stop happened; only the report of it failed. Queue the exact payload.
        Err(error) if error.kind == ErrorKind::Transient => {
            let mut next = state.read_recovery().await;
            next.enqueue_stop(stop).map_err(|_| {
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
async fn monitor_dismiss_suggestion(state: State<'_, AppState>) -> ApiResult<()> {
    state.monitor.clear_suggestion();
    Ok(())
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

/// The [Fix] button on a browser card: re-run registration for that browser
/// and answer with the resulting health so the card updates immediately.
#[tauri::command]
fn browser_repair(
    state: State<'_, AppState>,
    browser: String,
) -> ApiResult<browser::BrowserHealth> {
    browser::repair(&state.monitor.browser_dir(), &browser)
}

/// [Connect Chrome] opens the browser's own store page in the default
/// browser; the install and its confirmation are the browser's floor.
#[tauri::command]
fn browser_open_store_page(browser: String) -> ApiResult<()> {
    browser::open_store_page(&browser)
}

/// The local suggestion tally: unmatched origins with their focused seconds,
/// minus never-suggest answers and origins a current rule already covers.
/// Local-only — none of this is ever uploaded.
#[tauri::command]
fn suggestions_list(state: State<'_, AppState>) -> Vec<browser::TallyEntry> {
    browser::read_suggestions(
        &state.monitor.browser_dir(),
        &state.monitor.cached_mappings(),
    )
}

/// "No - don't ask again" for one origin.
#[tauri::command]
fn suggestion_never_suggest(state: State<'_, AppState>, origin: String) -> ApiResult<()> {
    browser::never_suggest(&state.monitor.browser_dir(), &origin)
}

/// Clears the local tally and the never-suggest list, from settings.
#[tauri::command]
fn suggestions_clear(state: State<'_, AppState>) -> ApiResult<()> {
    browser::clear_suggestion_data(&state.monitor.browser_dir())
}

#[tauri::command]
async fn me_stats(
    state: State<'_, AppState>,
    from_at: Option<String>,
    to_exclusive_at: Option<String>,
) -> ApiResult<MeStats> {
    let access_token = state.access_token().await?;
    state
        .client
        .me_stats(
            &access_token,
            from_at.as_deref(),
            to_exclusive_at.as_deref(),
        )
        .await
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

#[tauri::command]
async fn path_mappings_list(state: State<'_, AppState>) -> ApiResult<Vec<PathMapping>> {
    let access_token = state.access_token().await?;
    let mappings = state.client.path_mappings(&access_token).await?;
    state.monitor.cache_mappings(mappings.clone());
    Ok(mappings)
}

/// Refreshes the monitor's local mapping cache after a change, so suggested
/// starts resolve against current data without waiting for the upload tick.
async fn refresh_mapping_cache(state: &State<'_, AppState>, access_token: &str) {
    if let Ok(mappings) = state.client.path_mappings(access_token).await {
        state.monitor.cache_mappings(mappings);
    }
}

#[tauri::command]
async fn path_mappings_create(
    state: State<'_, AppState>,
    input: PathMappingCreateInput,
) -> ApiResult<PathMapping> {
    let access_token = state.access_token().await?;
    let mapping = state
        .client
        .create_path_mapping(&access_token, &input)
        .await?;
    refresh_mapping_cache(&state, &access_token).await;
    Ok(mapping)
}

#[tauri::command]
async fn path_mappings_update(
    state: State<'_, AppState>,
    id: String,
    input: PathMappingUpdateInput,
) -> ApiResult<PathMapping> {
    let access_token = state.access_token().await?;
    let mapping = state
        .client
        .update_path_mapping(&access_token, &id, &input)
        .await?;
    refresh_mapping_cache(&state, &access_token).await;
    Ok(mapping)
}

#[tauri::command]
async fn path_mappings_delete(state: State<'_, AppState>, id: String) -> ApiResult<()> {
    let access_token = state.access_token().await?;
    state.client.delete_path_mapping(&access_token, &id).await?;
    refresh_mapping_cache(&state, &access_token).await;
    Ok(())
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
///
/// This is also where a downloaded update installs: quit is the one moment
/// replacing the binary never interrupts anything.
fn flush_monitor_and_exit(app: &tauri::AppHandle, code: i32) {
    EXIT_FLUSH_STARTED.store(true, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        state.monitor.stop().await;
        let pending = state
            .pending_update
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some((update, bytes)) = pending {
            // A failed install is silent: the user keeps the current version
            // and the next launch's check starts over.
            let _ = update.install(bytes);
        }
        app.exit(code);
    });
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Clock-In", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Clock-In", true, None::<&str>)?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
            let recovery = Arc::new(Mutex::new(RecoveryState::default()));

            let monitor = monitor::Monitor::new(monitor::MonitorConfig {
                client: client.clone(),
                settings_path: data_dir.join("settings.json"),
                segments_path: data_dir.join("segments-spool.jsonl"),
                agent_path: spool::default_spool_path(),
                browser_dir: spool::default_browser_dir(),
                recovery: Arc::clone(&recovery),
                recovery_path: recovery_path.clone(),
            });

            // Silent, idempotent native-messaging registration for every
            // detected browser: the manifests and HKCU keys are Clock-In's own
            // and inert until the user installs the extension, so a broken
            // registration is repaired here before any card could show it.
            browser::ensure_registered(&spool::default_browser_dir());

            app.manage(AppState {
                client,
                recovery,
                recovery_path: Mutex::new(recovery_path),
                active_identity: Mutex::new(None),
                monitor,
                pending_update: std::sync::Mutex::new(None),
            });
            build_tray(app.handle())?;

            // Auto-update: check and download in the background now, install
            // on quit (see flush_monitor_and_exit). Every failure is silent.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_updater::UpdaterExt;
                let Ok(updater) = handle.updater() else {
                    return;
                };
                let Ok(Some(update)) = updater.check().await else {
                    return;
                };
                let Ok(bytes) = update.download(|_, _| {}, || {}).await else {
                    return;
                };
                let state = handle.state::<AppState>();
                *state
                    .pending_update
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((update, bytes));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            timer_bootstrap,
            auth_login,
            auth_signup,
            auth_logout,
            org_overview,
            org_join,
            timer_start,
            timer_stop,
            timer_retry_pending,
            timer_use_server,
            timer_retry_local_start,
            monitor_status,
            hook_register,
            monitor_set_enabled,
            monitor_dismiss_suggestion,
            settings_get,
            settings_update,
            browser_repair,
            browser_open_store_page,
            suggestions_list,
            suggestion_never_suggest,
            suggestions_clear,
            me_stats,
            project_create,
            path_mappings_list,
            path_mappings_create,
            path_mappings_update,
            path_mappings_delete,
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
    use std::cell::RefCell;

    fn account() -> Account {
        Account {
            user: TimerUser {
                id: "u1".to_string(),
                email: "alex@example.com".to_string(),
                name: "Alex Morgan".to_string(),
            },
            identity: spool::EvidenceIdentity::new("u1", "o1").expect("identity is valid"),
            projects: vec![TimerProject {
                id: "p1".to_string(),
                name: "General Work".to_string(),
                color: None,
                is_default: true,
            }],
            selected_project_id: Some("p1".to_string()),
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
        assert_eq!(json["projects"][0]["name"], "General Work");
        assert_eq!(json["selectedProjectId"], "p1");
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
    fn stop_input_reads_null_idle_as_host_measured_and_zero_as_authoritative() {
        let missing: StopInput =
            serde_json::from_str(r#"{"sessionId":"s1","stoppedAt":"2026-08-06T15:00:00.000Z"}"#)
                .expect("a stop without idleSeconds parses");
        assert_eq!(missing.idle_seconds, None);

        let null: StopInput = serde_json::from_str(
            r#"{"sessionId":"s1","stoppedAt":"2026-08-06T15:00:00.000Z","idleSeconds":null}"#,
        )
        .expect("a stop with null idleSeconds parses");
        assert_eq!(null.idle_seconds, None);

        // An explicit 0 is a decision ("keep the away time; nothing else was
        // idle"), not a request to measure.
        let zero: StopInput = serde_json::from_str(
            r#"{"sessionId":"s1","stoppedAt":"2026-08-06T15:00:00.000Z","idleSeconds":0}"#,
        )
        .expect("a stop with zero idleSeconds parses");
        assert_eq!(zero.idle_seconds, Some(0));

        let decided: StopInput = serde_json::from_str(
            r#"{"sessionId":"s1","stoppedAt":"2026-08-06T15:00:00.000Z","idleSeconds":600}"#,
        )
        .expect("a stop with an idle figure parses");
        assert_eq!(decided.idle_seconds, Some(600));
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

    #[test]
    fn session_persistence_precedes_browser_collection_authorization() {
        let effects = RefCell::new(Vec::new());
        store_session_before_enabling_collection(
            || {
                effects.borrow_mut().push("store");
                Ok(())
            },
            || {
                effects.borrow_mut().push("enable");
                Ok(())
            },
        )
        .expect("both steps succeed");
        assert_eq!(*effects.borrow(), ["store", "enable"]);

        let blocked = RefCell::new(Vec::new());
        let result = store_session_before_enabling_collection(
            || {
                blocked.borrow_mut().push("store");
                Err(BridgeError::unknown("store failed"))
            },
            || {
                blocked.borrow_mut().push("enable");
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(*blocked.borrow(), ["store"]);
    }
}
