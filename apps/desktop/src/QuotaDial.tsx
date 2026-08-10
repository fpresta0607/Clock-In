import { useEffect, useId, useRef, useState } from "react";

import type { AgentQuota, QuotaWindow } from "./bridge.js";

/// A compact radial gauge for how much of a coding agent's plan is left,
/// sized to sit inside an activity row without changing its height.
///
/// What it measures is the account signed in to that provider on this machine
/// *now*, not the account that recorded the row it sits beside. The detail
/// says so in as many words and names the login, so a dial that moved because
/// someone switched accounts never reads as a dial that moved because work
/// happened.
///
/// Three more things are load-bearing. The arc never carries meaning alone —
/// the percentage is printed inside it and the whole control has a spoken
/// label. Unknown is a first-class face, drawn as a dashed ring with an em
/// dash, so "we could not read this" never looks like "you have none left".
/// And the dial shows only the window that actually binds; a provider's other
/// windows live one click away rather than crowding the row.

const DIAL = 36;
const STROKE = 4;
const RADIUS = (DIAL - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const CENTER = DIAL / 2;

/// Below this the arc turns red. The number beside it is what actually tells
/// the story; colour is a second, redundant channel.
const LOW_REMAINING = 15;

/// Plans arrive as the provider writes them ("max", "pro"). An all-lowercase
/// name reads as a tier once title-cased; anything already cased is left alone
/// so "Pro+" or "Copilot Business" survive intact.
export const planLabel = (plan: string): string => {
  const trimmed = plan.trim();
  if (trimmed !== trimmed.toLowerCase()) return trimmed;
  return trimmed
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
};

/// A reset time in the user's locale. Providers write these in their own
/// dialects, so anything unparseable is simply not shown.
const resetLabel = (resetsAt: string | null): string | undefined => {
  if (resetsAt === null) return undefined;
  const parsed = Date.parse(resetsAt);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const bindingWindow = (quota: AgentQuota): QuotaWindow | undefined =>
  quota.windows.find((window) => window.id === quota.bindingWindowId);

/// Names the login the reading belongs to, and says plainly that it is the one
/// live on this machine — the row beside it may well have been recorded by a
/// different account.
export const signInNote = (quota: AgentQuota | undefined): string => {
  const email = quota?.account?.email ?? undefined;
  const organization = quota?.account?.organization ?? undefined;
  const who = email ?? organization;
  if (who === undefined) return "Shows whichever account is signed in on this machine now.";
  const qualifier = organization !== undefined && organization !== who ? ` (${organization})` : "";
  return `Signed in as ${who}${qualifier} on this machine now.`;
};

export type QuotaDialProps = {
  /// The agent the surrounding row is attributed to, spoken in the label.
  agentLabel: string;
  quota?: AgentQuota | undefined;
  /// The host is still taking its first reading; says so rather than claiming
  /// the tool reported nothing.
  pending?: boolean | undefined;
};

export const QuotaDial = ({ agentLabel, quota, pending = false }: QuotaDialProps) => {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const detailPanel = useRef<HTMLDivElement>(null);

  // The activity list this usually sits in scrolls inside its card, so an
  // opened panel can land below the fold. `nearest` moves it into view without
  // yanking the page when it was already visible.
  useEffect(() => {
    if (open) detailPanel.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  // One value carries both "is this readable" and the reading itself, so the
  // known branch never has to re-prove that the number is there.
  const reading = quota !== undefined && quota.status === "known" && quota.percentRemaining !== null
    ? { quota, remaining: quota.percentRemaining, binding: bindingWindow(quota) }
    : undefined;
  const plan = quota?.plan === undefined || quota.plan === null ? undefined : planLabel(quota.plan);
  // A pending snapshot still lists every provider, each carrying the catalog's
  // "nothing reported" line — which would be a lie while the host is mid-read.
  // Still looking beats every reason a finished read could give.
  const detail = pending
    ? "Checking this tool's quota…"
    : quota?.detail ?? "No quota reading for this tool yet.";

  // What stands in for a plan name on the face, so the visible text tells the
  // same story as the spoken label.
  const metaLabel = plan
    ?? (reading !== undefined ? "Plan unknown" : pending ? "Checking…" : "Quota unknown");

  const label = reading === undefined
    ? `${agentLabel} quota unknown. ${detail} Show quota detail.`
    : `${agentLabel} quota: ${reading.remaining}% remaining`
      + (plan === undefined ? "" : ` on the ${plan} plan`)
      + (reading.binding === undefined ? "" : `, ${reading.binding.label} window`)
      + ". Show quota detail.";

  const classes = ["quota"];
  if (reading === undefined) classes.push("is-unknown");
  else if (reading.remaining <= LOW_REMAINING) classes.push("is-low");

  return (
    <div className={classes.join(" ")}>
      <button
        type="button"
        className="quota-trigger"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={label}
        title={reading === undefined ? detail : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <svg className="quota-face" viewBox={`0 0 ${DIAL} ${DIAL}`} width={DIAL} height={DIAL} aria-hidden="true" focusable="false">
          <circle className="quota-track" cx={CENTER} cy={CENTER} r={RADIUS} fill="none" strokeWidth={STROKE} />
          {reading !== undefined && (
            <circle
              className="quota-arc"
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${(CIRCUMFERENCE * reading.remaining) / 100} ${CIRCUMFERENCE}`}
              transform={`rotate(-90 ${CENTER} ${CENTER})`}
            />
          )}
          <text className="quota-figure" x={CENTER} y={CENTER} textAnchor="middle" dominantBaseline="central">
            {reading === undefined ? "—" : `${reading.remaining}%`}
          </text>
        </svg>
        <span className="quota-meta">
          <span className="quota-plan">{metaLabel}</span>
          {reading?.binding !== undefined && <span className="quota-window">{reading.binding.label}</span>}
        </span>
      </button>
      <div id={detailId} ref={detailPanel} className="quota-detail" hidden={!open}>
        <p className="quota-account">{signInNote(quota)}</p>
        {reading === undefined ? (
          <>
            <p className="quota-note">{detail}</p>
            {quota?.reason !== undefined && quota.reason !== null && <p className="quota-reason">{quota.reason}</p>}
          </>
        ) : (
          <>
            <ul className="quota-windows">
              {reading.quota.windows.map((window) => {
                const resets = resetLabel(window.resetsAt);
                return (
                  <li key={window.id} className={window.id === reading.quota.bindingWindowId ? "is-binding" : undefined}>
                    <span className="quota-window-label">{window.label}</span>
                    <span className="quota-window-value">{window.percentRemaining}% left</span>
                    {resets !== undefined && <span className="quota-window-reset">resets {resets}</span>}
                  </li>
                );
              })}
            </ul>
            {reading.quota.stale && <p className="quota-note">This reading may be out of date.</p>}
          </>
        )}
      </div>
    </div>
  );
};
