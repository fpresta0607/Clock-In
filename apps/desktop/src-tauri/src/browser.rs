//! The desktop side of browser attribution: native-messaging registration,
//! per-browser health, the rules file the host serves, the local suggestion
//! tally, and the handshake marker the host drops when the extension connects.
//!
//! Registration is silent and idempotent: for every detected browser the app
//! writes a host manifest beside the spools (its `allowed_origins` pins the
//! extension id) and points the browser's HKCU `NativeMessagingHosts` key at
//! it, at first run and again on every launch. The keys are Clock-In's own,
//! need no elevation, and are inert until the user installs the extension from
//! its store page - the one click no native app can perform for them.
//!
//! The manifest's `path` is the `clock-in-browser-host` binary installed next
//! to the app executable (both ship as `externalBin` siblings, exactly like
//! `clock-in-hook`), so registration resolves it with the same
//! "beside the running app" rule the hook registration uses.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::api::{ApiResult, BridgeError, MappingKind, PathMapping};
use crate::spool;

/// The native-messaging host name the extension connects to. Changing it is a
/// breaking change for every registered browser and the extension build.
pub const HOST_NAME: &str = "com.clock_in.browser_host";

/// Store listing ids are assigned at submission time; until then registration
/// pins these placeholders, and [Connect] opens the store home page. One spot
/// to update when the listings land.
const CHROME_EXTENSION_ID: &str = "pending-chrome-web-store-id";
const EDGE_EXTENSION_ID: &str = "pending-edge-add-ons-id";
/// The Firefox variant declares its id in its own manifest
/// (`apps/browser-extension/manifest.firefox.json`); keep these in sync.
const FIREFOX_EXTENSION_ID: &str = "browser-extension@clock-in.app";

const CHROME_STORE_URL: &str = "https://chromewebstore.google.com/";
const EDGE_STORE_URL: &str = "https://microsoftedge.microsoft.com/addons/";
const FIREFOX_STORE_URL: &str = "https://addons.mozilla.org/";

/// A browser Clock-In can register the native host for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Browser {
    Chrome,
    Edge,
    Firefox,
}

impl Browser {
    pub const ALL: [Browser; 3] = [Browser::Chrome, Browser::Edge, Browser::Firefox];

    /// The stable id the wire uses (`browser_repair` takes it, health reports it).
    pub fn id(self) -> &'static str {
        match self {
            Browser::Chrome => "chrome",
            Browser::Edge => "edge",
            Browser::Firefox => "firefox",
        }
    }

    /// The plain name the UI shows: "Chrome is connected", never more.
    pub fn label(self) -> &'static str {
        match self {
            Browser::Chrome => "Chrome",
            Browser::Edge => "Edge",
            Browser::Firefox => "Firefox",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|browser| browser.id() == id)
    }

    /// Maps the process that launched the host onto a browser, so the
    /// handshake marker knows which card to flip.
    fn from_process_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "chrome.exe" | "chrome" => Some(Browser::Chrome),
            "msedge.exe" | "msedge" => Some(Browser::Edge),
            "firefox.exe" | "firefox" => Some(Browser::Firefox),
            _ => None,
        }
    }

    /// The HKCU key the browser reads to find the host manifest.
    fn registry_key_path(self) -> String {
        let root = match self {
            Browser::Chrome => r"Software\Google\Chrome\NativeMessagingHosts",
            Browser::Edge => r"Software\Microsoft\Edge\NativeMessagingHosts",
            Browser::Firefox => r"Software\Mozilla\NativeMessagingHosts",
        };
        format!(r"{root}\{HOST_NAME}")
    }

    /// The page [Connect] opens. Placeholders until the store listings exist.
    pub fn store_url(self) -> &'static str {
        match self {
            Browser::Chrome => CHROME_STORE_URL,
            Browser::Edge => EDGE_STORE_URL,
            Browser::Firefox => FIREFOX_STORE_URL,
        }
    }

    /// Install locations that count as "this browser is on the machine".
    fn install_candidates(self) -> Vec<PathBuf> {
        let program_files = std::env::var_os("ProgramFiles")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);

        let mut candidates = Vec::new();
        let mut under = |roots: &[Option<PathBuf>], rest: &str| {
            for root in roots.iter().flatten() {
                candidates.push(root.join(rest));
            }
        };
        match self {
            Browser::Chrome => {
                under(
                    &[program_files, program_files_x86],
                    r"Google\Chrome\Application\chrome.exe",
                );
                under(&[local_app_data], r"Google\Chrome\Application\chrome.exe");
            }
            Browser::Edge => under(
                &[program_files, program_files_x86],
                r"Microsoft\Edge\Application\msedge.exe",
            ),
            Browser::Firefox => under(
                &[program_files, program_files_x86],
                r"Mozilla Firefox\firefox.exe",
            ),
        }
        candidates
    }
}

/// How one browser's connection stands, in the order a setup flows through
/// them. `Registered` means the plumbing is done and only the store install
/// is left - the card keeps offering [Connect], never an error to interpret.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HealthState {
    NeverRegistered,
    BinaryMissing,
    Registered,
    Connected,
}

/// One browser card's worth of health, surfaced on `monitor_status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHealth {
    pub browser: String,
    pub label: String,
    pub state: HealthState,
    pub store_url: String,
}

