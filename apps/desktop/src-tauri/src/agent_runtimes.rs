//! The agent-runtime roster.
//!
//! `packages/shared/src/agent-runtimes.json` is the single declaration of every
//! runtime Clock-In knows by name, and this module embeds that exact file so
//! the host and the TypeScript side cannot drift. Adding a runtime is an entry
//! in that JSON: the hook probes, the registration snippets, the display names,
//! the process folding, and the quota dials all read it.
//!
//! The roster is not an allowlist. `AgentSource` accepts any id of the
//! canonical shape, so a runtime nobody has declared yet is still spooled and
//! uploaded under its own name. The roster only decides what Clock-In can *say*
//! about a runtime.

use std::sync::OnceLock;

use serde::Deserialize;

/// Compiled in, so a build always ships a roster that matches its contracts.
const REGISTRY_JSON: &str = include_str!("../../../../packages/shared/src/agent-runtimes.json");

/// How Clock-In can switch a runtime's hooks on.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Registration {
    /// Claude Code's nested `hooks.SessionStart[].hooks[]` arrays, which Codex
    /// also uses in its own `hooks.json`.
    ClaudeJson,
    /// Cursor's flat `hooks.sessionStart[]` array of argv-carrying commands.
    CursorJson,
    /// No config shape the host will rewrite: the user gets an honest snippet.
    Manual,
}

/// The host's view of a roster entry. The roster carries more per runtime than
/// this — display labels, executables, quota providers, icons — but those are
/// the webview's business, so the host reads only what it acts on and ignores
/// the rest.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntime {
    pub id: String,
    /// Home-relative path to the config a hook registration lands in.
    pub config_path: String,
    pub registration: Registration,
    /// Paste-it-yourself lines; `{command}` stands in for the hook binary path.
    pub manual_snippet: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Registry {
    runtimes: Vec<AgentRuntime>,
}

/// The declared runtimes, in roster order. A malformed roster is a build-time
/// mistake, so it panics rather than silently shipping a shorter list.
pub fn runtimes() -> &'static [AgentRuntime] {
    static REGISTRY: OnceLock<Vec<AgentRuntime>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| {
            serde_json::from_str::<Registry>(REGISTRY_JSON)
                .expect("the bundled agent-runtime roster parses")
                .runtimes
        })
        .as_slice()
}

pub fn find(id: &str) -> Option<&'static AgentRuntime> {
    runtimes().iter().find(|runtime| runtime.id == id)
}

/// The paste-it-yourself text for a runtime the host will not rewrite.
pub fn manual_snippet(id: &str, command: &str) -> Option<String> {
    let runtime = find(id)?;
    if runtime.manual_snippet.is_empty() {
        return None;
    }
    Some(
        runtime
            .manual_snippet
            .join("\n")
            .replace("{command}", command),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_roster_parses_and_declares_the_runtimes_in_use() {
        let ids: Vec<&str> = runtimes()
            .iter()
            .map(|runtime| runtime.id.as_str())
            .collect();
        for expected in [
            "claude_code",
            "codex",
            "cursor",
            "kimi_code",
            "pi",
            "opencode",
        ] {
            assert!(
                ids.contains(&expected),
                "{expected} is missing from the roster"
            );
        }
    }

    #[test]
    fn runtimes_not_installed_anywhere_are_still_declared() {
        // The roster is a declaration, not a survey of this machine: absence is
        // never hard-coded, so these resolve without any of them being present.
        for id in ["pi_signed", "grok", "muse", "copilot"] {
            assert!(find(id).is_some(), "{id} is missing from the roster");
        }
    }

    #[test]
    fn an_undeclared_runtime_resolves_to_nothing_rather_than_to_a_neighbour() {
        assert!(find("some_new_agent").is_none());
        assert!(manual_snippet("some_new_agent", "/opt/clock-in-hook").is_none());
    }

    #[test]
    fn every_manual_runtime_carries_a_snippet_and_no_merged_one_does() {
        for runtime in runtimes() {
            let snippet = manual_snippet(&runtime.id, "/opt/clock-in-hook");
            match runtime.registration {
                Registration::Manual => {
                    let snippet = snippet.expect("a manual runtime explains itself");
                    assert!(
                        snippet.contains("/opt/clock-in-hook"),
                        "{} drops the command",
                        runtime.id
                    );
                    assert!(
                        !snippet.contains("{command}"),
                        "{} leaves a placeholder",
                        runtime.id
                    );
                }
                _ => assert!(
                    snippet.is_none(),
                    "{} merges, so it needs no snippet",
                    runtime.id
                ),
            }
        }
    }

    #[test]
    fn ids_are_unique_and_canonically_shaped() {
        let mut ids: Vec<&str> = runtimes()
            .iter()
            .map(|runtime| runtime.id.as_str())
            .collect();
        for id in &ids {
            assert_eq!(
                crate::spool::AgentSource::parse(id).map(|source| source.as_str().to_string()),
                Ok((*id).to_string()),
                "{id} is not already canonical",
            );
        }
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "two runtimes share an id");
    }
}
