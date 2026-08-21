import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { agentRuntimeLabel, type MeStatsResponse } from "@siqshift/shared";
import { App, buildAppRows, rangeQuery } from "./App.js";
import { ClientError, type Client } from "./client.js";
import { windowsInstallerUrl } from "./DownloadInstaller.js";

// jsdom has no WebGL context; the shader is decorative.
vi.mock("@siqshift/shared/webgl-shader", () => ({ WebGLShader: () => null }));

const organization = { id: "00000000-0000-4000-8000-000000000001", name: "SIQstack", inviteCode: "ACDEF-GHJKM" };

const noMeasurement = {
  concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
  byAgent: [] as never[],
};

const entries = [
  { rank: 1, user: { id: "u1", name: "Sam" }, durationSeconds: 7_200, sessionCount: 3, attributedSeconds: 5_400, unattributedSeconds: 1_800, activeSeconds: 8_040, agentSeconds: 10_800, ...noMeasurement },
  { rank: 2, user: { id: "u2", name: "Alex" }, durationSeconds: 3_600, sessionCount: 1, attributedSeconds: 3_600, unattributedSeconds: 0, activeSeconds: 3_600, agentSeconds: 0, ...noMeasurement },
];

/// The signed-in viewer is Alex, so the board highlights u2 by default.
const self = { id: "u2", email: "alex@example.com", name: "Alex" };

