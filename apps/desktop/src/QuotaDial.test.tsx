import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { QuotaDial, planLabel, signInNote } from "./QuotaDial.js";
import type { AgentQuota } from "./bridge.js";

const claude: AgentQuota = {
  provider: "claude",
  label: "Claude",
  sources: ["claude_code"],
  status: "known",
  account: { email: "dev@example.com", organization: "Example Org" },
  plan: "max",
  percentRemaining: 72,
  bindingWindowId: "seven_day",
  windows: [
    { id: "five_hour", label: "session", kind: "session", percentRemaining: 79, resetsAt: "2026-08-10T19:30:00.000Z" },
    { id: "seven_day", label: "week", kind: "weekly", percentRemaining: 72, resetsAt: "2026-08-13T21:00:00.000Z" },
  ],
  detail: null,
  reason: null,
  stale: false,
};

const unreadable: AgentQuota = {
  provider: "cursor",
  label: "Cursor",
  sources: ["cursor"],
  status: "unknown",
  account: null,
  plan: null,
  percentRemaining: null,
  bindingWindowId: null,
  windows: [],
  detail: "This tool's quota could not be read on this machine.",
  reason: "sqlite3_unavailable",
  stale: false,
};

/// The dial's own control, found by the reading it speaks rather than by class.
const dialFor = (name: RegExp): HTMLElement => screen.getByRole("button", { name });

