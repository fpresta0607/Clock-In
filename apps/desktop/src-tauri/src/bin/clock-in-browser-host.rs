//! `clock-in-browser-host`: the native-messaging host the browser extension
//! talks to.
//!
//! The browser launches this binary when the extension connects; the two
//! speak length-prefixed JSON over stdio (see `native_messaging`). The host
//! holds no credentials, opens no sockets, and has exactly two jobs: serve
//! the current URL-rule set so the extension can match locally, and append
//! span verdicts to `browser-spool.jsonl` under the same interprocess-lock,
//! rotation, and quarantine discipline as the agent spool. Unmatched-origin
//! tallies pass through to a local file the desktop reads on demand; they are
//! never uploaded. Unknown message types are ignored, malformed frames are
//! dropped without killing the port, and a missing or corrupt rules file
//! fails closed to an empty rule set — the failure mode is silence, never
//! leakage.
//!
//! Wire shapes (the extension in `apps/browser-extension` is the peer):
//! - `{"type":"get-rules"}` is answered with
//!   `{"type":"rules","collectionEnabled":…,"collectionId":…, "rules":[{"id":…,"pattern":…}]}`.
//! - `{"type":"span-event","collectionId":…, "event":{"event":…,"externalSessionId":…,"ruleId":…,"occurredAt":…}}`
//!   is appended to the browser spool with `source` stamped here and receives
//!   `span-ack` after the append or `span-retry` when it must remain queued.
//! - `{"type":"tally","collectionId":…, "weekStart":…, "entries":[…]}` replaces the local tally file
//!   and receives `collection-state`, with `clear-tally` first when needed.
//!
//! Being launched at all is the handshake: startup drops a marker beside the
//! spools naming the parent browser, which flips that browser's card to
//! connected in the desktop UI.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clock_in_desktop_lib::browser;
use clock_in_desktop_lib::native_messaging::{self, Frame};
use clock_in_desktop_lib::spool::{self, AgentEventKind, AgentSource, SpoolEvent};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("clock-in-browser-host: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let paths = HostPaths::default();
    browser::record_handshake(&paths.dir);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    serve(&mut reader, &mut writer, &paths).map_err(|error| format!("the port broke: {error}"))
}

/// The three files the host touches, all beside the agent spool so the
/// `CLOCK_IN_SPOOL` override relocates the whole set for tests and support
/// setups.
struct HostPaths {
    dir: PathBuf,
    spool: PathBuf,
    rules: PathBuf,
    tally: PathBuf,
}

impl HostPaths {
    fn default() -> Self {
        Self::in_dir(&spool::default_browser_dir())
    }

    fn in_dir(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
            spool: dir.join("browser-spool.jsonl"),
            rules: dir.join("browser-rules.json"),
            tally: dir.join("unmatched-tally.json"),
        }
    }
}

/// The stdin/stdout loop: read frames until the browser closes the port
/// (clean EOF), answering `get-rules` and spooling `span-event`s. Dropped
/// frames and unknown message types never break the loop.
fn serve(reader: &mut impl Read, writer: &mut impl Write, paths: &HostPaths) -> io::Result<()> {
    let mut buffer = Vec::new();
    loop {
        match native_messaging::read_frame(reader, &mut buffer)? {
            None => return Ok(()),
            Some(Frame::Dropped) => continue,
            Some(Frame::Message(body)) => dispatch(&body, paths, writer)?,
        }
    }
}

