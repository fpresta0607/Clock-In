import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App, rangeQuery } from "./App.js";
import { ClientError, type Client } from "./client.js";
import { windowsInstallerUrl } from "./DownloadInstaller.js";

// jsdom has no WebGL context; the shader is decorative.
vi.mock("./WebGLShader.js", () => ({ WebGLShader: () => null }));

const organization = { id: "00000000-0000-4000-8000-000000000001", name: "SIQstack", inviteCode: "ACDEF-GHJKM" };

const entries = [
  { rank: 1, user: { id: "u1", name: "Sam" }, durationSeconds: 7_200, sessionCount: 3, attributedSeconds: 5_400, unattributedSeconds: 1_800 },
  { rank: 2, user: { id: "u2", name: "Alex" }, durationSeconds: 3_600, sessionCount: 1, attributedSeconds: 3_600, unattributedSeconds: 0 },
];

/// The signed-in viewer is Alex, so the board highlights u2 by default.
const self = { id: "u2", email: "alex@example.com", name: "Alex" };

const memberStats = {
  filters: {},
  totalDurationSeconds: 7_200,
  attributedSeconds: 5_400,
  unattributedSeconds: 1_800,
  projects: [
    { project: { id: "p1", name: "General" }, durationSeconds: 7_200, attributedSeconds: 5_400, unattributedSeconds: 1_800, sessionCount: 3 },
  ],
  apps: [
    { processName: "claude.exe", durationSeconds: 3_600 },
    { processName: "Code.exe", durationSeconds: 1_800 },
  ],
  sites: [],
};

