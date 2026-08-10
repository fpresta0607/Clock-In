//! What survives an unexpected exit, and the one rule that decides what to do
//! with it. Pure logic: no I/O, no Tauri, no clock beyond what callers pass in.
//!
//! With recording automatic, the only thing worth carrying across a restart is
//! the session that was open when the process stopped. It is never resumed: a
//! restart is a boundary like any other, because nothing can vouch for the gap
//! between the last tick and the next launch. The session is closed at its last
//! active moment instead, so the work already recorded reaches the server and
//! the unattended gap never does.

use serde::{Deserialize, Serialize};

use crate::monitor::{iso8601, ObservedSession, OpenSession};

/// Deliberately excludes tokens, which live in the OS credential store.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryState {
    /// The session the tracker held open at the last poll tick.
    pub open_session: Option<OpenSession>,
}

/// Closes a carried-over session at the last moment the machine was in use.
/// Returns `None` when there was nothing open, or when nothing elapsed.
pub fn close_carried_session(state: &RecoveryState) -> Option<ObservedSession> {
    let open = state.open_session.as_ref()?;
    if open.last_active_at <= open.started_at {
        return None;
    }
    let elapsed = open.last_active_at - open.started_at;
    Some(ObservedSession {
        client_id: open.client_id.clone(),
        project_id: open.project.project_id.clone(),
        attribution: open.project.attribution,
        started_at: iso8601(open.started_at),
        stopped_at: iso8601(open.last_active_at),
        idle_seconds: open.idle_seconds.min(elapsed) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::{Attribution, SessionProject};

    fn open(started_at: u64, last_active_at: u64, idle_seconds: u64) -> RecoveryState {
        RecoveryState {
            open_session: Some(OpenSession {
                client_id: "c1".to_string(),
                project: SessionProject {
                    project_id: "p1".to_string(),
                    attribution: Attribution::Default,
                },
                started_at,
                idle_seconds,
                last_active_at,
            }),
        }
    }

    #[test]
    fn closes_a_carried_session_at_its_last_active_moment() {
        let closed = close_carried_session(&open(1_000, 4_600, 120)).expect("a closed session");

        assert_eq!(closed.client_id, "c1");
        assert_eq!(closed.started_at, iso8601(1_000));
        // Never at "now": the gap between the crash and the next launch is not work.
        assert_eq!(closed.stopped_at, iso8601(4_600));
        assert_eq!(closed.idle_seconds, 120);
    }

    #[test]
    fn keeps_reported_idle_inside_the_session_it_closes() {
        let closed = close_carried_session(&open(1_000, 1_500, 9_000)).expect("a closed session");

        assert_eq!(closed.idle_seconds, 500);
    }

    #[test]
    fn carries_nothing_when_nothing_was_open_or_nothing_elapsed() {
        assert_eq!(close_carried_session(&RecoveryState::default()), None);
        assert_eq!(close_carried_session(&open(1_000, 1_000, 0)), None);
    }
}
