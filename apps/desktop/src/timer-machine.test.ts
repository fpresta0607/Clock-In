import { describe, expect, it } from "vitest";

import { initialTimerState, timerReducer } from "./timer-machine.js";

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
});
