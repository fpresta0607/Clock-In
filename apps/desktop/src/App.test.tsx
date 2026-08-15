import { act, render, screen, waitFor, within } from "@testing-library/react";
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

const project = { id: "00000000-0000-4000-8000-000000000010", name: "Field work", color: "#d89a34" };
const otherProject = { id: "00000000-0000-4000-8000-000000000011", name: "Client work", color: null };
const newProject = { id: "00000000-0000-4000-8000-000000000012", name: "Fresh", color: null };

const account = {
  kind: "ready" as const,
  user,
  projects: [project, otherProject],
  defaultProjectId: project.id,
  selectedProjectId: null,
};

const settings = {
  enabled: true,
  awayThresholdMinutes: 10,
  agentOverrideEnabled: true,
  browserAutoInstall: true,
  deviceId: "00000000-0000-4000-8000-000000000300",
};

const status = {
  enabled: true,
  running: true,
  observing: true,
  lastPollAgeSeconds: 12,
  lastUploadAt: "2026-08-06T14:55:00.000Z",
  segmentBacklog: 0,
  agentBacklog: 0,
  sessionBacklog: 0,
  hooks: [
    { source: "claude_code", detected: true, installed: true, needsYou: false, configPath: "C:/Users/dev/.claude/settings.json" },
    { source: "codex", detected: false, installed: true, needsYou: false, configPath: "C:/Users/dev/.codex/config.toml" },
  ],
  agentActive: null,
  currentSession: null,
  openSpan: null,
  agentSessions: [],
  selectedProjectId: null,
};

const recording = {
  ...status,
  currentSession: {
    projectId: project.id,
    attribution: "agent" as const,
    since: "2026-08-06T14:00:00.000Z",
    idleSeconds: 0,
    apps: [],
  },
};

const noMeasurement = {
  activeSeconds: 0,
  agentSeconds: 0,
  concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
  byAgent: [] as never[],
};

const meStats = {
  filters: {},
  totalDurationSeconds: 7_200,
  attributedSeconds: 5_400,
  unattributedSeconds: 1_800,
  ...noMeasurement,
  projects: [{
    project: { id: project.id, name: project.name },
    durationSeconds: 7_200,
    attributedSeconds: 5_400,
    unattributedSeconds: 1_800,
    sessionCount: 3,
  }],
  apps: [
    { processName: "Code.exe", durationSeconds: 4_800 },
    { processName: "chrome.exe", durationSeconds: 1_200 },
  ],
};

const mapping = {
  id: "00000000-0000-4000-8000-000000000400",
  pathPrefix: "C:/dev/Clock-In",
  repoUrl: null,
  projectId: project.id,
};

const agentsReport = {
  headcount: { total: 1, active: 1, retired: 0 },
  rows: [{
    agent: {
      id: "00000000-0000-4000-8000-000000000500",
      name: "Claude Code @ Field work",
      source: "claude_code",
      status: "anonymous" as const,
      owner: { id: user.id, name: user.name },
      project: { id: project.id, name: project.name },
    },
    agentSeconds: 5_400,
    shiftCount: 2,
    commitsRecorded: 0,
    commitsPending: 0,
    commitsMerged: 0,
    commitsReverted: 0,
    commitsOrphaned: 0,
    heldRate: null,
    models: ["claude-fable-5"],
  }],
};

const bridgeFor = (overrides: Partial<TimerBridge> = {}): TimerBridge => ({
  bootstrap: vi.fn().mockResolvedValue(account),
  login: vi.fn().mockResolvedValue(account),
  signup: vi.fn().mockResolvedValue(account),
  logout: vi.fn().mockResolvedValue(undefined),
  preferencesGet: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
  preferencesSet: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
  orgOverview: vi.fn().mockResolvedValue({
    organization: { id: "00000000-0000-4000-8000-000000000900", name: "SIQstack", inviteCode: "ACDEF-GHJKM" },
    entries: [
      { rank: 1, user: { id: "b1c7e513-b094-4d4c-ae55-21790ae019a4", name: "Sam" }, durationSeconds: 7_200, sessionCount: 3, activeSeconds: 7_000, agentSeconds: 3_600 },
      { rank: 2, user: { id: user.id, name: user.name }, durationSeconds: 3_600, sessionCount: 1, activeSeconds: 3_600, agentSeconds: 1_800 },
    ],
  }),
  orgJoin: vi.fn().mockResolvedValue({
    organization: { id: "00000000-0000-4000-8000-000000000901", name: "Joined Team", inviteCode: "PQRTU-VWXY3" },
    entries: [{ rank: 1, user: { id: user.id, name: user.name }, durationSeconds: 0, sessionCount: 0, activeSeconds: 0, agentSeconds: 0 }],
  }),
  // The default is "the host cannot report": every recording surface stays
  // quiet rather than claiming something it cannot see.
  monitorStatus: vi.fn().mockRejectedValue({ kind: "unknown", message: "Recording unavailable" }),
  browserStatus: vi.fn().mockResolvedValue([]),
  browserRepair: vi.fn().mockRejectedValue({ kind: "unknown", message: "Repair unavailable" }),
  browserOpenStore: vi.fn().mockResolvedValue(undefined),
  sessionSelectProject: vi.fn().mockResolvedValue(status),
  hookRegister: vi.fn().mockResolvedValue({ status: "registered", configPath: "C:/Users/dev/.claude/settings.json" }),
  monitorSetEnabled: vi.fn().mockResolvedValue(settings),
  settingsGet: vi.fn().mockResolvedValue(settings),
  settingsUpdate: vi.fn().mockResolvedValue(settings),
  meStats: vi.fn().mockResolvedValue(meStats),
  agentsReport: vi.fn().mockResolvedValue(agentsReport),
  projectCreate: vi.fn().mockResolvedValue(newProject),
  projectUpdate: vi.fn().mockResolvedValue(project),
  projectUsage: vi.fn().mockResolvedValue({ sessionCount: 0, durationSeconds: 0, agentSessionCount: 0 }),
  projectDelete: vi.fn().mockResolvedValue(undefined),
  appIcons: vi.fn().mockResolvedValue({}),
  quotaStatus: vi.fn().mockResolvedValue({ status: "ready", checkedAt: null, detail: null, providers: [] }),
  onUpdateAvailable: vi.fn().mockResolvedValue(() => undefined),
  ...overrides,
});

