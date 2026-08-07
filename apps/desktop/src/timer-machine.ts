export type TimerUser = {
  id: string;
  email: string;
  name: string;
};

export type TimerProject = {
  id: string;
  name: string;
  color: string | null;
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

type Account = { user: TimerUser; projects: readonly TimerProject[] };

export type BootstrapSnapshot =
  | { kind: "signed-out" }
  | ({ kind: "idle" } & Account)
  | ({ kind: "running"; running: RunningTimer; source: "local-server-match" | "server-only" } & Account)
  | ({ kind: "retry-local-start"; start: StartIntent } & Account)
  | ({ kind: "pending-sync"; pendingCount: number } & Account)
  | ({ kind: "conflict"; localStart: StartIntent; serverRunning: RunningTimer } & Account);

export type TimerState =
  | { kind: "booting" }
  | { kind: "sign-in"; error?: string | undefined }
  | ({ kind: "idle"; error?: string | undefined } & Account)
  | ({ kind: "starting"; start: StartIntent } & Account)
  | ({ kind: "running"; running: RunningTimer; error?: string } & Account)
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
  | { type: "conflict-retry-failed"; message: string };

export const initialTimerState: TimerState = { kind: "booting" };

const account = (state: Exclude<TimerState, { kind: "booting" } | { kind: "sign-in" }>): Account => ({
  user: state.user,
  projects: state.projects,
});

const fromSnapshot = (snapshot: BootstrapSnapshot): TimerState => {
  switch (snapshot.kind) {
    case "signed-out":
      return { kind: "sign-in", error: undefined };
    case "idle":
      return { kind: "idle", user: snapshot.user, projects: snapshot.projects, error: undefined };
    case "running":
      return { kind: "running", user: snapshot.user, projects: snapshot.projects, running: snapshot.running };
    case "retry-local-start":
      return { kind: "starting", user: snapshot.user, projects: snapshot.projects, start: snapshot.start };
    case "pending-sync":
      return {
        kind: "pending-sync",
        user: snapshot.user,
        projects: snapshot.projects,
        pendingCount: snapshot.pendingCount,
        message: `${snapshot.pendingCount} stop${snapshot.pendingCount === 1 ? "" : "s"} waiting to sync`,
      };
    case "conflict":
      return {
        kind: "conflict",
        user: snapshot.user,
        projects: snapshot.projects,
        localStart: snapshot.localStart,
        serverRunning: snapshot.serverRunning,
        error: undefined,
      };
  }
};

export const timerReducer = (state: TimerState, event: TimerEvent): TimerState => {
  if (event.type === "bootstrapped") return fromSnapshot(event.snapshot);
  if (event.type === "auth-failed") return { kind: "sign-in", error: event.message };

  switch (state.kind) {
    case "booting":
    case "sign-in":
      return state;
    case "idle":
      if (event.type === "start-requested") return { kind: "starting", ...account(state), start: event.start };
      return state;
    case "starting":
      if (event.type === "start-confirmed") return { kind: "running", ...account(state), running: event.running };
      if (event.type === "start-failed") return { kind: "idle", ...account(state), error: event.message };
      return state;
    case "running":
      if (event.type === "stop-requested") {
        return { kind: "stopping", ...account(state), running: state.running, stoppedAt: event.stoppedAt };
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
