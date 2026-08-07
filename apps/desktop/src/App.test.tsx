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
  logout: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(running),
  stop: vi.fn().mockResolvedValue(undefined),
  retryPending: vi.fn().mockResolvedValue({ remaining: 0 }),
  useServerTimer: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "server-only" }),
  retryLocalStart: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "local-server-match" }),
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
});
