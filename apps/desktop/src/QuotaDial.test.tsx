import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { QuotaDial, planLabel, windowLine } from "./QuotaDial.js";
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

/// The same locale formatting the dial uses, so the assertion does not pin the
/// runner's time zone.
const resetText = (resetsAt: string): string => {
  const resets = new Date(resetsAt);
  const now = new Date();
  const isToday = resets.getFullYear() === now.getFullYear()
    && resets.getMonth() === now.getMonth()
    && resets.getDate() === now.getDate();
  return isToday
    ? resets.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : resets.toLocaleDateString([], { month: "short", day: "numeric" });
};

/// The dial's own control, found by the reading it speaks rather than by class.
const dialFor = (name: RegExp): HTMLElement => screen.getByRole("button", { name });

describe("QuotaDial", () => {
  it("shows the percentage, the plan, and when the binding window runs out", () => {
    render(<QuotaDial agentLabel="Claude Code" quota={claude} />);

    // The number is on the face, not only in the arc: colour is never the only
    // channel this reading travels on.
    const trigger = dialFor(/Claude Code quota: 72% remaining on the Max plan, til /);
    expect(trigger).toHaveTextContent("72%");
    expect(trigger).toHaveTextContent("Max");
    expect(trigger).toHaveTextContent(`til ${resetText("2026-08-13T21:00:00.000Z")}`);
  });

  it("names the window when the provider gave no reset time to count down to", () => {
    render(
      <QuotaDial
        agentLabel="Claude Code"
        quota={{ ...claude, windows: [{ id: "seven_day", label: "week", kind: "weekly", percentRemaining: 72, resetsAt: null }] }}
      />,
    );

    expect(screen.getByText("week")).toBeInTheDocument();
    expect(screen.queryByText(/til /)).not.toBeInTheDocument();
  });

  it("falls back to the window name rather than printing a reset it cannot parse", () => {
    render(
      <QuotaDial
        agentLabel="Claude Code"
        quota={{
          ...claude,
          windows: [{ id: "seven_day", label: "week", kind: "weekly", percentRemaining: 72, resetsAt: "whenever" }],
        }}
      />,
    );

    expect(screen.getByText("week")).toBeInTheDocument();
    expect(screen.queryByText(/whenever/)).not.toBeInTheDocument();
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

  it("keeps every window one click away, as one plain line each", async () => {
    const person = userEvent.setup();
    render(<QuotaDial agentLabel="Claude Code" quota={claude} />);

    const trigger = dialFor(/Claude Code quota: 72%/);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("79% left the session")).not.toBeVisible();

    await person.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("79% left the session")).toBeVisible();
    expect(screen.getByText("72% left the week")).toBeVisible();
    expect(screen.getByText("72% left the week").closest("li")).toHaveClass("is-binding");
    expect(screen.getByText("79% left the session").closest("li")).not.toHaveClass("is-binding");

    await person.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves the provider's own error code out of the detail entirely", async () => {
    const person = userEvent.setup();
    render(<QuotaDial agentLabel="Cursor" quota={unreadable} />);

    await person.click(dialFor(/Cursor quota unknown/));
    expect(screen.getByText("This tool's quota could not be read on this machine.")).toBeVisible();
    expect(screen.queryByText("sqlite3_unavailable")).not.toBeInTheDocument();
  });

  it("keeps the detail to the readings, with nothing else crowding them", async () => {
    const person = userEvent.setup();
    const { container } = render(<QuotaDial agentLabel="Claude Code" quota={{ ...claude, stale: true }} />);

    await person.click(dialFor(/Claude Code quota: 72%/));
    const lines = [...(container.querySelector(".quota-detail")?.querySelectorAll("li") ?? [])];
    expect(lines.map((line) => line.textContent)).toEqual(["79% left the session", "72% left the week"]);
    expect(container.querySelector(".quota-detail")?.querySelectorAll("p")).toHaveLength(0);
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

    expect(dialFor(/Claude Code quota: 9% remaining on the Pro plan/)).toHaveTextContent("9%");
  });

  it("names a plan without a tier and one the provider already cased", () => {
    render(<QuotaDial agentLabel="Claude Code" quota={{ ...claude, plan: null }} />);

    expect(screen.getByText("Plan unknown")).toBeInTheDocument();
    expect(planLabel("max")).toBe("Max");
    expect(planLabel("copilot business")).toBe("Copilot Business");
    expect(planLabel("Pro+")).toBe("Pro+");
  });

  it("spells one window the way the detail prints it", () => {
    expect(windowLine({ id: "seven_day", label: "week", kind: "weekly", percentRemaining: 27, resetsAt: null }))
      .toBe("27% left the week");
    expect(windowLine({ id: "five_hour", label: "session", kind: "session", percentRemaining: 34, resetsAt: null }))
      .toBe("34% left the session");
  });
});
