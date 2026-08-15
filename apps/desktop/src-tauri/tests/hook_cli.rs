//! End-to-end checks for the `clock-in-hook` binary: valid input lands as one
//! canonical spool line, invalid input exits non-zero and writes nothing.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use clock_in_desktop_lib::spool::{self, MAX_SPOOL_RECORD_BYTES};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("clock-in-hook-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir is created");
    dir
}

fn active_agent_spool(root: &Path) -> PathBuf {
    let identity =
        spool::EvidenceIdentity::new("cli-user", "cli-organization").expect("identity is valid");
    let dir = root
        .join("evidence")
        .join(&identity.account_id)
        .join(&identity.organization_id);
    std::fs::create_dir_all(&dir).expect("active evidence namespace creates");
    std::fs::write(
        root.join("active-identity.json"),
        serde_json::to_vec(&identity).expect("active identity serializes"),
    )
    .expect("active identity writes");
    dir.join("agent-spool.jsonl")
}

fn run_hook(root: &Path, args: &[&str], stdin: Option<&str>) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_clock-in-hook"))
        .args(args)
        .env("CLOCK_IN_SPOOL", root.join("agent-spool.jsonl"))
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
fn an_event_lands_in_the_default_spool_when_no_identity_is_active() {
    // The state every real install is in: nothing activates a namespaced
    // evidence identity, so the hook must write the spool the desktop uploader
    // drains. Getting this wrong is silent — the hook exits 0 and the whole
    // agent-attribution path simply reports that no agents ever ran.
    let dir = temp_dir("no-identity");
    let spool = dir.join("agent-spool.jsonl");

    let output = run_hook(
        &dir,
        &[
            "--source",
            "pi",
            "--event",
            "session-start",
            "--session-id",
            "s1",
            "--cwd",
            "/home/dev/Clock-In",
            "--model",
            "deepseek-v4-pro",
        ],
        None,
    );

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = std::fs::read_to_string(&spool).expect("the default spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert_eq!(value["source"], "pi");
    assert_eq!(value["model"], "deepseek-v4-pro");
    assert_eq!(value["cwd"], "/home/dev/Clock-In");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_runtimes_each_land_as_their_own_line() {
    // Several agent CLIs run at once on one machine. Two runtimes in the same
    // folder must stay two events, told apart by source and session id.
    let dir = temp_dir("concurrent-runtimes");
    let spool = dir.join("agent-spool.jsonl");

    for (source, session, model) in [
        ("claude_code", "claude-1", "claude-opus-5"),
        ("pi", "pi-1", "deepseek-v4-pro"),
    ] {
        let output = run_hook(
            &dir,
            &[
                "--source",
                source,
                "--event",
                "session-start",
                "--session-id",
                session,
                "--cwd",
                "/home/dev/Clock-In",
                "--model",
                model,
            ],
            None,
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let content = std::fs::read_to_string(&spool).expect("the default spool reads");
    let recorded: Vec<(String, String)> = content
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("line parses"))
        .map(|value| {
            (
                value["source"].as_str().expect("a source").to_string(),
                value["model"].as_str().expect("a model").to_string(),
            )
        })
        .collect();
    assert_eq!(
        recorded,
        vec![
            ("claude_code".to_string(), "claude-opus-5".to_string()),
            ("pi".to_string(), "deepseek-v4-pro".to_string()),
        ],
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_valid_stdin_event_lands_as_one_canonical_line() {
    let dir = temp_dir("stdin");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
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
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
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
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
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
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
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
    let spool = active_agent_spool(&dir);

    let output = run_hook(&dir, &[], Some(r#"{"version":2,"source":"codex"}"#));

    assert!(!output.status.success());
    assert!(!spool.exists());
    let stderr = String::from_utf8(output.stderr).expect("stderr is utf-8");
    assert!(stderr.contains("clock-in-hook:"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn oversized_stdin_exits_non_zero_without_creating_a_spool() {
    let dir = temp_dir("oversized");
    let spool = active_agent_spool(&dir);
    let input = "x".repeat(MAX_SPOOL_RECORD_BYTES + 1);

    let output = run_hook(&dir, &[], Some(&input));

    assert!(!output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn argv_flags_are_a_fallback_for_clis_that_cannot_pipe() {
    let dir = temp_dir("argv");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
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
    let spool = active_agent_spool(&dir);

    // --session-id without the rest of the identity flags is incomplete.
    let output = run_hook(&dir, &["--source", "codex", "--session-id", "s1"], None);

    assert!(!output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cursor_flags_with_a_native_payload_spool_an_event() {
    let dir = temp_dir("cursor-native");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
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
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &["--source", "cursor", "--event", "session-end"],
        Some(r#"{"cwd":"/x"}"#),
    );

    assert!(output.status.success());
    assert!(!spool.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

fn init_repo_with_one_commit(dir: &Path) -> String {
    std::fs::create_dir_all(dir).expect("repo dir creates");
    for args in [
        &["init", "--quiet", "--initial-branch=main"][..],
        &["config", "user.email", "shift@example.test"][..],
        &["config", "user.name", "Shift Test"][..],
        &["config", "commit.gpgsign", "false"][..],
    ] {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git runs");
        assert!(status.success(), "git setup failed in {dir:?}");
    }
    std::fs::write(dir.join("a.txt"), "base").expect("scratch file writes");
    for args in [&["add", "-A"][..], &["commit", "--quiet", "-m", "base"][..]] {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git runs");
        assert!(status.success(), "git commit failed in {dir:?}");
    }
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .expect("git rev-parse runs");
    String::from_utf8(output.stdout)
        .expect("utf8 sha")
        .trim()
        .to_string()
}

#[test]
fn a_started_event_over_a_git_repo_records_the_head_at_shift_start() {
    let dir = temp_dir("started-head-repo");
    let repo = dir.join("repo");
    let head = init_repo_with_one_commit(&repo);
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[
            "--source",
            "pi",
            "--event",
            "session-start",
            "--session-id",
            "s1",
            "--cwd",
            repo.to_str().expect("utf8 path"),
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert_eq!(value["startHead"], head);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_started_event_over_a_non_repo_cwd_records_no_head() {
    let dir = temp_dir("started-head-non-repo");
    let not_a_repo = dir.join("not-a-repo");
    std::fs::create_dir_all(&not_a_repo).expect("dir creates");
    let spool = active_agent_spool(&dir);

    let output = run_hook(
        &dir,
        &[
            "--source",
            "pi",
            "--event",
            "session-start",
            "--session-id",
            "s1",
            "--cwd",
            not_a_repo.to_str().expect("utf8 path"),
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let content = std::fs::read_to_string(&spool).expect("spool reads");
    let value: serde_json::Value =
        serde_json::from_str(content.lines().next().expect("one line")).expect("line parses");
    assert!(value.get("startHead").is_none());

    let _ = std::fs::remove_dir_all(&dir);
}
