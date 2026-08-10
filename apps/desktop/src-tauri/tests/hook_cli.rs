//! End-to-end checks for the `clock-in-hook` binary: valid input lands as one
//! canonical spool line, invalid input exits non-zero and writes nothing.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use clock_in_desktop_lib::spool::MAX_SPOOL_RECORD_BYTES;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("clock-in-hook-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir is created");
    dir
}

fn run_hook(spool: &PathBuf, args: &[&str], stdin: Option<&str>) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_clock-in-hook"))
        .args(args)
        .env("CLOCK_IN_SPOOL", spool)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .spawn()
        .expect("hook binary spawns");
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .expect("stdin is piped")
            .write_all(input.as_bytes())
            .expect("stdin writes");
    }
    child.wait_with_output().expect("hook exits")
}

#[test]
fn a_valid_stdin_event_lands_as_one_canonical_line() {
    let dir = temp_dir("stdin");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(
        &spool,
        &[],
        Some(
            r#"{"version":1,"source":"claude-code","event":"session-start","sessionId":"s1","cwd":"C:/dev/Clock-In","occurredAt":"2026-08-07T12:00:00Z"}"#,
        ),
    );

    assert!(output.status.success());
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).expect("line parses");
    assert_eq!(value["source"], "claude_code");
    assert_eq!(value["event"], "started");
    assert_eq!(value["externalSessionId"], "s1");
    assert_eq!(value["occurredAt"], "2026-08-07T12:00:00Z");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_claude_native_stdin_payload_is_translated_and_spooled() {
    let dir = temp_dir("claude-native");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(
        &spool,
        &[],
        Some(
            r#"{"session_id":"s1","transcript_path":"/tmp/t.jsonl","cwd":"C:/dev/Clock-In","hook_event_name":"SessionStart","source":"startup"}"#,
        ),
    );

    assert!(output.status.success());
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).expect("line parses");
    assert_eq!(value["source"], "claude_code");
    assert_eq!(value["event"], "started");
    assert_eq!(value["externalSessionId"], "s1");
    assert_eq!(value["cwd"], "C:/dev/Clock-In");
    // Claude's payload has no timestamp; the hook stamps the current time.
    assert!(value["occurredAt"]
        .as_str()
        .expect("stamped")
        .ends_with('Z'));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_untracked_claude_event_exits_zero_and_writes_nothing() {
    let dir = temp_dir("claude-ignored");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(
        &spool,
        &[],
        Some(r#"{"session_id":"s1","cwd":"/x","hook_event_name":"Notification"}"#),
    );

    assert!(output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_claude_payload_without_a_session_id_exits_non_zero() {
    let dir = temp_dir("claude-invalid");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(
        &spool,
        &[],
        Some(r#"{"cwd":"/x","hook_event_name":"SessionStart"}"#),
    );

    assert!(!output.status.success());
    assert!(!spool.exists());
    let stderr = String::from_utf8(output.stderr).expect("stderr is utf-8");
    assert!(stderr.contains("clock-in-hook:"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn malformed_stdin_exits_non_zero_and_writes_nothing() {
    let dir = temp_dir("malformed");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(&spool, &[], Some(r#"{"version":2,"source":"codex"}"#));

    assert!(!output.status.success());
    assert!(!spool.exists());
    let stderr = String::from_utf8(output.stderr).expect("stderr is utf-8");
    assert!(stderr.contains("clock-in-hook:"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn oversized_stdin_exits_non_zero_without_creating_a_spool() {
    let dir = temp_dir("oversized");
    let spool = dir.join("agent-spool.jsonl");
    let input = "x".repeat(MAX_SPOOL_RECORD_BYTES + 1);

    let output = run_hook(&spool, &[], Some(&input));

    assert!(!output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn argv_flags_are_a_fallback_for_clis_that_cannot_pipe() {
    let dir = temp_dir("argv");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(
        &spool,
        &[
            "--source",
            "kimi-code",
            "--event",
            "heartbeat",
            "--session-id",
            "s9",
            "--cwd",
            "/home/alex/project",
        ],
        None,
    );

    assert!(output.status.success());
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert_eq!(value["source"], "kimi_code");
    assert_eq!(value["event"], "heartbeat");
    // --occurred-at omitted: the hook stamps the current time itself.
    assert!(value["occurredAt"]
        .as_str()
        .expect("stamped")
        .ends_with('Z'));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_flag_value_exits_non_zero_and_writes_nothing() {
    let dir = temp_dir("argv-missing");
    let spool = dir.join("agent-spool.jsonl");

    // --session-id without the rest of the identity flags is incomplete.
    let output = run_hook(&spool, &["--source", "codex", "--session-id", "s1"], None);

    assert!(!output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cursor_flags_with_a_native_payload_spool_an_event() {
    let dir = temp_dir("cursor-native");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(
        &spool,
        &["--source", "cursor", "--event", "session-start"],
        Some(r#"{"conversation_id":"c1","workspace_roots":["C:/dev/Clock-In"]}"#),
    );

    assert!(output.status.success());
    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).expect("line parses");
    assert_eq!(value["source"], "cursor");
    assert_eq!(value["event"], "started");
    assert_eq!(value["externalSessionId"], "c1");
    assert_eq!(value["cwd"], "C:/dev/Clock-In");
    // Cursor's payload has no timestamp; the hook stamps the current time.
    assert!(value["occurredAt"]
        .as_str()
        .expect("stamped")
        .ends_with('Z'));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_cursor_payload_without_a_session_id_exits_zero_and_writes_nothing() {
    let dir = temp_dir("cursor-ignored");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(
        &spool,
        &["--source", "cursor", "--event", "session-end"],
        Some(r#"{"cwd":"/x"}"#),
    );

    assert!(output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}
