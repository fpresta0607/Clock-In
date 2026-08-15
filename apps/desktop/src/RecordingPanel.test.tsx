import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RecordingPanel, recordingState } from "./RecordingPanel.js";
import type { MonitorStatus } from "./bridge.js";

const status: MonitorStatus = {
  enabled: true,
  running: true,
  observing: true,
  lastPollAgeSeconds: 12,
  lastUploadAt: "2026-08-09T14:55:00.000Z",
  segmentBacklog: 0,
  agentBacklog: 0,
  sessionBacklog: 0,
  hooks: [
    { source: "claude_code", detected: true, installed: true, needsYou: false, configPath: "C:/Users/dev/.claude/settings.json" },
    { source: "codex", detected: false, installed: true, needsYou: false, configPath: "C:/Users/dev/.codex/config.toml" },
  ],
  agentActive: null,
  openSpan: null,
  agentSessions: [],
  currentSession: {
    projectId: "00000000-0000-4000-8000-000000000010",
    attribution: "agent",
    since: "2026-08-09T14:00:00.000Z",
    idleSeconds: 0,
    apps: [],
  },
  selectedProjectId: null,
};

const panelFor = (overrides: Partial<Parameters<typeof RecordingPanel>[0]> = {}) => {
  const props = {
    open: true,
    onClose: vi.fn(),
    status,
    hookSnippets: {},
    browsers: [],
    projectName: "Field work",
    defaultProjectName: "Field work",
    onTurnOnRecording: vi.fn(),
    onConnectAgent: vi.fn(),
    onConnectBrowser: vi.fn(),
    onRepairBrowser: vi.fn(),
    ...overrides,
  };
  render(<RecordingPanel {...props} />);
  return props;
};

describe("recordingState", () => {
  it("separates on, paused, off, and unreachable", () => {
    expect(recordingState(status)).toBe("on");
    expect(recordingState({ ...status, running: false })).toBe("paused");
    expect(recordingState({ ...status, enabled: false, running: false })).toBe("off");
    expect(recordingState(undefined)).toBe("unknown");
  });
});

