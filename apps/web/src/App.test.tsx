import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { ClientError, type Client } from "./client.js";

const organization = { id: "00000000-0000-4000-8000-000000000001", name: "SIQstack", inviteCode: "ACDEF-GHJKM" };

const entries = [
  { rank: 1, user: { id: "u1", name: "Sam" }, durationSeconds: 7_200, sessionCount: 3 },
  { rank: 2, user: { id: "u2", name: "Alex" }, durationSeconds: 3_600, sessionCount: 1 },
];

const rows = [
  {
    id: "s1",
    user: { id: "u1", name: "Sam" },
    project: { id: "p1", name: "General" },
    description: "Wiring the relay",
    status: "stopped" as const,
    startedAt: "2026-08-06T14:00:00.000Z",
    stoppedAt: "2026-08-06T16:00:00.000Z",
    idleSeconds: 0,
    durationSeconds: 7_200,
  },
];

function clientFor(overrides: Partial<Client> = {}): Client {
  return {
    hasSession: false,
    signIn: vi.fn().mockResolvedValue(undefined),
    signUp: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    organization: vi.fn().mockResolvedValue({ organization }),
    leaderboard: vi.fn().mockResolvedValue({ entries, totalDurationSeconds: 10_800, filters: {} }),
    report: vi.fn().mockResolvedValue({ rows, totalDurationSeconds: 7_200, filters: {}, pagination: {} }),
    exportCsv: vi.fn().mockResolvedValue(new Blob(["a,b"], { type: "text/csv" })),
    ...overrides,
  } as unknown as Client;
}

async function signIn(client: Client) {
  const person = userEvent.setup();
  render(<App client={client} />);
  await person.type(screen.getByLabelText("Email"), "alex@example.com");
  await person.type(screen.getByLabelText("Password"), "long-enough-password");
  await person.click(screen.getByRole("button", { name: "Sign in" }));
  return person;
}

describe("dashboard", () => {
  it("ranks the team and totals the range after signing in", async () => {
    await signIn(clientFor());

    expect(await screen.findByRole("heading", { name: "SIQstack" })).toBeInTheDocument();
    const board = within(screen.getByRole("region", { name: "Leaderboard" }));
    const [first, second] = board.getAllByRole("row").slice(1);
    expect(first).toHaveTextContent("Sam");
    expect(first).toHaveTextContent("02:00:00");
    expect(second).toHaveTextContent("Alex");
    expect(board.getByText("03:00:00 total")).toBeInTheDocument();
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

  it("reloads with inclusive calendar bounds when the range changes", async () => {
    const leaderboard = vi.fn().mockResolvedValue({ entries, totalDurationSeconds: 10_800, filters: {} });
    const person = await signIn(clientFor({ leaderboard }));
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.selectOptions(screen.getByRole("combobox"), "7");

    await waitFor(() => expect(leaderboard).toHaveBeenLastCalledWith(expect.stringMatching(/^\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/)));
  });

  it("passes the invite code through sign-up and omits it when blank", async () => {
    const signUp = vi.fn().mockResolvedValue(undefined);
    const person = userEvent.setup();
    render(<App client={clientFor({ signUp })} />);

    await person.click(screen.getByRole("button", { name: "New here? Create an account" }));
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

  it("exports the visible range as CSV", async () => {
    const exportCsv = vi.fn().mockResolvedValue(new Blob(["a,b"], { type: "text/csv" }));
    URL.createObjectURL = vi.fn().mockReturnValue("blob:csv");
    URL.revokeObjectURL = vi.fn();
    const person = await signIn(clientFor({ exportCsv }));
    await screen.findByRole("heading", { name: "SIQstack" });

    await person.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() => expect(exportCsv).toHaveBeenCalledWith(expect.stringContaining("from=")));
  });

  it("says so plainly when a range has no recorded time", async () => {
    await signIn(clientFor({
      leaderboard: vi.fn().mockResolvedValue({ entries: [], totalDurationSeconds: 0, filters: {} }),
      report: vi.fn().mockResolvedValue({ rows: [], totalDurationSeconds: 0, filters: {}, pagination: {} }),
    }));

    expect(await screen.findByText("No recorded time in this range yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing recorded in this range.")).toBeInTheDocument();
  });

  it("lists recent sessions with their project and duration", async () => {
    await signIn(clientFor());

    const sessions = within(await screen.findByRole("region", { name: "Recent sessions" }));
    expect(sessions.getByText("Wiring the relay")).toBeInTheDocument();
    expect(sessions.getByText("General")).toBeInTheDocument();
  });
});