/// Opens the "All stats" overlay, where everything historical now lives: the
/// main surface is the record card and this session, and nothing else.
const openAllStats = async (person: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await person.click(await screen.findByTestId("all-stats-trigger"));
  // The overlay is titled by the workspace it shows.
  return screen.getByRole("dialog", { name: /SIQstack|All stats/ });
};

/// Opens the settings overlay from the titlebar gear and returns the dialog.
const openSettings = async (person: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await person.click(await screen.findByRole("button", { name: "Settings" }));
  return screen.getByRole("dialog", { name: "Settings" });
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("sign-in", () => {
  it("shows a labelled sign-in form after a signed-out bootstrap", async () => {
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }) })} />);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("surfaces a failed sign-in without losing the form", async () => {
    const login = vi.fn().mockRejectedValue({ kind: "auth", message: "Those details did not match." });
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), login })} />);

    await screen.findByRole("heading", { name: "Sign in" });
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Those details did not match.");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("signs in and lands on the recording screen", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }),
      monitorStatus: vi.fn().mockResolvedValue(recording),
    })} />);

    await screen.findByRole("heading", { name: "Sign in" });
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Recording on")).toBeInTheDocument();
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
});

describe("recording", () => {
  it("shows the stretch of work in progress with nothing to press", async () => {
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    // One accumulated figure for the day, under the date: a second timer for
    // the open stretch only ever raised the question of which was the total.
    expect(await screen.findByTestId("elapsed-time")).toBeInTheDocument();
    expect(screen.queryByTestId("today-line")).not.toBeInTheDocument();
    expect(screen.queryByText(/Filed here because/)).not.toBeInTheDocument();
    // Nothing in the product starts or stops time any more.
    expect(screen.queryByRole("button", { name: /start/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();
  });

  it("explains an idle machine instead of pretending to record", async () => {
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) })} />);

    // The clock still shows the day's total; the note says why nothing is
    // being added to it right now.
    expect(await screen.findByTestId("elapsed-time")).toBeInTheDocument();
    expect(await screen.findByText(/There is nothing to press/)).toBeInTheDocument();
  });

  it("says recording is off, and never implies otherwise", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({ ...status, enabled: false, running: false, observing: false }),
    })} />);

    // Recording state is a dot and a spoken label beside the project now, so
    // the surface never has to repeat itself in a heading.
    expect(await screen.findByText("Recording off")).toBeInTheDocument();
    expect(screen.getByText(/Turn recording on/)).toBeInTheDocument();
  });

  // The screenshot bug: the timer said RECORDING while the card under it said
  // "Turn on recording in settings". Both now read the one shared state, so no
  // arrangement of props can make them disagree.
  it("never tells you to turn recording on while it is recording", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      // Recording is demonstrably on, but nothing has been added up yet.
      meStats: vi.fn().mockResolvedValue({ ...meStats, totalDurationSeconds: 0, apps: [], projects: [] }),
    })} />);

    const person = userEvent.setup();
    expect(await screen.findByText(/^Recording on/)).toBeInTheDocument();
    expect(await screen.findByTestId("elapsed-time")).toBeInTheDocument();

    // The live surface shows the open stretch on its project's row rather
    // than an empty state telling anyone to do anything.
    expect(await screen.findByTestId("project-list")).not.toHaveTextContent(/turn (on )?recording/i);
    expect(screen.queryByTestId("today-panel-empty")).not.toBeInTheDocument();

    // And the historical one behind "All stats", which is where the
    // contradiction used to be printed.
    const empty = within(await openAllStats(person)).getByTestId("today-empty");
    expect(empty).not.toHaveTextContent(/turn (on )?recording/i);
    expect(empty).toHaveTextContent("Nothing has been added up yet.");
  });

  // A poll task that dies leaves `running` true. Reading "on" from that alone
  // is what let the app look healthy while it recorded nothing for days.
  it("says recording stopped responding when the machine is no longer sampled", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({ ...recording, observing: false, lastPollAgeSeconds: 900 }),
    })} />);

    expect(await screen.findByText("Recording stopped responding")).toBeInTheDocument();
    expect(screen.queryByText("Recording on")).not.toBeInTheDocument();
  });

  it("gives every running agent session its own row, named by its project", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({
        ...recording,
        // Two terminals of the same tool, working in different folders.
        agentSessions: [
          { source: "claude_code", externalSessionId: "one", projectId: project.id, since: new Date(Date.now() - 600_000).toISOString() },
          { source: "claude_code", externalSessionId: "two", projectId: otherProject.id, since: new Date(Date.now() - 120_000).toISOString() },
        ],
      }),
    })} />);

    const rows = within(await screen.findByTestId("session-app-list")).getAllByRole("listitem");
    const claude = rows.filter((row) => row.textContent?.includes("Claude Code"));
    // One row for the tool, naming every project its sessions are in. Five
    // terminals are one tool, not five slices of the day.
    expect(claude).toHaveLength(1);
    expect(claude[0]).toHaveTextContent(project.name);
    expect(claude[0]).toHaveTextContent(otherProject.name);
    // No minutes of its own: an agent runs beside the editor it lives in, so
    // its wall-clock would double-count time already counted there. And it
    // says "connected", not "working" — a registered session is presence,
    // not proof of activity.
    expect(claude[0]).toHaveTextContent("connected");
    expect(claude[0]).not.toHaveTextContent("working");
  });

  it("renders no recording surfaces when the host cannot report status", async () => {
    render(<App bridge={bridgeFor()} />);

    // A host that cannot answer is its own state: the screen says it is still
    // checking rather than borrowing the wording of a healthy idle machine.
    expect(await screen.findByText(/asking this computer what it is doing/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/^Recording (on|paused|off)$/)).not.toBeInTheDocument());
  });

  it("names the workspace and project above the clock, with the picker behind Change", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    // The header says where time is landing, in words rather than an icon.
    const where = await screen.findByTestId("filing-where");
    await waitFor(() => expect(where).toHaveTextContent("SIQstack"));
    expect(where).toHaveTextContent(project.name);

    // Collapsed by default: no dropdown competing with the clock.
    expect(screen.queryByLabelText("File my time under")).not.toBeInTheDocument();

    await person.click(screen.getByTestId("filing-change"));
    expect(screen.getByLabelText("File my time under")).toBeVisible();

    await person.click(screen.getByTestId("filing-change"));
    expect(screen.queryByLabelText("File my time under")).not.toBeInTheDocument();
  });

  it("pins time to a project and hands the choice back to the host", async () => {
    const sessionSelectProject = vi.fn().mockResolvedValue({ ...recording, selectedProjectId: otherProject.id });
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording), sessionSelectProject })} />);

    await person.click(await screen.findByTestId("filing-change"));
    const picker = screen.getByRole("radiogroup", { name: "File my time under" });
    // The default choice is "work it out for me", naming where that lands,
    // and exactly one row carries the tick.
    expect(within(picker).getByRole("radio", { name: /Work it out for me \(Field work\)/ })).toHaveAttribute("aria-checked", "true");
    expect(within(picker).getAllByRole("radio", { checked: true })).toHaveLength(1);

    await person.click(within(picker).getByRole("radio", { name: otherProject.name }));
    await waitFor(() => expect(sessionSelectProject).toHaveBeenCalledWith(otherProject.id));

    // Choosing collapses the picker and the header names the pinned project.
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "File my time under" })).not.toBeInTheDocument());
    expect(screen.getByTestId("filing-where")).toHaveTextContent(otherProject.name);
  });

  it("lists the account's projects with no team row - one login is one team", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    await person.click(await screen.findByTestId("filing-change"));
    const picker = await screen.findByRole("radiogroup", { name: "File my time under" });
    expect(screen.queryByLabelText("Team")).not.toBeInTheDocument();
    expect(within(picker).getByRole("radio", { name: project.name })).toBeInTheDocument();
    expect(within(picker).getByRole("radio", { name: otherProject.name })).toBeInTheDocument();
  });

  it("creates a project and pins recording to it", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByTestId("filing-change"));
    await person.click(await screen.findByRole("button", { name: "New project…" }));
    await person.type(screen.getByLabelText("New project name"), "Fresh");
    await person.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(bridge.projectCreate).toHaveBeenCalledWith({ name: "Fresh" }));
    await waitFor(() => expect(bridge.sessionSelectProject).toHaveBeenCalledWith(newProject.id));
  });

  it("says nothing about syncing, which happens on its own", async () => {
    const backlogged = { ...recording, segmentBacklog: 2, sessionBacklog: 1 };
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(backlogged) })} />);

    await screen.findByTestId("elapsed-time");
    // A backlog is the app's problem, not the reader's: it drains by itself
    // and never earns a banner on the record surface.
    expect(screen.queryByTestId("sync-line")).not.toBeInTheDocument();
    expect(screen.queryByText(/still on this computer/i)).not.toBeInTheDocument();
  });
});