fn health(browser: Browser, state: HealthState) -> BrowserHealth {
    BrowserHealth {
        browser: browser.id().to_string(),
        label: browser.label().to_string(),
        state,
        store_url: browser.store_url().to_string(),
    }
}

/// The browsers on this machine, by their well-known install locations.
pub fn detected_browsers() -> Vec<Browser> {
    Browser::ALL
        .into_iter()
        .filter(|browser| {
            browser
                .install_candidates()
                .iter()
                .any(|candidate| candidate.exists())
        })
        .collect()
}

/// The host binary registration points at: installed beside the app
/// executable, as `externalBin` places it. Same rule as `clock-in-hook`.
fn host_binary_path() -> ApiResult<PathBuf> {
    let exe = std::env::current_exe()
        .map_err(|_| BridgeError::unknown("Could not locate the Clock-In app."))?;
    let file_name = if cfg!(windows) {
        "clock-in-browser-host.exe"
    } else {
        "clock-in-browser-host"
    };
    Ok(exe
        .parent()
        .map(|dir| dir.join(file_name))
        .unwrap_or_else(|| PathBuf::from(file_name)))
}

/// The manifest one browser's registry key points at. Kept beside the spools
/// so the `CLOCK_IN_SPOOL` override relocates it for tests and support setups.
fn manifest_path(dir: &Path, browser: Browser) -> PathBuf {
    dir.join(format!("browser-host-manifest-{}.json", browser.id()))
}

/// The manifest content: the host path plus the extension pin. Chrome and
/// Edge pin by `allowed_origins`; Firefox uses `allowed_extensions`.
fn host_manifest(browser: Browser, host_binary: &Path) -> String {
    // Backslashes in the Windows install path must survive JSON encoding.
    let path = host_binary.to_string_lossy().replace('\\', "\\\\");
    let pinned = match browser {
        Browser::Chrome => {
            format!(r#""allowed_origins": ["chrome-extension://{CHROME_EXTENSION_ID}/"]"#)
        }
        Browser::Edge => {
            format!(r#""allowed_origins": ["chrome-extension://{EDGE_EXTENSION_ID}/"]"#)
        }
        Browser::Firefox => format!(r#""allowed_extensions": ["{FIREFOX_EXTENSION_ID}"]"#),
    };
    format!(
        "{{\n  \"name\": \"{HOST_NAME}\",\n  \"description\": \"Clock-In browser attribution host\",\n  \"path\": \"{path}\",\n  \"type\": \"stdio\",\n  {pinned}\n}}\n"
    )
}

const COLLECTION_FILE: &str = "browser-collection.json";
const COLLECTION_REVOCATION_FILE: &str = "browser-collection-revoked";
const TALLY_CLEAR_FILE: &str = "browser-tally-clear.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCollection {
    account_id: String,
    collection_id: String,
    admission_id: String,
}

fn collection_path(dir: &Path) -> PathBuf {
    dir.join(COLLECTION_FILE)
}

fn collection_revocation_path(dir: &Path) -> PathBuf {
    dir.join(COLLECTION_REVOCATION_FILE)
}

fn tally_clear_path(dir: &Path) -> PathBuf {
    dir.join(TALLY_CLEAR_FILE)
}

fn browser_spool_path(dir: &Path) -> PathBuf {
    dir.join("browser-spool.jsonl")
}

fn ensure_browser_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)
}

fn read_collection(dir: &Path) -> Option<BrowserCollection> {
    let collection = serde_json::from_slice::<BrowserCollection>(&std::fs::read(collection_path(dir)).ok()?).ok()?;
    (!collection.account_id.trim().is_empty() && !collection.collection_id.trim().is_empty() && !collection.admission_id.trim().is_empty()).then_some(collection)
}

pub fn collection_id(dir: &Path) -> Option<String> {
    read_collection(dir).map(|collection| collection.collection_id)
}

fn collection_is_revoked(dir: &Path) -> bool {
    match std::fs::metadata(collection_revocation_path(dir)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        _ => true,
    }
}

pub fn admitted_collection_id(dir: &Path) -> Option<String> {
    admitted_collection_id_with_session(
        dir,
        crate::read_session_token().is_some_and(|session| !session.trim().is_empty()),
    )
}

pub fn admitted_collection_id_with_session(dir: &Path, session_authorized: bool) -> Option<String> {
    session_authorized
        .then(|| (!collection_is_revoked(dir)).then(|| collection_id(dir)).flatten())
        .flatten()
}

fn next_collection_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!("{}-{}-{}", crate::monitor::unix_now(), std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn discard_browser_evidence(dir: &Path) -> io::Result<()> {
    let spool = browser_spool_path(dir);
    for path in [
        spool.clone(),
        spool.with_extension("old.jsonl"),
        dir.join("unmatched-tally.json"),
        dir.join("never-suggest.json"),
        tally_clear_path(dir),
    ] {
        remove_if_exists(&path)?;
    }
    Ok(())
}

pub fn enable_collection(dir: &Path, account_id: &str) -> ApiResult<()> {
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return Err(BridgeError::new(crate::api::ErrorKind::Validation, "Could not identify the signed-in account."));
    }
    ensure_browser_dir(dir)
        .map_err(|_| BridgeError::unknown("Could not enable browser attribution."))?;
    let spool = browser_spool_path(dir);
    spool::with_lock(&spool, || {
        if !collection_is_revoked(dir) && read_collection(dir).is_some_and(|collection| collection.account_id == account_id) {
            return Ok(());
        }
        remove_if_exists(&collection_path(dir))?;
        discard_browser_evidence(dir)?;
        let body = serde_json::to_vec(&BrowserCollection {
            account_id: account_id.to_string(),
            collection_id: next_collection_id(),
            admission_id: next_collection_id(),
        })
        .map_err(io::Error::other)?;
        write_if_changed(&collection_path(dir), &body)?;
        remove_if_exists(&collection_revocation_path(dir))
    })
    .map_err(|_| BridgeError::unknown("Could not enable browser attribution."))
}

