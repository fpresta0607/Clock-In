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
//!   `{"type":"rules","rules":[{"id":…,"pattern":…}]}`.
//! - `{"type":"span-event","event":{"event":…,"externalSessionId":…,"ruleId":…,"occurredAt":…}}`
//!   is appended to the browser spool with `source` stamped here; no reply.
//! - `{"type":"tally","entries":[…]}` replaces the local tally file; no reply.
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
    match message.get("type").and_then(|kind| kind.as_str()) {
        Some("get-rules") => {
            let reply = serde_json::json!({ "type": "rules", "rules": load_rules(&paths.rules) });
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
                        &serde_json::json!({ "type": "rules", "rules": [] }),
                    )
                }
            }
        }
        Some("span-event") => {
            if let Err(error) = append_span_event(message.get("event"), paths) {
                // The port stays up; the extension's heartbeats mean the span
                // recovers on the next event.
                eprintln!("clock-in-browser-host: {error}");
            }
            Ok(())
        }
        Some("tally") => {
            if let Err(error) = store_tally(message.get("entries"), paths) {
                eprintln!("clock-in-browser-host: could not store the tally: {error}");
            }
            Ok(())
        }
        // Unknown message types are ignored.
        _ => Ok(()),
    }
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
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RulesFile>(&bytes).ok())
        .map(|file| file.rules)
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

fn append_span_event(event: Option<&serde_json::Value>, paths: &HostPaths) -> Result<(), String> {
    let event = event.ok_or_else(|| "span-event without an event payload".to_string())?;
    let input: SpanEventInput = serde_json::from_value(event.clone())
        .map_err(|error| format!("invalid span event: {error}"))?;
    input.validate()?;
    let event = input.into_event();
    // The shared discipline: interprocess lock, whole-line append, rotation
    // at the cap, partial-tail repair.
    spool::append(&paths.spool, &event)
        .map_err(|error| format!("could not write the browser spool: {error}"))
}

/// The unmatched-origin tally is pass-through: the extension keeps the
/// authoritative tally in its own storage and sends snapshots, the desktop
/// reads this file on demand, and nobody uploads it. A snapshot replaces the
/// file rather than merging — the extension's copy wins.
fn store_tally(entries: Option<&serde_json::Value>, paths: &HostPaths) -> io::Result<()> {
    let Some(entries) = entries.filter(|value| value.is_array()) else {
        return Ok(());
    };
    if let Some(parent) = paths.tally.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "entries": entries }))
        .map_err(io::Error::other)?;
    // A temp file plus rename, so the desktop never reads a half-written tally.
    let tmp = paths.tally.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    // Windows cannot rename over an existing file.
    match std::fs::remove_file(&paths.tally) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::rename(&tmp, &paths.tally)
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

    fn span_event_message(session: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "type": "span-event",
            "event": {
                "event": "started",
                "externalSessionId": session,
                "ruleId": "r1",
                "occurredAt": "2026-08-09T12:00:00Z"
            }
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
        let paths = HostPaths::in_dir(&dir);
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
        let paths = HostPaths::in_dir(&dir);
        let mut out = Vec::new();

        dispatch(&span_event_message("s1"), &paths, &mut out).expect("dispatch succeeds");

        // Appends are fire-and-forget: no reply frame.
        assert!(out.is_empty());
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
    fn concurrent_span_events_append_whole_lines_under_the_lock() {
        let dir = temp_dir("concurrent");
        let paths = Arc::new(HostPaths::in_dir(&dir));

        // Same sizing as the agent spool's concurrent test: lock hand-off
        // favours the thread that just released, so large bursts can outwait
        // the lock patience on slow disks.
        let handles: Vec<_> = (0..4)
            .map(|thread_index| {
                let paths = Arc::clone(&paths);
                std::thread::spawn(move || {
                    let mut out = Vec::new();
                    for index in 0..15 {
                        let message = span_event_message(&format!("t{thread_index}-{index}"));
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
        let paths = HostPaths::in_dir(&dir);
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
        let paths = HostPaths::in_dir(&dir);
        let mut out = Vec::new();

        dispatch(
            br#"{"type":"tally","entries":[{"origin":"quickbooks.com","seconds":10800}]}"#,
            &paths,
            &mut out,
        )
        .expect("dispatch succeeds");

        assert!(out.is_empty());
        let stored: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&paths.tally).expect("the tally reads"))
                .expect("the tally parses");
        assert_eq!(stored["entries"][0]["origin"], "quickbooks.com");
        assert_eq!(stored["entries"][0]["seconds"], 10800);

        // A second snapshot replaces the first; the extension's copy wins.
        dispatch(br#"{"type":"tally","entries":[]}"#, &paths, &mut out).expect("dispatch succeeds");
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
    fn an_oversize_rule_set_fails_closed_and_the_port_keeps_serving() {
        let dir = temp_dir("oversize-rules");
        let paths = HostPaths::in_dir(&dir);
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
        wire.extend_from_slice(&framed(&span_event_message("s1")));

        let mut reader = &wire[..];
        let mut out = Vec::new();
        serve(&mut reader, &mut out, &paths).expect("serve runs to EOF");

        let replies = reply_values(&out);
        assert_eq!(replies.len(), 1, "one answer, not a dead port");
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
        let paths = HostPaths::in_dir(&dir);
        // A corrupt rules file, to prove fail-closed end to end.
        std::fs::write(&paths.rules, "garbage").expect("the rules file writes");

        let mut wire = Vec::new();
        // An oversize frame, dropped without killing the loop.
        let big = vec![b'x'; native_messaging::MAX_MESSAGE_BYTES + 1];
        wire.extend_from_slice(&framed(&big));
        // A span event and a get-rules behind it must still land.
        wire.extend_from_slice(&framed(&span_event_message("s1")));
        wire.extend_from_slice(&framed(br#"{"type":"get-rules"}"#));

        let mut reader = &wire[..];
        let mut out = Vec::new();
        serve(&mut reader, &mut out, &paths).expect("serve runs to EOF");

        assert_eq!(spool_lines(&paths.spool).len(), 1);
        let replies = reply_values(&out);
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["type"], "rules");
        assert!(replies[0]["rules"]
            .as_array()
            .expect("rules is an array")
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
