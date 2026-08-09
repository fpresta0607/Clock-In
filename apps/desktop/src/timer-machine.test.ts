import { describe, expect, it } from "vitest";

import { initialTimerState, stopIdleSeconds, timerReducer } from "./timer-machine.js";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "timer@example.com",
  name: "Timer User",
};

const project = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "Field work",
  color: "#d89a34",
};

const start = {
  clientId: "00000000-0000-4000-8000-000000000100",
  projectId: project.id,
  description: "Inspect relay",
  startedAt: "2026-08-06T15:00:00.000Z",
};

const running = { ...start, sessionId: "00000000-0000-4000-8000-000000000200" };

describe("timerReducer", () => {
  it("begins in boot loading", () => {
    expect(initialTimerState).toEqual({ kind: "booting" });
  });

  it("moves a signed-out bootstrap response to sign-in", () => {
    expect(timerReducer(initialTimerState, { type: "bootstrapped", snapshot: { kind: "signed-out" } })).toEqual({
      kind: "sign-in",
      error: undefined,
    });
  });

  it("keeps bootstrap blocked when authorization revocation cannot complete", () => {
    expect(timerReducer(initialTimerState, {
      type: "bootstrap-failed",
      message: "Could not disable browser attribution.",
    })).toEqual({ kind: "booting", error: "Could not disable browser attribution." });
  });

  it("moves a signed-in bootstrap response to idle with active projects", () => {
    const state = timerReducer(initialTimerState, {
      type: "bootstrapped",
      snapshot: { kind: "idle", user, projects: [project] },
    });

    expect(state).toEqual({ kind: "idle", user, projects: [project], error: undefined });
  });

  it("records an unconfirmed local start before network confirmation", () => {
    const idle = { kind: "idle", user, projects: [project] } as const;
    expect(timerReducer(idle, { type: "start-requested", start })).toEqual({
      kind: "starting",
      user,
      projects: [project],
      start,
    });
  });

  it("confirms an optimistic start as running", () => {
    const starting = { kind: "starting", user, projects: [project], start } as const;
    expect(timerReducer(starting, { type: "start-confirmed", running })).toEqual({
      kind: "running",
      user,
      projects: [project],
      running,
    });
  });

  it("rolls a failed start back to idle with an actionable error", () => {
    const starting = { kind: "starting", user, projects: [project], start } as const;
    expect(timerReducer(starting, { type: "start-failed", message: "Network unavailable" })).toEqual({
      kind: "idle",
      user,
      projects: [project],
      error: "Network unavailable",
    });
  });

  it("transitions a running timer to stopping and then idle", () => {
    const active = { kind: "running", user, projects: [project], running } as const;
    const stopping = timerReducer(active, { type: "stop-requested", stoppedAt: "2026-08-06T16:00:00.000Z" });
    expect(stopping).toEqual({
      kind: "stopping",
      user,
      projects: [project],
      running,
      stoppedAt: "2026-08-06T16:00:00.000Z",
    });
    expect(timerReducer(stopping, { type: "stop-confirmed" })).toEqual({
      kind: "idle",
      user,
      projects: [project],
      error: undefined,
    });
  });

  it("removes a timer and enters pending sync after a transient stop failure", () => {
    const stopping = {
      kind: "stopping",
      user,
      projects: [project],
      running,
      stoppedAt: "2026-08-06T16:00:00.000Z",
    } as const;
    expect(timerReducer(stopping, { type: "stop-pending", message: "Saved for retry" })).toEqual({
      kind: "pending-sync",
      user,
      projects: [project],
      pendingCount: 1,
      message: "Saved for retry",
    });
  });

  it("moves an auth failure to sign-in-required", () => {
    const active = { kind: "running", user, projects: [project], running } as const;
    expect(timerReducer(active, { type: "auth-failed", message: "Session expired" })).toEqual({
      kind: "sign-in",
      error: "Session expired",
    });
  });

  it("adopts a server timer during startup reconciliation", () => {
    const state = timerReducer(initialTimerState, {
      type: "bootstrapped",
      snapshot: { kind: "running", user, projects: [project], running, source: "server-only" },
    });
    expect(state).toEqual({ kind: "running", user, projects: [project], running });
  });

  it("retries an unconfirmed local start during startup reconciliation", () => {
    const state = timerReducer(initialTimerState, {
      type: "bootstrapped",
      snapshot: { kind: "retry-local-start", user, projects: [project], start },
    });
    expect(state).toEqual({ kind: "starting", user, projects: [project], start });
  });

  it("surfaces recovery conflicts without discarding either timer", () => {
    const server = { ...running, sessionId: "00000000-0000-4000-8000-000000000201" };
    const state = timerReducer(initialTimerState, {
      type: "bootstrapped",
      snapshot: { kind: "conflict", user, projects: [project], localStart: start, serverRunning: server },
    });
    expect(state).toEqual({
      kind: "conflict",
      user,
      projects: [project],
      localStart: start,
      serverRunning: server,
      error: undefined,
    });
  });

  it("keeps pending queue status after a retry reports remaining work", () => {
    const pending = { kind: "pending-sync", user, projects: [project], pendingCount: 2, message: "Queued" } as const;
    expect(timerReducer(pending, { type: "pending-retried", remaining: 1 })).toEqual({
      kind: "pending-sync",
      user,
      projects: [project],
      pendingCount: 1,
      message: "1 stop waiting to sync",
    });
  });

  it("keeps pending sync active while surfacing a retry failure", () => {
    const pending = { kind: "pending-sync", user, projects: [project], pendingCount: 1, message: "Queued" } as const;
    expect(timerReducer(pending, { type: "pending-retry-failed", message: "Still offline" })).toEqual({
      ...pending,
      error: "Still offline",
    });
  });
});

