//! Local recovery state and the reconciliation rules that decide what the UI
//! sees at startup. Pure logic: no I/O, no Tauri, no clock beyond what callers
//! pass in, so every branch is unit-testable.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

/// Refusing beyond this many unsynced stops keeps a disk-backed queue bounded
/// without ever discarding recorded work.
pub const MAX_PENDING_STOPS: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartIntent {
    pub client_id: String,
    pub project_id: String,
    pub description: String,
    pub started_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTimer {
    pub session_id: String,
    pub client_id: String,
    pub project_id: String,
    pub description: String,
    pub started_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingStop {
    pub session_id: String,
    pub stopped_at: String,
    pub idle_seconds: u32,
}

/// What survives an unexpected exit. Deliberately excludes tokens, which live
/// in the OS credential store instead.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryState {
    /// A start that was written down before the server confirmed it.
    pub local_start: Option<StartIntent>,
    /// A start the server confirmed.
    pub running: Option<RunningTimer>,
    pub pending_stops: VecDeque<PendingStop>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunningSource {
    LocalServerMatch,
    ServerOnly,
}

/// Mirrors the `BootstrapSnapshot` union the React bridge decodes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
// rename_all covers variant names; rename_all_fields is what makes the payload
// fields camelCase for the bridge decoder.
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Reconciliation {
    Idle,
    Running {
        running: RunningTimer,
        source: RunningSource,
    },
    RetryLocalStart {
        start: StartIntent,
    },
    PendingSync {
        pending_count: usize,
    },
    Conflict {
        local_start: StartIntent,
        server_running: RunningTimer,
    },
}

impl RecoveryState {
    pub fn enqueue_stop(&mut self, stop: PendingStop) -> Result<usize, PendingQueueFull> {
        if self.pending_stops.len() >= MAX_PENDING_STOPS {
            return Err(PendingQueueFull);
        }
        self.running = None;
        self.local_start = None;
        self.pending_stops.push_back(stop);
        Ok(self.pending_stops.len())
    }

    pub fn peek_stop(&self) -> Option<&PendingStop> {
        self.pending_stops.front()
    }

    /// Drops the oldest stop only once the server has accepted it, so a failed
    /// retry leaves the queue exactly as it was.
    pub fn confirm_oldest_stop(&mut self) -> usize {
        self.pending_stops.pop_front();
        self.pending_stops.len()
    }
}

/// Decides what to show at startup by comparing what we wrote down locally with
/// what the server believes is running.
pub fn reconcile(state: &RecoveryState, server_running: Option<&RunningTimer>) -> Reconciliation {
    // Unsynced stops win: their sessions must close before anything new starts.
    if !state.pending_stops.is_empty() {
        return Reconciliation::PendingSync {
            pending_count: state.pending_stops.len(),
        };
    }

    if let Some(local_start) = &state.local_start {
        return match server_running {
            // The start did reach the server; we just never saw the response.
            Some(server) if server.client_id == local_start.client_id => Reconciliation::Running {
                running: server.clone(),
                source: RunningSource::LocalServerMatch,
            },
            // Something else is running, so the local start cannot be replayed blindly.
            Some(server) => Reconciliation::Conflict {
                local_start: local_start.clone(),
                server_running: server.clone(),
            },
            None => Reconciliation::RetryLocalStart {
                start: local_start.clone(),
            },
        };
    }

    match (server_running, &state.running) {
        (Some(server), Some(local)) if server.session_id == local.session_id => {
            Reconciliation::Running {
                running: server.clone(),
                source: RunningSource::LocalServerMatch,
            }
        }
        (Some(server), _) => Reconciliation::Running {
            running: server.clone(),
            source: RunningSource::ServerOnly,
        },
        (None, _) => Reconciliation::Idle,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingQueueFull;

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(client_id: &str) -> StartIntent {
        StartIntent {
            client_id: client_id.to_string(),
            project_id: "11111111-1111-4111-8111-111111111111".to_string(),
            description: "Writing".to_string(),
            started_at: "2026-08-06T14:00:00.000Z".to_string(),
        }
    }

    fn running(session_id: &str, client_id: &str) -> RunningTimer {
        RunningTimer {
            session_id: session_id.to_string(),
            client_id: client_id.to_string(),
            project_id: "11111111-1111-4111-8111-111111111111".to_string(),
            description: "Writing".to_string(),
            started_at: "2026-08-06T14:00:00.000Z".to_string(),
        }
    }

    fn stop(session_id: &str) -> PendingStop {
        PendingStop {
            session_id: session_id.to_string(),
            stopped_at: "2026-08-06T15:00:00.000Z".to_string(),
            idle_seconds: 0,
        }
    }

    #[test]
    fn idle_when_nothing_is_recorded_anywhere() {
        assert_eq!(
            reconcile(&RecoveryState::default(), None),
            Reconciliation::Idle
        );
    }

    #[test]
    fn adopts_a_server_session_the_client_never_saw() {
        let server = running("s1", "c1");

        assert_eq!(
            reconcile(&RecoveryState::default(), Some(&server)),
            Reconciliation::Running {
                running: server,
                source: RunningSource::ServerOnly,
            }
        );
    }

    #[test]
    fn matches_a_confirmed_local_session_against_the_server() {
        let server = running("s1", "c1");
        let state = RecoveryState {
            running: Some(server.clone()),
            ..RecoveryState::default()
        };

        assert_eq!(
            reconcile(&state, Some(&server)),
            Reconciliation::Running {
                running: server,
                source: RunningSource::LocalServerMatch,
            }
        );
    }

    #[test]
    fn treats_a_different_server_session_as_server_only() {
        let state = RecoveryState {
            running: Some(running("s1", "c1")),
            ..RecoveryState::default()
        };
        let server = running("s2", "c2");

        assert_eq!(
            reconcile(&state, Some(&server)),
            Reconciliation::Running {
                running: server,
                source: RunningSource::ServerOnly,
            }
        );
    }

    #[test]
    fn replays_an_unconfirmed_start_when_the_server_has_nothing() {
        let state = RecoveryState {
            local_start: Some(intent("c1")),
            ..RecoveryState::default()
        };

        assert_eq!(
            reconcile(&state, None),
            Reconciliation::RetryLocalStart {
                start: intent("c1")
            }
        );
    }

    #[test]
    fn resolves_an_unconfirmed_start_that_actually_reached_the_server() {
        let state = RecoveryState {
            local_start: Some(intent("c1")),
            ..RecoveryState::default()
        };
        let server = running("s1", "c1");

        assert_eq!(
            reconcile(&state, Some(&server)),
            Reconciliation::Running {
                running: server,
                source: RunningSource::LocalServerMatch,
            }
        );
    }

    #[test]
    fn reports_a_conflict_when_a_different_session_is_already_running() {
        let state = RecoveryState {
            local_start: Some(intent("c1")),
            ..RecoveryState::default()
        };
        let server = running("s9", "c9");

        assert_eq!(
            reconcile(&state, Some(&server)),
            Reconciliation::Conflict {
                local_start: intent("c1"),
                server_running: server,
            }
        );
    }

    #[test]
    fn unsynced_stops_take_priority_over_any_running_session() {
        let mut state = RecoveryState {
            local_start: Some(intent("c1")),
            ..RecoveryState::default()
        };
        state.pending_stops.push_back(stop("s1"));

        assert_eq!(
            reconcile(&state, Some(&running("s2", "c2"))),
            Reconciliation::PendingSync { pending_count: 1 }
        );
    }

    #[test]
    fn a_failed_retry_preserves_the_queue_and_a_confirmed_one_shrinks_it() {
        let mut state = RecoveryState::default();
        state.enqueue_stop(stop("s1")).expect("first stop queues");
        state.enqueue_stop(stop("s2")).expect("second stop queues");

        // Peeking must not consume: a retry that fails has to see the same stop again.
        assert_eq!(state.peek_stop().map(|s| s.session_id.as_str()), Some("s1"));
        assert_eq!(state.pending_stops.len(), 2);

        assert_eq!(state.confirm_oldest_stop(), 1);
        assert_eq!(state.peek_stop().map(|s| s.session_id.as_str()), Some("s2"));
        assert_eq!(state.confirm_oldest_stop(), 0);
        assert_eq!(state.peek_stop(), None);
    }

    #[test]
    fn enqueueing_a_stop_clears_the_session_it_closes() {
        let mut state = RecoveryState {
            local_start: Some(intent("c1")),
            running: Some(running("s1", "c1")),
            ..RecoveryState::default()
        };

        assert_eq!(state.enqueue_stop(stop("s1")), Ok(1));
        assert_eq!(state.running, None);
        assert_eq!(state.local_start, None);
    }

    #[test]
    fn the_queue_refuses_overflow_instead_of_discarding_recorded_work() {
        let mut state = RecoveryState::default();
        for index in 0..MAX_PENDING_STOPS {
            state
                .enqueue_stop(stop(&format!("s{index}")))
                .expect("queue accepts up to the cap");
        }

        assert_eq!(state.enqueue_stop(stop("overflow")), Err(PendingQueueFull));
        assert_eq!(state.pending_stops.len(), MAX_PENDING_STOPS);
        // The oldest work is still intact rather than silently dropped.
        assert_eq!(state.peek_stop().map(|s| s.session_id.as_str()), Some("s0"));
    }

    #[test]
    fn serializes_snapshots_in_the_shape_the_bridge_decodes() {
        let json = serde_json::to_value(Reconciliation::Running {
            running: running("s1", "c1"),
            source: RunningSource::LocalServerMatch,
        })
        .expect("snapshot serializes");

        assert_eq!(json["kind"], "running");
        assert_eq!(json["source"], "local-server-match");
        assert_eq!(json["running"]["sessionId"], "s1");
        assert_eq!(json["running"]["clientId"], "c1");
    }

    #[test]
    fn every_variant_payload_field_is_camel_case_for_the_bridge() {
        let pending = serde_json::to_value(Reconciliation::PendingSync { pending_count: 3 })
            .expect("snapshot serializes");
        assert_eq!(pending["pendingCount"], 3);

        let conflict = serde_json::to_value(Reconciliation::Conflict {
            local_start: intent("c1"),
            server_running: running("s9", "c9"),
        })
        .expect("snapshot serializes");
        assert_eq!(conflict["localStart"]["clientId"], "c1");
        assert_eq!(conflict["serverRunning"]["sessionId"], "s9");

        let retry = serde_json::to_value(Reconciliation::RetryLocalStart {
            start: intent("c1"),
        })
        .expect("snapshot serializes");
        assert_eq!(
            retry["start"]["projectId"],
            "11111111-1111-4111-8111-111111111111"
        );
    }
}