describe("today", () => {
  it("totals the range and names where unattributed time landed", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) })} />);

    const panel = await openAllStats(person);
    // The card renders before the stats land, so wait for the figure itself.
    // The project row underneath repeats the number, so pin the headline.
    expect(await within(panel).findByText("2h 00m", { selector: "strong" })).toBeInTheDocument();
    expect(within(panel).getByTestId("unattributed-foot")).toHaveTextContent(
      "30m of that landed in the default project, because nothing said which project it was for.",
    );
  });

  it("switches range and refetches from the week's start", async () => {
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    // Opening costs nothing: your own "today" reuses the main screen's read.
    expect(bridge.meStats).toHaveBeenCalledTimes(1);
    await person.click(await within(panel).findByRole("button", { name: "This week" }));

    await waitFor(() => expect(bridge.meStats).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: /This week/ })).toBeInTheDocument();
  });

  it("folds agent CLI processes into one friendly row", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [
          { processName: "claude.exe", durationSeconds: 3_600 },
          { processName: "Code.exe", durationSeconds: 1_800 },
        ],
      }),
    })} />);

    const panel = await openAllStats(person);
    expect(await within(panel).findByText("Claude Code")).toBeInTheDocument();
    expect(within(panel).getByText("VS Code")).toBeInTheDocument();
  });

  it("lists every model in the agent sessions table, including background-only runtimes", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [{ processName: "claude.exe", durationSeconds: 3_600 }],
        byAgent: [
          { source: "claude_code", model: "claude-fable-5", durationSeconds: 3_000, sessionCount: 4, maxConcurrent: 2, medianSeconds: 750 },
          { source: "codex", model: null, durationSeconds: 600, sessionCount: 1, maxConcurrent: 1, medianSeconds: 600 },
        ],
      }),
    })} />);

    const panel = await openAllStats(person);
    const sessions = await within(panel).findByTestId("agent-sessions");
    expect(sessions).toHaveTextContent("claude-fable-5");
    expect(sessions).toHaveTextContent("Codex");
    // The app row still folds the CLI into one friendly "Claude Code" row,
    // and the sessions table names the same runtime in its Runtime column.
    expect(within(panel).getAllByText("Claude Code").length).toBeGreaterThan(0);
  });

  it("shows absence as a dash when the API predates the session details", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        byAgent: [
          { source: "claude_code", model: null, durationSeconds: 3_600, sessionCount: null, maxConcurrent: null, medianSeconds: null },
        ],
      }),
    })} />);

    const panel = await openAllStats(person);
    const sessions = await within(panel).findByTestId("agent-sessions");
    const cells = [...sessions.querySelectorAll("tbody td")].map((cell) => cell.textContent);
    // Runtime and model lead; sessions, max at once and median are dashes,
    // never fake zeros; the duration the API did send still renders.
    expect(cells).toEqual(["Claude Code", "-", "-", "-", "1h 00m", "-"]);
  });
});