const memberStats = {
  filters: {},
  totalDurationSeconds: 7_200,
  attributedSeconds: 5_400,
  unattributedSeconds: 1_800,
  activeSeconds: 7_200,
  agentSeconds: 3_600,
  concurrency: { t0Seconds: 3_600, t1Seconds: 3_600, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
  byAgent: [
    { source: "claude_code", model: "claude-fable-5", durationSeconds: 3_000, sessionCount: 4, maxConcurrent: 2, medianSeconds: 750 },
    { source: "claude_code", model: null, durationSeconds: 600, sessionCount: 1, maxConcurrent: 1, medianSeconds: 600 },
  ],
  hourly: [],
  projects: [
    { project: { id: "p1", name: "General" }, durationSeconds: 7_200, attributedSeconds: 5_400, unattributedSeconds: 1_800, sessionCount: 3 },
  ],
  apps: [
    { processName: "claude.exe", durationSeconds: 3_600 },
    { processName: "Code.exe", durationSeconds: 1_800 },
  ],
  sites: [],
  agents: [],
};

const rosterAgent = {
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "Claude Code @ General",
  source: "claude_code",
  status: "anonymous" as const,
  owner: { id: "u2", name: "Alex" },
  project: { id: "p1", name: "General" },
  repoName: "siqshift",
  repoRoot: "C:/dev/siqshift",
  createdAt: "2026-08-01T00:00:00.000Z",
};

/// The Agents tab's map: two codebases, three shifts, one decided commit.
const agentShiftsResponse = {
  filters: {},
  totalAgentSeconds: 7_200,
  /// Heaviest first, summing back to the total the way the server builds it.
  people: [
    { owner: { id: "u2", name: "Alex" }, agentSeconds: 5_400, shiftCount: 2 },
    { owner: { id: "u3", name: "Sam" }, agentSeconds: 1_800, shiftCount: 1 },
  ],
  groups: [
    {
      repo: "siqshift",
      agentSeconds: 5_400,
      shiftCount: 2,
      heldRate: 0.5,
      shifts: [
        {
          id: "00000000-0000-4000-8000-000000000601",
          source: "claude_code",
          owner: { id: "u2", name: "Alex" },
          model: "claude-opus-5",
          startedAt: "2026-08-06T15:00:00.000Z",
          endedAt: "2026-08-06T16:00:00.000Z",
          agentSeconds: 3_600,
          commitCount: 2,
        },
        {
          id: "00000000-0000-4000-8000-000000000602",
          source: "claude_code",
          owner: { id: "u2", name: "Alex" },
          model: null,
          startedAt: "2026-08-06T13:00:00.000Z",
          endedAt: "2026-08-06T13:30:00.000Z",
          agentSeconds: 1_800,
          commitCount: 0,
        },
      ],
    },
    {
      repo: null,
      agentSeconds: 1_800,
      shiftCount: 1,
      heldRate: null,
      shifts: [{
        id: "00000000-0000-4000-8000-000000000603",
        source: "pi",
        owner: { id: "u2", name: "Alex" },
        model: "deepseek-v4-pro",
        startedAt: "2026-08-06T12:00:00.000Z",
        endedAt: "2026-08-06T12:30:00.000Z",
        agentSeconds: 1_800,
        commitCount: 1,
      }],
    },
  ],
};

function clientFor(overrides: Partial<Client> = {}): Client {
  return {
    hasSession: false,
    signIn: vi.fn().mockResolvedValue(undefined),
    signUp: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    organization: vi.fn().mockResolvedValue({ organization }),
    claimAdmin: vi.fn().mockRejectedValue(new ClientError("validation", "A workspace administrator already exists.")),
    leaderboard: vi.fn().mockResolvedValue({ entries, totalDurationSeconds: 10_800, medianSessionSeconds: 1_800, filters: {} }),
    me: vi.fn().mockResolvedValue({ user: self }),
    meStats: vi.fn().mockResolvedValue(memberStats),
    projects: vi.fn().mockResolvedValue({ projects: [{ id: "p1", name: "General", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false, isDefault: true }], selectedProjectId: null }),
    preferences: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
    updatePreferences: vi.fn().mockResolvedValue({ scope: "all", range: "30d" }),
    report: vi.fn().mockResolvedValue({ rows: [], totalDurationSeconds: 0, filters: {}, pagination: { page: 1, pageSize: 25, totalRows: 0, totalPages: 0 } }),
    joinOrganization: vi.fn().mockResolvedValue(undefined),
    restoreSession: vi.fn().mockResolvedValue(false),
    agentShifts: vi.fn().mockResolvedValue(agentShiftsResponse),
    ...overrides,
  } as unknown as Client;
}

async function signIn(client: Client) {
  const person = userEvent.setup();
  render(<App client={client} />);
  await person.type(await screen.findByLabelText("Email"), "alex@example.com");
  await person.type(screen.getByLabelText("Password"), "long-enough-password");
  await person.click(screen.getByRole("button", { name: "Sign in" }));
  return person;
}

describe("app row folding", () => {
  it("never folds an agent runtime into Everything else", () => {
    // Nine heavy apps outrank a lightly-used Claude Code; the fold must not
    // swallow the agent row that anchors its by-agent note.
    const apps = [
      ...Array.from({ length: 9 }, (_, index) => ({ processName: `app-${index}.exe`, durationSeconds: 9_000 - index })),
      { processName: "claude.exe", durationSeconds: 60 },
    ];

    const rows = buildAppRows(apps);

    expect(rows.map((row) => row.key)).toContain("claude_code");
    const fold = rows.find((row) => row.key === "everything-else");
    // The fold keeps only the non-agent tail.
    expect(fold?.durationSeconds).toBe(9_000 - 8);
    expect(rows.filter((row) => row.agent)).toHaveLength(1);
  });
});

describe("dashboard", () => {
  it("ranks the team by active hours, with agent time as its own muted line", async () => {
    await signIn(clientFor());

    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    const board = within(screen.getByRole("region", { name: "Leaderboard" }));
    const [first, second] = await board.findAllByRole("listitem");
    expect(first).toHaveTextContent("Sam");
    expect(first).toHaveTextContent("2h 14m");
    // Sam's 3h of agent runtime reads as leverage, never as hours worked.
    expect(first).toHaveTextContent("Agent 3h 00m · 1.3×");
    expect(second).toHaveTextContent("Alex");
    expect(second).toHaveTextContent("1h 00m");
  });

  it("shows the invite code and copies it on request", async () => {
    const person = await signIn(clientFor());
    expect(await screen.findByText("ACDEF-GHJKM")).toBeInTheDocument();

    // userEvent.setup() installs a getter-only clipboard stub, so spy on it
    // rather than replacing the property.
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await person.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("ACDEF-GHJKM");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("explains how the app works from the dashboard help button", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "How SIQshift works" }));

    const dialog = screen.getByRole("dialog", { name: "How SIQshift works" });
    expect(dialog).toHaveTextContent("Install the desktop app");
    expect(within(dialog).getByRole("link", { name: /download/i })).toBeInTheDocument();

    // The same story the desktop app's "what's recorded" panel tells.
    expect(dialog).toHaveTextContent("There is no timer to start and none to forget.");
    expect(dialog).toHaveTextContent("Hours are filed under a project.");
    const kept = within(dialog).getByRole("heading", { name: "SIQshift writes down" }).nextElementSibling;
    expect(kept).toHaveTextContent("The name only.");
    // Identity is keyed on the repository and the repository is named by its
    // remote, so the remote leaves the machine too and the sentence says so.
    expect(kept).toHaveTextContent("origin remote URL with any embedded credentials removed");
    const never = within(dialog).getByRole("heading", { name: "SIQshift never writes down" }).nextElementSibling;
    expect(never).toHaveTextContent("Not one keystroke.");
    // The remote is a repository name, not browsing, and the never-list says so
    // rather than claiming a category the code no longer honours.
    expect(never).toHaveTextContent("Browsing addresses, history, or page content.");
    expect(never).toHaveTextContent("is not browsing");
    expect(never).toHaveTextContent("Anything you type into a form, chat, or document.");
    expect(never).toHaveTextContent("SIQshift never reaches inside or controls your other apps.");
    expect(dialog).toHaveTextContent("Everyone sees the same numbers.");

    await person.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await person.click(screen.getByRole("button", { name: "How SIQshift works" }));
    await person.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reloads with device-local instant bounds when the range changes", async () => {
    const leaderboard = vi.fn().mockResolvedValue({ entries, totalDurationSeconds: 10_800, filters: {} });
    const person = await signIn(clientFor({ leaderboard }));
    await screen.findByRole("heading", { name: "SIQstack" });

    const callsBefore = leaderboard.mock.calls.length;
    await person.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() => expect(leaderboard.mock.calls.length).toBeGreaterThan(callsBefore));
    const query = new URLSearchParams(leaderboard.mock.calls.at(-1)?.[0]);
    expect(query.get("fromAt")).not.toBeNull();
    expect(query.get("toExclusiveAt")).not.toBeNull();
  });

  it("asks for everything by sending no bounds on all time", async () => {
    const leaderboard = vi.fn().mockResolvedValue({ entries, totalDurationSeconds: 10_800, filters: {} });
    const person = await signIn(clientFor({ leaderboard }));
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "All time" }));

    await waitFor(() => expect(leaderboard).toHaveBeenLastCalledWith(""));
  });

  it("uses local calendar midnights across a daylight-saving boundary", () => {
    // 2026-03-08 is the US spring-forward Sunday; the week began Monday the 2nd.
    const now = new Date(2026, 2, 8, 12);
    const query = new URLSearchParams(rangeQuery("7d", now));
    const from = new Date(query.get("fromAt")!);
    const toExclusive = new Date(query.get("toExclusiveAt")!);

    expect(from.getHours()).toBe(0);
    expect(toExclusive.getHours()).toBe(0);
    expect(from.getDate()).toBe(2);
    expect(toExclusive.getDate()).toBe(9);
  });

  it("passes the invite code through sign-up and omits it when blank", async () => {
    const signUp = vi.fn().mockResolvedValue(undefined);
    const person = userEvent.setup();
    render(<App client={clientFor({ signUp })} />);

    await person.click(await screen.findByRole("button", { name: "New here? Create an account" }));
    await person.type(screen.getByLabelText("Name"), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), "alex@example.com");
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.type(screen.getByLabelText(/Invite code/), "  ACDEF-GHJKM ");
    await person.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signUp).toHaveBeenCalledWith({
      email: "alex@example.com",
      password: "long-enough-password",
      name: "Alex Morgan",
      inviteCode: "ACDEF-GHJKM",
    }));
  });

  it("walks a brand-new account through the download step before the dashboard", async () => {
    const person = userEvent.setup();
    render(<App client={clientFor()} />);

    await person.click(await screen.findByRole("button", { name: "New here? Create an account" }));
    await person.type(screen.getByLabelText("Name"), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), "alex@example.com");
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("heading", { name: /the app/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", windowsInstallerUrl);

    await person.click(screen.getByRole("button", { name: "Skip to your dashboard" }));
    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
  });

  it("names the new workspace when no invite code is given", async () => {
    const signUp = vi.fn().mockResolvedValue(undefined);
    const person = userEvent.setup();
    render(<App client={clientFor({ signUp })} />);

    await person.click(await screen.findByRole("button", { name: "New here? Create an account" }));
    await person.type(screen.getByLabelText("Name"), "Alex Morgan");
    await person.type(screen.getByLabelText("Email"), "alex@example.com");
    await person.type(screen.getByLabelText("Password"), "long-enough-password");
    await person.type(screen.getByLabelText(/Workspace name/), "  SIQstack  ");
    await person.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signUp).toHaveBeenCalledWith({
      email: "alex@example.com",
      password: "long-enough-password",
      name: "Alex Morgan",
      workspaceName: "SIQstack",
    }));
  });

  it("hides the workspace name field once an invite code is entered", async () => {
    const person = userEvent.setup();
    render(<App client={clientFor()} />);

    await person.click(await screen.findByRole("button", { name: "New here? Create an account" }));
    expect(screen.getByLabelText(/Workspace name/)).toBeInTheDocument();

    await person.type(screen.getByLabelText(/Invite code/), "ACDEF-GHJKM");
    expect(screen.queryByLabelText(/Workspace name/)).not.toBeInTheDocument();
  });

  it("takes a returning account straight to the dashboard", async () => {
    await signIn(clientFor());

    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /the app/i })).not.toBeInTheDocument();
  });

  it("restores a live session on load and skips the sign-in form", async () => {
    const client = clientFor({ restoreSession: vi.fn().mockResolvedValue(true) });
    render(<App client={client} />);

    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("returns to sign-in with a readable message when the session expires", async () => {
    const client = clientFor({
      leaderboard: vi.fn().mockRejectedValue(new ClientError("auth", "Your session expired. Sign in again.")),
    });
    await signIn(client);

    expect(await screen.findByRole("alert")).toHaveTextContent("session expired");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("keeps the dashboard up and reports a transient failure without signing out", async () => {
    const client = clientFor({
      leaderboard: vi.fn().mockRejectedValue(new ClientError("transient", "The server is unavailable. Try again shortly.")),
    });
    await signIn(client);

    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("shows an actionable error for a wrong password and stays on the form", async () => {
    const signInMock = vi.fn().mockRejectedValue(new ClientError("auth", "Incorrect email or password."));
    await signIn(clientFor({ signIn: signInMock }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("keeps the workspace on screen when the API refuses the report calls", async () => {
    // The live failure: a deployed API that predates the instant-bound filters
    // 400s both report calls. Promise.all threw the successful /organization
    // away with them, so a server-side refusal read as an empty account.
    const refused = () => new ClientError("validation", "The server would not accept that request.");
    await signIn(clientFor({
      leaderboard: vi.fn().mockRejectedValue(refused()),
      meStats: vi.fn().mockRejectedValue(refused()),
    }));

    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    expect(await screen.findByText("ACDEF-GHJKM")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("would not accept");
  });

  it("distinguishes a card that failed to load from a range with nothing in it", async () => {
    const refused = () => new ClientError("validation", "The server would not accept that request.");
    await signIn(clientFor({
      leaderboard: vi.fn().mockRejectedValue(refused()),
      meStats: vi.fn().mockRejectedValue(refused()),
    }));

    const board = within(await screen.findByRole("region", { name: "Leaderboard" }));
    expect(await board.findByText("Could not load hours for this range.")).toBeInTheDocument();
    // A zero total is a claim about the data; nothing was loaded to claim it from.
    expect(board.queryByText(/No recorded time in this range yet/)).not.toBeInTheDocument();
    expect(await board.findByText("Could not load this member's breakdown.")).toBeInTheDocument();
  });

  it("says so plainly when a range has no recorded time", async () => {
    await signIn(clientFor({
      leaderboard: vi.fn().mockResolvedValue({ entries: [], totalDurationSeconds: 0, filters: {} }),
      meStats: vi.fn().mockResolvedValue({ ...memberStats, totalDurationSeconds: 0, projects: [], apps: [], byAgent: [] }),
    }));

    expect(await screen.findByText(/No recorded time in this range yet/)).toBeInTheDocument();
    expect(await screen.findByText("No recorded time in this range.")).toBeInTheDocument();
  });

  it("keeps the install hint beside a roster-only zero row", async () => {
    await signIn(clientFor({
      leaderboard: vi.fn().mockResolvedValue({
        entries: [{ rank: 1, user: { id: "u2", name: "Alex" }, durationSeconds: 0, sessionCount: 0, attributedSeconds: 0, unattributedSeconds: 0, activeSeconds: 0, agentSeconds: 0, ...noMeasurement }],
        totalDurationSeconds: 0,
        filters: {},
      }),
    }));

    const board = within(await screen.findByRole("region", { name: "Leaderboard" }));
    expect(await board.findByText(/No recorded time in this range yet/)).toBeInTheDocument();
    expect(await board.findByRole("button", { name: /Alex/ })).toHaveTextContent("0s");
  });

  it("claims the first admin role once on sign-in and swallows the existing-admin refusal", async () => {
    const claimAdmin = vi.fn().mockRejectedValue(new ClientError("validation", "A workspace administrator already exists."));
    await signIn(clientFor({ claimAdmin }));

    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    expect(claimAdmin).toHaveBeenCalledTimes(1);
    // A 409 once an admin exists is a silent no-op, never an error on screen.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/administrator already exists/)).not.toBeInTheDocument();
  });

  it("opens on your own breakdown, with agent tools folded into named rows", async () => {
    await signIn(clientFor());

    const board = within(await screen.findByRole("region", { name: "Leaderboard" }));
    // You are the highlighted row from the start.
    expect(await board.findByRole("button", { name: /Alex/ })).toHaveAttribute("aria-pressed", "true");
    const stats = within(await screen.findByRole("region", { name: /Alex · Last 30 days/ }));
    // The breakdown leads with active time and splits it into human work and
    // the agent-assisted buckets that actually have time in them.
    const breakdown = stats.getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("Active time");
    expect(breakdown).toHaveTextContent("2h 00m");
    expect(breakdown).toHaveTextContent("Human work");
    expect(breakdown).toHaveTextContent("With 1 agent");
    expect(breakdown).not.toHaveTextContent("With 2 agents");
    // What the agents themselves added up to is the agent's number, not the
    // person's; it lives on the Agents tab now, with its own table.
    expect(breakdown).not.toHaveTextContent("while away");
    expect(breakdown).not.toHaveTextContent("Total agent time");
    expect(stats.queryByTestId("agent-sessions")).not.toBeInTheDocument();
    expect(stats.getByText("General")).toBeInTheDocument();
    // claude.exe reads as the tool it is, so the team sees Claude usage plainly.
    expect(stats.getAllByText("Claude Code").length).toBeGreaterThan(0);
    expect(stats.getByText("VS Code")).toBeInTheDocument();
    expect(stats.getByText(/30m of that landed in the default project/)).toBeInTheDocument();
  });

  it("renders an older API response that lacks the hourly series", async () => {
    const olderStats = { ...memberStats, hourly: undefined } as unknown as MeStatsResponse;
    await signIn(clientFor({ meStats: vi.fn().mockResolvedValue(olderStats) }));

    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    const stats = within(await screen.findByRole("region", { name: /Alex · Last 30 days/ }));
    expect(stats.getByTestId("breakdown")).toHaveTextContent("Active time");
    expect(stats.queryByTestId("hourly-graph")).not.toBeInTheDocument();
  });

  it("draws the hourly chart as real path geometry once the API sends buckets", async () => {
    await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        hourly: [
          { hourStart: "2026-08-15T09:00:00.000Z", activeSeconds: 600, agentSeconds: 300, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
          { hourStart: "2026-08-15T10:00:00.000Z", activeSeconds: 1_800, agentSeconds: 900, inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 },
          { hourStart: "2026-08-15T11:00:00.000Z", activeSeconds: 300, agentSeconds: 0, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
        ],
      }),
    }));

    const stats = within(await screen.findByRole("region", { name: /Alex · Last 30 days/ }));
    // Pin the series by their hooks, never by a path count: gradient areas
    // are paths too. The chart must emit <path d="M… L…"> elements, not
    // polylines fed a path string: `points` cannot parse path commands, so a
    // polyline would hold zero points and the graph would be an empty frame.
    const graph = stats.getByTestId("hourly-graph");
    const agentLine = graph.querySelector('path[data-series="agent"]');
    const humanLine = graph.querySelector('path[data-series="human"]');
    expect(agentLine).not.toBeNull();
    expect(humanLine).not.toBeNull();
    for (const line of [agentLine, humanLine]) {
      const d = line!.getAttribute("d")!;
      expect(d).toMatch(/^M\d/);
      expect(d).toContain("L");
    }
    // Geometry is measured, not just present: the busiest hour must plot
    // highest (smallest y), and an empty hour must sit on the baseline.
    const points = [...agentLine!.getAttribute("d")!.matchAll(/[ML]([\d.]+),([\d.]+)/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
    expect(points).toHaveLength(3);
    expect(points[1]!.y).toBeLessThan(points[0]!.y);
    expect(points[2]!.y).toBeGreaterThan(points[1]!.y);
    // Day resolution draws a visible dot per bucket.
    expect(graph.querySelectorAll('circle[data-point="agent"]')).toHaveLength(3);
  });

  it("switches the hourly chart to tokens, breaking the line over hours that reported none", async () => {
    await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        agents: [{
          agent: { ...rosterAgent, owner: undefined },
          agentSeconds: 3_600,
          shiftCount: 2,
          commitsRecorded: 0,
          commitsPending: 0,
          commitsMerged: 0,
          commitsReverted: 0,
          commitsOrphaned: 0,
          heldRate: null,
          models: [],
          tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          tokensReported: false,
        }],
        hourly: [
          { hourStart: "2026-08-15T09:00:00.000Z", activeSeconds: 600, agentSeconds: 300, inputTokens: 4_000, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 8_000 },
          { hourStart: "2026-08-15T10:00:00.000Z", activeSeconds: 1_800, agentSeconds: 900, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
          { hourStart: "2026-08-15T11:00:00.000Z", activeSeconds: 300, agentSeconds: 100, inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 },
        ],
      }),
    }));

    const stats = within(await screen.findByRole("region", { name: /Alex · Last 30 days/ }));
    const graph = stats.getByTestId("hourly-graph");
    // The time view says nothing about tokens; the note belongs to the token
    // series alone, where it names the runtime that reported none.
    expect(graph).not.toHaveTextContent(/No token data/);
    const measure = within(graph).getByRole("group", { name: "Chart measure" });
    await userEvent.click(within(measure).getByRole("button", { name: "Tokens" }));
    expect(graph).toHaveTextContent("No token data from Claude Code.");

    const tokensIn = graph.querySelector('path[data-series="tokens-in"]');
    const tokensOut = graph.querySelector('path[data-series="tokens-out"]');
    expect(tokensIn).not.toBeNull();
    expect(tokensOut).not.toBeNull();
    // The null hour lifts the pen: two subpaths, never a plunge to the baseline.
    const d = tokensIn!.getAttribute("d")!;
    expect(d.match(/M/g)).toHaveLength(2);
    const points = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((match) => Number(match[2]));
    expect(points).toHaveLength(2);
    expect(points[1]!).toBeLessThan(points[0]!); // 72.4k plots above 12k
  });

  it("hides the tokens measure when nothing in the range reported tokens", async () => {
    await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        hourly: [
          { hourStart: "2026-08-15T09:00:00.000Z", activeSeconds: 600, agentSeconds: 300, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
          { hourStart: "2026-08-15T10:00:00.000Z", activeSeconds: 1_800, agentSeconds: 900, inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
        ],
      }),
    }));

    const stats = within(await screen.findByRole("region", { name: /Alex · Last 30 days/ }));
    const graph = stats.getByTestId("hourly-graph");
    expect(within(graph).queryByRole("group", { name: "Chart measure" })).not.toBeInTheDocument();
    expect(graph).not.toHaveTextContent("No token data from");
  });

  it("labels 3+ concurrency in plain words and leaves the agents' own totals to their tab", async () => {
    await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 5_400, awaySeconds: 1_800 },
      }),
    }));

    const stats = within(await screen.findByRole("region", { name: /Alex · Last 30 days/ }));
    const breakdown = stats.getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("With 3+ agents");
    expect(breakdown).toHaveTextContent("1h 30m");
    expect(breakdown).not.toHaveTextContent("With 2 agents");
    expect(breakdown).not.toHaveTextContent("With 1 agent");
    expect(breakdown).not.toHaveTextContent("while away");
  });

  it("keeps the breakdown quiet when there is nothing recorded", async () => {
    await signIn(clientFor({
      meStats: vi.fn().mockResolvedValue({
        ...memberStats,
        activeSeconds: 0,
        agentSeconds: 0,
        concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
        byAgent: [],
      }),
    }));

    const stats = within(await screen.findByRole("region", { name: /Alex · Last 30 days/ }));
    const breakdown = stats.getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("Human work");
    expect(breakdown).not.toHaveTextContent("Total agent time");
    expect(stats.queryByTestId("agent-sessions")).not.toBeInTheDocument();
  });

  it("follows whichever member gets picked on the board", async () => {
    const meStats = vi.fn().mockResolvedValue(memberStats);
    const person = await signIn(clientFor({ meStats }));

    const board = within(await screen.findByRole("region", { name: "Leaderboard" }));
    await person.click(await board.findByRole("button", { name: /Sam/ }));

    expect(await screen.findByRole("region", { name: /Sam · Last 30 days/ })).toBeInTheDocument();
    const query = new URLSearchParams((meStats.mock.calls.at(-1)?.[0] as string).replace(/^\?/, ""));
    expect(query.get("userId")).toBe("u1");
    expect(query.get("fromAt")).not.toBeNull();
  });

  it("offers a way back to your own breakdown after picking a teammate", async () => {
    const person = await signIn(clientFor());

    const board = within(await screen.findByRole("region", { name: "Leaderboard" }));
    await person.click(await board.findByRole("button", { name: /Sam/ }));
    await screen.findByRole("region", { name: /Sam · Last 30 days/ });

    await person.click(screen.getByRole("button", { name: "Show my own" }));
    expect(await screen.findByRole("region", { name: /Alex · Last 30 days/ })).toBeInTheDocument();
  });

  it("lets a stranded account join a teammate's workspace and reloads", async () => {
    const joinOrganization = vi.fn().mockResolvedValue(undefined);
    const organizationCall = vi.fn().mockResolvedValue({ organization });
    const person = await signIn(clientFor({
      joinOrganization,
      organization: organizationCall,
      leaderboard: vi.fn().mockResolvedValue({ entries: [entries[1]], totalDurationSeconds: 3_600, filters: {} }),
    }));
    await screen.findByRole("heading", { name: "Joining a teammate?" });

    await person.type(screen.getByLabelText("Invite code to join"), "acdef-ghjkm");
    await person.click(screen.getByRole("button", { name: "Join" }));

    await waitFor(() => expect(joinOrganization).toHaveBeenCalledWith("acdef-ghjkm"));
    // The dashboard reloads so the new workspace replaces the old one on screen.
    await waitFor(() => expect(organizationCall.mock.calls.length).toBeGreaterThan(1));
  });

  it("explains why an account with recorded time cannot move", async () => {
    const joinOrganization = vi.fn().mockRejectedValue(
      new ClientError("validation", "This account already recorded time here, so it cannot move."),
    );
    const person = await signIn(clientFor({
      joinOrganization,
      leaderboard: vi.fn().mockResolvedValue({ entries: [entries[1]], totalDurationSeconds: 3_600, filters: {} }),
    }));
    await screen.findByRole("heading", { name: "Joining a teammate?" });

    await person.type(screen.getByLabelText("Invite code to join"), "ACDEF-GHJKM");
    await person.click(screen.getByRole("button", { name: "Join" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("cannot move");
  });

  it("hides the join prompt once the workspace has more than one member", async () => {
    await signIn(clientFor());

    // Wait for the board itself; before the entries land the join prompt may
    // legitimately flash for a workspace that still looks empty.
    const board = within(await screen.findByRole("region", { name: "Leaderboard" }));
    await board.findByText("Sam");
    expect(screen.queryByRole("heading", { name: "Joining a teammate?" })).not.toBeInTheDocument();
  });
});

describe("getting the desktop app", () => {
  it("leaves the sign-in page alone", async () => {
    const { container } = render(<App client={clientFor()} />);
    await screen.findByRole("heading", { name: "Sign in" });

    // Signing in is the only thing anyone came to this page to do, so the
    // download control is not floated over it.
    expect(container.querySelector(".download-menu, .download-corner")).toBeNull();
    expect(screen.queryByRole("link", { name: /download/i })).not.toBeInTheDocument();
  });

  it("keeps the same installer one pill wide in the dashboard masthead", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "SIQstack" });

    const trigger = screen.getByRole("button", { name: /download/i });
    expect(trigger.closest(".masthead-actions")).not.toBeNull();
    // Nothing of the download's own is in the header row until it is asked for.
    expect(screen.queryByRole("link", { name: /installer|download/i })).not.toBeInTheDocument();

    await person.click(trigger);
    expect(screen.getByRole("link", { name: "Download for Windows" }))
      .toHaveAttribute("href", windowsInstallerUrl);
  });

  it("hands out one installer everywhere, including from the help dialog", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "SIQstack" });
    await person.click(screen.getByRole("button", { name: "How SIQshift works" }));

    const dialog = screen.getByRole("dialog", { name: "How SIQshift works" });
    expect(within(dialog).getByRole("link", { name: "Download for Windows" }))
      .toHaveAttribute("href", windowsInstallerUrl);
  });
});

