//! `siqshift-hook`: appends one agent-session event to the local spool and exits.
//!
//! Agent CLIs invoke this from their lifecycle hooks. Following the Claude Code
//! convention the event arrives as JSON on stdin; equivalent `--flags` are the
//! fallback for CLIs that cannot pipe. Claude Code pipes its own native payload
//! rather than the SIQshift contract, so stdin is translated when it carries
//! `hook_event_name` (`SessionStart`/`SessionEnd`/`PostToolUse`; any other
//! Claude event is accepted and ignored). Cursor's registration passes only
//! `--source cursor --event …`, and its stdin payload is then mined
//! best-effort for a session id and cwd. The binary holds no credentials and
//! opens no sockets — the spool file is the whole interface, so a hook can
//! never slow down or block the agent CLI. Invalid input exits non-zero with a
//! one-line message the CLI surfaces, and never writes a partial line.

use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

use siqshift_desktop_lib::git_evidence;
use siqshift_desktop_lib::spool::{
    self, AgentEventKind, ArgvContext, HookInput, HookStdin, TokenCounters,
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("siqshift-hook: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut event = match input_from_args(&args)? {
        ArgvInput::Event(input) => input.into_event(),
        ArgvInput::Stdin(context) => match input_from_stdin(context)? {
            HookStdin::Event(event) => event,
            // An event SIQshift does not track (or a Cursor payload without a
            // session id): accepted, not spooled.
            HookStdin::Ignored => return Ok(()),
        },
    };
    if event.event == AgentEventKind::Started {
        // One probe of the working directory answers both questions: which
        // commit the shift opened at, and which codebase it is working in.
        // Each collapses any failure to `None` on its own, so a machine
        // without git records neither and nothing else changes.
        let cwd = event.cwd.clone();
        if let Some(cwd) = cwd.as_deref().map(Path::new) {
            event.start_head = git_evidence::head_sha(cwd);
            event.repo_root =
                git_evidence::repo_root(cwd).map(|root| root.to_string_lossy().into_owned());
        }
    }
    let path = spool::agent_spool_path();
    spool::append(&path, &event).map_err(|error| format!("could not write the spool: {error}"))
}

/// How the command line says the event arrives.
enum ArgvInput {
    /// Stdin carries the event; `Some` when the flags supplied the event
    /// identity (`--source`/`--event` only) and stdin carries a CLI-native
    /// payload to extract from, `None` when stdin must stand alone.
    Stdin(Option<ArgvContext>),
    /// Every flag was passed: the event is complete without stdin.
    Event(HookInput),
}

fn input_from_stdin(context: Option<ArgvContext>) -> Result<HookStdin, String> {
    let mut buffer = String::new();
    std::io::stdin()
        .take((spool::MAX_SPOOL_RECORD_BYTES + 1) as u64)
        .read_to_string(&mut buffer)
        .map_err(|error| format!("could not read stdin: {error}"))?;
    if buffer.len() > spool::MAX_SPOOL_RECORD_BYTES {
        return Err("hook input exceeds the maximum size".to_string());
    }
    spool::parse_stdin_with_context(&buffer, context)
}

fn input_from_args(args: &[String]) -> Result<ArgvInput, String> {
    if args.is_empty() {
        return Ok(ArgvInput::Stdin(None));
    }

    let mut source = None;
    let mut event = None;
    let mut session_id = None;
    let mut cwd = None;
    let mut occurred_at = None;
    let mut model = None;
    let mut input_tokens = None;
    let mut output_tokens = None;
    let mut cache_creation_input_tokens = None;
    let mut cache_read_input_tokens = None;

    let mut iter = args.iter();
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--source" => source = Some(parse_value(value)?),
            "--event" => event = Some(parse_value(value)?),
            "--session-id" => session_id = Some(value.clone()),
            "--cwd" => cwd = Some(value.clone()),
            "--occurred-at" => occurred_at = Some(value.clone()),
            // A runtime that cannot name its model passes an empty string
            // rather than branching its own hook wiring; that reads as absent.
            "--model" => model = Some(value.clone()).filter(|value| !value.trim().is_empty()),
            // Cumulative session totals, never per-turn deltas; the usage
            // registry keeps the maximum restatement per counter. An empty
            // value reads as absent, exactly as --model does.
            "--input-tokens" => input_tokens = parse_token_count(value)?,
            "--output-tokens" => output_tokens = parse_token_count(value)?,
            "--cache-creation-input-tokens" => {
                cache_creation_input_tokens = parse_token_count(value)?
            }
            "--cache-read-input-tokens" => cache_read_input_tokens = parse_token_count(value)?,
            _ => {
                return Err(format!(
                    "unknown flag {flag}; usage: siqshift-hook --source SOURCE --event EVENT [--session-id ID --cwd DIR [--model MODEL] [--occurred-at ISO8601] [--input-tokens N --output-tokens N --cache-creation-input-tokens N --cache-read-input-tokens N]]"
                ))
            }
        }
    }

    // `None` when no token flag was passed at all, so an event from a runtime
    // that never reports tokens carries no counters rather than four zeros.
    let tokens = (input_tokens.is_some()
        || output_tokens.is_some()
        || cache_creation_input_tokens.is_some()
        || cache_read_input_tokens.is_some())
    .then_some(TokenCounters {
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
    });

    match (source, event, session_id, cwd, occurred_at) {
        // Identity only: stdin carries a CLI-native payload (Cursor, Codex).
        (Some(source), Some(event), None, None, None) => Ok(ArgvInput::Stdin(Some(ArgvContext {
            source,
            event,
            tokens,
        }))),
        (Some(source), Some(event), Some(session_id), Some(cwd), occurred_at) => {
            Ok(ArgvInput::Event(
                HookInput {
                    version: 1,
                    source,
                    event,
                    session_id,
                    cwd,
                    occurred_at: occurred_at.unwrap_or_else(spool::now_iso8601),
                    model,
                    tokens,
                }
                .validate()?,
            ))
        }
        _ => Err(
            "incomplete flags; pass --source and --event, optionally with --session-id and --cwd"
                .to_string(),
        ),
    }
}

/// One cumulative token counter from the command line: a non-negative integer,
/// or an empty string for "not reported", exactly as `--model` spells it.
fn parse_token_count(value: &str) -> Result<Option<u64>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    trimmed
        .parse::<u64>()
        .map(Some)
        .map_err(|_| format!("unrecognized token count \"{value}\""))
}

/// Reuses the serde aliases so flags accept the same spellings as stdin JSON.
fn parse_value<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(&format!("\"{value}\""))
        .map_err(|_| format!("unrecognized value \"{value}\""))
}