describe("settings", () => {
  it("round-trips the recording switch and the quiet-time limit", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    expect(await within(dialog).findByLabelText("Record my work time on this computer")).toBeChecked();

    await person.click(within(dialog).getByLabelText("Record my work time on this computer"));
    await waitFor(() => expect(bridge.monitorSetEnabled).toHaveBeenCalledWith(false));

    await person.click(within(dialog).getByLabelText("Keep recording while an AI tool is working"));
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ agentOverrideEnabled: false }));

    await person.click(within(dialog).getByLabelText("Add the Clock-In extension to my browsers automatically"));
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ browserAutoInstall: false }));

    const quiet = within(dialog).getByLabelText("End a stretch after this many quiet minutes");
    await person.clear(quiet);
    await person.type(quiet, "15");
    await person.tab();
    await waitFor(() => expect(bridge.settingsUpdate).toHaveBeenCalledWith({ awayThresholdMinutes: 15 }));
  });

  it("keeps the overlay open when a settings write is refused", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(status),
      monitorSetEnabled: vi.fn().mockRejectedValue({ kind: "transient", message: "Settings could not be saved" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByLabelText("Record my work time on this computer"));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Settings could not be saved");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("has no folders-and-projects group left to configure", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const dialog = await openSettings(person);
    await within(dialog).findByText("Recording");
    expect(within(dialog).queryByText("Folders and projects")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Folder")).not.toBeInTheDocument();
  });

  it("shows connected tools as badges and connects one through the dropdown", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByText("AI tools"));

    // Connected tools are a fact, not a control; only the add needs buttons.
    const badge = within(within(dialog).getByTestId("hook-connected")).getByText("Claude Code");
    expect(badge).toBeInTheDocument();
    // No session has named a model, so the badge's second line is the dash:
    // absence as absence, never a zero.
    expect(badge.closest("li")).toHaveTextContent("-");
    expect(within(dialog).getAllByRole("button", { name: "Connect" })).toHaveLength(1);

    const picker = within(dialog).getByLabelText("Tool to connect");
    await person.selectOptions(picker, "codex");
    await person.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(bridge.hookRegister).toHaveBeenCalledWith("codex"));
  });

  it("names the models a connected tool has driven and what an unconnected one can report", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(status),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        byAgent: [
          { source: "claude_code", model: "claude-fable-5", durationSeconds: 3_600, sessionCount: 2, maxConcurrent: 1, medianSeconds: 1_800 },
          { source: "claude_code", model: null, durationSeconds: 600, sessionCount: 1, maxConcurrent: 1, medianSeconds: 600 },
        ],
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByText("AI tools"));

    // The badge's second line names the models seen, and a session that
    // named none adds nothing to it.
    const badge = await within(within(dialog).getByTestId("hook-connected")).findByText("Claude Code");
    await waitFor(() => expect(badge.closest("li")).toHaveTextContent("claude-fable-5"));

    // The picker says whether a runtime can report a model at all, straight
    // from the roster's own declaration.
    const picker = within(dialog).getByLabelText("Tool to connect");
    expect(within(picker).getByRole("option", { name: "Codex · cannot name its model" })).toBeInTheDocument();
  });

  it("opens the what's-recorded panel from the recording group", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByRole("button", { name: /See exactly what's recorded/ }));

    const panel = await screen.findByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText("Recording is on")).toBeInTheDocument();
    // Escape closes the panel it belongs to, leaving settings open behind it.
    await person.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "What Clock-In is recording" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("logs out and returns to the sign-in form", async () => {
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByRole("button", { name: "Log out" }));

    await waitFor(() => expect(bridge.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("the what's-recorded panel", () => {
  it("opens from the recording line and lists every source", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    await person.click(await screen.findByRole("button", { name: "What's recorded?" }));

    const panel = await screen.findByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText("Claude Code").closest("li")).toHaveTextContent("Connected");
    expect(within(panel).getByText("Codex").closest("li")).toHaveTextContent("Not connected");
    expect(within(panel).getByTestId("panel-current")).toHaveTextContent("Field work");

    await person.click(within(panel).getByRole("button", { name: "Close what's recorded" }));
    expect(screen.queryByRole("dialog", { name: "What Clock-In is recording" })).not.toBeInTheDocument();
  });

  it("turns recording on from the panel when it is off", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({ ...status, enabled: false, running: false, observing: false }),
      monitorSetEnabled: vi.fn().mockResolvedValue({ ...settings, enabled: true }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "What's recorded?" }));
    const panel = await screen.findByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText("Recording is off")).toBeInTheDocument();

    await person.click(within(panel).getByRole("button", { name: "Turn recording on" }));
    await waitFor(() => expect(bridge.monitorSetEnabled).toHaveBeenCalledWith(true));
  });

  it("connects an AI tool from the panel and shows what to paste when it cannot", async () => {
    const bridge = bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(status),
      hookRegister: vi.fn().mockResolvedValue({
        status: "manual",
        configPath: "C:/Users/dev/.codex/config.toml",
        snippet: "notify = [\"clock-in-hook\"]",
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    await person.click(await screen.findByRole("button", { name: "What's recorded?" }));
    const panel = await screen.findByRole("dialog", { name: "What Clock-In is recording" });
    await person.click(within(panel).getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(bridge.hookRegister).toHaveBeenCalledWith("codex"));
    expect(await within(panel).findByText(/can't switch this one on by itself/)).toBeInTheDocument();
    expect(within(panel).getByText('notify = ["clock-in-hook"]')).toBeInTheDocument();
  });
});

describe("the today panel", () => {
  it("lays out where today's time went: projects first, then apps in one row each", async () => {
    render(<App bridge={bridgeFor({
      // No open stretch: the rows below are exactly the server totals.
      monitorStatus: vi.fn().mockResolvedValue({
        ...status,
        agentActive: { source: "claude_code", since: "2026-08-06T14:10:00.000Z" },
      }),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        projects: [
          { project: { id: project.id, name: project.name }, durationSeconds: 5_400, attributedSeconds: 5_400, unattributedSeconds: 0, sessionCount: 2 },
          { project: { id: otherProject.id, name: otherProject.name }, durationSeconds: 900, attributedSeconds: 0, unattributedSeconds: 900, sessionCount: 1 },
        ],
        apps: [
          { processName: "claude.exe", durationSeconds: 3_600 },
          { processName: "chrome.exe", durationSeconds: 1_800 },
          { processName: "Code.exe", durationSeconds: 900 },
        ],
      }),
    })} />);

    // Time consolidates under the projects the monitor filed it into.
    const projects = within(await screen.findByTestId("project-list")).getAllByRole("listitem");
    expect(projects[0]).toHaveTextContent("Field work");
    expect(projects[0]).toHaveTextContent("1h 30m");
    expect(projects[1]).toHaveTextContent("Client work");
    expect(projects[1]).toHaveTextContent("15m");

    const rows = within(screen.getByTestId("session-app-list")).getAllByRole("listitem");
    // Heaviest first, agent CLIs named by their runtime rather than their exe.
    expect(rows[0]).toHaveTextContent("Claude Code");
    expect(rows[0]).toHaveTextContent("1h 00m");
    expect(rows[1]).toHaveTextContent("Google Chrome");
    expect(rows[1]).toHaveTextContent("30m");
    expect(rows[2]).toHaveTextContent("VS Code");
    expect(rows[2]).toHaveTextContent("15m");
  });

  it("draws the hourly chart as real path geometry once the API sends buckets", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        hourly: [
          { hourStart: "2026-08-15T09:00:00.000Z", activeSeconds: 600, agentSeconds: 300 },
          { hourStart: "2026-08-15T10:00:00.000Z", activeSeconds: 1_800, agentSeconds: 900 },
          { hourStart: "2026-08-15T11:00:00.000Z", activeSeconds: 300, agentSeconds: 0 },
        ],
      }),
    })} />);

    // The chart must emit <path d="M… L…"> elements, not polylines fed a
    // path string: `points` cannot parse path commands, so a polyline would
    // hold zero points and the graph would be an empty frame.
    const graph = await screen.findByTestId("hourly-graph");
    const lines = graph.querySelectorAll("path");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const d = line.getAttribute("d");
      expect(d).toMatch(/^M\d/);
      expect(d).toContain("L");
    }
  });

  it("keeps agent runtimes on their own rows instead of folding them together", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [
          { processName: "claude.exe", durationSeconds: 3_600 },
          { processName: "codex.exe", durationSeconds: 1_800 },
        ],
      }),
    })} />);

    const list = await screen.findByTestId("session-app-list");
    // Which tool the time went to is the question this surface answers, so
    // "Agent CLIs" as one row would defeat the point.
    expect(within(list).getByText("Claude Code")).toBeInTheDocument();
    expect(within(list).getByText("Codex")).toBeInTheDocument();
    expect(within(list).queryByText("Agent CLIs")).not.toBeInTheDocument();
  });

  it("adds the open stretch to its project's row so the breakdown ticks with the clock", async () => {
    const live = {
      ...recording,
      currentSession: {
        ...recording.currentSession,
        since: new Date(Date.now() - 30_000).toISOString(),
      },
    };
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(live),
      // The server knows nothing yet; the row below exists purely live.
      meStats: vi.fn().mockResolvedValue({ ...meStats, totalDurationSeconds: 0, apps: [], projects: [] }),
    })} />);

    const projects = within(await screen.findByTestId("project-list")).getAllByRole("listitem");
    expect(projects[0]).toHaveTextContent("Field work");
    expect(projects[0]).toHaveTextContent(/\d+s/);
  });

  it("counts the still-open span so the app in front is neither frozen nor missing", async () => {
    const live = {
      ...recording,
      // In front for two minutes, and no upload covers it yet.
      openSpan: { processName: "WindowsTerminal.exe", since: new Date(Date.now() - 120_000).toISOString() },
    };
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(live),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [{ processName: "Code.exe", durationSeconds: 60 }],
      }),
    })} />);

    const rows = within(await screen.findByTestId("session-app-list")).getAllByRole("listitem");
    // The open app appears at all - the server has never heard of it - and
    // outranks the app the server does know about.
    expect(rows[0]).toHaveTextContent("Windows Terminal");
    expect(rows[0]).toHaveTextContent("2m");
    expect(rows[1]).toHaveTextContent("VS Code");
  });

  it("puts the plan reading on an agent's row instead of a share bar", async () => {
    const quotaStatus = vi.fn().mockResolvedValue({
      status: "ready",
      checkedAt: "2026-08-12T19:00:00.000Z",
      detail: null,
      providers: [{
        provider: "claude",
        label: "Claude",
        sources: ["claude_code"],
        status: "known",
        account: { email: "dev@clock-in.test", organization: null },
        plan: "max",
        percentRemaining: 73,
        bindingWindowId: "five_hour",
        windows: [{ id: "five_hour", label: "session", kind: "session", percentRemaining: 73, resetsAt: null }],
        detail: null,
        reason: null,
        stale: false,
      }],
    });
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      quotaStatus,
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [{ processName: "claude.exe", durationSeconds: 3_600 }],
      }),
    })} />);

    // One row: the agent that is working, its own running time, and its plan
    // reading - not a separate list of every tool that could be installed.
    const rows = within(await screen.findByTestId("session-app-list")).getAllByRole("listitem");
    const row = rows.find((candidate) => candidate.textContent?.includes("Claude Code"));
    expect(row).toBeDefined();
    // The dial carries the whole reading as its label, so the arc is never
    // the only thing saying it.
    expect(await within(row!).findByRole("button", { name: /73% remaining on the max plan/i })).toBeInTheDocument();
  });

  it("asks again while the plan reading is still pending", async () => {
    const pending = { status: "pending" as const, checkedAt: null, detail: null, providers: [] };
    const ready = {
      status: "ready" as const,
      checkedAt: "2026-08-12T19:00:00.000Z",
      detail: null,
      providers: [{
        provider: "claude",
        label: "Claude",
        sources: ["claude_code"],
        status: "known" as const,
        account: null,
        plan: "max",
        percentRemaining: 73,
        bindingWindowId: "five_hour",
        windows: [{ id: "five_hour", label: "session", kind: "session", percentRemaining: 73, resetsAt: null }],
        detail: null,
        reason: null,
        stale: false,
      }],
    };
    // The host answers the first call from an empty cache while it reads the
    // providers behind it; the dial must not sit on "checking" until the slow
    // poll comes round.
    const quotaStatus = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(ready);
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({
        ...recording,
        agentSessions: [{ source: "claude_code", externalSessionId: "one", projectId: project.id, since: new Date().toISOString() }],
      }),
      quotaStatus,
    })} />);

    await screen.findByTestId("session-app-list");
    await waitFor(() => expect(quotaStatus.mock.calls.length).toBeGreaterThan(1), { timeout: 5_000 });
    expect(await screen.findByRole("button", { name: /73% remaining/i })).toBeInTheDocument();
  }, 10_000);

  it("shows the OS icon for an app when the host has one", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(recording),
      appIcons: vi.fn().mockResolvedValue({ "chrome.exe": "data:image/png;base64,AAAA", "Code.exe": null }),
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        apps: [
          { processName: "chrome.exe", durationSeconds: 1_800 },
          { processName: "Code.exe", durationSeconds: 900 },
        ],
      }),
    })} />);

    const list = await screen.findByTestId("session-app-list");
    // The real icon when the OS offers one, a quiet placeholder when not.
    await waitFor(() => {
      const image = list.querySelector("img.app-mark");
      expect(image).toHaveAttribute("src", "data:image/png;base64,AAAA");
    });
    expect(list.querySelector(".app-mark.is-plain")).not.toBeNull();
  });

  it("ships a runtime mark for every connector in the roster", async () => {
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    await screen.findByText("Recording on");
    await userEvent.setup().click(screen.getByRole("button", { name: "What's recorded?" }));

    const panel = await screen.findByRole("dialog", { name: "What Clock-In is recording" });
    for (const source of ["claude_code", "codex"]) {
      const mark = within(panel).getByTestId(`agent-mark-${source}`);
      // A real mark, not a letter tile standing in for one.
      expect(mark.querySelector("svg")).not.toBeNull();
      expect(mark).not.toHaveClass("is-generic");
    }
  });
});