pub fn revoke_collection(dir: &Path) -> ApiResult<()> {
    ensure_browser_dir(dir)
        .map_err(|_| BridgeError::unknown("Could not disable browser attribution."))?;
    let spool = browser_spool_path(dir);
    spool::with_lock(&spool, || write_if_changed_locked(&collection_revocation_path(dir), b"{}"))
        .map_err(|_| BridgeError::unknown("Could not disable browser attribution."))
}

pub fn discard_collection(dir: &Path) -> ApiResult<()> {
    let spool = browser_spool_path(dir);
    spool::with_lock(&spool, || {
        remove_if_exists(&collection_path(dir))?;
        discard_browser_evidence(dir)
    })
    .map_err(|_| BridgeError::unknown("Could not disable browser attribution."))
}

pub fn disable_collection(dir: &Path) -> ApiResult<()> {
    revoke_collection(dir)?;
    discard_collection(dir)
}

/// Silent first-run-and-every-launch registration: rewrite the manifests and
/// repair any missing registry keys for the browsers on the machine. Nothing
/// here may fail the app - a broken registration surfaces on the browser card
/// with a [Fix] button instead.
pub fn ensure_registered(dir: &Path) {
    for browser in detected_browsers() {
        if let Err(error) = register(dir, browser) {
            eprintln!(
                "clock-in: could not register the browser host for {}: {error}",
                browser.id()
            );
        }
    }
}

/// Writes the manifest and points the browser's registry key at it. Idempotent:
/// an already-correct key is left alone.
fn register(dir: &Path, browser: Browser) -> io::Result<()> {
    let host_binary = host_binary_path().map_err(|error| io::Error::other(error.message))?;
    let manifest = manifest_path(dir, browser);
    if let Some(parent) = manifest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_if_changed(&manifest, host_manifest(browser, &host_binary).as_bytes())?;
    registry::ensure_key(&browser.registry_key_path(), &manifest.to_string_lossy())
}

/// The [Fix] button's repair: register again, then report the resulting
/// health so the card updates from the answer, not a second poll.
pub fn repair(dir: &Path, browser_id: &str) -> ApiResult<BrowserHealth> {
    let browser = Browser::from_id(browser_id)
        .ok_or_else(|| BridgeError::new(crate::api::ErrorKind::Validation, "Unknown browser."))?;
    register(dir, browser)
        .map_err(|_| BridgeError::unknown("The connection could not be repaired."))?;
    Ok(health_of(dir, browser))
}

/// Every detected browser's current health, for the status payload.
pub fn health_all(dir: &Path) -> Vec<BrowserHealth> {
    detected_browsers()
        .into_iter()
        .map(|browser| health_of(dir, browser))
        .collect()
}

fn health_of(dir: &Path, browser: Browser) -> BrowserHealth {
    let Some(registered_manifest) = registry::read_key(&browser.registry_key_path()) else {
        return health(browser, HealthState::NeverRegistered);
    };
    if !Path::new(&registered_manifest).exists() {
        return health(browser, HealthState::NeverRegistered);
    }
    match host_binary_path() {
        Ok(binary) if !binary.exists() => health(browser, HealthState::BinaryMissing),
        Err(_) => health(browser, HealthState::BinaryMissing),
        _ if handshake_is_fresh(dir, browser, crate::monitor::unix_now()) => health(browser, HealthState::Connected),
        _ => health(browser, HealthState::Registered),
    }
}

/// A handshake marker proves "connected" only while fresh. The browser
/// relaunches the host - and re-marks - on every extension connect, so an
/// active extension refreshes the marker many times a day; a marker older
/// than a day means the extension (or the browser) is gone, and the card
/// drops back to "registered" rather than claiming Connected forever.
const HANDSHAKE_STALE_SECONDS: u64 = 24 * 3_600;

/// Which browser's extension has completed a handshake, if any. The host
/// drops this marker when the browser launches it (that launch *is* the
/// handshake), naming the parent process it could see. `now` is injected so
/// staleness is testable.
fn handshake_is_fresh(dir: &Path, browser: Browser, now: u64) -> bool {
    let bytes = match std::fs::read(handshake_path(dir, browser)) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    let Some(at) = value
        .get("at")
        .and_then(|value| value.as_str())
        .and_then(crate::monitor::parse_iso8601)
    else {
        return false;
    };
    if now.saturating_sub(at) > HANDSHAKE_STALE_SECONDS {
        return false;
    }
    value.get("browser").and_then(|value| value.as_str()) == Some(browser.id())
}