function clientFor(overrides: Partial<Client> = {}): Client {
  return {
    hasSession: false,
    signIn: vi.fn().mockResolvedValue(undefined),
    signUp: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    organization: vi.fn().mockResolvedValue({ organization }),
    leaderboard: vi.fn().mockResolvedValue({ entries, totalDurationSeconds: 10_800, filters: {} }),
    me: vi.fn().mockResolvedValue({ user: self }),
    meStats: vi.fn().mockResolvedValue(memberStats),
    joinOrganization: vi.fn().mockResolvedValue(undefined),
    restoreSession: vi.fn().mockResolvedValue(false),
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

describe("dashboard", () => {
  it("ranks the team in human-readable hours after signing in", async () => {
    await signIn(clientFor());

    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    const board = within(screen.getByRole("region", { name: "Leaderboard" }));
    const [first, second] = await board.findAllByRole("listitem");
    expect(first).toHaveTextContent("Sam");
    expect(first).toHaveTextContent("2 hr");
    expect(second).toHaveTextContent("Alex");
    expect(second).toHaveTextContent("1 hr");
    expect(board.getByText("3 hr total")).toBeInTheDocument();
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

    await person.click(screen.getByRole("button", { name: "How Clock-In works" }));

    const dialog = screen.getByRole("dialog", { name: "How Clock-In works" });
    expect(dialog).toHaveTextContent("Install the desktop app");
    expect(within(dialog).getByRole("link", { name: /download/i })).toBeInTheDocument();

    // The same story the desktop app's "what's recorded" panel tells.
    expect(dialog).toHaveTextContent("There is no timer to start and none to forget.");
    expect(dialog).toHaveTextContent("Hours are filed under a project.");
    const kept = within(dialog).getByRole("heading", { name: "Clock-In writes down" }).nextElementSibling;
    expect(kept).toHaveTextContent("The name only.");
    const never = within(dialog).getByRole("heading", { name: "Clock-In never writes down" }).nextElementSibling;
    expect(never).toHaveTextContent("Not one keystroke.");
    expect(never).toHaveTextContent("Web addresses");
    expect(never).toHaveTextContent("Anything you type into a form, chat, or document.");
    expect(never).toHaveTextContent("Clock-In never reaches inside or controls your other apps.");
    expect(dialog).toHaveTextContent("Everyone sees the same numbers.");

    await person.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await person.click(screen.getByRole("button", { name: "How Clock-In works" }));
    await person.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reloads with device-local instant bounds when the range changes", async () => {
    const leaderboard = vi.fn().mockResolvedValue({ entries, totalDurationSeconds: 10_800, filters: {} });
    const person = await signIn(clientFor({ leaderboard }));
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "This week" }));

    await waitFor(() => expect(leaderboard).toHaveBeenCalledTimes(2));
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
    const query = new URLSearchParams(rangeQuery("week", now));
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
    expect(screen.getByText("ACDEF-GHJKM")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("would not accept");
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
    expect(board.queryByText("No recorded time in this range yet.")).not.toBeInTheDocument();
    expect(board.getByText("Not loaded")).toBeInTheDocument();
    expect(await board.findByText("Could not load this member's breakdown.")).toBeInTheDocument();
  });

  it("says so plainly when a range has no recorded time", async () => {
    await signIn(clientFor({
      leaderboard: vi.fn().mockResolvedValue({ entries: [], totalDurationSeconds: 0, filters: {} }),
      meStats: vi.fn().mockResolvedValue({ ...memberStats, totalDurationSeconds: 0, projects: [], apps: [] }),
    }));

    expect(await screen.findByText("No recorded time in this range yet.")).toBeInTheDocument();
    expect(await screen.findByText("No recorded time in this range.")).toBeInTheDocument();
  });

  it("opens on your own breakdown, with agent tools folded into named rows", async () => {
    await signIn(clientFor());

    const board = within(await screen.findByRole("region", { name: "Leaderboard" }));
    // You are the highlighted row from the start.
    expect(await board.findByRole("button", { name: /Alex/ })).toHaveAttribute("aria-pressed", "true");
    const stats = within(await screen.findByRole("region", { name: /Alex · Today/ }));
    // The project row repeats the number, so pin the headline figure.
    expect(await stats.findByText("2 hr", { selector: "strong" })).toBeInTheDocument();
    expect(stats.getByText("General")).toBeInTheDocument();
    // claude.exe reads as the tool it is, so the team sees Claude usage plainly.
    expect(stats.getByText("Claude Code")).toBeInTheDocument();
    expect(stats.getByText("VS Code")).toBeInTheDocument();
    expect(stats.getByText(/30 min of that landed in the default project/)).toBeInTheDocument();
  });

  it("follows whichever member gets picked on the board", async () => {
    const meStats = vi.fn().mockResolvedValue(memberStats);
    const person = await signIn(clientFor({ meStats }));

    const board = within(await screen.findByRole("region", { name: "Leaderboard" }));
    await person.click(await board.findByRole("button", { name: /Sam/ }));

    expect(await screen.findByRole("region", { name: /Sam · Today/ })).toBeInTheDocument();
    const query = new URLSearchParams((meStats.mock.calls.at(-1)?.[0] as string).replace(/^\?/, ""));
    expect(query.get("userId")).toBe("u1");
    expect(query.get("fromAt")).not.toBeNull();
  });

  it("offers a way back to your own breakdown after picking a teammate", async () => {
    const person = await signIn(clientFor());

    const board = within(await screen.findByRole("region", { name: "Leaderboard" }));
    await person.click(await board.findByRole("button", { name: /Sam/ }));
    await screen.findByRole("region", { name: /Sam · Today/ });

    await person.click(screen.getByRole("button", { name: "Show my own" }));
    expect(await screen.findByRole("region", { name: /Alex · Today/ })).toBeInTheDocument();
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

    await screen.findByRole("heading", { name: "Leaderboard" });
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
    await person.click(screen.getByRole("button", { name: "How Clock-In works" }));

    const dialog = screen.getByRole("dialog", { name: "How Clock-In works" });
    expect(within(dialog).getByRole("link", { name: "Download for Windows" }))
      .toHaveAttribute("href", windowsInstallerUrl);
  });
});
