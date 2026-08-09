import { StrictMode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type { TimerBridge } from "./bridge.js";

vi.mock("./WebGLShader.js", () => ({ WebGLShader: () => null }));

const windowControls = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowControls }));

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

const newProject = {
  id: "00000000-0000-4000-8000-000000000012",
  name: "Client work",
  color: null,
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

const monitorSettings = {
  enabled: true,
  awayThresholdMinutes: 10,
  hardAwayLimitMinutes: 60,
  autoStopOnLock: false,
  agentOverrideEnabled: true,
  onboarded: true,
  deviceId: "00000000-0000-4000-8000-000000000300",
};

const idleMonitorStatus = {
  enabled: true,
  running: true,
  lastUploadAt: "2026-08-06T14:55:00.000Z",
  segmentBacklog: 0,
  agentBacklog: 0,
  hooks: [
    { source: "claude_code", detected: true, installed: true, configPath: "C:/Users/dev/.claude/settings.json" },
    { source: "codex", detected: false, installed: true, configPath: "C:/Users/dev/.codex/config.toml" },
  ],
  browsers: [] as { browser: string; label: string; state: string; storeUrl: string }[],
  pendingSuggestion: null,
  agentActive: null,
  sessionIdleSeconds: null,
  away: null,
};

const meStats = {
  filters: {},
  totalDurationSeconds: 7_200,
  corroboratedSeconds: 5_400,
  projects: [
    { project: { id: project.id, name: project.name }, durationSeconds: 7_200, corroboratedSeconds: 5_400, sessionCount: 3 },
  ],
  apps: [
    { processName: "Code.exe", durationSeconds: 4_800 },
    { processName: "chrome.exe", durationSeconds: 1_200 },
  ],
  sites: [],
};

const mapping = {
  id: "00000000-0000-4000-8000-000000000400",
  kind: "path_prefix" as const,
  pathPrefix: "C:/dev/Clock-In",
  repoUrl: null,
  projectId: project.id,
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
  orgJoin: vi.fn().mockResolvedValue({
    organization: { id: "00000000-0000-4000-8000-000000000901", name: "Joined Team", inviteCode: "PQRTU-VWXY3" },
    entries: [{ rank: 1, user: { id: user.id, name: user.name }, durationSeconds: 0, sessionCount: 0 }],
  }),
  // The default is "monitoring unsupported": every monitor surface stays
  // hidden, which is what the legacy tests above implicitly rely on.
  monitorStatus: vi.fn().mockRejectedValue({ kind: "unknown", message: "Monitoring unavailable" }),
  hookRegister: vi.fn().mockResolvedValue({ status: "registered", configPath: "C:/Users/dev/.claude/settings.json" }),
  browserRepair: vi.fn().mockResolvedValue({ browser: "chrome", label: "Chrome", state: "registered", storeUrl: "https://chromewebstore.google.com/" }),
  browserOpenStorePage: vi.fn().mockResolvedValue(undefined),
  suggestionsList: vi.fn().mockResolvedValue([]),
  suggestionNeverSuggest: vi.fn().mockResolvedValue(undefined),
  suggestionsClear: vi.fn().mockResolvedValue(undefined),
  monitorSetEnabled: vi.fn().mockResolvedValue(monitorSettings),
  monitorDismissSuggestion: vi.fn().mockResolvedValue(undefined),
  settingsGet: vi.fn().mockResolvedValue(monitorSettings),
  settingsUpdate: vi.fn().mockResolvedValue(monitorSettings),
  meStats: vi.fn().mockResolvedValue(meStats),
  projectCreate: vi.fn().mockResolvedValue(newProject),
  pathMappingsList: vi.fn().mockResolvedValue([mapping]),
  pathMappingsCreate: vi.fn().mockResolvedValue(mapping),
  pathMappingsUpdate: vi.fn().mockResolvedValue(mapping),
  pathMappingsDelete: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

/// Opens the settings overlay from the titlebar gear and returns the dialog.
const openSettings = async (person: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await person.click(await screen.findByRole("button", { name: "Settings" }));
  return screen.getByRole("dialog", { name: "Settings" });
};

/// Opens the Advanced disclosure inside an open settings dialog.
const openAdvanced = async (person: ReturnType<typeof userEvent.setup>, dialog: HTMLElement): Promise<void> => {
  await person.click(within(dialog).getByRole("button", { name: "Advanced" }));
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("App", () => {
  it("shows a labelled sign-in form after signed-out bootstrap", async () => {
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) })} />);

    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  it("shows window controls but no settings gear on the sign-in screen", async () => {
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) })} />);

    await screen.findByRole("heading", { name: "Clock in" });
    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("wires the titlebar window controls to the current window", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    await person.click(await screen.findByRole("button", { name: "Minimize" }));
    expect(windowControls.minimize).toHaveBeenCalledTimes(1);
    await person.click(screen.getByRole("button", { name: "Maximize" }));
    expect(windowControls.toggleMaximize).toHaveBeenCalledTimes(1);
    await person.click(screen.getByRole("button", { name: "Close" }));
    expect(windowControls.close).toHaveBeenCalledTimes(1);
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
    await person.type(screen.getByLabelText(/Description/), "Inspect relay");
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

  it("creates a project from the start form and selects it", async () => {
    const bridge = bridgeFor({
      bootstrap: vi.fn()
        .mockResolvedValueOnce({ kind: "idle", user, projects: [project] })
        .mockResolvedValue({ kind: "idle", user, projects: [project, newProject] }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await screen.findByRole("option", { name: "Field work" });
    await person.click(screen.getByRole("button", { name: "New project…" }));
    const nameInput = screen.getByLabelText("New project name");
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    await person.type(nameInput, "  Client work  ");
    await person.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(bridge.projectCreate).toHaveBeenCalledWith({ name: "Client work" }));
    expect(await screen.findByRole("option", { name: "Client work" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue(newProject.id));
    expect(screen.queryByLabelText("New project name")).not.toBeInTheDocument();
  });

  it("keeps the start form usable when project creation fails", async () => {
    const bridge = bridgeFor({
      projectCreate: vi.fn().mockRejectedValue({ kind: "validation", message: "Project names must be 1 to 80 characters." }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await screen.findByRole("option", { name: "Field work" });
    await person.click(screen.getByRole("button", { name: "New project…" }));
    await person.type(screen.getByLabelText("New project name"), "Client work");
    await person.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("1 to 80 characters");
    // The inline form stays open and no account refresh was attempted.
    expect(screen.getByLabelText("New project name")).toBeInTheDocument();
    expect(bridge.bootstrap).toHaveBeenCalledTimes(1);
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

  it("stops with a timestamp and no UI-decided idle figure", async () => {
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "server-only" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);
    await person.click(await screen.findByRole("button", { name: "Stop timer" }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalledWith({
      sessionId: running.sessionId,
      stoppedAt: expect.stringMatching(/Z$/),
      idleSeconds: null,
    }));
    expect(await screen.findByRole("button", { name: "Start timer" })).toBeVisible();
  });

  it("switches projects while running: stops the session, then starts the new project", async () => {
    const switched = { ...start, projectId: projectB.id, sessionId: "00000000-0000-4000-8000-000000000201" };
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project, projectB], running, source: "server-only" }),
      start: vi.fn().mockResolvedValue(switched),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const picker = await screen.findByLabelText("Project");
    expect(picker).toHaveValue(project.id);
    await person.selectOptions(picker, projectB.id);

    await waitFor(() => expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: projectB.id,
      description: "",
    })));
    expect(bridge.stop).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: running.sessionId,
      idleSeconds: null,
    }));
    const stopOrder = vi.mocked(bridge.stop).mock.invocationCallOrder[0] ?? 0;
    const startOrder = vi.mocked(bridge.start).mock.invocationCallOrder[0] ?? 0;
    expect(stopOrder).toBeLessThan(startOrder);
    expect(await screen.findByText("Recording · Account B work")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toHaveValue(projectB.id);
  });

  it("refreshes today's stats after a mid-timer project switch", async () => {
    const switched = { ...start, projectId: projectB.id, sessionId: "00000000-0000-4000-8000-000000000201" };
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project, projectB], running, source: "server-only" }),
      start: vi.fn().mockResolvedValue(switched),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await waitFor(() => expect(bridge.meStats).toHaveBeenCalledTimes(1));
    // The board lives in settings now, so nothing fetches it on the main screen.
    expect(bridge.orgOverview).not.toHaveBeenCalled();
    await person.selectOptions(await screen.findByLabelText("Project"), projectB.id);

    await waitFor(() => expect(bridge.meStats).toHaveBeenCalledTimes(2));
    await openSettings(person);
    await waitFor(() => expect(bridge.orgOverview).toHaveBeenCalledTimes(1));
  });

  it("aborts the project switch when the stop fails", async () => {
    const bridge = bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project, projectB], running, source: "server-only" }),
      stop: vi.fn().mockRejectedValue({ kind: "unknown", message: "Stop failed" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.selectOptions(await screen.findByLabelText("Project"), projectB.id);

    expect(await screen.findByRole("alert")).toHaveTextContent("Stop failed");
    expect(bridge.start).not.toHaveBeenCalled();
    expect(screen.getByText("Recording · Field work")).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "We found two timers - pick one to keep" })).toBeVisible();
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

  it("keeps authorization recovery blocked instead of showing signed-out state", async () => {
    render(<App bridge={bridgeFor({
      bootstrap: vi.fn().mockRejectedValue({ kind: "unknown", message: "Could not disable browser attribution." }),
    })} />);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not disable browser attribution."));
    expect(screen.queryByRole("heading", { name: "Clock in" })).not.toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "What are you working on?" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Local start cannot be resumed");
  });

  it("uses one bootstrap request during StrictMode effect replay", async () => {
    const bridge = bridgeFor();
    render(<StrictMode><App bridge={bridge} /></StrictMode>);
    await screen.findByRole("heading", { name: "What are you working on?" });
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
    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByRole("button", { name: "Log out" }));
    expect(within(dialog).getByRole("button", { name: "Logging out…" })).toBeDisabled();
    await person.click(within(dialog).getByRole("button", { name: "Logging out…" }));
    expect(bridge.logout).toHaveBeenCalledTimes(1);
    request.reject({ kind: "transient", message: "Unable to sign out right now" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to sign out right now");
    expect(screen.getByRole("heading", { name: "What are you working on?" })).toBeInTheDocument();
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
    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByRole("button", { name: "Log out" }));
    logoutRequest.reject({ kind: "transient", message: "Unable to sign out right now" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to sign out right now");
    startRequest.resolve(running);
    expect(await screen.findByRole("button", { name: "Stop timer" })).toBeInTheDocument();
  });

  it("ignores a logout failure after unmount", async () => {
    const request = deferred<void>();
    const bridge = bridgeFor({ logout: vi.fn().mockReturnValue(request.promise) });
    const person = userEvent.setup();
    const view = render(<App bridge={bridge} />);
    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByRole("button", { name: "Log out" }));
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
    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByRole("button", { name: "Log out" }));
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
    await person.type(screen.getByLabelText(/Description/), "Account A work");
    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveValue("");
    await person.type(screen.getByLabelText("Email"), accountB.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("option", { name: "Account B work" })).toBeVisible();
    expect(screen.getByLabelText("Project")).toHaveValue("");
    expect(screen.getByLabelText(/Description/)).toHaveValue("");
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
    expect(await screen.findByRole("heading", { name: "What are you working on?" })).toBeInTheDocument();
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

  it("shows the team leaderboard in settings with the signed-in member marked", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const dialog = await openSettings(person);
    const rows = await within(dialog).findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Sam");
    expect(rows[0]).toHaveTextContent("02:00:00");
    expect(rows[1]).toHaveTextContent(user.name);
    expect(rows[1]).toHaveTextContent("you");
  });

  it("keeps invite codes and join forms off the main screen", async () => {
    render(<App bridge={bridgeFor()} />);

    await screen.findByRole("heading", { name: "What are you working on?" });
    await waitFor(() => expect(screen.queryByText("ACDEF-GHJKM")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Invite code to join/)).not.toBeInTheDocument();
    // The idle hero offers exactly one primary action.
    expect(screen.getAllByRole("button").filter((button) => button.className.includes("signal-button"))).toHaveLength(1);

    const person = userEvent.setup();
    const dialog = await openSettings(person);
    expect(await within(dialog).findByText("ACDEF-GHJKM")).toBeInTheDocument();
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
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    expect((await within(dialog).findAllByRole("listitem"))).toHaveLength(5);
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
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    expect(await screen.findByRole("heading", { name: "What are you working on?" })).toBeInTheDocument();
    const dialog = await openSettings(person);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Board unavailable");
  });

  it("joins a teammate's workspace from settings", async () => {
    const orgJoin = vi.fn().mockResolvedValue({
      organization: { id: "00000000-0000-4000-8000-000000000901", name: "Joined Team", inviteCode: "PQRTU-VWXY3" },
      entries: [{ rank: 1, user: { id: user.id, name: user.name }, durationSeconds: 0, sessionCount: 0 }],
    });
    const bridge = bridgeFor({
      orgJoin,
      orgOverview: vi.fn().mockResolvedValue({
        organization: { id: "00000000-0000-4000-8000-000000000900", name: "Solo", inviteCode: "ACDEF-GHJKM" },
        entries: [],
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.type(await within(dialog).findByLabelText(/Invite code to join/), "acdef-ghjkm");
    await person.click(within(dialog).getByRole("button", { name: "Join" }));

    await waitFor(() => expect(orgJoin).toHaveBeenCalledWith("acdef-ghjkm"));
    expect(await within(dialog).findByText("Joined Team")).toBeInTheDocument();
  });

  it("keeps the timer usable when a join is refused", async () => {
    const bridge = bridgeFor({
      orgJoin: vi.fn().mockRejectedValue({ kind: "validation", message: "That invite code does not match a workspace." }),
      orgOverview: vi.fn().mockResolvedValue({
        organization: { id: "00000000-0000-4000-8000-000000000900", name: "Solo", inviteCode: "ACDEF-GHJKM" },
        entries: [],
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.type(await within(dialog).findByLabelText(/Invite code to join/), "ACDEF-GHJKM");
    await person.click(within(dialog).getByRole("button", { name: "Join" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("does not match a workspace");
    expect(screen.getByRole("heading", { name: "What are you working on?" })).toBeInTheDocument();
  });

  it("shows one muted monitoring line when the host answers", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus) });
    render(<App bridge={bridge} />);

    expect(await screen.findByText("Monitoring on")).toBeInTheDocument();
    // Hook badges and upload detail moved to settings; the line stays minimal.
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last upload/)).not.toBeInTheDocument();
  });

  it("says when monitoring is paused or off rather than implying it records", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({ ...idleMonitorStatus, running: false }),
    });
    const view = render(<App bridge={bridge} />);
    expect(await screen.findByText("Monitoring paused")).toBeInTheDocument();

    view.rerender(
      <App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue({ ...idleMonitorStatus, enabled: false, running: false }) })} />,
    );
    expect(await screen.findByText("Monitoring off")).toBeInTheDocument();
  });

  it("renders no monitor surfaces when the host cannot report status", async () => {
    render(<App bridge={bridgeFor()} />);
    await screen.findByRole("heading", { name: "What are you working on?" });
    await waitFor(() => expect(screen.queryByText(/^Monitoring (on|paused|off)$/)).not.toBeInTheDocument());
  });

  it("lists per-CLI hook badges under settings when the host answers", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await openAdvanced(person, dialog);
    expect(within(dialog).getByRole("heading", { name: "Watch my agent CLIs" })).toBeInTheDocument();
    const detected = await within(dialog).findByText("Claude Code");
    expect(detected).toHaveClass("hook-badge", "is-detected");
    expect(detected).toHaveAttribute("title", "C:/Users/dev/.claude/settings.json");
    const missing = within(dialog).getByText("Codex");
    expect(missing).toHaveClass("hook-badge", "is-missing");
    expect(missing).toHaveAttribute("title", "C:/Users/dev/.codex/config.toml");
  });

  it("labels a Cursor hook badge from the host-reported hooks", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({
        ...idleMonitorStatus,
        hooks: [{ source: "cursor", detected: true, installed: true, configPath: "C:/Users/dev/.cursor/hooks.json" }],
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await openAdvanced(person, dialog);
    const detected = await within(dialog).findByText("Cursor");
    expect(detected).toHaveClass("hook-badge", "is-detected");
    expect(detected).toHaveAttribute("title", "C:/Users/dev/.cursor/hooks.json");
  });

  it("registers a missing hook from settings and shows a returned manual snippet", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus),
      hookRegister: vi.fn().mockResolvedValue({
        status: "manual",
        configPath: "C:/Users/dev/.codex/config.toml",
        snippet: "notify = [\"C:/bin/clock-in-hook.exe\", \"--source\", \"codex\"]",
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await openAdvanced(person, dialog);
    // Only the missing hook (Codex) offers registration; Claude Code is detected.
    const register = await within(dialog).findByRole("button", { name: "Register" });
    await person.click(register);

    await waitFor(() => expect(bridge.hookRegister).toHaveBeenCalledWith("codex"));
    expect(await within(dialog).findByText(/notify =/)).toBeInTheDocument();
    // The status re-poll keeps the badge state current after registering.
    const pollsBefore = vi.mocked(bridge.monitorStatus).mock.calls.length;
    await person.click(register);
    await waitFor(() => expect(vi.mocked(bridge.monitorStatus).mock.calls.length).toBeGreaterThan(pollsBefore));
  });

  it("marks a hook as registered in settings once the host reports it", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await openAdvanced(person, dialog);
    // Claude Code is detected in the fixture: state, not a Register button.
    expect(await within(dialog).findByText("Registered")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: "Register" })).toHaveLength(1);
  });

  const suggestedStatus = {
    ...idleMonitorStatus,
    pendingSuggestion: { projectId: project.id, source: "codex", since: "2026-08-06T14:58:00.000Z" },
  };

  it("offers a suggested start and confirms it with the project preselected", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(suggestedStatus) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    expect(await screen.findByText(/Codex active - start tracking/)).toBeInTheDocument();
    expect(screen.getByText("Field work", { selector: "strong" })).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id })));
    expect(await screen.findByRole("button", { name: "Stop timer" })).toBeVisible();
    expect(screen.queryByText(/Codex active - start tracking/)).not.toBeInTheDocument();
  });

  it("dismisses a suggested start on the host and in the UI", async () => {
    let dismissed = false;
    const bridge = bridgeFor({
      monitorDismissSuggestion: vi.fn().mockImplementation(() => {
        dismissed = true;
        return Promise.resolve();
      }),
      monitorStatus: vi.fn().mockImplementation(() => Promise.resolve(dismissed ? idleMonitorStatus : suggestedStatus)),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await screen.findByText(/Codex active - start tracking/);
    await person.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(bridge.monitorDismissSuggestion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/Codex active - start tracking/)).not.toBeInTheDocument());
    expect(bridge.start).not.toHaveBeenCalled();
  });

  const awayStatus = {
    ...idleMonitorStatus,
    sessionIdleSeconds: 2_100,
    away: { startedAt: "2026-08-06T15:20:00.000Z", seconds: 1_500, ongoing: false, exceedsHardLimit: false },
  };

  const runningBridge = (overrides: Partial<TimerBridge> = {}): TimerBridge => bridgeFor({
    bootstrap: vi.fn().mockResolvedValue({ kind: "running", user, projects: [project], running, source: "server-only" }),
    monitorStatus: vi.fn().mockResolvedValue(awayStatus),
    ...overrides,
  });

  it("shows idle trimmed so far on the running hero", async () => {
    render(<App bridge={runningBridge()} />);
    expect(await screen.findByTestId("idle-trimmed")).toHaveTextContent("Idle trimmed so far 00:35:00");
  });

  it("keeps the away span out of the idle trim when the user keeps it", async () => {
    const bridge = runningBridge();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    expect(await screen.findByText(/You were away 25 minutes/)).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Yes" }));
    expect(screen.getByText("Away time kept - it stays on the timer.")).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Stop timer" }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalledWith(expect.objectContaining({ idleSeconds: 600 })));
  });

  it("lets the host measure the idle trim when the user discards the away span", async () => {
    const bridge = runningBridge();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    expect(await screen.findByText(/You were away 25 minutes/)).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "No" }));
    expect(screen.getByText("Away time will be trimmed at stop.")).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Stop timer" }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalledWith(expect.objectContaining({ idleSeconds: null })));
  });

  it("sends an explicit zero when the kept away span is the only idle", async () => {
    const bridge = runningBridge({
      monitorStatus: vi.fn().mockResolvedValue({ ...awayStatus, sessionIdleSeconds: 1_500 }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    expect(await screen.findByText(/You were away 25 minutes/)).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Yes" }));
    await person.click(screen.getByRole("button", { name: "Stop timer" }));
    // Authoritative 0: the host must not re-measure and flip keep into discard.
    await waitFor(() => expect(bridge.stop).toHaveBeenCalledWith(expect.objectContaining({ idleSeconds: 0 })));
  });

  it("names the active agent session while the override pauses idle trimming", async () => {
    const bridge = runningBridge({
      monitorStatus: vi.fn().mockResolvedValue({
        ...awayStatus,
        agentActive: { source: "kimi_code", since: "2026-08-06T14:40:00.000Z" },
      }),
    });
    render(<App bridge={bridge} />);

    expect(await screen.findByTestId("agent-active")).toHaveTextContent("Kimi Code active - idle trim paused");
  });

  it("does not raise the away prompt while the user is still away", async () => {
    const bridge = runningBridge({
      monitorStatus: vi.fn().mockResolvedValue({ ...awayStatus, away: { ...awayStatus.away, ongoing: true } }),
    });
    render(<App bridge={bridge} />);
    await screen.findByTestId("idle-trimmed");
    expect(screen.queryByText(/You were away/)).not.toBeInTheDocument();
  });

  it("shows today's total and friendly per-app rows without corroboration jargon", async () => {
    const bridge = bridgeFor();
    render(<App bridge={bridge} />);

    await waitFor(() => expect(bridge.meStats).toHaveBeenCalledTimes(1));
    expect(bridge.meStats).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    const panel = await screen.findByRole("region", { name: "Today so far" });
    expect(await within(panel).findByText("2h", { selector: "strong" })).toBeInTheDocument();
    const codeRow = within(panel).getByText("VS Code").closest("li");
    expect(codeRow).toHaveTextContent("1h 20m");
    const chromeRow = within(panel).getByText("Google Chrome").closest("li");
    expect(chromeRow).toHaveTextContent("20m");
    expect(within(panel).queryByText(/Code\.exe/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/corroborated/i)).not.toBeInTheDocument();
  });

  it("shows the apps empty state when no monitoring activity was recorded", async () => {
    const bridge = bridgeFor({
      meStats: vi.fn().mockResolvedValue({ ...meStats, totalDurationSeconds: 0, corroboratedSeconds: 0, projects: [], apps: [] }),
    });
    render(<App bridge={bridge} />);

    const panel = await screen.findByRole("region", { name: "Today so far" });
    expect(await within(panel).findByText("No activity yet. Turn on monitoring in settings to see where your time goes.")).toBeInTheDocument();
  });

  it("caps the app rows at eight and folds the rest into Everything else", async () => {
    const apps = Array.from({ length: 12 }, (_, index) => ({ processName: `app-${String(index).padStart(2, "0")}.exe`, durationSeconds: 60 * (12 - index) }));
    const bridge = bridgeFor({ meStats: vi.fn().mockResolvedValue({ ...meStats, apps }) });
    render(<App bridge={bridge} />);

    const panel = await screen.findByRole("region", { name: "Today so far" });
    expect(await within(panel).findByText("App 07")).toBeInTheDocument();
    expect(within(panel).queryByText("App 08")).not.toBeInTheDocument();
    const restRow = within(panel).getByText("Everything else").closest("li");
    // 4 + 3 + 2 + 1 minutes from the folded rows.
    expect(restRow).toHaveTextContent("10m");
  });

  it("refetches stats for the week range from Monday midnight", async () => {
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await waitFor(() => expect(bridge.meStats).toHaveBeenCalledTimes(1));
    await person.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() => expect(bridge.meStats).toHaveBeenCalledTimes(2));
    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    expect(bridge.meStats).toHaveBeenLastCalledWith(monday.toISOString().slice(0, 10));
    expect(screen.getByRole("region", { name: "This week" })).toBeInTheDocument();
  });

  it("keeps the Today card readable when the stats request fails", async () => {
    const bridge = bridgeFor({ meStats: vi.fn().mockRejectedValue({ kind: "transient", message: "Stats unavailable" }) });
    render(<App bridge={bridge} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Stats unavailable");
    expect(screen.getByRole("heading", { name: "What are you working on?" })).toBeInTheDocument();
  });

  it("shows the verified footer only when monitoring is on and some of today is verified", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus) });
    render(<App bridge={bridge} />);

    const panel = await screen.findByRole("region", { name: "Today so far" });
    expect(await within(panel).findByText("1h 30m of today verified")).toBeInTheDocument();
  });

  it("hides the verified footer when monitoring is off", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({ ...idleMonitorStatus, enabled: false, running: false }),
    });
    render(<App bridge={bridge} />);

    const panel = await screen.findByRole("region", { name: "Today so far" });
    await within(panel).findByText("VS Code");
    expect(within(panel).queryByText(/verified/)).not.toBeInTheDocument();
  });

  it("hides the verified footer when nothing is verified yet", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus),
      meStats: vi.fn().mockResolvedValue({ ...meStats, corroboratedSeconds: 0 }),
    });
    render(<App bridge={bridge} />);

    const panel = await screen.findByRole("region", { name: "Today so far" });
    await within(panel).findByText("VS Code");
    expect(within(panel).queryByText(/verified/)).not.toBeInTheDocument();
  });

  it("words the verified footer for the week range", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await within(await screen.findByRole("region", { name: "Today so far" })).findByText("1h 30m of today verified");
    await person.click(screen.getByRole("button", { name: "This week" }));
    const panel = await screen.findByRole("region", { name: "This week" });
    expect(await within(panel).findByText("1h 30m of this week verified")).toBeInTheDocument();
  });

  it("folds agent CLI processes into one row and marks it active now", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({
        ...idleMonitorStatus,
        agentActive: { source: "claude_code", since: "2026-08-06T14:40:00.000Z" },
      }),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [
          { processName: "chrome.exe", durationSeconds: 7_200 },
          { processName: "claude.exe", durationSeconds: 3_600 },
          { processName: "codex.exe", durationSeconds: 1_800 },
        ],
      }),
    });
    render(<App bridge={bridge} />);

    const panel = await screen.findByRole("region", { name: "Today so far" });
    const agentRow = (await within(panel).findByText("Agent CLIs")).closest("li");
    expect(agentRow).toHaveTextContent("1h 30m");
    expect(agentRow).toHaveTextContent("· active now");
    expect(within(panel).queryByText(/claude\.exe/)).not.toBeInTheDocument();
    const chromeRow = within(panel).getByText("Google Chrome").closest("li");
    expect(chromeRow).toHaveTextContent("2h");
  });

  it("names a single agent CLI row from its source label", async () => {
    const bridge = bridgeFor({
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [{ processName: "claude.exe", durationSeconds: 3_600 }],
      }),
    });
    render(<App bridge={bridge} />);

    const panel = await screen.findByRole("region", { name: "Today so far" });
    const row = (await within(panel).findByText("Claude Code")).closest("li");
    expect(row).toHaveTextContent("1h");
    expect(row).not.toHaveTextContent("active now");
  });

  it("loads mappings only once the overlay opens", async () => {
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    // Settings load with the account (the first-run flow keys off them), so
    // only the mappings wait for the overlay.
    await screen.findByRole("heading", { name: "What are you working on?" });
    await waitFor(() => expect(bridge.settingsGet).toHaveBeenCalledTimes(1));
    expect(bridge.pathMappingsList).not.toHaveBeenCalled();

    await openSettings(person);
    await waitFor(() => expect(bridge.pathMappingsList).toHaveBeenCalledTimes(1));
  });

  it("closes the settings overlay on Escape", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    await openSettings(person);
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("closes the settings overlay from its close button and the overlay backdrop", async () => {
    const person = userEvent.setup();
    const view = render(<App bridge={bridgeFor()} />);

    let dialog = await openSettings(person);
    await person.click(within(dialog).getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();

    dialog = await openSettings(person);
    const overlay = view.container.querySelector(".modal-overlay");
    expect(overlay).not.toBeNull();
    await person.click(overlay as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("round-trips monitoring settings from the settings overlay", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await waitFor(() => expect(bridge.settingsGet).toHaveBeenCalled());
    expect(await within(dialog).findByLabelText("Activity monitoring")).toBeChecked();

    await person.click(within(dialog).getByLabelText("Activity monitoring"));
    await waitFor(() => expect(bridge.monitorSetEnabled).toHaveBeenCalledWith(false));

    await person.click(within(dialog).getByLabelText("Count agent sessions as work while I'm away"));
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ agentOverrideEnabled: false }));

    await openAdvanced(person, dialog);
    const threshold = within(dialog).getByLabelText("Away threshold (minutes)");
    await person.clear(threshold);
    await person.type(threshold, "15");
    await person.tab();
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ awayThresholdMinutes: 15 }));
  });

  it("surfaces a settings failure without closing the overlay", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus),
      monitorSetEnabled: vi.fn().mockRejectedValue({ kind: "transient", message: "Settings could not be saved" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByLabelText("Activity monitoring"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Settings could not be saved");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("lists, adds, and deletes path mappings with project names", async () => {
    const created = { ...mapping, id: "00000000-0000-4000-8000-000000000401", pathPrefix: "C:/dev/other" };
    const bridge = bridgeFor({
      pathMappingsCreate: vi.fn().mockResolvedValue(created),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await openAdvanced(person, dialog);
    expect(await within(dialog).findByText("C:/dev/Clock-In")).toBeInTheDocument();
    expect(within(dialog).getByText("C:/dev/Clock-In").closest("li")).toHaveTextContent("Field work");

    await person.type(within(dialog).getByLabelText("Path prefix"), "C:/dev/other");
    await person.selectOptions(within(dialog).getAllByLabelText("Project")[0]!, project.id);
    await person.click(within(dialog).getByRole("button", { name: "Add mapping" }));
    await waitFor(() => expect(bridge.pathMappingsCreate).toHaveBeenCalledWith({ pathPrefix: "C:/dev/other", projectId: project.id }));
    expect(await within(dialog).findByText("C:/dev/other")).toBeInTheDocument();

    const [firstDelete] = within(dialog).getAllByRole("button", { name: "Delete" });
    await person.click(firstDelete!);
    await waitFor(() => expect(bridge.pathMappingsDelete).toHaveBeenCalledWith(mapping.id));
    expect(within(dialog).queryByText("C:/dev/Clock-In")).not.toBeInTheDocument();
  });

  it("keeps mappings listed when create or delete is refused", async () => {
    const bridge = bridgeFor({
      pathMappingsCreate: vi.fn().mockRejectedValue({ kind: "validation", message: "That path prefix is already mapped." }),
      pathMappingsDelete: vi.fn().mockRejectedValue({ kind: "transient", message: "Delete failed; try again" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await openAdvanced(person, dialog);
    await within(dialog).findByText("C:/dev/Clock-In");

    await person.type(within(dialog).getByLabelText("Path prefix"), "C:/dev/Clock-In");
    await person.selectOptions(within(dialog).getAllByLabelText("Project")[0]!, project.id);
    await person.click(within(dialog).getByRole("button", { name: "Add mapping" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already mapped");

    await person.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Delete failed; try again");
    expect(within(dialog).getByText("C:/dev/Clock-In")).toBeInTheDocument();
  });

  it("states plainly what monitoring records and where evidence waits", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const dialog = await openSettings(person);
    const note = await within(dialog).findByText(/samples the foreground process name/);
    expect(note).toHaveTextContent("never records window titles, URLs, document names, or keystrokes");
    expect(note).toHaveTextContent("%APPDATA%");
    expect(note).toHaveTextContent("not marked verified");
    expect(note).not.toHaveTextContent(/uncorroborated/i);
  });

  const chromeRegistered = {
    browser: "chrome",
    label: "Chrome",
    state: "registered" as const,
    storeUrl: "https://chromewebstore.google.com/",
  };

  it("runs first-run onboarding: one question, browser cards, then the timer", async () => {
    const notOnboarded = { ...monitorSettings, onboarded: false };
    const onboardedNow = { ...monitorSettings, onboarded: true };
    let connected = false;
    const bridge = bridgeFor({
      settingsGet: vi.fn().mockResolvedValue(notOnboarded),
      settingsUpdate: vi.fn().mockResolvedValue(onboardedNow),
      monitorSetEnabled: vi.fn().mockResolvedValue(notOnboarded),
      monitorStatus: vi.fn().mockImplementation(() => Promise.resolve({
        ...idleMonitorStatus,
        browsers: [{ ...chromeRegistered, state: connected ? "connected" : "registered" }],
      })),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    // One question, one button, nothing else to decide.
    await person.click(await screen.findByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(bridge.monitorSetEnabled).toHaveBeenCalledWith(true));

    // The browser card offers the store page, then flips on the handshake.
    await person.click(await screen.findByRole("button", { name: "Connect Chrome" }));
    expect(bridge.browserOpenStorePage).toHaveBeenCalledWith("chrome");
    connected = true;
    expect(await screen.findByText("Chrome is connected ✓", {}, { timeout: 5_000 })).toBeInTheDocument();

    await person.click(screen.getByRole("button", { name: "Start using Clock-In" }));
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ onboarded: true }));
    expect(await screen.findByRole("heading", { name: "What are you working on?" })).toBeInTheDocument();
  });

  it("shows a neutral browser check while onboarding status is still loading", async () => {
    const pendingStatus = deferred<typeof idleMonitorStatus>();
    const bridge = bridgeFor({
      settingsGet: vi.fn().mockResolvedValue({ ...monitorSettings, onboarded: false }),
      monitorSetEnabled: vi.fn().mockResolvedValue({ ...monitorSettings, onboarded: false }),
      monitorStatus: vi.fn().mockReturnValue(pendingStatus.promise),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "Turn on" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Checking for browsers...");
    expect(screen.queryByText(/No supported browser found/)).not.toBeInTheDocument();
  });

  it("repairs a broken browser connection with one [Fix] click", async () => {
    const bridge = bridgeFor({
      settingsGet: vi.fn().mockResolvedValue({ ...monitorSettings, onboarded: false }),
      settingsUpdate: vi.fn().mockResolvedValue(monitorSettings),
      monitorSetEnabled: vi.fn().mockResolvedValue({ ...monitorSettings, onboarded: false }),
      monitorStatus: vi.fn().mockResolvedValue({
        ...idleMonitorStatus,
        browsers: [{ ...chromeRegistered, state: "binary-missing" }],
      }),
      browserRepair: vi.fn().mockResolvedValue({ ...chromeRegistered }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("The Chrome connection needs a quick repair.")).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Fix" }));

    await waitFor(() => expect(bridge.browserRepair).toHaveBeenCalledWith("chrome"));
    // The answer carries the repaired health, so the card offers Connect next.
    expect(await screen.findByRole("button", { name: "Connect Chrome" })).toBeInTheDocument();
  });

  it("lets a persistent Turn on failure be skipped to the main screen", async () => {
    const bridge = bridgeFor({
      settingsGet: vi.fn().mockResolvedValue({ ...monitorSettings, onboarded: false }),
      settingsUpdate: vi.fn().mockResolvedValue(monitorSettings),
      monitorSetEnabled: vi.fn().mockRejectedValue({ kind: "transient", message: "Could not save the settings." }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the settings");
    // The failure must not be a dead end: skipping lands on the main app.
    await person.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ onboarded: true }));
    expect(await screen.findByRole("heading", { name: "What are you working on?" })).toBeInTheDocument();
  });

  it("returns to sign-in when Turn on hits an auth failure", async () => {
    const bridge = bridgeFor({
      settingsGet: vi.fn().mockResolvedValue({ ...monitorSettings, onboarded: false }),
      monitorSetEnabled: vi.fn().mockRejectedValue({ kind: "auth", message: "Session expired" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Session expired");
  });

  it("offers a sign-out escape from the onboarding screens", async () => {
    const bridge = bridgeFor({
      settingsGet: vi.fn().mockResolvedValue({ ...monitorSettings, onboarded: false }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(bridge.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
  });

  it("answers a site question with Yes and creates the whole-site rule", async () => {
    const bridge = bridgeFor({
      suggestionsList: vi.fn().mockResolvedValue([{ origin: "quickbooks.com", seconds: 10_800 }]),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    expect(await screen.findByText(/You spent 3 hours on quickbooks\.com this week\. Is that work\?/)).toBeInTheDocument();
    await person.selectOptions(screen.getByLabelText("Project for this site"), project.id);
    await person.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(bridge.pathMappingsCreate).toHaveBeenCalledWith({
      kind: "url_rule",
      pathPrefix: "*.quickbooks.com",
      projectId: project.id,
    }));
    await waitFor(() => expect(screen.queryByText(/Is that work\?/)).not.toBeInTheDocument());
  });

  it("uses singular minute copy in the site question", async () => {
    const bridge = bridgeFor({
      suggestionsList: vi.fn().mockResolvedValue([{ origin: "quickbooks.com", seconds: 60 }]),
    });
    render(<App bridge={bridge} />);

    expect(await screen.findByText(/You spent 1 minute on quickbooks\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/1 minutes/)).not.toBeInTheDocument();
  });

  it("asks the narrower question for a multi-project host before creating the rule", async () => {
    const bridge = bridgeFor({
      suggestionsList: vi.fn().mockResolvedValue([{ origin: "github.com", seconds: 3_600 }]),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    expect(await screen.findByText(/You spent 1 hour on github\.com this week/)).toBeInTheDocument();
    await person.selectOptions(screen.getByLabelText("Project for this site"), project.id);
    await person.click(screen.getByRole("button", { name: "Yes" }));

    // github.com spans many projects: one follow-up, then the narrowed rule.
    expect(bridge.pathMappingsCreate).not.toHaveBeenCalled();
    await person.type(await screen.findByLabelText("Organization or team name"), "acme");
    await person.click(screen.getByRole("button", { name: "Yes, track it" }));

    await waitFor(() => expect(bridge.pathMappingsCreate).toHaveBeenCalledWith({
      kind: "url_rule",
      pathPrefix: "github.com/acme/*",
      projectId: project.id,
    }));
  });

  it("resets narrowing input when polling changes the suggested origin", async () => {
    const firstBridge = bridgeFor({
      suggestionsList: vi.fn().mockResolvedValue([{ origin: "github.com", seconds: 3_600 }]),
    });
    const secondBridge = bridgeFor({
      suggestionsList: vi.fn().mockResolvedValue([{ origin: "gitlab.com", seconds: 3_600 }]),
    });
    const person = userEvent.setup();
    const view = render(<App bridge={firstBridge} />);

    await screen.findByText(/github\.com this week/);
    await person.click(screen.getByRole("button", { name: "Yes" }));
    await person.type(await screen.findByLabelText("Organization or team name"), "acme");

    view.rerender(<App bridge={secondBridge} />);
    expect(await screen.findByText(/gitlab\.com this week/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Organization or team name")).not.toBeInTheDocument();

    await person.click(screen.getByRole("button", { name: "Yes" }));
    expect(await screen.findByLabelText("Organization or team name")).toHaveValue("");
  });

  it("answers a site question with No and never asks again for that origin", async () => {
    const bridge = bridgeFor({
      suggestionsList: vi.fn().mockResolvedValue([{ origin: "quickbooks.com", seconds: 10_800 }]),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await screen.findByText(/Is that work\?/);
    await person.click(screen.getByRole("button", { name: /don't ask again/ }));

    await waitFor(() => expect(bridge.suggestionNeverSuggest).toHaveBeenCalledWith("quickbooks.com"));
    await waitFor(() => expect(screen.queryByText(/Is that work\?/)).not.toBeInTheDocument());
    expect(bridge.pathMappingsCreate).not.toHaveBeenCalled();
  });

  it("keeps thresholds, mappings, and hooks behind the Advanced disclosure", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(idleMonitorStatus) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await within(dialog).findByLabelText("Activity monitoring");
    expect(within(dialog).queryByLabelText("Away threshold (minutes)")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Path mappings")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Claude Code")).not.toBeInTheDocument();

    await openAdvanced(person, dialog);
    expect(within(dialog).getByLabelText("Away threshold (minutes)")).toBeInTheDocument();
    expect(within(dialog).getByText("Path mappings")).toBeInTheDocument();
    expect(await within(dialog).findByText("Claude Code")).toBeInTheDocument();
  });

  it("hides hook rows for CLIs that are not on the machine", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({
        ...idleMonitorStatus,
        hooks: [
          { source: "claude_code", detected: true, installed: true, configPath: "C:/Users/dev/.claude/settings.json" },
          { source: "codex", detected: false, installed: false, configPath: "C:/Users/dev/.codex/config.toml" },
        ],
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await openAdvanced(person, dialog);
    expect(await within(dialog).findByText("Claude Code")).toBeInTheDocument();
    expect(within(dialog).queryByText("Codex")).not.toBeInTheDocument();
  });

  it("shows browser cards with health in settings and clears saved site answers", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({
        ...idleMonitorStatus,
        browsers: [chromeRegistered],
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    expect(await within(dialog).findByRole("button", { name: "Connect Chrome" })).toBeInTheDocument();

    await person.click(within(dialog).getByRole("button", { name: "Clear saved site answers" }));
    await waitFor(() => expect(bridge.suggestionsClear).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(/ask about sites again/);
  });
});