describe("QuotaDial", () => {
  it("shows the percentage, the plan, and the window that binds", () => {
    render(<QuotaDial agentLabel="Claude Code" quota={claude} />);

    // The number is on the face, not only in the arc: colour is never the only
    // channel this reading travels on.
    const trigger = dialFor(/Claude Code quota: 72% remaining on the Max plan, week window/);
    expect(trigger).toHaveTextContent("72%");
    expect(trigger).toHaveTextContent("Max");
    expect(trigger).toHaveTextContent("week");
  });

  it("draws an arc proportional to what is left", () => {
    const { container } = render(<QuotaDial agentLabel="Claude Code" quota={claude} />);

    const arc = container.querySelector(".quota-arc");
    const [drawn, circumference] = (arc?.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
    expect(circumference).toBeGreaterThan(0);
    expect((drawn as number) / (circumference as number)).toBeCloseTo(0.72, 5);
  });

  it("marks a nearly spent plan without leaning on the colour alone", () => {
    const { container } = render(
      <QuotaDial agentLabel="Codex" quota={{ ...claude, provider: "codex", plan: "pro", percentRemaining: 4 }} />,
    );

    expect(screen.getByText("4%")).toBeInTheDocument();
    expect(container.querySelector(".quota")).toHaveClass("is-low");
  });

  it("keeps a full plan out of the low state", () => {
    const { container } = render(<QuotaDial agentLabel="Claude Code" quota={claude} />);

    expect(container.querySelector(".quota")).not.toHaveClass("is-low");
    expect(container.querySelector(".quota")).not.toHaveClass("is-unknown");
  });

  it("renders an unreadable provider as an explicit unknown, not as empty", () => {
    const { container } = render(<QuotaDial agentLabel="Cursor" quota={unreadable} />);

    expect(container.querySelector(".quota")).toHaveClass("is-unknown");
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Quota unknown")).toBeInTheDocument();
    expect(container.querySelector(".quota-arc")).toBeNull();
    expect(dialFor(/Cursor quota unknown\. This tool's quota could not be read on this machine\./)).toBeInTheDocument();
  });

  it("says it is still looking rather than claiming nothing was reported", () => {
    render(<QuotaDial agentLabel="Claude Code" pending />);

    expect(dialFor(/Claude Code quota unknown\. Checking this tool's quota…/)).toBeInTheDocument();
  });

  it("keeps saying it is looking even though a pending snapshot lists the provider", () => {
    // What the host actually hands back before its first read finishes: every
    // provider present, every one unknown, each carrying the catalogue's line.
    render(
      <QuotaDial
        agentLabel="Claude Code"
        pending
        quota={{ ...unreadable, provider: "claude", sources: ["claude_code"], detail: "No quota reported for this tool.", reason: null }}
      />,
    );

    expect(dialFor(/Claude Code quota unknown\. Checking this tool's quota…/)).toBeInTheDocument();
    // The face says the same thing the label does.
    expect(screen.getByText("Checking…")).toBeInTheDocument();
    expect(screen.queryByText("No quota reported for this tool.")).not.toBeInTheDocument();
    expect(screen.queryByText("Quota unknown")).not.toBeInTheDocument();
  });

  it("reads as unknown when no provider answered for this agent at all", () => {
    render(<QuotaDial agentLabel="Kimi Code" />);

    expect(dialFor(/Kimi Code quota unknown\. No quota reading for this tool yet\./)).toBeInTheDocument();
  });

  it("keeps the other windows one click away and marks the binding one", async () => {
    const person = userEvent.setup();
    render(<QuotaDial agentLabel="Claude Code" quota={claude} />);

    const trigger = dialFor(/Claude Code quota: 72%/);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("79% left")).not.toBeVisible();

    await person.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const session = screen.getByText("79% left");
    expect(session).toBeVisible();
    expect(session.closest("li")).toHaveTextContent("session");
    expect(screen.getByText("72% left").closest("li")).toHaveClass("is-binding");
    expect(screen.getByText("79% left").closest("li")).not.toHaveClass("is-binding");

    await person.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("puts the provider's own error code in the detail rather than the headline", async () => {
    const person = userEvent.setup();
    render(<QuotaDial agentLabel="Cursor" quota={unreadable} />);

    expect(screen.getByText("sqlite3_unavailable")).not.toBeVisible();
    await person.click(dialFor(/Cursor quota unknown/));
    expect(screen.getByText("sqlite3_unavailable")).toBeVisible();
    expect(screen.getByText("This tool's quota could not be read on this machine.")).toBeVisible();
  });

  it("admits when a shown reading is out of date", async () => {
    const person = userEvent.setup();
    render(<QuotaDial agentLabel="Claude Code" quota={{ ...claude, stale: true }} />);

    await person.click(dialFor(/Claude Code quota: 72%/));
    expect(screen.getByText("This reading may be out of date.")).toBeVisible();
  });

  it("skips a reset time it cannot parse instead of printing nonsense", async () => {
    const person = userEvent.setup();
    render(
      <QuotaDial
        agentLabel="Claude Code"
        quota={{
          ...claude,
          windows: [{ id: "seven_day", label: "week", kind: "weekly", percentRemaining: 72, resetsAt: "whenever" }],
        }}
      />,
    );

    await person.click(dialFor(/Claude Code quota: 72%/));
    expect(screen.queryByText(/resets/)).not.toBeInTheDocument();
  });

  it("names the login the reading belongs to and says it is the live one", async () => {
    const person = userEvent.setup();
    render(<QuotaDial agentLabel="Claude Code" quota={claude} />);

    await person.click(dialFor(/Claude Code quota: 72%/));
    expect(screen.getByText("Signed in as dev@example.com (Example Org) on this machine now.")).toBeVisible();
  });

  it("still says whose sign-in it means when the provider names nobody", async () => {
    const person = userEvent.setup();
    render(<QuotaDial agentLabel="Cursor" quota={unreadable} />);

    await person.click(dialFor(/Cursor quota unknown/));
    expect(screen.getByText("Shows whichever account is signed in on this machine now.")).toBeVisible();
  });

  it("reads the login from whichever field the provider filled in", () => {
    expect(signInNote({ ...claude, account: { email: "dev@example.com", organization: null } }))
      .toBe("Signed in as dev@example.com on this machine now.");
    expect(signInNote({ ...claude, account: { email: null, organization: "Example Org" } }))
      .toBe("Signed in as Example Org on this machine now.");
    expect(signInNote({ ...claude, account: null }))
      .toBe("Shows whichever account is signed in on this machine now.");
    expect(signInNote(undefined)).toBe("Shows whichever account is signed in on this machine now.");
  });

  it("follows the account the host last reported rather than holding the old one", () => {
    // The host re-reads the live credential on every refresh, so a switched
    // login arrives as a plain new reading — the dial only has to render it.
    const { rerender } = render(<QuotaDial agentLabel="Claude Code" quota={claude} />);
    expect(dialFor(/Claude Code quota: 72% remaining on the Max plan/)).toBeInTheDocument();

    rerender(
      <QuotaDial
        agentLabel="Claude Code"
        quota={{
          ...claude,
          account: { email: "someone-else@example.com", organization: null },
          plan: "pro",
          percentRemaining: 9,
        }}
      />,
    );

    const trigger = dialFor(/Claude Code quota: 9% remaining on the Pro plan/);
    expect(trigger).toHaveTextContent("9%");
    expect(screen.getByText("Signed in as someone-else@example.com on this machine now.")).toBeInTheDocument();
  });

  it("names a plan without a tier and one the provider already cased", () => {
    render(<QuotaDial agentLabel="Claude Code" quota={{ ...claude, plan: null }} />);

    expect(screen.getByText("Plan unknown")).toBeInTheDocument();
    expect(planLabel("max")).toBe("Max");
    expect(planLabel("copilot business")).toBe("Copilot Business");
    expect(planLabel("Pro+")).toBe("Pro+");
  });
});