describe("RecordingPanel", () => {
  it("renders nothing while closed", () => {
    panelFor({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says recording is on and needs no fixing", async () => {
    panelFor();

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText("Recording is on")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Turn recording on" })).not.toBeInTheDocument();
    expect(within(panel).getByText("This computer").closest("li")).toHaveTextContent("On, looks every 30 seconds");
  });

  it("offers one button when recording is off", async () => {
    const person = userEvent.setup();
    const props = panelFor({ status: { ...status, enabled: false, running: false } });

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText("Recording is off")).toBeInTheDocument();
    expect(within(panel).getByText("This computer").closest("li")).toHaveTextContent("Off");

    await person.click(within(panel).getByRole("button", { name: "Turn recording on" }));
    expect(props.onTurnOnRecording).toHaveBeenCalledTimes(1);
  });

  it("explains a paused recorder without offering a switch that is already on", () => {
    panelFor({ status: { ...status, running: false } });

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText("Recording is on, but not running right now")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Turn recording on" })).not.toBeInTheDocument();
    expect(within(panel).getByText("This computer").closest("li")).toHaveTextContent("Waiting to start");
  });

  it("stays honest when the host never answered", () => {
    panelFor({ status: undefined });

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText("Clock-In can't check this computer")).toBeInTheDocument();
    expect(within(panel).queryByText("This computer")).not.toBeInTheDocument();
    // The lists and the explainer are always true, so they stay on screen.
    expect(within(panel).getByText("What you type. Not one keystroke.")).toBeInTheDocument();
    expect(within(panel).getByText("Anything you type into a form, chat, or document.")).toBeInTheDocument();
    expect(within(panel).getByText("Clock-In never reaches inside or controls your other apps.")).toBeInTheDocument();
    expect(within(panel).getByText(/You do nothing/)).toBeInTheDocument();
  });

  it("lists each agent tool as connected or not, with one button to connect it", async () => {
    const person = userEvent.setup();
    const props = panelFor();

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText("Claude Code").closest("li")).toHaveTextContent("Connected");
    const codex = within(panel).getByText("Codex").closest("li");
    expect(codex).toHaveTextContent("Not connected");

    await person.click(within(codex as HTMLElement).getByRole("button", { name: "Connect" }));
    expect(props.onConnectAgent).toHaveBeenCalledWith("codex");
  });

  // Discovery connects what it can at startup, so the list reports state
  // instead of handing out a row of Connect buttons.
  it("reports each connector's state and asks only where a person is needed", () => {
    panelFor({
      status: {
        ...status,
        hooks: [
          { source: "claude_code", detected: true, installed: true, needsYou: false, configPath: "C:/Users/dev/.claude/settings.json" },
          { source: "grok", detected: false, installed: false, needsYou: false, configPath: "C:/Users/dev/.grok/settings.json" },
          { source: "kimi_code", detected: false, installed: true, needsYou: true, configPath: "C:/Users/dev/.kimi/config.toml" },
        ],
      },
    });

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    const connected = within(panel).getByText("Claude Code").closest("li") as HTMLElement;
    expect(connected).toHaveTextContent("Connected");
    expect(within(connected).queryByRole("button")).not.toBeInTheDocument();

    // Not installed is a state, not a job for the reader.
    const absent = within(panel).getByText("Grok").closest("li") as HTMLElement;
    expect(absent).toHaveTextContent("Not on this computer");
    expect(within(absent).queryByRole("button")).not.toBeInTheDocument();

    // The one row that genuinely cannot be finished without a person.
    const manual = within(panel).getByText("Kimi Code").closest("li") as HTMLElement;
    expect(manual).toHaveTextContent("Needs a hand");
    expect(within(manual).getByRole("button", { name: "Show me how" })).toBeInTheDocument();
  });

  it("says the browser is not watched rather than implying a connection", () => {
    panelFor();

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText(/does not watch your web browser/)).toBeInTheDocument();
  });

  it("shows each browser with its connection state and the one action that finishes it", async () => {
    const person = userEvent.setup();
    const props = panelFor({
      browsers: [
        { browser: "chrome", label: "Chrome", state: "registered", storeUrl: "https://chromewebstore.google.com/" },
        { browser: "edge", label: "Edge", state: "connected", storeUrl: "https://microsoftedge.microsoft.com/addons/" },
        { browser: "firefox", label: "Firefox", state: "never-registered", storeUrl: "https://addons.mozilla.org/" },
      ],
    });

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    const chrome = within(panel).getByText("Chrome").closest("li") as HTMLElement;
    expect(chrome).toHaveTextContent("Not connected");
    await person.click(within(chrome).getByRole("button", { name: "Add extension" }));
    expect(props.onConnectBrowser).toHaveBeenCalledWith("chrome");

    const edge = within(panel).getByText("Edge").closest("li") as HTMLElement;
    expect(edge).toHaveTextContent("Connected");
    expect(within(edge).queryByRole("button")).not.toBeInTheDocument();

    const firefox = within(panel).getByText("Firefox").closest("li") as HTMLElement;
    expect(firefox).toHaveTextContent("Needs a hand");
    await person.click(within(firefox).getByRole("button", { name: "Repair" }));
    expect(props.onRepairBrowser).toHaveBeenCalledWith("firefox");
  });

  it("keeps a disabled browser off the card list", () => {
    panelFor({
      browsers: [
        { browser: "chrome", label: "Chrome", state: "disabled", storeUrl: "https://chromewebstore.google.com/" },
      ],
    });

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).queryByText("Chrome")).not.toBeInTheDocument();
    expect(within(panel).getByText(/does not watch your web browser/)).toBeInTheDocument();
  });

  it("shows what to paste when a tool cannot be connected automatically", () => {
    panelFor({ hookSnippets: { codex: 'notify = ["clock-in-hook"]' } });

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    expect(within(panel).getByText(/can't switch this one on by itself/)).toBeInTheDocument();
    expect(within(panel).getByText('notify = ["clock-in-hook"]')).toBeInTheDocument();
  });

  it("lists what is written down and what never is, in plain words", () => {
    panelFor();

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    const kept = within(panel).getByRole("heading", { name: "Clock-In writes down" }).nextElementSibling;
    expect(kept).toHaveTextContent("away from it");
    expect(kept).toHaveTextContent("The name only.");
    expect(kept).toHaveTextContent("which folder it worked in");
    expect(kept).not.toHaveTextContent(/press start/i);

    const never = within(panel).getByRole("heading", { name: "Clock-In never writes down" }).nextElementSibling;
    expect(never).toHaveTextContent("Not one keystroke.");
    expect(never).toHaveTextContent("Pictures of your screen.");
    expect(never).toHaveTextContent("titles of your windows");
    expect(never).toHaveTextContent("Web addresses");
    expect(never).toHaveTextContent("inside your files");
  });

  it("explains that nothing is pressed, and where the numbers go", () => {
    panelFor();

    const panel = screen.getByRole("dialog", { name: "What Clock-In is recording" });
    const steps = within(panel).getByRole("heading", { name: "How Clock-In works" }).nextElementSibling;
    expect(steps).toHaveTextContent("You do nothing.");
    expect(steps).toHaveTextContent("no button to press and no timer to forget");
    expect(steps).toHaveTextContent("Quiet time is never counted.");
    expect(steps).toHaveTextContent("You see what your team sees.");
  });

  it("reports when evidence last went out and how much is still waiting", () => {
    panelFor({ status: { ...status, segmentBacklog: 3, agentBacklog: 1 } });

    expect(screen.getByText(/4 notes are still waiting to be sent/)).toBeInTheDocument();
    expect(screen.getByText(/Last sent at/)).toBeInTheDocument();
  });

  it("closes on the button, the overlay, and Escape", async () => {
    const person = userEvent.setup();
    const props = panelFor();

    await person.click(screen.getByRole("button", { name: "Close what's recorded" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);

    await person.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