describe("project management", () => {
  const webProjects = [
    { id: "p1", name: "General", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false, isDefault: true },
    { id: "p2", name: "Client", createdAt: "2026-08-11T12:00:00.000Z", isArchived: false, isDefault: false },
  ];

  it("drops the Unassigned scope and reads a stored unassigned as everything", async () => {
    const leaderboard = vi.fn().mockResolvedValue({ entries, totalDurationSeconds: 10_800, filters: {} });
    await signIn(clientFor({
      preferences: vi.fn().mockResolvedValue({ scope: "unassigned", range: "30d" }),
      leaderboard,
    }));

    const scope = await screen.findByLabelText("Project scope");
    await waitFor(() => expect(scope).toHaveValue("all"));
    expect(within(scope).queryByRole("option", { name: "Unassigned" })).not.toBeInTheDocument();
    // The board fetched the unscoped view rather than passing "unassigned" through.
    await waitFor(() => {
      const query = leaderboard.mock.calls.at(-1)?.[0] ?? "";
      expect(query).not.toContain("scope=unassigned");
      expect(query).not.toContain("scope=");
    });
  });

  it("tags the default project and hides its delete button", async () => {
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
    }));
    await screen.findByRole("heading", { name: "SIQstack" });
    await person.click(screen.getByRole("button", { name: "Projects" }));

    const dialog = screen.getByRole("dialog", { name: "Projects" });
    const defaultRow = within(dialog).getByText("General").closest("li");
    expect(defaultRow).not.toBeNull();
    expect(within(defaultRow as HTMLElement).getByText("default")).toBeInTheDocument();
    expect(within(defaultRow as HTMLElement).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    const otherRow = within(dialog).getByText("Client").closest("li");
    expect(otherRow).not.toBeNull();
    expect(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("deletes an empty project on the click, with no confirmation panel", async () => {
    const deleteProject = vi.fn().mockResolvedValue(undefined);
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 0, durationSeconds: 0, agentSessionCount: 0, agentCount: 0 }),
      deleteProject,
    }));
    await screen.findByRole("heading", { name: "SIQstack" });
    await person.click(screen.getByRole("button", { name: "Projects" }));

    const dialog = screen.getByRole("dialog", { name: "Projects" });
    const otherRow = within(dialog).getByText("Client").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p2", { reassignTo: null }));
    expect(within(dialog).queryByText("What happens to its sessions?")).not.toBeInTheDocument();
  });

  it("shows counts and a move-or-delete choice instead of a typed name", async () => {
    const person = await signIn(clientFor({
      projects: vi.fn().mockResolvedValue({ projects: webProjects, selectedProjectId: null }),
      projectUsage: vi.fn().mockResolvedValue({ sessionCount: 2, durationSeconds: 3_600, agentSessionCount: 5, agentCount: 3 }),
    }));
    await screen.findByRole("heading", { name: "SIQstack" });
    await person.click(screen.getByRole("button", { name: "Projects" }));

    const dialog = screen.getByRole("dialog", { name: "Projects" });
    const otherRow = within(dialog).getByText("Client").closest("li");
    await person.click(within(otherRow as HTMLElement).getByRole("button", { name: "Delete" }));

    await within(dialog).findByText("What happens to its sessions?");
    expect(dialog).toHaveTextContent("2 sessions");
    expect(dialog).toHaveTextContent("5 agent sessions");
    // The roster identities hold the project through a restrict FK, so the
    // admin sees them before confirming rather than after a 500.
    expect(dialog).toHaveTextContent("3 roster agents move with it");
    expect(within(dialog).queryByLabelText(/type the project's name to confirm/i)).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete Client" })).toBeEnabled());
  });
});