fn handshake_path(dir: &Path, browser: Browser) -> PathBuf {
    dir.join(format!("browser-handshake-{}.json", browser.id()))
}

/// Called by `clock-in-browser-host` at startup: the browser launched it, so
/// the extension is connected. Best-effort - the marker feeds a UI badge and
/// nothing else.
pub fn record_handshake(dir: &Path) {
    let Some(browser) = parent_browser() else {
        return;
    };
    record_handshake_for(dir, browser);
}

fn record_handshake_for(dir: &Path, browser: Browser) {
    let marker = handshake_path(dir, browser);
    let body = serde_json::json!({
        "browser": browser.id(),
        "at": spool::now_iso8601(),
    });
    let Ok(bytes) = serde_json::to_vec(&body) else {
        return;
    };
    let _ = write_if_changed(&marker, &bytes);
}

/// The browser that launched this process, by walking the process table for
/// the parent's executable name. Windows-only; elsewhere the marker records
/// `null` and cards stay at "registered" rather than guessing.
#[cfg(windows)]
fn parent_browser() -> Option<Browser> {
    parent_process_name().and_then(|name| Browser::from_process_name(&name))
}

#[cfg(not(windows))]
fn parent_browser() -> Option<Browser> {
    None
}

/// One process-table row: pid, parent pid, executable name.
struct ProcessEntry {
    pid: u32,
    parent_pid: u32,
    name: String,
}

/// Finds the parent process's executable name in a full process-table
/// snapshot: locate our own row for the parent pid, then that row's name.
/// Pure over the entries so the lookup is testable without real processes.
/// Parents usually enumerate *before* their children, so the snapshot must
/// be collected whole before the lookup; a single forward pass that expects
/// the parent after the child misses the typical case entirely.
fn parent_name_from_entries(entries: &[ProcessEntry], self_pid: u32) -> Option<String> {
    let parent_pid = entries
        .iter()
        .find(|entry| entry.pid == self_pid)?
        .parent_pid;
    entries
        .iter()
        .find(|entry| entry.pid == parent_pid)
        .map(|entry| entry.name.clone())
}

#[cfg(windows)]
fn parent_process_name() -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let result = (|| {
            let mut entry: windows_sys::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W =
                std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            if Process32FirstW(snapshot, &mut entry) == 0 {
                return None;
            }
            let mut entries = Vec::new();
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|unit| *unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                entries.push(ProcessEntry {
                    pid: entry.th32ProcessID,
                    parent_pid: entry.th32ParentProcessID,
                    name: String::from_utf16(&entry.szExeFile[..end]).ok()?,
                });
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
            parent_name_from_entries(&entries, std::process::id())
        })();
        let _ = CloseHandle(snapshot);
        result
    }
}

/// Rewrites the rules file the host serves from the cached mappings: rule id
/// plus pattern only, `url_rule` rows only. Skips the write when nothing
/// changed, so the five-minute cache refresh does not touch the file.
pub fn write_rules_file(dir: &Path, mappings: &[PathMapping]) -> io::Result<()> {
    let rules: Vec<serde_json::Value> = mappings
        .iter()
        .filter(|mapping| mapping.kind == MappingKind::UrlRule)
        .map(|mapping| serde_json::json!({ "id": mapping.id, "pattern": mapping.path_prefix }))
        .collect();
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "rules": rules }))
        .map_err(io::Error::other)?;
    write_if_changed(&dir.join("browser-rules.json"), &bytes)
}

/// Writes `content` to `path` via a temp file and rename, unless the file
/// already holds exactly those bytes. The spool's advisory lock serializes
/// the full compare/write/remove/rename sequence across processes; the temp
/// name is unique as a second line of defense against a crashed writer's
/// leftover. The browser files have real concurrent writers: uploader and
/// mapping commands share the rules file, and browser host processes share
/// the tally and handshake files.
pub fn write_if_changed(path: &Path, content: &[u8]) -> io::Result<()> {
    spool::with_lock(path, || write_if_changed_locked(path, content))
}

fn write_if_changed_locked(path: &Path, content: &[u8]) -> io::Result<()> {
    if std::fs::read(path).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    let tmp = unique_temp(path);
    let outcome = std::fs::write(&tmp, content).and_then(|()| {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        std::fs::rename(&tmp, path)
    });
    if outcome.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    outcome
}

/// The per-writer temp name for `path`: same directory, unique to this
/// process and this call.
fn unique_temp(path: &Path) -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let serial = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    path.with_extension(format!("tmp-{}-{serial}", std::process::id()))
}

/// One suggestion the tally earns: an unmatched origin and its focused seconds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TallyEntry {
    pub origin: String,
    pub seconds: u64,
}

fn tally_week_start(now: u64) -> u64 {
    let days = now / 86_400;
    let days_since_monday = (days + 3) % 7;
    (days - days_since_monday) * 86_400_000
}

