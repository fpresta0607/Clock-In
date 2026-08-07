import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type { TimerBridge } from "./bridge.js";

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

const accountB = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "timer-b@example.com",
  name: "Timer User B",
};

const projectB = {
  id: "00000000-0000-4000-8000-000000000011",
  name: "Account B work",
  color: "#8b9d76",
};

const startB = {
  clientId: "00000000-0000-4000-8000-000000000101",
  projectId: projectB.id,
  description: "Account B recovery",
  startedAt: "2026-08-06T15:01:00.000Z",
};

const deferred = <Value,>() => {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const bridgeFor = (overrides: Partial<TimerBridge> = {}): TimerBridge => ({
  bootstrap: vi.fn().mockResolvedValue({ kind: "idle", user, projects: [project] }),
  login: vi.fn().mockResolvedValue({ kind: "idle", user, projects: [project] }),
  signup: vi.fn().mockResolvedValue({ kind: "idle", user, projects: [project] }),
  logout: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(running),
  stop: vi.fn().mockResolvedValue(undefined),
  retryPending: vi.fn().mockResolvedValue({ remaining: 0 }),
  useServerTimer: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "server-only" }),
  retryLocalStart: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "local-server-match" }),
  orgOverview: vi.fn().mockResolvedValue({
    organization: { id: "00000000-0000-4000-8000-000000000900", name: "SIQstack", inviteCode: "ACDEF-GHJKM" },
    entries: [
      { rank: 1, user: { id: "b1c7e513-b094-4d4c-ae55-21790ae019a4", name: "Sam" }, durationSeconds: 7_200, sessionCount: 3 },
      { rank: 2, user: { id: user.id, name: user.name }, durationSeconds: 3_600, sessionCount: 1 },
    ],
  }),
  ...overrides,
});

afterEach(() => vi.useRealTimers());

