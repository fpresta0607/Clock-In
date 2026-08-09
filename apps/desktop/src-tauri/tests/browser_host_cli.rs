//! End-to-end checks for the `clock-in-browser-host` binary over real pipes:
//! get-rules answers from the rules file (failing closed when it is missing
//! or corrupt), span events land in the browser spool under the interprocess
//! lock, unknown types and bad frames never kill the port.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "clock-in-browser-host-cli-{}-{tag}",
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

fn parse_frames(bytes: &[u8]) -> Vec<serde_json::Value> {
    let mut values = Vec::new();
    let mut offset = 0;
    while offset + 4 <= bytes.len() {
        let length = u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .expect("a length prefix"),
        ) as usize;
        offset += 4;
        assert!(offset + length <= bytes.len(), "every reply is complete");
        values.push(serde_json::from_slice(&bytes[offset..offset + length]).expect("reply parses"));
        offset += length;
    }
    assert_eq!(offset, bytes.len(), "no trailing bytes after the frames");
    values
}

struct Host {
    child: Child,
}

impl Host {
    fn spawn(dir: &Path) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_clock-in-browser-host"))
            // The host derives its whole working set from the agent spool's
            // directory, so the one override relocates spool, rules, and tally.
            .env("CLOCK_IN_SPOOL", dir.join("agent-spool.jsonl"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("host binary spawns");
        Self { child }
    }

    fn send(&mut self, messages: &[Vec<u8>]) {
        let stdin = self.child.stdin.as_mut().expect("stdin is piped");
        for message in messages {
            stdin.write_all(message).expect("message writes");
        }
        stdin.flush().expect("stdin flushes");
    }

    /// Closes stdin (the browser hung up) and collects every reply frame.
    fn finish(mut self) -> (std::process::Output, Vec<serde_json::Value>) {
        drop(self.child.stdin.take());
        let output = self.child.wait_with_output().expect("host exits");
        let replies = parse_frames(&output.stdout);
        (output, replies)
    }
}

#[test]
fn host_without_a_durable_session_fails_closed_to_empty_rules() {
    let dir = temp_dir("get-rules");
    std::fs::write(
        dir.join("browser-rules.json"),
        r#"{"rules":[{"id":"r1","pattern":"github.com/acme/*"}]}"#,
    )
    .expect("rules file writes");

    let mut host = Host::spawn(&dir);
    host.send(&[framed(br#"{"type":"get-rules"}"#)]);
    let (output, replies) = host.finish();

    assert!(output.status.success());
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["type"], "rules");
    assert!(replies[0]["rules"].as_array().expect("rules is an array").is_empty());
    assert_eq!(replies[0]["collectionEnabled"], false);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn get_rules_fails_closed_when_the_file_is_missing_or_corrupt() {
    for (tag, contents) in [("missing", None), ("corrupt", Some("{not json"))] {
        let dir = temp_dir(tag);
        if let Some(contents) = contents {
            std::fs::write(dir.join("browser-rules.json"), contents).expect("rules file writes");
        }

        let mut host = Host::spawn(&dir);
        host.send(&[framed(br#"{"type":"get-rules"}"#)]);
        let (output, replies) = host.finish();

        assert!(output.status.success());
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["type"], "rules");
        assert!(replies[0]["rules"]
            .as_array()
            .expect("rules is an array")
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn a_host_without_a_durable_session_rejects_span_events() {
    let dir = temp_dir("span-event");

    let mut host = Host::spawn(&dir);
    host.send(&[framed(
        format!(
            r#"{{"type":"span-event","collectionId":"stale","event":{{"event":"started","externalSessionId":"s1","ruleId":"r1","occurredAt":"2026-08-09T12:00:00Z"}}}}"#
        )
        .as_bytes(),
    )]);
    let (output, replies) = host.finish();

    assert!(output.status.success());
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["type"], "collection-state");
    assert_eq!(replies[0]["collectionEnabled"], false);
    assert!(!dir.join("browser-spool.jsonl").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_host_without_a_durable_session_rejects_tallies() {
    let dir = temp_dir("tally");

    let mut host = Host::spawn(&dir);
    host.send(&[framed(
        format!(
            r#"{{"type":"tally","collectionId":"stale","weekStart":1786060800000,"entries":[{{"origin":"quickbooks.com","seconds":10800}}]}}"#
        )
        .as_bytes(),
    )]);
    let (output, replies) = host.finish();

    assert!(output.status.success());
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["type"], "collection-state");
    assert_eq!(replies[0]["collectionEnabled"], false);
    assert!(!dir.join("unmatched-tally.json").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn signed_out_host_rejects_browser_evidence() {
    let dir = temp_dir("signed-out");

    let mut host = Host::spawn(&dir);
    host.send(&[
        framed(
            br#"{"type":"span-event","collectionId":"stale","event":{"event":"started","externalSessionId":"s1","ruleId":"r1","occurredAt":"2026-08-09T12:00:00Z"}}"#,
        ),
        framed(
            br#"{"type":"tally","collectionId":"stale","weekStart":1786060800000,"entries":[{"origin":"quickbooks.com","seconds":10800}]}"#,
        ),
    ]);
    let (output, replies) = host.finish();

    assert!(output.status.success());
    assert_eq!(replies.len(), 2);
    for reply in replies {
        assert_eq!(reply["type"], "collection-state");
        assert_eq!(reply["collectionEnabled"], false);
    }
    assert!(!dir.join("browser-spool.jsonl").exists());
    assert!(!dir.join("unmatched-tally.json").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unknown_types_and_bad_frames_never_kill_the_port() {
    let dir = temp_dir("resilient");
    let oversize = vec![b'x'; 64 * 1024 + 1];

    let mut host = Host::spawn(&dir);
    host.send(&[
        framed(br#"{"type":"mystery"}"#),
        framed(b"not json"),
        framed(&oversize),
        framed(br#"{"type":"get-rules"}"#),
    ]);
    let (output, replies) = host.finish();

    assert!(output.status.success());
    // Only the get-rules behind the bad frames gets an answer.
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["type"], "rules");
    assert!(!dir.join("browser-spool.jsonl").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_signed_out_hosts_reject_every_span() {
    let dir = temp_dir("concurrent");

    let handles: Vec<_> = (0..3)
        .map(|host_index| {
            let dir = dir.clone();
            std::thread::spawn(move || {
                let mut host = Host::spawn(&dir);
                let messages: Vec<Vec<u8>> = (0..5)
                    .map(|index| {
                        framed(
                            format!(
                                r#"{{"type":"span-event","collectionId":"stale","event":{{"event":"heartbeat","externalSessionId":"h{host_index}-{index}","ruleId":"r1","occurredAt":"2026-08-09T12:00:00Z"}}}}"#
                            )
                            .as_bytes(),
                        )
                    })
                    .collect();
                host.send(&messages);
                let (output, _) = host.finish();
                assert!(output.status.success());
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("host thread finishes");
    }

    assert!(!dir.join("browser-spool.jsonl").exists());

    let _ = std::fs::remove_dir_all(&dir);
}