/// The tally minus anything already answered: never-suggest origins and
/// origins a current `url_rule` already covers (the extension's next snapshot
/// still carries them until its rules refresh; the desktop filters them).
pub fn read_suggestions(dir: &Path, mappings: &[PathMapping]) -> Vec<TallyEntry> {
    let never = read_origin_set(&dir.join("never-suggest.json"));
    let ruled: Vec<String> = mappings
        .iter()
        .filter(|mapping| mapping.kind == MappingKind::UrlRule)
        .map(|mapping| pattern_host(&mapping.path_prefix))
        .collect();
    let bytes = match std::fs::read(dir.join("unmatched-tally.json")) {
        Ok(bytes) => bytes,
        Err(_) => return Vec::new(),
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Vec::new();
    };
    if value.get("weekStart").and_then(|value| value.as_u64()) != Some(tally_week_start(crate::monitor::unix_now())) {
        return Vec::new();
    }
    value
        .get("entries")
        .and_then(|entries| entries.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let origin = entry.get("origin")?.as_str()?.to_string();
                    let seconds = entry.get("seconds")?.as_u64()?;
                    Some(TallyEntry { origin, seconds })
                })
                .filter(|entry| !never.contains(&entry.origin))
                .filter(|entry| !ruled.iter().any(|host| host == &entry.origin))
                .collect()
        })
        .unwrap_or_default()
}

/// The host part of a URL-rule pattern: strip a `*.` prefix, drop any path.
fn pattern_host(pattern: &str) -> String {
    let without_glob = pattern.strip_prefix("*.").unwrap_or(pattern);
    without_glob
        .split('/')
        .next()
        .unwrap_or(without_glob)
        .to_string()
}

/// "No - don't ask again": the origin joins the local never-suggest list.
pub fn never_suggest(dir: &Path, origin: &str) -> ApiResult<()> {
    let origin = origin.trim();
    if origin.is_empty() {
        return Err(BridgeError::new(
            crate::api::ErrorKind::Validation,
            "Origin must not be empty.",
        ));
    }
    let mut origins = read_origin_set(&dir.join("never-suggest.json"));
    origins.insert(origin.to_string());
    let mut sorted: Vec<&String> = origins.iter().collect();
    sorted.sort();
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "origins": sorted }))
        .map_err(|_| BridgeError::unknown("Could not save that answer."))?;
    write_if_changed(&dir.join("never-suggest.json"), &bytes)
        .map_err(|_| BridgeError::unknown("Could not save that answer."))
}

/// Clears the local suggestion data from settings: the tally copy and the
/// never-suggest list. Both are local-only; nothing here was ever uploaded.
pub fn clear_suggestion_data(dir: &Path) -> ApiResult<()> {
    let tally = dir.join("unmatched-tally.json");
    spool::with_lock(&browser_spool_path(dir), || {
        spool::with_lock(&tally, || {
            write_if_changed_locked(&tally_clear_path(dir), b"{}")?;
            remove_if_exists(&tally)?;
            remove_if_exists(&dir.join("never-suggest.json"))
        })
    })
    .map_err(|_| BridgeError::unknown("Could not clear the saved answers."))
}

pub enum TallyStoreOutcome {
    Stored,
    ClearRequested,
}

pub fn store_tally_snapshot(dir: &Path, content: &[u8], is_empty: bool) -> io::Result<TallyStoreOutcome> {
    let tally = dir.join("unmatched-tally.json");
    spool::with_lock(&tally, || {
        let clear = tally_clear_path(dir);
        if clear.exists() {
            if !is_empty {
                return Ok(TallyStoreOutcome::ClearRequested);
            }
            remove_if_exists(&clear)?;
        }
        write_if_changed_locked(&tally, content)?;
        Ok(TallyStoreOutcome::Stored)
    })
}

fn read_origin_set(path: &Path) -> std::collections::BTreeSet<String> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("origins")
                .and_then(|origins| origins.as_array())
                .map(|origins| {
                    origins
                        .iter()
                        .filter_map(|origin| origin.as_str().map(str::to_string))
                        .collect()
                })
        })
        .unwrap_or_default()
}

/// [Connect] opens the browser's own store page in the default browser. The
/// install and its confirmation are the browser's floor; we only open the door.
pub fn open_store_page(browser_id: &str) -> ApiResult<()> {
    let browser = Browser::from_id(browser_id)
        .ok_or_else(|| BridgeError::new(crate::api::ErrorKind::Validation, "Unknown browser."))?;
    open_url(browser.store_url())
}

#[cfg(windows)]
fn open_url(url: &str) -> ApiResult<()> {
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()
        .map(|_| ())
        .map_err(|_| BridgeError::unknown("Could not open the browser's store page."))
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> ApiResult<()> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|_| BridgeError::unknown("Could not open the browser's store page."))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_url(url: &str) -> ApiResult<()> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|_| BridgeError::unknown("Could not open the browser's store page."))
}

/// The registry half of registration, isolated so everything above it stays
/// testable on any OS. HKCU only; no elevation, ever.
#[cfg(windows)]
mod registry {
    use std::io;

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_SZ,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Points `key` at `value`, unless it already does. Returns io::Error so
    /// callers fold registry failures into their own reporting.
    pub fn ensure_key(key: &str, value: &str) -> io::Result<()> {
        if read_key(key).as_deref() == Some(value) {
            return Ok(());
        }
        unsafe {
            let mut handle: HKEY = std::ptr::null_mut();
            let path = wide(key);
            let status = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_WRITE,
                std::ptr::null(),
                &mut handle,
                std::ptr::null_mut(),
            );
            if status != ERROR_SUCCESS {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            let data = wide(value);
            let data_bytes = std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2);
            let status = RegSetValueExW(
                handle,
                std::ptr::null(),
                0,
                REG_SZ,
                data_bytes.as_ptr(),
                data_bytes.len() as u32,
            );
            let _ = RegCloseKey(handle);
            if status != ERROR_SUCCESS {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            Ok(())
        }
    }