describe("App", () => {
  it("shows a labelled sign-in form after signed-out bootstrap", async () => {
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) })} />);

    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  it("shows sign-in loading and an actionable login error", async () => {
    let rejectLogin: (reason: unknown) => void = () => undefined;
    const login = vi.fn().mockImplementation(
      () => new Promise((_, reject: (reason: unknown) => void) => { rejectLogin = reject; }),
    );
    const bridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), login });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await screen.findByRole("heading", { name: "Clock in" });
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    rejectLogin({ kind: "auth", message: "Incorrect email or password" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password");
  });

  it("renders active projects and starts from the selected project", async () => {
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await screen.findByRole("option", { name: "Field work" });
    await person.selectOptions(screen.getByLabelText("Project"), project.id);
    await person.type(screen.getByLabelText("Description"), "Inspect relay");
    await person.click(screen.getByRole("button", { name: "Start timer" }));
    await waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Stop timer" })).toBeVisible();
  });

  it("disables duplicate starts while the optimistic start is unconfirmed", async () => {
    const startRequest = new Promise<typeof running>(() => undefined);
    const bridge = bridgeFor({ start: vi.fn().mockReturnValue(startRequest) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await screen.findByRole("option", { name: "Field work" });
    await person.selectOptions(screen.getByLabelText("Project"), project.id);
    await person.click(screen.getByRole("button", { name: "Start timer" }));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(bridge.start).toHaveBeenCalledTimes(1);
  });

  it("updates the running elapsed readout from its persisted startedAt basis", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-06T15:00:05.000Z"));
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "local-server-match" }),
    });
    render(<App bridge={bridge} />);
    expect(await screen.findByTestId("elapsed-time")).toHaveTextContent("00:00:05");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(screen.getByTestId("elapsed-time")).toHaveTextContent("00:00:07");
  });

  it("stops with a timestamp and zero idle seconds", async () => {
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "server-only" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await person.click(await screen.findByRole("button", { name: "Stop timer" }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalledWith({
      sessionId: running.sessionId,
      stoppedAt: expect.stringMatching(/Z$/),
      idleSeconds: 0,
    }));
    expect(await screen.findByRole("button", { name: "Start timer" })).toBeVisible();
  });

  it("removes the running timer and exposes pending sync retry after transient stop failure", async () => {
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "server-only" }),
      stop: vi.fn().mockRejectedValue({ kind: "transient", message: "Saved locally; will retry" }),
      retryPending: vi.fn().mockResolvedValue({ remaining: 1 }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await person.click(await screen.findByRole("button", { name: "Stop timer" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved locally; will retry");
    expect(screen.queryByTestId("elapsed-time")).not.toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Retry sync" }));
    await waitFor(() => expect(bridge.retryPending).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("1 stop waiting to sync");
  });

  it("presents recovery conflict actions without discarding local or server state", async () => {
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "conflict", user, projects: [project], localStart: start, serverRunning: running }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    expect(await screen.findByRole("heading", { name: "Timer needs reconciliation" })).toBeVisible();
    expect(screen.getByText("Inspect relay")).toBeVisible();
    await person.click(screen.getByRole("button", { name: "Use server timer" }));
    await waitFor(() => expect(bridge.useServerTimer).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("elapsed-time")).toBeVisible();
  });

  it("returns to sign-in when bootstrap reports an expired session", async () => {
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockRejectedValue({ kind: "auth", message: "Session expired" }) })} />);
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Session expired");
  });

  it("automatically retries a bootstrap local start and adopts the returned snapshot", async () => {
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "retry-local-start", user, projects: [project], start }),
      retryLocalStart: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "local-server-match" }),
    });
    render(<App bridge={bridge} />);
    await waitFor(() => expect(bridge.retryLocalStart).toHaveBeenCalledWith(start));
    expect(bridge.retryLocalStart).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("elapsed-time")).toBeVisible();
  });

  it("deduplicates a retry-local-start command while returning from bridge B to bridge A", async () => {
    const retry = deferred<Awaited<ReturnType<TimerBridge["retryLocalStart"]>>>();
    const firstBridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "retry-local-start", user, projects: [project], start }),
      retryLocalStart: vi.fn().mockReturnValue(retry.promise),
    });
    const secondBridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) });
    const view = render(<App bridge={firstBridge} />);
    await waitFor(() => expect(firstBridge.retryLocalStart).toHaveBeenCalledWith(start));
    view.rerender(<App bridge={secondBridge} />);
    await screen.findByRole("heading", { name: "Clock in" });
    view.rerender(<App bridge={firstBridge} />);
    expect(firstBridge.retryLocalStart).toHaveBeenCalledTimes(1);
    retry.resolve({ kind: "running", user, projects: [project], running, source: "local-server-match" });
    expect(await screen.findByTestId("elapsed-time")).toBeVisible();
  });

  it("deduplicates recovery commands during StrictMode replay", async () => {
    const retry = deferred<Awaited<ReturnType<TimerBridge["retryLocalStart"]>>>();
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "retry-local-start", user, projects: [project], start }),
      retryLocalStart: vi.fn().mockReturnValue(retry.promise),
    });
    render(<StrictMode><App bridge={bridge} /></StrictMode>);
    await waitFor(() => expect(bridge.retryLocalStart).toHaveBeenCalledWith(start));
    expect(bridge.retryLocalStart).toHaveBeenCalledTimes(1);
  });

  it("automatically retries a login local start and returns idle with an error when it fails", async () => {
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }),
      login: vi.fn().mockResolvedValue({ kind: "retry-local-start", user, projects: [project], start }),
      retryLocalStart: vi.fn().mockRejectedValue({ kind: "validation", message: "Local start cannot be resumed" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await screen.findByRole("heading", { name: "Clock in" });
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(bridge.retryLocalStart).toHaveBeenCalledWith(start));
    expect(await screen.findByRole("heading", { name: "Start a timer" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Local start cannot be resumed");
  });

  it("uses one bootstrap request during StrictMode effect replay", async () => {
    const bridge = bridgeFor();
    render(<StrictMode><App bridge={bridge} /></StrictMode>);
    await screen.findByRole("heading", { name: "Start a timer" });
    expect(bridge.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale bootstrap result after the bridge is replaced", async () => {
    const first = deferred<Awaited<ReturnType<TimerBridge["bootstrap"]>>>();
    const firstBridge = bridgeFor({ bootstrap: vi.fn().mockReturnValue(first.promise) });
    const secondBridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) });
    const view = render(<App bridge={firstBridge} />);
    view.rerender(<App bridge={secondBridge} />);
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    first.resolve({ kind: "idle", user, projects: [project] });
    await Promise.resolve();
    expect(screen.getByRole("heading", { name: "Clock in" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Field work" })).not.toBeInTheDocument();
  });

  it("reuses an in-flight bootstrap promise when a prior bridge is restored", () => {
    const first = deferred<Awaited<ReturnType<TimerBridge["bootstrap"]>>>();
    const second = deferred<Awaited<ReturnType<TimerBridge["bootstrap"]>>>();
    const firstBridge = bridgeFor({ bootstrap: vi.fn().mockReturnValue(first.promise) });
    const secondBridge = bridgeFor({ bootstrap: vi.fn().mockReturnValue(second.promise) });
    const view = render(<App bridge={firstBridge} />);
    view.rerender(<App bridge={secondBridge} />);
    view.rerender(<App bridge={firstBridge} />);
    expect(firstBridge.bootstrap).toHaveBeenCalledTimes(1);
    expect(secondBridge.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("disables pending-sync retry while its request is in flight", async () => {
    const request = deferred<{ remaining: number }>();
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "pending-sync", user, projects: [project], pendingCount: 1 }),
      retryPending: vi.fn().mockReturnValue(request.promise),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    const retry = await screen.findByRole("button", { name: "Retry sync" });
    await person.click(retry);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    await person.click(screen.getByRole("button", { name: "Retrying…" }));
    expect(bridge.retryPending).toHaveBeenCalledTimes(1);
    request.resolve({ remaining: 1 });
    expect(await screen.findByRole("button", { name: "Retry sync" })).toBeEnabled();
  });

  it("disables competing conflict actions while resolving one choice", async () => {
    const request = deferred<Awaited<ReturnType<TimerBridge["useServerTimer"]>>>();
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "conflict", user, projects: [project], localStart: start, serverRunning: running }),
      useServerTimer: vi.fn().mockReturnValue(request.promise),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await person.click(await screen.findByRole("button", { name: "Use server timer" }));
    expect(screen.getByRole("button", { name: "Resolving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry local start" })).toBeDisabled();
    await person.click(screen.getByRole("button", { name: "Retry local start" }));
    expect(bridge.useServerTimer).toHaveBeenCalledTimes(1);
    expect(bridge.retryLocalStart).not.toHaveBeenCalled();
    request.resolve({ kind: "running", user, projects: [project], running, source: "server-only" });
    expect(await screen.findByTestId("elapsed-time")).toBeVisible();
  });

  it("freezes elapsed time at the captured stop timestamp while stopping", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-06T15:00:05.000Z"));
    const stop = deferred<void>();
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "server-only" }),
      stop: vi.fn().mockReturnValue(stop.promise),
    });
    const person = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App bridge={bridge} />);
    expect(await screen.findByTestId("elapsed-time")).toHaveTextContent("00:00:05");
    await person.click(screen.getByRole("button", { name: "Stop timer" }));
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(screen.getByTestId("elapsed-time")).toHaveTextContent("00:00:05");
  });

  it("does not let a stale start completion overwrite a replacement bridge", async () => {
    const request = deferred<typeof running>();
    const firstBridge = bridgeFor({ start: vi.fn().mockReturnValue(request.promise) });
    const secondBridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) });
    const person = userEvent.setup();
    const view = render(<App bridge={firstBridge} />);
    await person.selectOptions(await screen.findByLabelText("Project"), project.id);
    await person.click(screen.getByRole("button", { name: "Start timer" }));
    view.rerender(<App bridge={secondBridge} />);
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    request.resolve(running);
    await Promise.resolve();
    expect(screen.getByRole("heading", { name: "Clock in" })).toBeVisible();
  });

  it("ignores a stale stop completion after bridge replacement", async () => {
    const request = deferred<void>();
    const firstBridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "server-only" }),
      stop: vi.fn().mockReturnValue(request.promise),
    });
    const secondBridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) });
    const person = userEvent.setup();
    const view = render(<App bridge={firstBridge} />);
    await person.click(await screen.findByRole("button", { name: "Stop timer" }));
    view.rerender(<App bridge={secondBridge} />);
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    request.resolve(undefined);
    await Promise.resolve();
    expect(screen.getByRole("heading", { name: "Clock in" })).toBeVisible();
  });

  it("disables duplicate logout attempts and retains the account on a current failure", async () => {
    const request = deferred<void>();
    const bridge = bridgeFor({ logout: vi.fn().mockReturnValue(request.promise) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    const logout = await screen.findByRole("button", { name: "Log out" });
    await person.click(logout);
    expect(screen.getByRole("button", { name: "Logging out…" })).toBeDisabled();
    await person.click(screen.getByRole("button", { name: "Logging out…" }));
    expect(bridge.logout).toHaveBeenCalledTimes(1);
    request.reject({ kind: "transient", message: "Unable to sign out right now" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to sign out right now");
    expect(screen.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  });

  it("allows a pending start to settle when logout fails", async () => {
    const startRequest = deferred<typeof running>();
    const logoutRequest = deferred<void>();
    const bridge = bridgeFor({
      start: vi.fn().mockReturnValue(startRequest.promise),
      logout: vi.fn().mockReturnValue(logoutRequest.promise),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await person.selectOptions(await screen.findByLabelText("Project"), project.id);
    await person.click(screen.getByRole("button", { name: "Start timer" }));
    await person.click(screen.getByRole("button", { name: "Log out" }));
    logoutRequest.reject({ kind: "transient", message: "Unable to sign out right now" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to sign out right now");
    startRequest.resolve(running);
    expect(await screen.findByRole("button", { name: "Stop timer" })).toBeVisible();
  });

  it("ignores a logout failure after unmount", async () => {
    const request = deferred<void>();
    const bridge = bridgeFor({ logout: vi.fn().mockReturnValue(request.promise) });
    const person = userEvent.setup();
    const view = render(<App bridge={bridge} />);
    await person.click(await screen.findByRole("button", { name: "Log out" }));
    view.unmount();
    request.reject({ kind: "transient", message: "Unable to sign out right now" });
    await Promise.resolve();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("does not let an account A start completion confirm account B recovery on the same bridge", async () => {
    const accountAStart = deferred<typeof running>();
    const accountBRecovery = deferred<Awaited<ReturnType<TimerBridge["retryLocalStart"]>>>();
    const bridge = bridgeFor({
      start: vi.fn().mockReturnValue(accountAStart.promise),
      login: vi.fn().mockResolvedValue({ kind: "retry-local-start", user: accountB, projects: [projectB], start: startB }),
      retryLocalStart: vi.fn().mockImplementation((intent) => intent.clientId === startB.clientId ? accountBRecovery.promise : Promise.resolve({ kind: "running", user, projects: [project], running, source: "local-server-match" })),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await person.selectOptions(await screen.findByLabelText("Project"), project.id);
    await person.click(screen.getByRole("button", { name: "Start timer" }));
    await person.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    await person.type(screen.getByLabelText("Email"), accountB.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(bridge.retryLocalStart).toHaveBeenCalledWith(startB));
    accountAStart.resolve(running);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop timer" })).not.toBeInTheDocument();
  });

  it("clears account-bound form values before account B can start account A's project", async () => {
    const bridge = bridgeFor({
      login: vi.fn().mockResolvedValue({ kind: "idle", user: accountB, projects: [projectB] }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await person.selectOptions(await screen.findByLabelText("Project"), project.id);
    await person.type(screen.getByLabelText("Description"), "Account A work");
    await person.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveValue("");
    await person.type(screen.getByLabelText("Email"), accountB.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("option", { name: "Account B work" })).toBeVisible();
    expect(screen.getByLabelText("Project")).toHaveValue("");
    expect(screen.getByLabelText("Description")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Start timer" })).toBeDisabled();
    await person.click(screen.getByRole("button", { name: "Start timer" }));
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("retries a persisted local start after its prior recovery request fails", async () => {
    const firstBridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "retry-local-start", user, projects: [project], start }),
      retryLocalStart: vi.fn()
        .mockRejectedValueOnce({ kind: "transient", message: "Service unavailable" })
        .mockResolvedValueOnce({ kind: "running", user, projects: [project], running, source: "local-server-match" }),
    });
    const signedOutBridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) });
    const view = render(<App bridge={firstBridge} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Service unavailable");
    expect(firstBridge.retryLocalStart).toHaveBeenCalledTimes(1);
    view.rerender(<App bridge={signedOutBridge} />);
    await screen.findByRole("heading", { name: "Clock in" });
    view.rerender(<App bridge={firstBridge} />);
    expect(await screen.findByTestId("elapsed-time")).toBeVisible();
    expect(firstBridge.retryLocalStart).toHaveBeenCalledTimes(2);
  });

  it("keeps pending sync visible and announces a non-auth retry failure", async () => {
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "pending-sync", user, projects: [project], pendingCount: 1 }),
      retryPending: vi.fn().mockRejectedValue({ kind: "transient", message: "Still offline" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await person.click(await screen.findByRole("button", { name: "Retry sync" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Still offline");
    expect(screen.getByRole("status")).toHaveTextContent("1 stop waiting to sync");
  });

  it("submits the sign-in form with Tab and Enter", async () => {
    const login = vi.fn().mockResolvedValue({ kind: "idle", user, projects: [project] });
    const bridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), login });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await person.type(await screen.findByLabelText("Email"), user.email);
    await person.tab();
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.keyboard("{Enter}");
    await waitFor(() => expect(login).toHaveBeenCalledWith({ email: user.email, password: "not-stored-here" }));
  });

  it("creates an account from the sign-up form and lands on the timer", async () => {
    const signup = vi.fn().mockResolvedValue({ kind: "idle", user, projects: [project] });
    const bridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), signup });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "New here? Create an account" }));
    await person.type(screen.getByLabelText("Name"), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signup).toHaveBeenCalledWith({
      email: user.email,
      password: "long-enough-password",
      name: "Alex Morgan",
    }));
    expect(await screen.findByRole("heading", { name: "Start a timer" })).toBeInTheDocument();
  });

  it("shows an actionable error when the email is already registered", async () => {
    const signup = vi.fn().mockRejectedValue({
      kind: "validation",
      message: "That email already has an account. Sign in instead.",
    });
    const bridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), signup });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "New here? Create an account" }));
    await person.type(screen.getByLabelText("Name"), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in instead");
  });

  it("switches back to sign-in without carrying the typed password over", async () => {
    const bridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "New here? Create an account" }));
    await person.type(screen.getByLabelText("Password"), "typed-while-signing-up");
    await person.click(screen.getByRole("button", { name: "Already have an account? Sign in" }));

    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the team leaderboard with the signed-in member marked", async () => {
    render(<App bridge={bridgeFor()} />);

    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    const rows = await screen.findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Sam");
    expect(rows[0]).toHaveTextContent("02:00:00");
    expect(rows[1]).toHaveTextContent(user.name);
    expect(rows[1]).toHaveTextContent("you");
  });

  it("shows the invite code a teammate needs to join", async () => {
    render(<App bridge={bridgeFor()} />);

    expect(await screen.findByText("ACDEF-GHJKM")).toBeInTheDocument();
  });

  it("shows at most five members so the window stays compact", async () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({
      rank: index + 1,
      user: { id: `00000000-0000-4000-8000-00000000090${index}`, name: `Member ${index}` },
      durationSeconds: 9_000 - index * 100,
      sessionCount: 1,
    }));
    const bridge = bridgeFor({
      orgOverview: vi.fn().mockResolvedValue({
        organization: { id: "00000000-0000-4000-8000-000000000900", name: "SIQstack", inviteCode: "ACDEF-GHJKM" },
        entries,
      }),
    });
    render(<App bridge={bridge} />);

    await screen.findByRole("heading", { name: "SIQstack" });
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("invites a teammate into an existing workspace at sign-up", async () => {
    const signup = vi.fn().mockResolvedValue({ kind: "idle", user, projects: [project] });
    const bridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), signup });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "New here? Create an account" }));
    await person.type(screen.getByLabelText(/Name/), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.type(screen.getByLabelText(/Invite code/), "  acdef-ghjkm ");
    await person.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signup).toHaveBeenCalledWith({
      email: user.email,
      password: "long-enough-password",
      name: "Alex Morgan",
      inviteCode: "acdef-ghjkm",
    }));
  });

  it("omits the invite code entirely when none is typed", async () => {
    const signup = vi.fn().mockResolvedValue({ kind: "idle", user, projects: [project] });
    const bridge = bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), signup });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "New here? Create an account" }));
    await person.type(screen.getByLabelText(/Name/), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.type(screen.getByLabelText(/Invite code/), "   ");
    await person.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signup).toHaveBeenCalledWith({
      email: user.email,
      password: "long-enough-password",
      name: "Alex Morgan",
    }));
  });

  it("keeps the timer usable when the leaderboard cannot be read", async () => {
    const bridge = bridgeFor({
      orgOverview: vi.fn().mockRejectedValue({ kind: "transient", message: "Board unavailable" }),
    });
    render(<App bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "Start a timer" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "SIQstack" })).not.toBeInTheDocument();
  });
});