describe("the agents tab", () => {
  it("maps every shift under its codebase, with the total recorded on top", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Agents" }));

    const panel = within(await screen.findByTestId("agent-shifts"));
    // The header mirrors a member's breakdown: the range and the recorded
    // total, then the codebases, heaviest first - no leaderboard to filter.
    expect(panel.getByRole("heading", { level: 3, name: /Agents ·/ })).toBeInTheDocument();
    expect(panel.getByText("2h 00m")).toBeInTheDocument();
    const groups = panel.getAllByTestId("shift-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("siqshift");
    expect(groups[0]).toHaveTextContent("50% held");
    // The label-less group's commits are all pending: it says nothing rather
    // than "pending", because a rate with no decided commits is not a fact.
    expect(groups[1]).toHaveTextContent("No codebase recorded");
    expect(groups[1]!.textContent).not.toMatch(/held|pending/);
  });

  it("emits the meter row the layout suite styles, four cells to a row", async () => {
    // tests/browser/harness.ts hand-writes this markup to measure it in a real
    // browser, because jsdom has no layout engine. That only holds while the
    // app really does emit these classes, so this is the pin between the two.
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Agents" }));
    const heads = within(await screen.findByTestId("agent-shifts")).getAllByTestId("shift-group")
      .map((group) => group.querySelector(".shift-group-head"));

    for (const head of heads) {
      expect(head).not.toBeNull();
      expect(head!).toHaveClass("meter-row");
      expect(head!.children).toHaveLength(4);
      // The drawer's own contract, and the reason the count above must stay
      // four: the head is the `summary` and it is the `details`' first child.
      // jsdom only treats the first `summary` as the toggle, so a wrapper
      // would silently disable opening in tests while still working in
      // Chromium, and a fifth cell would wrap the four-track grid.
      expect(head!.tagName).toBe("SUMMARY");
      expect(head!.parentElement!.tagName).toBe("DETAILS");
      expect(head!.parentElement!.firstElementChild).toBe(head);
    }
  });

  it("opens on a board of the people whose agents ran, heaviest first", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Agents" }));
    const board = within(await screen.findByTestId("agent-people"));

    const rows = board.getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Alex"),
      expect.stringContaining("Sam"),
    ]);
    // Two measures, and the shift count is the one that says a row can be
    // several agents at once rather than one worker's long day.
    expect(rows[0]).toHaveTextContent("1h 30m");
    expect(rows[0]).toHaveTextContent("2 shifts");
    expect(rows[1]).toHaveTextContent("1 shift");
    expect(rows.every((row) => row.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("narrows the tab to whoever is picked on the board, and offers a way back", async () => {
    const agentShifts = vi.fn().mockResolvedValue(agentShiftsResponse);
    const person = await signIn(clientFor({ agentShifts }));
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Agents" }));
    await screen.findByTestId("agent-people");
    const before = agentShifts.mock.calls.length;

    await person.click(within(screen.getByTestId("agent-people")).getByRole("button", { name: /Sam/ }));

    await waitFor(() => expect(agentShifts.mock.calls.length).toBeGreaterThan(before));
    const query = new URLSearchParams((agentShifts.mock.calls.at(-1)?.[0] as string).replace(/^\?/, ""));
    expect(query.get("userId")).toBe("u3");
    // The heading names who the tab is narrowed to, and the board that picked
    // them is still there to unpick them with.
    expect(await screen.findByRole("heading", { level: 3, name: /^Sam ·/ })).toBeInTheDocument();
    expect(within(screen.getByTestId("agent-people")).getAllByRole("button")).toHaveLength(2);

    await person.click(screen.getByRole("button", { name: "All people" }));

    await waitFor(() => {
      const latest = new URLSearchParams((agentShifts.mock.calls.at(-1)?.[0] as string).replace(/^\?/, ""));
      expect(latest.has("userId")).toBe(false);
    });
    expect(await screen.findByRole("heading", { level: 3, name: /^Agents ·/ })).toBeInTheDocument();
  });

  it("shows no board when one person's agents did all the work", async () => {
    const soloResponse = { ...agentShiftsResponse, people: [agentShiftsResponse.people[0]!] };
    const person = await signIn(clientFor({ agentShifts: vi.fn().mockResolvedValue(soloResponse) }));
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Agents" }));
    await screen.findByTestId("agent-shifts");

    // A board of one ranks nothing and filters nothing.
    expect(screen.queryByTestId("agent-people")).not.toBeInTheDocument();
  });

  it("keeps each codebase's shifts in a drawer that starts closed", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Agents" }));
    const group = within(await screen.findByTestId("agent-shifts")).getAllByTestId("shift-group")[0]!;

    // Never a visibility assertion here: jsdom has no rule hiding a closed
    // `details`, so the rows are in the document either way. The browser
    // suite is where the hiding itself is checked.
    expect(group).not.toHaveAttribute("open");
    // The head carries the count, so a closed drawer still says how much is
    // inside it.
    expect(group).toHaveTextContent("2 shifts");

    await person.click(group.querySelector("summary")!);

    expect(group).toHaveAttribute("open");
  });

  it("gives each codebase a Today row: a mark, the name, its share, its duration", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Agents" }));
    const groups = within(await screen.findByTestId("agent-shifts")).getAllByTestId("shift-group");

    // The head reads in the shared meter row, so a column of codebases scans
    // the way Today's breakdown does. The bar is this codebase's share of the
    // recorded agent time: 5,400s and 1,800s of 7,200s.
    const shares = groups.map((group) => {
      // `head?.querySelector(...)` would be `undefined` - and pass - when the
      // head itself is missing, so the head is asserted before it is read.
      const head = group.querySelector(".meter-row.shift-group-head");
      expect(head).not.toBeNull();
      expect(head!.querySelector(".project-dot")).not.toBeNull();
      expect(head!.querySelector(".meter-name")).not.toBeNull();
      expect(head!.querySelector(".meter-duration")).not.toBeNull();
      return head!.querySelector<HTMLElement>(".meter-bar")?.style.getPropertyValue("--share");
    });
    expect(shares).toEqual(["75%", "25%"]);
  });

  it("shows no hourly graph on all time, keeping the groups and total", async () => {
    vi.setSystemTime(new Date("2026-08-06T20:00:00.000Z"));
    try {
      const person = await signIn(clientFor());
      await screen.findByRole("heading", { name: "SIQstack" });

      await person.click(screen.getByRole("button", { name: "Agents" }));
      const panel = within(await screen.findByTestId("agent-shifts"));
      // A bounded range folds an hourly line from the shifts on screen.
      expect(panel.getByTestId("hourly-graph")).toBeInTheDocument();

      await person.click(screen.getByRole("button", { name: "All time" }));

      // Per-hour resolution over an unbounded range is meaningless, so the graph
      // goes away - but the codebase map and its total stay put.
      await waitFor(() => expect(panel.queryByTestId("hourly-graph")).not.toBeInTheDocument());
      expect(panel.getByText("2h 00m")).toBeInTheDocument();
      expect(panel.getAllByTestId("shift-group")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each shift its own line: when, who, what model, what commits", async () => {
    const person = await signIn(clientFor());
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Agents" }));

    const panel = within(await screen.findByTestId("agent-shifts"));
    const rows = within(panel.getAllByTestId("shift-group")[0]!).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Claude Code");
    expect(rows[0]).toHaveTextContent("Alex");
    expect(rows[0]).toHaveTextContent("claude-opus-5");
    expect(rows[0]).toHaveTextContent("2 commits");
    // A shift that named no model says nothing - absence is absence.
    expect(rows[1]!.textContent).not.toMatch(/not recorded/);
  });

  it("says nobody worked rather than rendering an empty map", async () => {
    const person = await signIn(clientFor({
      agentShifts: vi.fn().mockResolvedValue({ filters: {}, totalAgentSeconds: 0, groups: [] }),
    }));
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Agents" }));

    expect(await screen.findByText("No agent worked in this range.")).toBeInTheDocument();
  });
});