    /// The key's default value, or None when the key is absent or unreadable.
    pub fn read_key(key: &str) -> Option<String> {
        unsafe {
            let mut handle: HKEY = std::ptr::null_mut();
            let path = wide(key);
            if RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut handle)
                != ERROR_SUCCESS
            {
                return None;
            }
            let mut length: u32 = 0;
            let status = RegQueryValueExW(
                handle,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut length,
            );
            if status != ERROR_SUCCESS || length == 0 {
                let _ = RegCloseKey(handle);
                return None;
            }
            let mut buffer = vec![0u16; (length as usize).div_ceil(2)];
            let status = RegQueryValueExW(
                handle,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as *mut u8,
                &mut length,
            );
            let _ = RegCloseKey(handle);
            if status != ERROR_SUCCESS {
                return None;
            }
            let used = (length as usize) / 2;
            buffer.truncate(used);
            if buffer.last() == Some(&0) {
                buffer.pop();
            }
            String::from_utf16(&buffer).ok()
        }
    }
}

#[cfg(not(windows))]
mod registry {
    use std::io;

    pub fn ensure_key(_key: &str, _value: &str) -> io::Result<()> {
        Ok(())
    }

    pub fn read_key(_key: &str) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "clock-in-browser-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        dir
    }

    fn mapping(id: &str, kind: MappingKind, prefix: &str) -> PathMapping {
        PathMapping {
            id: id.to_string(),
            kind,
            path_prefix: prefix.to_string(),
            repo_url: None,
            project_id: "p1".to_string(),
        }
    }

    #[test]
    fn chrome_and_edge_manifests_pin_origins_and_firefox_pins_extensions() {
        let binary = PathBuf::from(r"C:\Program Files\Clock-In\clock-in-browser-host.exe");

        let chrome: serde_json::Value =
            serde_json::from_str(&host_manifest(Browser::Chrome, &binary))
                .expect("manifest parses");
        assert_eq!(chrome["name"], HOST_NAME);
        assert_eq!(chrome["type"], "stdio");
        assert_eq!(
            chrome["path"],
            r"C:\Program Files\Clock-In\clock-in-browser-host.exe"
        );
        assert_eq!(
            chrome["allowed_origins"][0],
            format!("chrome-extension://{CHROME_EXTENSION_ID}/")
        );

        let edge: serde_json::Value =
            serde_json::from_str(&host_manifest(Browser::Edge, &binary)).expect("manifest parses");
        assert_eq!(
            edge["allowed_origins"][0],
            format!("chrome-extension://{EDGE_EXTENSION_ID}/")
        );

        let firefox: serde_json::Value =
            serde_json::from_str(&host_manifest(Browser::Firefox, &binary))
                .expect("manifest parses");
        assert_eq!(firefox["allowed_extensions"][0], FIREFOX_EXTENSION_ID);
        assert!(firefox.get("allowed_origins").is_none());
    }

    #[test]
    fn registry_keys_live_under_each_browsers_native_messaging_hosts() {
        assert_eq!(
            Browser::Chrome.registry_key_path(),
            r"Software\Google\Chrome\NativeMessagingHosts\com.clock_in.browser_host"
        );
        assert_eq!(
            Browser::Edge.registry_key_path(),
            r"Software\Microsoft\Edge\NativeMessagingHosts\com.clock_in.browser_host"
        );
        assert_eq!(
            Browser::Firefox.registry_key_path(),
            r"Software\Mozilla\NativeMessagingHosts\com.clock_in.browser_host"
        );
    }

    #[test]
    fn process_names_map_to_browsers_case_insensitively() {
        assert_eq!(
            Browser::from_process_name("chrome.exe"),
            Some(Browser::Chrome)
        );
        assert_eq!(
            Browser::from_process_name("MSEDGE.EXE"),
            Some(Browser::Edge)
        );
        assert_eq!(
            Browser::from_process_name("firefox"),
            Some(Browser::Firefox)
        );
        assert_eq!(Browser::from_process_name("code.exe"), None);
    }

    #[test]
    fn the_rules_file_carries_url_rules_only_as_id_and_pattern() {
        let dir = temp_dir("rules");
        let mappings = vec![
            mapping("r1", MappingKind::UrlRule, "github.com/acme/*"),
            mapping("m1", MappingKind::PathPrefix, "C:/dev/clock-in"),
            mapping("r2", MappingKind::UrlRule, "*.figma.com/files/*"),
        ];

        write_rules_file(&dir, &mappings).expect("rules write");
        let value: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("browser-rules.json")).expect("rules read"),
        )
        .expect("rules parse");
        let rules = value["rules"].as_array().expect("rules is an array");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0]["id"], "r1");
        assert_eq!(rules[0]["pattern"], "github.com/acme/*");
        assert_eq!(rules[1]["id"], "r2");
        assert!(
            rules[0].get("projectId").is_none(),
            "the file is id + pattern only"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unchanged_rule_set_leaves_the_file_untouched() {
        let dir = temp_dir("rules-stable");
        let mappings = vec![mapping("r1", MappingKind::UrlRule, "quickbooks.com")];

        write_rules_file(&dir, &mappings).expect("first write");
        let before = std::fs::metadata(dir.join("browser-rules.json"))
            .expect("rules exist")
            .modified()
            .expect("mtime reads");
        write_rules_file(&dir, &mappings).expect("second write");
        let after = std::fs::metadata(dir.join("browser-rules.json"))
            .expect("rules exist")
            .modified()
            .expect("mtime reads");
        assert_eq!(before, after, "identical content is not rewritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn suggestions_drop_never_suggest_and_already_ruled_origins() {
        let dir = temp_dir("suggestions");
        std::fs::write(
            dir.join("unmatched-tally.json"),
            format!(
                r#"{{"weekStart":{},"entries":[{{"origin":"quickbooks.com","seconds":10800}},{{"origin":"github.com","seconds":600}},{{"origin":"figma.com","seconds":300}}]}}"#,
                tally_week_start(crate::monitor::unix_now()),
            ),
        )
        .expect("tally writes");
        std::fs::write(
            dir.join("never-suggest.json"),
            r#"{"origins":["figma.com"]}"#,
        )
        .expect("never-suggest writes");
        let mappings = vec![mapping("r1", MappingKind::UrlRule, "github.com/acme/*")];

        let entries = read_suggestions(&dir, &mappings);
        assert_eq!(
            entries,
            vec![TallyEntry {
                origin: "quickbooks.com".to_string(),
                seconds: 10800,
            }]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_corrupt_tally_suggests_nothing() {
        let dir = temp_dir("suggestions-empty");
        assert!(read_suggestions(&dir, &[]).is_empty());
        std::fs::write(dir.join("unmatched-tally.json"), "{not json").expect("tally writes");
        assert!(read_suggestions(&dir, &[]).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_previous_weeks_mirrored_tally_suggests_nothing() {
        let dir = temp_dir("stale-tally");
        std::fs::write(
            dir.join("unmatched-tally.json"),
            format!(
                r#"{{"weekStart":{},"entries":[{{"origin":"quickbooks.com","seconds":10800}}]}}"#,
                tally_week_start(crate::monitor::unix_now()).saturating_sub(7 * 86_400_000),
            ),
        )
        .expect("tally writes");

        assert!(read_suggestions(&dir, &[]).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_suggest_accumulates_origins_and_survives_a_corrupt_file() {
        let dir = temp_dir("never-suggest");
        never_suggest(&dir, "figma.com").expect("first records");
        never_suggest(&dir, "netflix.com").expect("second records");
        never_suggest(&dir, "figma.com").expect("a repeat is idempotent");
        assert!(never_suggest(&dir, "  ").is_err());

        let stored: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("never-suggest.json")).expect("file reads"),
        )
        .expect("file parses");
        assert_eq!(stored["origins"][0], "figma.com");
        assert_eq!(stored["origins"][1], "netflix.com");
        assert_eq!(
            stored["origins"]
                .as_array()
                .expect("origins is an array")
                .len(),
            2
        );

        std::fs::write(dir.join("never-suggest.json"), "garbage").expect("corrupt writes");
        never_suggest(&dir, "example.com").expect("a corrupt file restarts the list");
        let stored: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("never-suggest.json")).expect("file reads"),
        )
        .expect("file parses");
        assert_eq!(stored["origins"][0], "example.com");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_suggestion_data_removes_local_files_and_queues_an_extension_clear() {
        let dir = temp_dir("clear");
        clear_suggestion_data(&dir).expect("clearing nothing succeeds");

        std::fs::write(dir.join("unmatched-tally.json"), "{}").expect("tally writes");
        std::fs::write(dir.join("never-suggest.json"), "{}").expect("never writes");
        clear_suggestion_data(&dir).expect("clear succeeds");
        assert!(!dir.join("unmatched-tally.json").exists());
        assert!(!dir.join("never-suggest.json").exists());
        assert!(dir.join(TALLY_CLEAR_FILE).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collection_changes_discard_browser_evidence_and_disable_future_collection() {
        let dir = temp_dir("collection");
        enable_collection(&dir, "user-one").expect("first account enables collection");
        let first_id = collection_id(&dir).expect("collection id exists");
        std::fs::write(dir.join("browser-spool.jsonl"), "old evidence\n").expect("spool writes");
        std::fs::write(dir.join("unmatched-tally.json"), "old tally").expect("tally writes");

        enable_collection(&dir, "user-two").expect("second account enables collection");
        let second_id = collection_id(&dir).expect("new collection id exists");
        assert_ne!(first_id, second_id);
        assert!(!dir.join("browser-spool.jsonl").exists());
        assert!(!dir.join("unmatched-tally.json").exists());

        disable_collection(&dir).expect("logout disables collection");
        assert!(collection_id(&dir).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collection_admission_requires_a_current_session_authorization() {
        let dir = temp_dir("collection-admission");
        enable_collection(&dir, "user-one").expect("collection enables");
        let collection_id = collection_id(&dir).expect("collection id exists");

        assert_eq!(admitted_collection_id_with_session(&dir, false), None);
        assert_eq!(admitted_collection_id_with_session(&dir, true), Some(collection_id));
        revoke_collection(&dir).expect("collection revokes");
        assert_eq!(admitted_collection_id_with_session(&dir, true), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn independent_handshake_markers_drive_each_browsers_connected_state() {
        let dir = temp_dir("handshake");
        let marked_at = crate::monitor::parse_iso8601("2026-08-09T12:00:00Z").expect("time parses");
        assert!(!handshake_is_fresh(&dir, Browser::Chrome, marked_at));
        assert!(!handshake_is_fresh(&dir, Browser::Edge, marked_at));

        record_handshake_for(&dir, Browser::Chrome);
        record_handshake_for(&dir, Browser::Edge);
        assert!(handshake_is_fresh(&dir, Browser::Chrome, crate::monitor::unix_now()));
        assert!(handshake_is_fresh(&dir, Browser::Edge, crate::monitor::unix_now()));

        std::fs::write(handshake_path(&dir, Browser::Chrome), "junk").expect("marker writes");
        assert!(!handshake_is_fresh(&dir, Browser::Chrome, marked_at));
        assert!(handshake_is_fresh(&dir, Browser::Edge, crate::monitor::unix_now()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_handshake_marker_drops_back_to_not_connected() {
        let dir = temp_dir("handshake-stale");
        let marked_at = crate::monitor::parse_iso8601("2026-08-09T12:00:00Z").expect("time parses");
        std::fs::write(
            handshake_path(&dir, Browser::Chrome),
            r#"{"browser":"chrome","at":"2026-08-09T12:00:00Z"}"#,
        )
        .expect("marker writes");

        // Inside the window the marker still proves the connection.
        let fresh = marked_at + HANDSHAKE_STALE_SECONDS - 1;
        assert!(handshake_is_fresh(&dir, Browser::Chrome, fresh));

        // Past it, the extension is treated as gone: an active one would have
        // re-marked by now, because the browser relaunches the host on every
        // connect.
        let stale = marked_at + HANDSHAKE_STALE_SECONDS + 1;
        assert!(!handshake_is_fresh(&dir, Browser::Chrome, stale));

        // A marker without a readable timestamp connects nothing either.
        std::fs::write(
            handshake_path(&dir, Browser::Chrome),
            r#"{"browser":"chrome","at":"not-a-time"}"#,
        )
        .expect("marker writes");
        assert!(!handshake_is_fresh(&dir, Browser::Chrome, marked_at));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_parent_lookup_finds_the_parent_wherever_it_enumerates() {
        let entry = |pid: u32, parent_pid: u32, name: &str| ProcessEntry {
            pid,
            parent_pid,
            name: name.to_string(),
        };

        // The typical order: the parent enumerates before its child.
        let parent_first = vec![
            entry(100, 4, "chrome.exe"),
            entry(200, 100, "clock-in-browser-host.exe"),
        ];
        assert_eq!(
            parent_name_from_entries(&parent_first, 200).as_deref(),
            Some("chrome.exe")
        );

        // The order the old single-pass code depended on.
        let parent_last = vec![
            entry(200, 100, "clock-in-browser-host.exe"),
            entry(100, 4, "msedge.exe"),
        ];
        assert_eq!(
            parent_name_from_entries(&parent_last, 200).as_deref(),
            Some("msedge.exe")
        );

        // Unknown pids and a missing parent row resolve to nothing.
        assert_eq!(parent_name_from_entries(&parent_first, 999), None);
        assert_eq!(
            parent_name_from_entries(&[entry(200, 100, "host.exe")], 200),
            None
        );
    }

    #[test]
    fn concurrent_writers_leave_one_whole_file_and_no_temp_litter() {
        let dir = temp_dir("concurrent-write");
        let path = std::sync::Arc::new(dir.join("browser-rules.json"));
        let expected: Vec<String> = (0..4)
            .map(|writer| format!("{{\"writer\":{writer}}}{}", "\n".repeat(200)))
            .collect();

        let handles: Vec<_> = expected
            .iter()
            .enumerate()
            .map(|(writer, content)| {
                let path = std::sync::Arc::clone(&path);
                let content = content.clone();
                std::thread::spawn(move || {
                    for round in 0..20 {
                        // Vary content per round so the unchanged-skip cannot
                        // mask an interleave: the file must always end as one
                        // writer's complete payload.
                        write_if_changed(&path, format!("{content}//{writer}-{round}").as_bytes())
                            .expect("writes succeed");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("writer thread finishes");
        }

        let final_bytes = std::fs::read(&*path).expect("the file reads");
        let final_text = String::from_utf8(final_bytes).expect("the file is utf-8");
        let whole = expected.iter().enumerate().any(|(writer, content)| {
            (0..20).any(|round| final_text == format!("{content}//{writer}-{round}"))
        });
        assert!(
            whole,
            "the file is one writer's complete payload, got: {final_text:.80}"
        );
        let litter = std::fs::read_dir(&dir)
            .expect("dir reads")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains("tmp-"))
            .count();
        assert_eq!(litter, 0, "no temp files survive");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pattern_hosts_strip_globs_and_paths() {
        assert_eq!(pattern_host("github.com/acme/*"), "github.com");
        assert_eq!(pattern_host("*.figma.com/files/*"), "figma.com");
        assert_eq!(pattern_host("quickbooks.com"), "quickbooks.com");
    }
}