fn dispatch(body: &[u8], paths: &HostPaths, writer: &mut impl Write) -> io::Result<()> {
    // Malformed JSON is a dropped message, not a port error.
    let Ok(message) = serde_json::from_slice::<serde_json::Value>(body) else {
        return Ok(());
    };
    browser::record_handshake(&paths.dir);
    match message.get("type").and_then(|kind| kind.as_str()) {
        Some("get-rules") => {
            let state = collection_state(paths);
            let rules = state["collectionEnabled"]
                .as_bool()
                .unwrap_or(false)
                .then(|| load_rules(&paths.rules))
                .unwrap_or_default();
            let reply = rules_reply(state, rules);
            match native_messaging::write_json(writer, &reply) {
                Ok(()) => Ok(()),
                // A rule set that outgrows the 64 KB frame cap fails closed,
                // the same as a missing or corrupt rules file: log, answer
                // with an empty set, and keep serving - never take the port
                // down (the browser would relaunch us into a crash loop).
                Err(error) => {
                    eprintln!(
                        "clock-in-browser-host: could not send the rules ({error}); failing closed to an empty set"
                    );
                    native_messaging::write_json(
                        writer,
                        &rules_reply(collection_state(paths), Vec::new()),
                    )
                }
            }
        }
        Some("span-event") => {
            match append_span_event(message.get("event"), message.get("collectionId"), paths) {
                SpanAppendOutcome::Appended => {
                    write_span_reply(writer, paths, "span-ack", message.get("event"))
                }
                SpanAppendOutcome::Dropped => write_collection_state(writer, paths),
                SpanAppendOutcome::Rejected(error) => {
                    eprintln!("clock-in-browser-host: {error}");
                    write_collection_state(writer, paths)
                }
                SpanAppendOutcome::Retry(error) => {
                    eprintln!("clock-in-browser-host: {error}");
                    write_span_reply(writer, paths, "span-retry", message.get("event"))
                }
            }
        }
        Some("tally") => {
            match store_tally(
                message.get("entries"),
                message.get("weekStart"),
                message.get("collectionId"),
                paths,
            ) {
                Ok(TallyOutcome::ClearRequested) => native_messaging::write_json(
                    writer,
                    &serde_json::json!({ "type": "clear-tally" }),
                )?,
                Ok(TallyOutcome::Stored | TallyOutcome::Dropped) => {}
                Err(error) => {
                    eprintln!("clock-in-browser-host: could not store the tally: {error}")
                }
            }
            write_collection_state(writer, paths)
        }
        // Unknown message types are ignored.
        _ => Ok(()),
    }
}

fn collection_state(paths: &HostPaths) -> serde_json::Value {
    match admitted_collection_id(paths) {
        Some(collection_id) => {
            serde_json::json!({ "collectionEnabled": true, "collectionId": collection_id })
        }
        None => serde_json::json!({ "collectionEnabled": false }),
    }
}

fn admitted_collection_id(paths: &HostPaths) -> Option<String> {
    browser::admitted_collection_id(&paths.dir)
}

fn rules_reply(mut state: serde_json::Value, rules: Vec<Rule>) -> serde_json::Value {
    state["type"] = serde_json::Value::String("rules".to_string());
    state["rules"] =
        serde_json::to_value(rules).unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    state
}

fn write_collection_state(writer: &mut impl Write, paths: &HostPaths) -> io::Result<()> {
    let mut state = collection_state(paths);
    state["type"] = serde_json::Value::String("collection-state".to_string());
    native_messaging::write_json(writer, &state)
}

fn write_span_reply(
    writer: &mut impl Write,
    paths: &HostPaths,
    kind: &str,
    event: Option<&serde_json::Value>,
) -> io::Result<()> {
    let mut reply = collection_state(paths);
    reply["type"] = serde_json::Value::String(kind.to_string());
    reply["event"] = event.cloned().unwrap_or(serde_json::Value::Null);
    native_messaging::write_json(writer, &reply)
}

/// One URL rule as the extension needs it: id for the verdict, pattern for
/// local matching. Extra fields the desktop's writer adds later are tolerated.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Rule {
    id: String,
    pattern: String,
}

#[derive(Debug, serde::Deserialize)]
struct RulesFile {
    rules: Vec<Rule>,
}

/// The current rule set. A missing or unparseable file fails closed to no
/// rules: the extension then matches nothing, which is silence, not leakage.
fn load_rules(path: &Path) -> Vec<Rule> {
    spool::with_lock(path, || {
        Ok(std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RulesFile>(&bytes).ok())
            .map(|file| file.rules)
            .unwrap_or_default())
    })
    .unwrap_or_default()
}

