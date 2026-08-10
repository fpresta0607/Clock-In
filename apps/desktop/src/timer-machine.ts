export type TimerUser = {
  id: string;
  email: string;
  name: string;
};

export type TimerProject = {
  id: string;
  name: string;
  color: string | null;
  isDefault?: boolean;
};

export type StartIntent = {
  clientId: string;
  projectId: string;
  description: string;
  startedAt: string;
};

export type RunningTimer = StartIntent & {
  sessionId: string;
};

/// "An agent started in a mapped directory while no timer runs" — raised from
/// `monitor_status.pendingSuggestion`; automation proposes, the human confirms.
export type StartSuggestion = {
  projectId: string;
  source: string;
  since: string;
};

export type AwayDecision = "keep" | "discard";

/// A completed away span the user has not yet ruled on. `decision` is set by
/// the away prompt and consulted by the stop flow (see `stopIdleSeconds`).
export type AwayPrompt = {
  startedAt: string;
  seconds: number;
  exceedsHardLimit: boolean;
  decision?: AwayDecision | undefined;
};

/// The stop contract: `idleSeconds: null` tells the host to measure idle
/// itself; any number — including 0 — is the UI's authoritative decision.
/// "Discard" lets the host trim everything it measured; "keep" overrides the
/// measurement so the away span stays billable (other idle is still trimmed),
/// and a computed zero is now expressible: keep with no other idle trims
/// nothing at all.
export const stopIdleSeconds = (
  away: AwayPrompt | undefined,
  sessionIdleSeconds: number | null | undefined,
): number | null => {
  if (away?.decision !== "keep" || sessionIdleSeconds === null || sessionIdleSeconds === undefined) return null;
  return Math.max(0, sessionIdleSeconds - away.seconds);
};

type Account = { user: TimerUser; projects: readonly TimerProject[]; selectedProjectId?: string | null };

export type BootstrapSnapshot =
  | { kind: "signed-out" }
  | ({ kind: "idle" } & Account)
  | ({ kind: "running"; running: RunningTimer; source: "local-server-match" | "server-only" } & Account)
  | ({ kind: "retry-local-start"; start: StartIntent } & Account)
  | ({ kind: "pending-sync"; pendingCount: number } & Account)
  | ({ kind: "conflict"; localStart: StartIntent; serverRunning: RunningTimer } & Account);

export type TimerState =
  | { kind: "booting"; error?: string | undefined }
  | { kind: "sign-in"; error?: string | undefined }
  | ({ kind: "idle"; error?: string | undefined; suggestion?: StartSuggestion | undefined } & Account)
  | ({ kind: "starting"; start: StartIntent } & Account)
  | ({ kind: "running"; running: RunningTimer; error?: string; away?: AwayPrompt | undefined } & Account)
  | ({ kind: "stopping"; running: RunningTimer; stoppedAt: string } & Account)
  | ({ kind: "pending-sync"; pendingCount: number; message: string; error?: string | undefined } & Account)
  | ({
      kind: "conflict";
      localStart: StartIntent;
      serverRunning: RunningTimer;
      error?: string | undefined;
    } & Account);

export type TimerEvent =
  | { type: "bootstrapped"; snapshot: BootstrapSnapshot }
  | { type: "workspace-reset" }
  | { type: "bootstrap-failed"; message: string }
  | { type: "start-requested"; start: StartIntent }
  | { type: "start-confirmed"; running: RunningTimer }
  | { type: "start-failed"; message: string }
  | { type: "stop-requested"; stoppedAt: string }
  | { type: "stop-confirmed" }
  | { type: "stop-pending"; message: string }
  | { type: "stop-failed"; message: string }
  | { type: "pending-retried"; remaining: number }
  | { type: "pending-retry-failed"; message: string }
  | { type: "auth-failed"; message: string }
  | { type: "conflict-retry-failed"; message: string }
  | { type: "suggestion-received"; suggestion: StartSuggestion }
  | { type: "suggestion-cleared" }
  | { type: "away-detected"; away: Omit<AwayPrompt, "decision"> }
  | { type: "away-answered"; decision: AwayDecision };

export const initialTimerState: TimerState = { kind: "booting" };

const account = (state: Exclude<TimerState, { kind: "booting" } | { kind: "sign-in" }>): Account => ({
  user: state.user,
  projects: state.projects,
  ...(state.selectedProjectId === undefined ? {} : { selectedProjectId: state.selectedProjectId }),
});

