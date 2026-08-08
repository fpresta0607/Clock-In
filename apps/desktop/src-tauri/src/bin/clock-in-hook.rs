//! `clock-in-hook`: appends one agent-session event to the local spool and exits.
//!
//! Agent CLIs invoke this from their lifecycle hooks. Following the Claude Code
//! convention the event arrives as JSON on stdin; equivalent `--flags` are the
//! fallback for CLIs that cannot pipe. Claude Code pipes its own native payload
//! rather than the Clock-In contract, so stdin is translated when it carries
//! `hook_event_name` (`SessionStart`/`SessionEnd`/`PostToolUse`; any other
//! Claude event is accepted and ignored). The binary holds no credentials and
//! opens no sockets — the spool file is the whole interface, so a hook can
//! never slow down or block the agent CLI. Invalid input exits non-zero with a
//! one-line message the CLI surfaces, and never writes a partial line.

use std::io::Read;
use std::process::ExitCode;

use clock_in_desktop_lib::spool::{self, HookInput, HookStdin};

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
        Some(input) => input.into_event(),
        None => match input_from_stdin()? {
            HookStdin::Event(event) => event,
            // A Claude Code event Clock-In does not track: accepted, not spooled.
            HookStdin::Ignored => return Ok(()),
        },
    };
    spool::append(&spool::default_spool_path(), &event)
        .map_err(|error| format!("could not write the spool: {error}"))
}

fn input_from_stdin() -> Result<HookStdin, String> {
    let mut buffer = String::new();
    std::io::stdin()
        .read_to_string(&mut buffer)
        .map_err(|error| format!("could not read stdin: {error}"))?;
    spool::parse_stdin(&buffer)
}

/// Returns `None` when no flags were passed, meaning stdin carries the event.
fn input_from_args(args: &[String]) -> Result<Option<HookInput>, String> {
    if args.is_empty() {
        return Ok(None);
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
                    "unknown flag {flag}; usage: clock-in-hook --source SOURCE --event EVENT --session-id ID --cwd DIR [--occurred-at ISO8601]"
                ))
            }
        }
    }

    Ok(Some(
        HookInput {
            version: 1,
            source: source.ok_or("missing --source")?,
            event: event.ok_or("missing --event")?,
            session_id: session_id.ok_or("missing --session-id")?,
            cwd: cwd.ok_or("missing --cwd")?,
            occurred_at: occurred_at.unwrap_or_else(spool::now_iso8601),
        }
        .validate()?,
    ))
}

/// Reuses the serde aliases so flags accept the same spellings as stdin JSON.
fn parse_value<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(&format!("\"{value}\""))
        .map_err(|_| format!("unrecognized value \"{value}\""))
}