describe("the all-stats overlay scope", () => {
  it("offers no project scope select and fetches every project", async () => {
    const bridge = bridgeFor({
      preferencesGet: vi.fn().mockResolvedValue({ scope: otherProject.id, range: "30d" }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    // The main screen's filing bar already answers "which project"; the
    // overlay reads everything and never touches the shared preference row.
    expect(within(panel).queryByLabelText("Project scope")).not.toBeInTheDocument();
    await waitFor(() => expect(bridge.orgOverview).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
    ));
    expect(bridge.preferencesGet).not.toHaveBeenCalled();
    expect(bridge.preferencesSet).not.toHaveBeenCalled();
  });
});

describe("the team board", () => {
  it("ranks the workspace and marks the signed-in member", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    // The board is history, so it sits behind "All stats" with the rest of it.
    const board = within(await openAllStats(person)).getByTestId("board-list");
    expect(within(board).getByText("Sam")).toBeInTheDocument();
    expect(within(board).getByText("you")).toBeInTheDocument();
  });

  it("opens on your own breakdown and follows whichever member gets picked", async () => {
    const samStats = {
      ...meStats,
      totalDurationSeconds: 5_400,
      apps: [{ processName: "blender.exe", durationSeconds: 5_400 }],
    };
    const bridge = bridgeFor({
      meStats: vi.fn().mockImplementation((_fromAt?: string, _toExclusiveAt?: string, userId?: string) =>
        Promise.resolve(userId === undefined ? meStats : samStats)),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    // You are highlighted and shown by default.
    const stats = within(panel).getByTestId("member-stats");
    expect(within(stats).getByRole("heading", { name: /Timer User · Today/ })).toBeInTheDocument();

    // Picking Sam swaps the breakdown to Sam, fetched by their id.
    await person.click(within(panel).getByRole("button", { name: /Sam/ }));
    expect(await within(stats).findByRole("heading", { name: /Sam · Today/ })).toBeInTheDocument();
    await waitFor(() => expect(bridge.meStats).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      "b1c7e513-b094-4d4c-ae55-21790ae019a4",
    ));
    expect(await within(stats).findByText("Blender")).toBeInTheDocument();
  });

  it("writes the breakdown in plain words and drops empty agent buckets", async () => {
    const bridge = bridgeFor({
      meStats: vi.fn().mockResolvedValue({
        ...meStats,
        activeSeconds: 14_400,
        agentSeconds: 21_600,
        concurrency: { t0Seconds: 3_600, t1Seconds: 3_600, t2Seconds: 0, t3PlusSeconds: 5_400, awaySeconds: 1_800 },
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    const stats = within(panel).getByTestId("member-stats");
    const breakdown = within(stats).getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("Human work");
    expect(breakdown).toHaveTextContent("With 1 agent");
    expect(breakdown).toHaveTextContent("With 3+ agents");
    expect(breakdown).toHaveTextContent("1h 30m");
    expect(breakdown).toHaveTextContent("Agents while away");
    expect(breakdown).toHaveTextContent("30m");
    expect(breakdown).not.toHaveTextContent("With 2 agents");
  });

  it("keeps the breakdown quiet when there is nothing recorded", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const panel = await openAllStats(person);
    const stats = within(panel).getByTestId("member-stats");
    const breakdown = within(stats).getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("Human work");
    expect(breakdown).not.toHaveTextContent("Total agent time");
    expect(within(stats).queryByTestId("agent-sessions")).not.toBeInTheDocument();
  });

  it("offers a way back to your own breakdown after picking a teammate", async () => {
    const samStats = {
      ...meStats,
      totalDurationSeconds: 5_400,
      apps: [{ processName: "blender.exe", durationSeconds: 5_400 }],
    };
    const bridge = bridgeFor({
      meStats: vi.fn().mockImplementation((_fromAt?: string, _toExclusiveAt?: string, userId?: string) =>
        Promise.resolve(userId === undefined ? meStats : samStats)),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    const stats = within(panel).getByTestId("member-stats");
    await person.click(within(panel).getByRole("button", { name: /Sam/ }));
    expect(await within(stats).findByRole("heading", { name: /Sam · Today/ })).toBeInTheDocument();

    await person.click(within(stats).getByRole("button", { name: "Show my own" }));
    expect(await within(stats).findByRole("heading", { name: /Timer User · Today/ })).toBeInTheDocument();
  });

  it("surfaces a failed self/today read instead of a blank or endless state", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue(status),
      meStats: vi.fn().mockRejectedValue({ kind: "transient", message: "The stats service is unavailable." }),
    })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The stats service is unavailable.");
    expect(screen.queryByTestId("today-panel-empty")).not.toBeInTheDocument();

    const panel = await openAllStats(person);
    const stats = within(panel).getByTestId("member-stats");
    expect(within(stats).getByRole("alert")).toHaveTextContent("The stats service is unavailable.");
    expect(within(stats).queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("rides out fewer than three failed refreshes on last-good data", async () => {
    vi.useFakeTimers();
    const failure = { kind: "transient", message: "The stats service is unavailable." };
    const meStatsMock = vi.fn()
      .mockResolvedValueOnce(meStats)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(meStats);
    render(<App bridge={bridgeFor({ meStats: meStatsMock })} />);

    // The first read lands; the day is on screen.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("session-app-list")).toBeInTheDocument();

    // Two failed background refreshes keep the numbers and stay quiet.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(meStatsMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-app-list")).toBeInTheDocument();

    // The third consecutive failure earns the banner - beside the data.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("The stats service is unavailable.");
    expect(screen.getByTestId("session-app-list")).toBeInTheDocument();

    // The next success clears it and resets the count.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("joins another workspace by invite code from settings", async () => {
    const bridge = bridgeFor({
      preferencesGet: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
  preferencesSet: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
  orgOverview: vi.fn().mockResolvedValue({
        organization: { id: "00000000-0000-4000-8000-000000000900", name: "SIQstack", inviteCode: "ACDEF-GHJKM" },
        entries: [{ rank: 1, user: { id: user.id, name: user.name }, durationSeconds: 0, sessionCount: 0, activeSeconds: 0, agentSeconds: 0 }],
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    // Team management is settings, not the record surface.
    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Team"));

    await person.type(await screen.findByLabelText("Their invite code"), "PQRTU-VWXY3");
    await person.click(screen.getByRole("button", { name: "Join this team" }));

    await waitFor(() => expect(bridge.orgJoin).toHaveBeenCalledWith("PQRTU-VWXY3"));
    // The group names the team you are now on, in a sentence rather than as a
    // bare heading beside a code. The home header names it too, so the
    // assertion is scoped to the settings dialog.
    expect(await within(dialog).findByText("Joined Team")).toBeInTheDocument();
    expect(within(dialog).getByTestId("invite-code")).toHaveTextContent("PQRTU-VWXY3");
  });

  it("re-reads the account after joining so the picker lists the new workspace's projects", async () => {
    const joinedProject = { id: "00000000-0000-4000-8000-000000000020", name: "Joined project", color: null };
    const joinedAccount = {
      ...account,
      projects: [joinedProject],
      defaultProjectId: joinedProject.id,
    };
    const bootstrap = vi.fn()
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce(joinedAccount);
    const bridge = bridgeFor({ bootstrap });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Team"));
    await person.type(await screen.findByLabelText("Their invite code"), "PQRTU-VWXY3");
    await person.click(screen.getByRole("button", { name: "Join this team" }));

    await waitFor(() => expect(bridge.bootstrap).toHaveBeenCalledTimes(2));
    await person.click(within(dialog).getByRole("button", { name: "Close settings" }));
    await person.click(screen.getByRole("button", { name: "Change" }));

    expect(await screen.findByRole("radio", { name: "Joined project" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Field work" })).not.toBeInTheDocument();
  });
});

describe("the agents tab", () => {
  it("switches from the human board to a read-only agent roster and back", async () => {
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    // Humans is the default: the board and the member breakdown are on screen.
    expect(within(panel).getByTestId("board-list")).toBeInTheDocument();
    expect(within(panel).getByTestId("member-stats")).toBeInTheDocument();
    expect(within(panel).queryByTestId("agent-roster-list")).not.toBeInTheDocument();

    await person.click(within(panel).getByRole("button", { name: "Agents" }));

    const roster = await within(panel).findByTestId("agent-roster-list");
    expect(within(roster).getByText("Claude Code @ Field work")).toBeInTheDocument();
    expect(within(roster).getByText(/1h 30m/)).toBeInTheDocument();
    const row = within(roster).getByText("Claude Code @ Field work").closest("li");
    expect(row).toHaveClass("is-anonymous");
    expect(row).toHaveTextContent("Claude Code · claude-fable-5 · 2 shifts");
    // The human board and its breakdown step aside while Agents is open.
    expect(within(panel).queryByTestId("board-list")).not.toBeInTheDocument();
    expect(within(panel).queryByTestId("member-stats")).not.toBeInTheDocument();
    await waitFor(() => expect(bridge.agentsReport).toHaveBeenCalled());

    await person.click(within(panel).getByRole("button", { name: "Humans" }));
    expect(within(panel).getByTestId("board-list")).toBeInTheDocument();
    expect(within(panel).queryByTestId("agent-roster-list")).not.toBeInTheDocument();
  });

  it("reports every roster agent, zero-activity ones included, with no register control", async () => {
    const bridge = bridgeFor({
      agentsReport: vi.fn().mockResolvedValue({
        headcount: { total: 2, active: 1, retired: 1 },
        rows: [
          {
            agent: {
              id: "00000000-0000-4000-8000-000000000501",
              name: "Codex @ Field work",
              source: "codex",
              status: "registered" as const,
              owner: { id: user.id, name: user.name },
              project: { id: project.id, name: project.name },
            },
            agentSeconds: 0,
            shiftCount: 0,
            commitsRecorded: 0,
            commitsPending: 0,
            commitsMerged: 0,
            commitsReverted: 0,
            commitsOrphaned: 0,
            heldRate: null,
            models: [],
          },
          {
            agent: {
              id: "00000000-0000-4000-8000-000000000502",
              name: "Claude Code @ Field work",
              source: "claude_code",
              status: "retired" as const,
              owner: { id: user.id, name: user.name },
              project: null,
            },
            agentSeconds: 3_600,
            shiftCount: 1,
            commitsRecorded: 2,
            commitsPending: 0,
            commitsMerged: 1,
            commitsReverted: 1,
            commitsOrphaned: 0,
            heldRate: 0.5,
            models: ["claude-fable-5"],
          },
        ],
      }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    await person.click(within(panel).getByRole("button", { name: "Agents" }));

    const roster = await within(panel).findByTestId("agent-roster-list");
    expect(within(roster).queryByRole("button", { name: "Register" })).not.toBeInTheDocument();
    const zeroRow = within(roster).getByText("Codex @ Field work").closest("li");
    expect(zeroRow).not.toHaveClass("is-anonymous");
    expect(zeroRow).toHaveTextContent("0s");
    expect(zeroRow).toHaveTextContent("0 shifts");
    expect(zeroRow).toHaveTextContent("pending");
    const retiredRow = within(roster).getByText("Claude Code @ Field work").closest("li");
    expect(retiredRow).toHaveTextContent("retired");
    expect(retiredRow).toHaveTextContent("50% held");
  });
});

describe("the update banner", () => {
  it("announces a downloading update and the restart that follows", async () => {
    let announce: ((version: string) => void) | undefined;
    const bridge = bridgeFor({
      onUpdateAvailable: vi.fn().mockImplementation(async (handler: (version: string) => void) => {
        announce = handler;
        return () => undefined;
      }),
    });
    render(<App bridge={bridge} />);
    await screen.findByRole("button", { name: "Settings" });

    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
    act(() => announce?.("0.9.9"));

    const banner = await screen.findByTestId("update-banner");
    expect(banner).toHaveTextContent("Version 0.9.9");
    expect(banner).toHaveTextContent("restarts itself");
  });
});

describe("the projects list", () => {
  it("tags the default project and hides its delete button", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Projects"));

    const list = within(dialog).getByTestId("project-manage-list");
    const defaultRow = within(list).getByText("Field work").closest("li");
    expect(defaultRow).not.toBeNull();
    expect(within(defaultRow as HTMLElement).getByText("default")).toBeInTheDocument();
    expect(within(defaultRow as HTMLElement).getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(within(defaultRow as HTMLElement).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    const otherRow = within(list).getByText("Client work").closest("li");
    expect(otherRow).not.toBeNull();
    expect(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("counts agent sessions in the delete confirmation", async () => {
    const bridge = bridgeFor({
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 2, durationSeconds: 3_600, agentSessionCount: 5 }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Projects"));

    const list = within(dialog).getByTestId("project-manage-list");
    const otherRow = within(list).getByText("Client work").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    const confirm = await within(dialog).findByTestId("project-delete-confirm");
    expect(confirm).toHaveTextContent("2 sessions");
    expect(confirm).toHaveTextContent("5 agent sessions");
  });

  it("deletes an empty project on the click, with no confirmation panel", async () => {
    const projectDelete = vi.fn().mockResolvedValue(undefined);
    const bridge = bridgeFor({
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 0, durationSeconds: 0, agentSessionCount: 0 }),
      projectDelete,
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Projects"));

    const list = within(dialog).getByTestId("project-manage-list");
    const otherRow = within(list).getByText("Client work").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(projectDelete).toHaveBeenCalledWith(otherProject.id, null));
    expect(within(dialog).queryByTestId("project-delete-confirm")).not.toBeInTheDocument();
  });

  it("asks for a move-or-delete choice instead of a typed name", async () => {
    const bridge = bridgeFor({
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 2, durationSeconds: 3_600, agentSessionCount: 5 }),
    });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(within(dialog).getByText("Projects"));

    const list = within(dialog).getByTestId("project-manage-list");
    const otherRow = within(list).getByText("Client work").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    const confirm = await within(dialog).findByTestId("project-delete-confirm");
    expect(confirm).toHaveTextContent("What happens to its sessions?");
    expect(within(confirm).queryByLabelText(/type the project's name to confirm/i)).not.toBeInTheDocument();
    await waitFor(() => expect(within(confirm).getByRole("button", { name: "Delete Client work" })).toBeEnabled());
  });
});