/// The verdict payload the extension emits for a rule hit. `event` reuses the
/// agent lifecycle kinds — browser spans upload as agent sessions.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpanEventInput {
    event: AgentEventKind,
    external_session_id: String,
    rule_id: String,
    occurred_at: String,
}

impl SpanEventInput {
    /// The checks serde cannot express: identity fields present but empty.
    fn validate(&self) -> Result<(), String> {
        if self.external_session_id.trim().is_empty() {
            return Err("externalSessionId must not be empty".to_string());
        }
        if self.rule_id.trim().is_empty() {
            return Err("ruleId must not be empty".to_string());
        }
        if self.occurred_at.trim().is_empty() {
            return Err("occurredAt must not be empty".to_string());
        }
        Ok(())
    }

    /// The browser-spool line: the agent-session shape with `ruleId` in place
    /// of `cwd`, `source` stamped here rather than trusted from the sender.
    fn into_event(self) -> SpoolEvent {
        SpoolEvent {
            source: AgentSource::Browser,
            external_session_id: self.external_session_id,
            event: self.event,
            occurred_at: self.occurred_at,
            cwd: None,
            rule_id: Some(self.rule_id),
        }
    }
}

fn message_collection_id(value: Option<&serde_json::Value>) -> Option<&str> {
    value
        .and_then(|value| value.as_str())
        .filter(|id| !id.trim().is_empty())
}

enum SpanAppendOutcome {
    Appended,
    Dropped,
    Rejected(String),
    Retry(String),
}

fn append_span_event(
    event: Option<&serde_json::Value>,
    collection_id: Option<&serde_json::Value>,
    paths: &HostPaths,
) -> SpanAppendOutcome {
    let Some(event) = event else {
        return SpanAppendOutcome::Rejected("span-event without an event payload".to_string());
    };
    let input: SpanEventInput = match serde_json::from_value(event.clone()) {
        Ok(input) => input,
        Err(error) => return SpanAppendOutcome::Rejected(format!("invalid span event: {error}")),
    };
    if let Err(error) = input.validate() {
        return SpanAppendOutcome::Rejected(error);
    }
    let Some(collection_id) = message_collection_id(collection_id) else {
        return SpanAppendOutcome::Dropped;
    };
    let collection_id = collection_id.to_string();
    let event = input.into_event();
    spool::append_if(&paths.spool, &event, || {
        browser::admitted_collection_id_locked(&paths.dir).as_deref()
            == Some(collection_id.as_str())
    })
    .map(|appended| {
        if appended {
            SpanAppendOutcome::Appended
        } else {
            SpanAppendOutcome::Dropped
        }
    })
    .unwrap_or_else(|error| {
        SpanAppendOutcome::Retry(format!("could not write the browser spool: {error}"))
    })
}

/// The unmatched-origin tally is pass-through: the extension keeps the
/// authoritative tally in its own storage and sends snapshots, the desktop
/// reads this file on demand, and nobody uploads it. A snapshot replaces the
/// file rather than merging; the extension's copy wins. The shared locked
/// temp-and-rename writer keeps concurrent host processes from racing.
enum TallyOutcome {
    Stored,
    ClearRequested,
    Dropped,
}

