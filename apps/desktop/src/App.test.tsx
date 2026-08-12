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

const meStats = {
  filters: {},
  totalDurationSeconds: 7_200,
  attributedSeconds: 5_400,
  unattributedSeconds: 1_800,
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

const bridgeFor = (overrides: Partial<TimerBridge> = {}): TimerBridge => ({
  bootstrap: vi.fn().mockResolvedValue(account),
  login: vi.fn().mockResolvedValue(account),
  signup: vi.fn().mockResolvedValue(account),
  logout: vi.fn().mockResolvedValue(undefined),
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
  // The default is "the host cannot report": every recording surface stays
  // quiet rather than claiming something it cannot see.
  monitorStatus: vi.fn().mockRejectedValue({ kind: "unknown", message: "Recording unavailable" }),
  sessionSelectProject: vi.fn().mockResolvedValue(status),
  hookRegister: vi.fn().mockResolvedValue({ status: "registered", configPath: "C:/Users/dev/.claude/settings.json" }),
  monitorSetEnabled: vi.fn().mockResolvedValue(settings),
  settingsGet: vi.fn().mockResolvedValue(settings),
  settingsUpdate: vi.fn().mockResolvedValue(settings),
  meStats: vi.fn().mockResolvedValue(meStats),
  projectCreate: vi.fn().mockResolvedValue(newProject),
  pathMappingsList: vi.fn().mockResolvedValue([mapping]),
  pathMappingsCreate: vi.fn().mockResolvedValue(mapping),
  pathMappingsUpdate: vi.fn().mockResolvedValue(mapping),
  pathMappingsDelete: vi.fn().mockResolvedValue(undefined),
  appIcons: vi.fn().mockResolvedValue({}),
  onUpdateAvailable: vi.fn().mockResolvedValue(() => undefined),
  ...overrides,
});

/// Opens the "All stats" overlay, where everything historical now lives: the
/// main surface is the record card and this session, and nothing else.
const openAllStats = async (person: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await person.click(await screen.findByTestId("all-stats-trigger"));
  return screen.getByRole("dialog", { name: /Today so far|This week/ });
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

    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("surfaces a failed sign-in without losing the form", async () => {
    const login = vi.fn().mockRejectedValue({ kind: "auth", message: "Those details did not match." });
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }), login })} />);

    await screen.findByRole("heading", { name: "Clock in" });
    await person.type(screen.getByLabelText("Email"), user.email);
    await person.type(screen.getByLabelText("Password"), "not-stored-here");
    await person.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Those details did not match.");
    expect(screen.getByRole("heading", { name: "Clock in" })).toBeInTheDocument();
  });

  it("signs in and lands on the recording screen", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({
      bootstrap: vi.fn().mockResolvedValue({ kind: "signed-out" }),
      monitorStatus: vi.fn().mockResolvedValue(recording),
    })} />);

    await screen.findByRole("heading", { name: "Clock in" });
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

    // The clock and the day's total: no project name, no explaining sentences.
    expect(await screen.findByTestId("elapsed-time")).toBeInTheDocument();
    expect(await screen.findByTestId("today-line")).toHaveTextContent(/^Today · /);
    expect(screen.queryByText(/Filed here because/)).not.toBeInTheDocument();
    // Nothing in the product starts or stops time any more.
    expect(screen.queryByRole("button", { name: /start/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();
  });

  it("explains an idle machine instead of pretending to record", async () => {
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) })} />);

    expect(await screen.findByRole("heading", { name: "Nothing to record yet" })).toBeInTheDocument();
    expect(screen.getByText(/There is nothing to press/)).toBeInTheDocument();
  });

  it("says recording is off, and never implies otherwise", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({ ...status, enabled: false, running: false, observing: false }),
    })} />);

    expect(await screen.findByText("Recording off")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recording is off" })).toBeInTheDocument();
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

    // The live surface on the main page.
    expect(await screen.findByTestId("today-panel-empty")).not.toHaveTextContent(/turn (on )?recording/i);

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

  it("names the AI tool holding recording open in the status line", async () => {
    render(<App bridge={bridgeFor({
      monitorStatus: vi.fn().mockResolvedValue({
        ...recording,
        agentActive: { source: "kimi_code", since: "2026-08-06T14:10:00.000Z" },
      }),
    })} />);

    // One compact line instead of a sentence on the clock card.
    expect(await screen.findByText("Recording on · Kimi Code working")).toBeInTheDocument();
  });

  it("renders no recording surfaces when the host cannot report status", async () => {
    render(<App bridge={bridgeFor()} />);

    // A host that cannot answer is its own state: the screen says it is still
    // checking rather than borrowing the wording of a healthy idle machine.
    await screen.findByRole("heading", { name: "Checking this computer…" });
    await waitFor(() => expect(screen.queryByText(/^Recording (on|paused|off)$/)).not.toBeInTheDocument());
  });

  it("keeps the project picker behind the corner caret", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording) })} />);

    // Collapsed by default: no dropdown competing with the clock. The caret
    // still names the filing target for anyone who asks.
    const caret = await screen.findByTestId("filing-change");
    expect(caret).toHaveAccessibleName(/picked automatically/);
    expect(screen.queryByLabelText("File my time under")).not.toBeInTheDocument();

    await person.click(caret);
    expect(screen.getByLabelText("File my time under")).toBeVisible();

    await person.click(caret);
    expect(screen.queryByLabelText("File my time under")).not.toBeInTheDocument();
  });

  it("pins time to a project and hands the choice back to the host", async () => {
    const sessionSelectProject = vi.fn().mockResolvedValue({ ...recording, selectedProjectId: otherProject.id });
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(recording), sessionSelectProject })} />);

    await person.click(await screen.findByTestId("filing-change"));
    const picker = screen.getByLabelText("File my time under");
    // The default choice is "work it out for me", naming where that lands.
    expect(picker).toHaveValue("");
    expect(within(picker).getByRole("option", { name: /Work it out for me \(Field work\)/ })).toBeInTheDocument();

    await person.selectOptions(picker, otherProject.id);
    await waitFor(() => expect(sessionSelectProject).toHaveBeenCalledWith(otherProject.id));

    // Choosing collapses the picker and the caret names the pinned project.
    await waitFor(() => expect(screen.queryByLabelText("File my time under")).not.toBeInTheDocument());
    expect(screen.getByTestId("filing-change")).toHaveAccessibleName(/Client work/);
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

  it("names a waiting backlog and says it syncs on its own", async () => {
    const backlogged = { ...recording, segmentBacklog: 2, sessionBacklog: 1 };
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(backlogged) })} />);

    const line = await screen.findByTestId("sync-line");
    expect(line).toHaveTextContent("3 recorded items are still on this computer");
    expect(line).toHaveTextContent("sync on their own");
    // Sync is automatic: nothing here to press.
    expect(within(line).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("today", () => {
  it("totals the range and names where unattributed time landed", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) })} />);

    const panel = await openAllStats(person);
    // The card renders before the stats land, so wait for the figure itself.
    expect(await within(panel).findByText("2 hr")).toBeInTheDocument();
    expect(within(panel).getByTestId("unattributed-foot")).toHaveTextContent(
      "30 min of it landed in Field work, because nothing said which project it was for.",
    );
  });

  it("switches range and refetches from the week's start", async () => {
    const bridge = bridgeFor();
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const panel = await openAllStats(person);
    await person.click(await within(panel).findByRole("button", { name: "This week" }));

    await waitFor(() => expect(bridge.meStats).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: "This week" })).toBeInTheDocument();
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

  it("lists, adds, and deletes folder-to-project matches", async () => {
    const created = { ...mapping, id: "00000000-0000-4000-8000-000000000401", pathPrefix: "C:/dev/other" };
    const bridge = bridgeFor({ pathMappingsCreate: vi.fn().mockResolvedValue(created) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    expect(await within(dialog).findByText("C:/dev/Clock-In")).toBeInTheDocument();

    await person.type(within(dialog).getByLabelText("Folder"), "C:/dev/other");
    await person.selectOptions(within(dialog).getByLabelText("Project"), project.id);
    await person.click(within(dialog).getByRole("button", { name: "Add folder" }));
    await waitFor(() => expect(bridge.pathMappingsCreate).toHaveBeenCalledWith({ pathPrefix: "C:/dev/other", projectId: project.id }));

    const [firstDelete] = within(dialog).getAllByRole("button", { name: "Delete" });
    await person.click(firstDelete!);
    await waitFor(() => expect(bridge.pathMappingsDelete).toHaveBeenCalledWith(mapping.id));
  });

  it("shows connected tools as badges and connects one through the dropdown", async () => {
    const bridge = bridgeFor({ monitorStatus: vi.fn().mockResolvedValue(status) });
    const person = userEvent.setup();
    render(<App bridge={bridge} />);

    const dialog = await openSettings(person);
    await person.click(await within(dialog).findByText("AI tools"));

    // Connected tools are a fact, not a control; only the add needs buttons.
    expect(within(within(dialog).getByTestId("hook-connected")).getByText("Claude Code")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: "Connect" })).toHaveLength(1);

    const picker = within(dialog).getByLabelText("Tool to connect");
    await person.selectOptions(picker, "codex");
    await person.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(bridge.hookRegister).toHaveBeenCalledWith("codex"));
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
    expect(await screen.findByRole("heading", { name: "Clock in" })).toBeInTheDocument();
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
      monitorStatus: vi.fn().mockResolvedValue({
        ...recording,
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
    expect(projects[0]).toHaveTextContent("1 hr 30 min");
    expect(projects[1]).toHaveTextContent("Client work");
    expect(projects[1]).toHaveTextContent("15 min");

    const rows = within(screen.getByTestId("session-app-list")).getAllByRole("listitem");
    // Heaviest first, agent CLIs named by their runtime rather than their exe.
    expect(rows[0]).toHaveTextContent("Claude Code");
    expect(rows[0]).toHaveTextContent("1 hr");
    expect(rows[1]).toHaveTextContent("Google Chrome");
    expect(rows[1]).toHaveTextContent("30 min");
    expect(rows[2]).toHaveTextContent("VS Code");
    expect(rows[2]).toHaveTextContent("15 min");
    // The runtime that is working right now says so on its own row.
    expect(rows[0]).toHaveTextContent("working now");
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

describe("the team board", () => {
  it("ranks the workspace and marks the signed-in member", async () => {
    const person = userEvent.setup();
    render(<App bridge={bridgeFor()} />);

    // The board is history, so it sits behind "All stats" with the rest of it.
    const board = within(await openAllStats(person)).getByLabelText("SIQstack");
    expect(within(board).getByText("Sam")).toBeInTheDocument();
    expect(within(board).getByText("you")).toBeInTheDocument();
  });

  it("joins another workspace by invite code from settings", async () => {
    const bridge = bridgeFor({
      orgOverview: vi.fn().mockResolvedValue({
        organization: { id: "00000000-0000-4000-8000-000000000900", name: "SIQstack", inviteCode: "ACDEF-GHJKM" },
        entries: [{ rank: 1, user: { id: user.id, name: user.name }, durationSeconds: 0, sessionCount: 0 }],
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
    // bare heading beside a code.
    expect(await screen.findByText("Joined Team")).toBeInTheDocument();
    expect(screen.getByTestId("invite-code")).toHaveTextContent("PQRTU-VWXY3");
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
