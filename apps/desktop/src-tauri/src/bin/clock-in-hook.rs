//! `clock-in-hook`: appends one agent-session event to the local spool and exits.
//!
//! Agent CLIs invoke this from their lifecycle hooks. Following the Claude Code
//! convention the event arrives as JSON on stdin; equivalent `--flags` are the
//! fallback for CLIs that cannot pipe. Claude Code pipes its own native payload
//! rather than the Clock-In contract, so stdin is translated when it carries
//! `hook_event_name` (`SessionStart`/`SessionEnd`/`PostToolUse`; any other
//! Claude event is accepted and ignored). Cursor's registration passes only
//! `--source cursor --event …`, and its stdin payload is then mined
//! best-effort for a session id and cwd. The binary holds no credentials and
//! opens no sockets — the spool file is the whole interface, so a hook can
//! never slow down or block the agent CLI. Invalid input exits non-zero with a
//! one-line message the CLI surfaces, and never writes a partial line.

use std::io::Read;
use std::process::ExitCode;

use clock_in_desktop_lib::spool::{self, ArgvContext, HookInput, HookStdin};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("clock-in-hook: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let event = match input_from_args(&args)? {
        ArgvInput::Event(input) => input.into_event(),
        ArgvInput::Stdin(context) => match input_from_stdin(context)? {
            HookStdin::Event(event) => event,
            // An event Clock-In does not track (or a Cursor payload without a
            // session id): accepted, not spooled.
            HookStdin::Ignored => return Ok(()),
        },
    };
    spool::append(&spool::default_spool_path(), &event)
        .map_err(|error| format!("could not write the spool: {error}"))
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
        .read_to_string(&mut buffer)
        .map_err(|error| format!("could not read stdin: {error}"))?;
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

    let mut iter = args.iter();
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--source" => source = Some(parse_value(value)?),
            "--event" => event = Some(parse_value(value)?),
            "--session-id" => session_id = Some(value.clone()),
            "--cwd" => cwd = Some(value.clone()),
            "--occurred-at" => occurred_at = Some(value.clone()),
            _ => {
                return Err(format!(
                    "unknown flag {flag}; usage: clock-in-hook --source SOURCE --event EVENT [--session-id ID --cwd DIR [--occurred-at ISO8601]]"
                ))
            }
        }
    }

    match (source, event, session_id, cwd, occurred_at) {
        // Identity only: stdin carries a CLI-native payload (Cursor).
        (Some(source), Some(event), None, None, None) => {
            Ok(ArgvInput::Stdin(Some(ArgvContext { source, event })))
        }
        (Some(source), Some(event), Some(session_id), Some(cwd), occurred_at) => {
            Ok(ArgvInput::Event(
                HookInput {
                    version: 1,
                    source,
                    event,
                    session_id,
                    cwd,
                    occurred_at: occurred_at.unwrap_or_else(spool::now_iso8601),
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

/// Reuses the serde aliases so flags accept the same spellings as stdin JSON.
fn parse_value<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(&format!("\"{value}\""))
        .map_err(|_| format!("unrecognized value \"{value}\""))
}