describe("suggested start", () => {
  const suggestion = { projectId: project.id, source: "codex", since: "2026-08-06T14:58:00.000Z" };
  const idle = { kind: "idle", user, projects: [project] } as const;

  it("raises a suggestion only while the timer is idle", () => {
    expect(timerReducer(idle, { type: "suggestion-received", suggestion })).toEqual({ ...idle, suggestion });

    const active = { kind: "running", user, projects: [project], running } as const;
    expect(timerReducer(active, { type: "suggestion-received", suggestion })).toBe(active);

    const starting = { kind: "starting", user, projects: [project], start } as const;
    expect(timerReducer(starting, { type: "suggestion-received", suggestion })).toBe(starting);
  });

  it("treats a repeat poll of the same suggestion as a no-op", () => {
    const raised = timerReducer(idle, { type: "suggestion-received", suggestion });
    expect(timerReducer(raised, { type: "suggestion-received", suggestion })).toBe(raised);

    const moved = { projectId: project.id, source: "codex", since: "2026-08-06T15:05:00.000Z" };
    expect(timerReducer(raised, { type: "suggestion-received", suggestion: moved })).toEqual({ ...idle, suggestion: moved });
  });

  it("dismisses a suggestion and stays dismissed across polls without one", () => {
    const raised = timerReducer(idle, { type: "suggestion-received", suggestion });
    expect(timerReducer(raised, { type: "suggestion-cleared" })).toEqual(idle);
    expect(timerReducer(idle, { type: "suggestion-cleared" })).toBe(idle);
  });

  it("confirms a suggestion through the normal start flow, dropping the prompt", () => {
    const raised = timerReducer(idle, { type: "suggestion-received", suggestion });
    const starting = timerReducer(raised, { type: "start-requested", start });
    expect(starting).toEqual({ kind: "starting", user, projects: [project], start });
    expect(timerReducer(starting, { type: "start-confirmed", running })).toEqual({
      kind: "running",
      user,
      projects: [project],
      running,
    });
  });
});

describe("away prompt", () => {
  const away = { startedAt: "2026-08-06T15:20:00.000Z", seconds: 1_500, exceedsHardLimit: false };
  const active = { kind: "running", user, projects: [project], running } as const;

  it("raises an away prompt on return and only while running", () => {
    expect(timerReducer(active, { type: "away-detected", away })).toEqual({ ...active, away });

    const idle = { kind: "idle", user, projects: [project] } as const;
    expect(timerReducer(idle, { type: "away-detected", away })).toBe(idle);
  });

  it("keeps the recorded decision when the same span is polled again", () => {
    const raised = timerReducer(active, { type: "away-detected", away });
    const kept = timerReducer(raised, { type: "away-answered", decision: "keep" });
    expect(kept).toEqual({ ...active, away: { ...away, decision: "keep" } });
    expect(timerReducer(kept, { type: "away-detected", away })).toBe(kept);
  });

  it("re-raises unanswered when a new away span completes", () => {
    const raised = timerReducer(active, { type: "away-detected", away });
    const discarded = timerReducer(raised, { type: "away-answered", decision: "discard" });
    const next = { startedAt: "2026-08-06T16:10:00.000Z", seconds: 600, exceedsHardLimit: false };
    expect(timerReducer(discarded, { type: "away-detected", away: next })).toEqual({ ...active, away: next });
  });

  it("ignores answers when there is no open prompt or it was already answered", () => {
    expect(timerReducer(active, { type: "away-answered", decision: "keep" })).toBe(active);
    const raised = timerReducer(active, { type: "away-detected", away });
    const answered = timerReducer(raised, { type: "away-answered", decision: "discard" });
    expect(timerReducer(answered, { type: "away-answered", decision: "keep" })).toBe(answered);
  });
});

describe("stopIdleSeconds", () => {
  const away = { startedAt: "2026-08-06T15:20:00.000Z", seconds: 1_500, exceedsHardLimit: false };

  it("lets the host measure unless the user chose to keep the away span", () => {
    expect(stopIdleSeconds(undefined, 2_100)).toBeNull();
    expect(stopIdleSeconds(away, 2_100)).toBeNull();
    expect(stopIdleSeconds({ ...away, decision: "discard" }, 2_100)).toBeNull();
  });

  it("excludes the kept away span from the measured idle trim", () => {
    expect(stopIdleSeconds({ ...away, decision: "keep" }, 2_100)).toBe(600);
  });

  it("clamps at zero and falls back to host measurement without a reading", () => {
    // Keep with no other idle: an explicit, authoritative 0 — the host must
    // not re-measure and flip the decision.
    expect(stopIdleSeconds({ ...away, decision: "keep" }, 900)).toBe(0);
    expect(stopIdleSeconds({ ...away, decision: "keep" }, null)).toBeNull();
    expect(stopIdleSeconds({ ...away, decision: "keep" }, undefined)).toBeNull();
  });
});