fn store_tally(
    entries: Option<&serde_json::Value>,
    week_start: Option<&serde_json::Value>,
    collection_id: Option<&serde_json::Value>,
    paths: &HostPaths,
) -> Result<TallyOutcome, String> {
    let Some(entries) = entries.filter(|value| value.is_array()) else {
        return Ok(TallyOutcome::Dropped);
    };
    let Some(week_start) = week_start.and_then(|value| value.as_u64()) else {
        return Ok(TallyOutcome::Dropped);
    };
    let Some(collection_id) = message_collection_id(collection_id) else {
        return Ok(TallyOutcome::Dropped);
    };
    let collection_id = collection_id.to_string();
    let bytes = serde_json::to_vec_pretty(
        &serde_json::json!({ "weekStart": week_start, "entries": entries }),
    )
    .map_err(|error| error.to_string())?;
    spool::with_lock(&paths.spool, || {
        if browser::admitted_collection_id_locked(&paths.dir).as_deref()
            != Some(collection_id.as_str())
        {
            return Ok(TallyOutcome::Dropped);
        }
        match browser::store_tally_snapshot(
            &paths.dir,
            &bytes,
            entries.as_array().is_some_and(Vec::is_empty),
        )? {
            browser::TallyStoreOutcome::Stored => Ok(TallyOutcome::Stored),
            browser::TallyStoreOutcome::ClearRequested => Ok(TallyOutcome::ClearRequested),
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "clock-in-browser-host-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        dir
    }

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(body);
        bytes
    }

    /// Decodes every reply frame a dispatch or serve run produced.
    fn reply_values(out: &[u8]) -> Vec<serde_json::Value> {
        let mut reader = out;
        let mut buffer = Vec::new();
        let mut values = Vec::new();
        while let Some(frame) =
            native_messaging::read_frame(&mut reader, &mut buffer).expect("the reply reads")
        {
            match frame {
                Frame::Message(body) => {
                    values.push(serde_json::from_slice(&body).expect("the reply parses"))
                }
                Frame::Dropped => panic!("replies are never dropped"),
            }
        }
        values
    }

    fn configured_paths(dir: &Path) -> HostPaths {
        browser::enable_collection(dir, "u1").expect("collection enables");
        HostPaths::in_dir(dir)
    }

    fn signed_out_paths(dir: &Path) -> HostPaths {
        browser::enable_collection(dir, "u1").expect("collection enables");
        browser::revoke_collection(dir).expect("collection revokes");
        HostPaths::in_dir(dir)
    }

    fn span_event_message(paths: &HostPaths, session: &str) -> Vec<u8> {
        let collection_id = browser::collection_id(&paths.dir).expect("collection id exists");
        serde_json::to_vec(&serde_json::json!({
            "type": "span-event",
            "collectionId": collection_id,
            "event": {
                "event": "started",
                "externalSessionId": session,
                "ruleId": "r1",
                "occurredAt": "2026-08-09T12:00:00Z"
            }
        }))
        .expect("the message serializes")
    }

    fn tally_message(paths: &HostPaths, entries: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "type": "tally",
            "collectionId": browser::collection_id(&paths.dir).expect("collection id exists"),
            "weekStart": 1785801600000u64,
            "entries": entries,
        }))
        .expect("the message serializes")
    }

    fn spool_lines(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .expect("the spool reads")
            .lines()
            .map(|line| serde_json::from_str(line).expect("every line parses"))
            .collect()
    }

    #[test]
    fn get_rules_replies_with_the_rules_files_rules() {
        let dir = temp_dir("get-rules");
        let paths = configured_paths(&dir);
        std::fs::write(
            &paths.rules,
            r#"{"rules":[{"id":"r1","pattern":"github.com/acme/*"},{"id":"r2","pattern":"*.figma.com/files/*"}]}"#,
        )
        .expect("the rules file writes");

        let mut out = Vec::new();
        dispatch(br#"{"type":"get-rules"}"#, &paths, &mut out).expect("dispatch succeeds");

        let replies = reply_values(&out);
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["type"], "rules");
        let rules = replies[0]["rules"].as_array().expect("rules is an array");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0]["id"], "r1");
        assert_eq!(rules[0]["pattern"], "github.com/acme/*");
        assert_eq!(rules[1]["pattern"], "*.figma.com/files/*");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn get_rules_waits_for_an_in_progress_rules_replacement() {
        let dir = temp_dir("rules-replacement");
        let paths = configured_paths(&dir);
        std::fs::write(
            &paths.rules,
            r#"{"rules":[{"id":"old","pattern":"github.com/acme/*"}]}"#,
        )
        .expect("old rules write");
        let replacement = dir.join("browser-rules.next.json");
        std::fs::write(
            &replacement,
            r#"{"rules":[{"id":"new","pattern":"*.figma.com/files/*"}]}"#,
        )
        .expect("new rules write");
        let rules_path = paths.rules.clone();
        let (removed_tx, removed_rx) = std::sync::mpsc::sync_channel(0);
        let (resume_tx, resume_rx) = std::sync::mpsc::sync_channel(0);
        let writer = std::thread::spawn(move || {
            spool::with_lock(&rules_path, || {
                std::fs::remove_file(&rules_path)?;
                removed_tx
                    .send(())
                    .map_err(|_| io::Error::other("test did not await replacement"))?;
                resume_rx
                    .recv()
                    .map_err(|_| io::Error::other("test did not resume replacement"))?;
                std::fs::rename(&replacement, &rules_path)
            })
        });
        removed_rx.recv().expect("writer removed the old rules");

        let reader_dir = dir.clone();
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            let paths = HostPaths::in_dir(&reader_dir);
            let mut out = Vec::new();
            let reply =
                dispatch(br#"{"type":"get-rules"}"#, &paths, &mut out).map(|()| reply_values(&out));
            reply_tx.send(reply).expect("test receives the reply");
        });

        assert!(reply_rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        resume_tx.send(()).expect("writer resumes");
        writer
            .join()
            .expect("writer joins")
            .expect("writer succeeds");
        let replies = reply_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("reader replies")
            .expect("dispatch succeeds");
        reader.join().expect("reader joins");

        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["rules"][0]["id"], "new");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn get_rules_waits_for_a_collection_authorization_renewal() {
        let dir = temp_dir("authorization-renewal");
        let paths = configured_paths(&dir);
        browser::enable_collection(&dir, "user-one").expect("collection enables");
        let collection_id = browser::collection_id(&dir).expect("collection id exists");
        std::fs::write(&paths.rules, r#"{"rules":[]}"#).expect("rules write");
        let authorization = dir.join("browser-collection-authorization.json");
        let replacement = dir.join("browser-collection-authorization.next.json");
        std::fs::copy(&authorization, &replacement).expect("authorization copy");

        let spool_path = paths.spool.clone();
        let (removed_tx, removed_rx) = std::sync::mpsc::sync_channel(0);
        let (resume_tx, resume_rx) = std::sync::mpsc::sync_channel(0);
        let writer = std::thread::spawn(move || {
            spool::with_lock(&spool_path, || {
                std::fs::remove_file(&authorization)?;
                removed_tx.send(()).map_err(|_| {
                    io::Error::other("test did not await authorization replacement")
                })?;
                resume_rx.recv().map_err(|_| {
                    io::Error::other("test did not resume authorization replacement")
                })?;
                std::fs::rename(&replacement, &authorization)
            })
        });
        removed_rx.recv().expect("writer removed the authorization");

        let reader_dir = dir.clone();
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            let paths = HostPaths::in_dir(&reader_dir);
            let mut out = Vec::new();
            let reply =
                dispatch(br#"{"type":"get-rules"}"#, &paths, &mut out).map(|()| reply_values(&out));
            reply_tx.send(reply).expect("test receives the reply");
        });

        assert!(reply_rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        resume_tx.send(()).expect("writer resumes");
        writer
            .join()
            .expect("writer joins")
            .expect("writer succeeds");
        let replies = reply_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("reader replies")
            .expect("dispatch succeeds");
        reader.join().expect("reader joins");

        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["collectionEnabled"].as_bool(), Some(true));
        assert_eq!(
            replies[0]["collectionId"].as_str(),
            Some(collection_id.as_str())
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_corrupt_rules_file_fails_closed_to_an_empty_set() {
        let dir = temp_dir("rules-fail-closed");
        let paths = HostPaths::in_dir(&dir);

        // Missing entirely.
        assert!(load_rules(&paths.rules).is_empty());

        // Not JSON.
        std::fs::write(&paths.rules, b"{not json").expect("the rules file writes");
        assert!(load_rules(&paths.rules).is_empty());

        // JSON, but not a rule set.
        std::fs::write(&paths.rules, r#"{"rules":"nope"}"#).expect("the rules file writes");
        assert!(load_rules(&paths.rules).is_empty());

        // And the failure reaches the wire as an empty rule set, not an error.
        let mut out = Vec::new();
        dispatch(br#"{"type":"get-rules"}"#, &paths, &mut out).expect("dispatch succeeds");
        let replies = reply_values(&out);
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["type"], "rules");
        assert!(replies[0]["rules"]
            .as_array()
            .expect("rules is an array")
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_span_event_lands_as_one_canonical_browser_line() {
        let dir = temp_dir("span-event");
        let paths = configured_paths(&dir);
        let mut out = Vec::new();

        dispatch(&span_event_message(&paths, "s1"), &paths, &mut out).expect("dispatch succeeds");

        let replies = reply_values(&out);
        assert_eq!(replies[0]["type"], "span-ack");
        assert_eq!(replies[0]["collectionEnabled"], true);
        assert_eq!(replies[0]["event"]["externalSessionId"], "s1");
        let lines = spool_lines(&paths.spool);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["source"], "browser");
        assert_eq!(lines[0]["event"], "started");
        assert_eq!(lines[0]["externalSessionId"], "s1");
        assert_eq!(lines[0]["ruleId"], "r1");
        assert_eq!(lines[0]["occurredAt"], "2026-08-09T12:00:00Z");
        assert!(lines[0].get("cwd").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_spool_write_failure_requests_retry_without_acknowledging_the_event() {
        let dir = temp_dir("span-retry");
        let paths = configured_paths(&dir);
        std::fs::create_dir(&paths.spool).expect("spool path becomes a directory");
        let mut out = Vec::new();
        let message = span_event_message(&paths, "s1");

        dispatch(&message, &paths, &mut out).expect("dispatch succeeds");

        let replies = reply_values(&out);
        assert_eq!(replies[0]["type"], "span-retry");
        assert_eq!(replies[0]["event"]["externalSessionId"], "s1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_span_event_without_identity_fields_writes_nothing() {
        for payload in [
            r#"{"type":"span-event"}"#,
            r#"{"type":"span-event","event":{"event":"started","externalSessionId":"  ","ruleId":"r1","occurredAt":"t"}}"#,
            r#"{"type":"span-event","event":{"event":"started","externalSessionId":"s1","occurredAt":"t"}}"#,
            r#"{"type":"span-event","event":{"event":"bogus","externalSessionId":"s1","ruleId":"r1","occurredAt":"t"}}"#,
        ] {
            let dir = temp_dir("span-invalid");
            let paths = HostPaths::in_dir(&dir);
            let mut out = Vec::new();

            dispatch(payload.as_bytes(), &paths, &mut out).expect("dispatch succeeds");

            assert!(!paths.spool.exists());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn signed_out_and_stale_collection_messages_never_cross_the_browser_spool_boundary() {
        let dir = temp_dir("collection-boundary");
        let paths = configured_paths(&dir);
        let old_id = browser::collection_id(&dir).expect("old collection id exists");
        let old_message = span_event_message(&paths, "old-span");
        browser::disable_collection(&dir).expect("logout disables collection");
        let mut out = Vec::new();

        dispatch(&old_message, &paths, &mut out).expect("signed-out message is handled");
        assert!(!paths.spool.exists());
        assert_eq!(reply_values(&out)[0]["collectionEnabled"], false);

        browser::enable_collection(&dir, "u2").expect("next account enables collection");
        out.clear();
        dispatch(&old_message, &paths, &mut out).expect("stale message is handled");
        assert!(!paths.spool.exists());
        assert_ne!(reply_values(&out)[0]["collectionId"], old_id);

        let current_message = span_event_message(&paths, "new-span");
        out.clear();
        dispatch(&current_message, &paths, &mut out).expect("current message is handled");
        assert_eq!(
            spool_lines(&paths.spool)[0]["externalSessionId"],
            "new-span"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_collection_file_without_a_current_session_cannot_admit_any_browser_evidence() {
        let dir = temp_dir("session-admission");
        let paths = signed_out_paths(&dir);
        std::fs::write(
            &paths.rules,
            r#"{"rules":[{"id":"r1","pattern":"github.com/acme/*"}]}"#,
        )
        .expect("rules file writes");
        let mut out = Vec::new();

        dispatch(br#"{"type":"get-rules"}"#, &paths, &mut out).expect("rules are handled");
        dispatch(&span_event_message(&paths, "s1"), &paths, &mut out).expect("span is handled");
        dispatch(
            &tally_message(
                &paths,
                serde_json::json!([{"origin":"quickbooks.com","seconds":60}]),
            ),
            &paths,
            &mut out,
        )
        .expect("tally is handled");

        let replies = reply_values(&out);
        assert!(replies
            .iter()
            .all(|reply| reply["collectionEnabled"] == false));
        assert!(replies[0]["rules"]
            .as_array()
            .expect("rules is an array")
            .is_empty());
        assert!(!paths.spool.exists());
        assert!(!paths.tally.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revoked_collection_cannot_admit_spans_or_tallies_before_cleanup() {
        let dir = temp_dir("revoked-collection");
        let paths = configured_paths(&dir);
        let span = span_event_message(&paths, "s1");
        let tally = tally_message(
            &paths,
            serde_json::json!([{"origin":"quickbooks.com","seconds":60}]),
        );
        browser::revoke_collection(&dir).expect("collection revokes");
        let mut out = Vec::new();

        dispatch(&span, &paths, &mut out).expect("span is handled");
        dispatch(&tally, &paths, &mut out).expect("tally is handled");

        assert!(!paths.spool.exists());
        assert!(!paths.tally.exists());
        for reply in reply_values(&out) {
            assert_eq!(reply["collectionEnabled"], false);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_span_events_append_whole_lines_under_the_lock() {
        let dir = temp_dir("concurrent");
        let paths = Arc::new(configured_paths(&dir));

        // Same sizing as the agent spool's concurrent test: lock hand-off
        // favours the thread that just released, so large bursts can outwait
        // the lock patience on slow disks.
        let handles: Vec<_> = (0..4)
            .map(|thread_index| {
                let paths = Arc::clone(&paths);
                std::thread::spawn(move || {
                    let mut out = Vec::new();
                    for index in 0..15 {
                        let message =
                            span_event_message(&paths, &format!("t{thread_index}-{index}"));
                        dispatch(&message, &paths, &mut out).expect("dispatch succeeds");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("writer thread finishes");
        }

        let lines = spool_lines(&paths.spool);
        assert_eq!(lines.len(), 60);
        for line in &lines {
            assert_eq!(line["source"], "browser");
        }
        assert!(dir.join("browser-spool.jsonl.lock").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_message_types_and_bad_json_are_ignored() {
        let dir = temp_dir("unknown");
        let paths = configured_paths(&dir);
        let mut out = Vec::new();

        for body in [
            &br#"{"type":"mystery"}"#[..],
            &b"not json at all"[..],
            &br#"{"type":42}"#[..],
            &br#"[1,2,3]"#[..],
        ] {
            dispatch(body, &paths, &mut out).expect("dispatch succeeds");
        }

        assert!(out.is_empty());
        assert!(!paths.spool.exists());
        assert!(!paths.tally.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tally_snapshot_is_stored_beside_the_spools_and_never_answered() {
        let dir = temp_dir("tally");
        let paths = configured_paths(&dir);
        let mut out = Vec::new();

        dispatch(
            &tally_message(
                &paths,
                serde_json::json!([{"origin":"quickbooks.com","seconds":10800}]),
            ),
            &paths,
            &mut out,
        )
        .expect("dispatch succeeds");

        assert_eq!(reply_values(&out)[0]["collectionEnabled"], true);
        let stored: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&paths.tally).expect("the tally reads"))
                .expect("the tally parses");
        assert_eq!(stored["entries"][0]["origin"], "quickbooks.com");
        assert_eq!(stored["entries"][0]["seconds"], 10800);

        // A second snapshot replaces the first; the extension's copy wins.
        dispatch(
            &tally_message(&paths, serde_json::json!([])),
            &paths,
            &mut out,
        )
        .expect("dispatch succeeds");
        let stored: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&paths.tally).expect("the tally reads"))
                .expect("the tally parses");
        assert!(stored["entries"]
            .as_array()
            .expect("entries is an array")
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clear_request_rejects_stale_tally_until_the_extension_confirms_empty_state() {
        let dir = temp_dir("tally-clear");
        let paths = configured_paths(&dir);
        let mut out = Vec::new();
        browser::clear_suggestion_data(&dir).expect("clear queues");

        dispatch(
            &tally_message(
                &paths,
                serde_json::json!([{"origin":"quickbooks.com","seconds":10800}]),
            ),
            &paths,
            &mut out,
        )
        .expect("stale tally is handled");
        let replies = reply_values(&out);
        assert_eq!(replies[0]["type"], "clear-tally");
        assert!(!paths.tally.exists());

        out.clear();
        dispatch(
            &tally_message(&paths, serde_json::json!([])),
            &paths,
            &mut out,
        )
        .expect("empty tally is handled");
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&paths.tally).expect("empty tally mirrors"))
                .expect("empty tally parses");
        assert!(stored["entries"]
            .as_array()
            .expect("entries is an array")
            .is_empty());
        assert!(!paths.dir.join("browser-tally-clear.json").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_oversize_rule_set_fails_closed_and_the_port_keeps_serving() {
        let dir = temp_dir("oversize-rules");
        let paths = configured_paths(&dir);
        // Enough rules that the serialized reply clears the 64 KB frame cap.
        let rules: Vec<serde_json::Value> = (0..700)
            .map(|index| {
                serde_json::json!({
                    "id": format!("r{index}"),
                    "pattern": format!("example-{index:04}.com/{}", "a".repeat(60)),
                })
            })
            .collect();
        let rules_json =
            serde_json::to_string(&serde_json::json!({ "rules": rules })).expect("rules serialize");
        assert!(rules_json.len() > native_messaging::MAX_MESSAGE_BYTES);
        std::fs::write(&paths.rules, &rules_json).expect("the rules file writes");

        let mut wire = Vec::new();
        wire.extend_from_slice(&framed(br#"{"type":"get-rules"}"#));
        // The port must survive and answer the next request too.
        wire.extend_from_slice(&framed(&span_event_message(&paths, "s1")));

        let mut reader = &wire[..];
        let mut out = Vec::new();
        serve(&mut reader, &mut out, &paths).expect("serve runs to EOF");

        let replies = reply_values(&out);
        assert_eq!(
            replies.len(),
            2,
            "the port keeps serving after the fallback"
        );
        assert_eq!(replies[0]["type"], "rules");
        assert!(
            replies[0]["rules"]
                .as_array()
                .expect("rules is an array")
                .is_empty(),
            "an unsendable rule set fails closed to empty"
        );
        assert_eq!(spool_lines(&paths.spool).len(), 1, "serving continues");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_loop_survives_dropped_frames_and_keeps_serving() {
        let dir = temp_dir("serve");
        let paths = configured_paths(&dir);
        // A corrupt rules file, to prove fail-closed end to end.
        std::fs::write(&paths.rules, "garbage").expect("the rules file writes");

        let mut wire = Vec::new();
        // An oversize frame, dropped without killing the loop.
        let big = vec![b'x'; native_messaging::MAX_MESSAGE_BYTES + 1];
        wire.extend_from_slice(&framed(&big));
        // A span event and a get-rules behind it must still land.
        wire.extend_from_slice(&framed(&span_event_message(&paths, "s1")));
        wire.extend_from_slice(&framed(br#"{"type":"get-rules"}"#));

        let mut reader = &wire[..];
        let mut out = Vec::new();
        serve(&mut reader, &mut out, &paths).expect("serve runs to EOF");

        assert_eq!(spool_lines(&paths.spool).len(), 1);
        let replies = reply_values(&out);
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[1]["type"], "rules");
        assert!(replies[1]["rules"]
            .as_array()
            .expect("rules is an array")
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