const snapshotAccount = (snapshot: Exclude<BootstrapSnapshot, { kind: "signed-out" }>): Account => ({
  user: snapshot.user,
  projects: snapshot.projects,
  ...(snapshot.selectedProjectId === undefined ? {} : { selectedProjectId: snapshot.selectedProjectId }),
});

const fromSnapshot = (snapshot: BootstrapSnapshot): TimerState => {
  switch (snapshot.kind) {
    case "signed-out":
      return { kind: "sign-in", error: undefined };
    case "idle":
      return { kind: "idle", ...snapshotAccount(snapshot), error: undefined };
    case "running":
      return { kind: "running", ...snapshotAccount(snapshot), running: snapshot.running };
    case "retry-local-start":
      return { kind: "starting", ...snapshotAccount(snapshot), start: snapshot.start };
    case "pending-sync":
      return {
        kind: "pending-sync",
        ...snapshotAccount(snapshot),
        pendingCount: snapshot.pendingCount,
        message: `${snapshot.pendingCount} stop${snapshot.pendingCount === 1 ? "" : "s"} waiting to sync`,
      };
    case "conflict":
      return {
        kind: "conflict",
        ...snapshotAccount(snapshot),
        localStart: snapshot.localStart,
        serverRunning: snapshot.serverRunning,
        error: undefined,
      };
  }
};

export const timerReducer = (state: TimerState, event: TimerEvent): TimerState => {
  if (event.type === "workspace-reset") return initialTimerState;
  if (event.type === "bootstrapped") return fromSnapshot(event.snapshot);
  if (event.type === "auth-failed") return { kind: "sign-in", error: event.message };
  if (state.kind === "booting" && event.type === "bootstrap-failed") {
    return { kind: "booting", error: event.message };
  }

  switch (state.kind) {
    case "booting":
    case "sign-in":
      return state;
    case "idle":
      if (event.type === "start-requested") return { kind: "starting", ...account(state), start: event.start };
      if (event.type === "suggestion-received") {
        const current = state.suggestion;
        if (
          current !== undefined
          && current.projectId === event.suggestion.projectId
          && current.since === event.suggestion.since
        ) {
          return state;
        }
        return { ...state, suggestion: event.suggestion };
      }
      if (event.type === "suggestion-cleared") {
        if (state.suggestion === undefined) return state;
        return { ...state, suggestion: undefined };
      }
      return state;
    case "starting":
      if (event.type === "start-confirmed") return { kind: "running", ...account(state), running: event.running };
      if (event.type === "start-failed") return { kind: "idle", ...account(state), error: event.message };
      return state;
    case "running":
      if (event.type === "stop-requested") {
        return { kind: "stopping", ...account(state), running: state.running, stoppedAt: event.stoppedAt };
      }
      if (event.type === "away-detected") {
        // The same span keeps its decision across polls; a new span (the user
        // went away again) replaces whatever was there, unanswered.
        if (state.away?.startedAt === event.away.startedAt) return state;
        return { ...state, away: event.away };
      }
      if (event.type === "away-answered") {
        if (state.away === undefined || state.away.decision !== undefined) return state;
        return { ...state, away: { ...state.away, decision: event.decision } };
      }
      return state;
    case "stopping":
      if (event.type === "stop-confirmed") return { kind: "idle", ...account(state), error: undefined };
      if (event.type === "stop-pending") {
        return { kind: "pending-sync", ...account(state), pendingCount: 1, message: event.message };
      }
      if (event.type === "stop-failed") {
        return { kind: "running", ...account(state), running: state.running, error: event.message };
      }
      return state;
    case "pending-sync":
      if (event.type === "pending-retried") {
        return event.remaining === 0
          ? { kind: "idle", ...account(state), error: undefined }
          : {
              kind: "pending-sync",
              ...account(state),
              pendingCount: event.remaining,
              message: `${event.remaining} stop${event.remaining === 1 ? "" : "s"} waiting to sync`,
              error: undefined,
            };
      }
      if (event.type === "pending-retry-failed") return { ...state, error: event.message };
      return state;
    case "conflict":
      if (event.type === "conflict-retry-failed") return { ...state, error: event.message };
      return state;
  }
};
