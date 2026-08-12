import { useEffect, useId, useRef, useState } from "react";

import type { AgentQuota, QuotaWindow } from "./bridge.js";

/// A compact radial gauge for how much of a coding agent's plan is left,
/// sized to sit inside an activity row without changing its height.
///
/// The row says two things and no more: the plan, and when the window that
/// binds runs out. Everything else - how much is left in each window a
/// provider reports - is one click away, one plain line each.
///
/// Two things are load-bearing. The arc never carries meaning alone: the
/// percentage is printed inside it and the whole control has a spoken label.
/// And unknown is a first-class face, drawn as a dashed ring with an em dash,
/// so "we could not read this" never looks like "you have none left".

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
/// dialects, so anything unparseable is simply not shown. The time stays in
/// alongside the date: a session window can run out this afternoon, and a bare
/// date would read as a whole day of headroom that is not there.
const resetLabel = (resetsAt: string | null): string | undefined => {
  if (resetsAt === null) return undefined;
  const parsed = Date.parse(resetsAt);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/// One window as the detail prints it: "27% left the week".
export const windowLine = (window: QuotaWindow): string =>
  `${window.percentRemaining}% left the ${window.label}`;

const bindingWindow = (quota: AgentQuota): QuotaWindow | undefined =>
  quota.windows.find((window) => window.id === quota.bindingWindowId);

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

  // The second line under the plan: when the window that binds runs out. A
  // provider that gave no reset time falls back to naming the window, which is
  // all it told us.
  const resets = reading?.binding === undefined ? undefined : resetLabel(reading.binding.resetsAt);
  const untilLine = reading?.binding === undefined
    ? undefined
    : resets === undefined ? reading.binding.label : `left until ${resets}`;

  const label = reading === undefined
    ? `${agentLabel} quota unknown. ${detail} Show quota detail.`
    : `${agentLabel} quota: ${reading.remaining}% remaining`
      + (plan === undefined ? "" : ` on the ${plan} plan`)
      + (untilLine === undefined ? "" : `, ${untilLine}`)
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
          {untilLine !== undefined && <span className="quota-window">{untilLine}</span>}
        </span>
      </button>
      {/* One line per window and nothing else. Anything the provider says
          about why a reading failed belongs to the unknown face, not here. */}
      <div id={detailId} ref={detailPanel} className="quota-detail" hidden={!open}>
        {reading === undefined ? (
          <p className="quota-note">{detail}</p>
        ) : (
          <ul className="quota-windows">
            {reading.quota.windows.map((window) => (
              <li key={window.id} className={window.id === reading.quota.bindingWindowId ? "is-binding" : undefined}>
                {windowLine(window)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
