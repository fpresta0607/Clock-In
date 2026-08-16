import { useCallback, useEffect, useRef, useState } from "react";

import {
  agentRuntimeForBinary,
  agentRuntimeLabel,
  formatHumanDuration,
  friendlyAppName,
  leverage,
  type Agent,
  type AgentPaystubResponse,
  type AgentsReportResponse,
  type LeaderboardEntry,
  type MeStatsAgent,
  type MeStatsResponse,
  type Organization,
  type ProjectListItem,
  type ProjectScope,
  type ProjectUsageResponse,
  type ReportRow,
  type ViewPreferences,
} from "@clock-in/shared";

import { ClientError, type Client } from "./client.js";
import { DownloadInstaller } from "./DownloadInstaller.js";
import { HelpModal } from "./HelpModal.js";
import { WebGLShader } from "./WebGLShader.js";

type AppProps = { client: Client };

/// The same ranges the desktop offers, measured on the viewer's own clock.
type Range = ViewPreferences["range"];

const rangeLabels: Record<Range, string> = {
  today: "Today",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "All time",
};

const rangeSentence: Record<Range, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

const rangeDays: Record<Range, number | null> = { today: 1, "7d": 7, "30d": 30, "90d": 90, all: null };

/**
 * Instant bounds on the viewer's local calendar, ending at the next local
 * midnight. Calendar-date params would be read as UTC days, which roll over
 * mid-afternoon west of Greenwich. "All time" sends no bounds.
 */
export function rangeQuery(range: Range, now = new Date()): string {
  const days = rangeDays[range];
  if (days === null) return "";
  const toExclusive = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from = new Date(toExclusive);
  from.setDate(from.getDate() - days);
  return `?fromAt=${encodeURIComponent(from.toISOString())}&toExclusiveAt=${encodeURIComponent(toExclusive.toISOString())}`;
}

/** Appends extra query parameters onto a possibly-empty range query. */
const withParams = (base: string, params: Record<string, string>): string => {
  const query = new URLSearchParams(base.replace(/^\?/, ""));
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
};

type AppRowItem = { key: string; label: string; agent: boolean; durationSeconds: number };

const TOP_APP_ROWS = 8;

/// One row per agent runtime (so "how much Claude Code" is a single line),
/// friendly names for everything else, heaviest first, non-agent tail folded.
export const buildAppRows = (apps: MeStatsResponse["apps"]): AppRowItem[] => {
  const totals = new Map<string, AppRowItem>();
  for (const app of apps) {
    if (app.durationSeconds <= 0) continue;
    const source = agentRuntimeForBinary(app.processName);
    const key = source ?? app.processName;
    const row = totals.get(key) ?? {
      key,
      label: source === undefined ? friendlyAppName(app.processName) : agentRuntimeLabel(source),
      agent: source !== undefined,
      durationSeconds: 0,
    };
    totals.set(key, { ...row, durationSeconds: row.durationSeconds + app.durationSeconds });
  }
  const rows = [...totals.values()]
    .sort((a, b) => b.durationSeconds - a.durationSeconds || a.label.localeCompare(b.label));
  if (rows.length <= TOP_APP_ROWS) return rows;
  // Agent runtimes never fold into the tail: the fold would hide them inside
  // "Everything else".
  const kept = [...rows.slice(0, TOP_APP_ROWS), ...rows.slice(TOP_APP_ROWS).filter((row) => row.agent)];
  const rest = rows.slice(TOP_APP_ROWS).filter((row) => !row.agent)
    .reduce((sum, row) => sum + row.durationSeconds, 0);
  if (rest === 0) return kept;
  return [...kept, { key: "everything-else", label: "Everything else", agent: false, durationSeconds: rest }];
};

type BoardSort = "active" | "agent" | "leverage";

/// The human/agent split laid out as labeled rows instead of one cramped
/// sentence: active time up top (Solo is now "Human work"), agent runtime
/// below, and the leverage ratio as the agent-side headline.
const MemberBreakdown = ({ stats, self }: { stats: MeStatsResponse; self: boolean }) => {
  const { activeSeconds, agentSeconds, concurrency } = stats;
  const awaySeconds = concurrency.awaySeconds;
  const presentAgentSeconds = Math.max(0, agentSeconds - awaySeconds);
  const ratio = leverage(stats);
  return (
    <div className="breakdown" data-testid="breakdown">
      <p className="group-label">{self ? "Your active time — the hours you were at this computer" : "Active time — the hours they were at this computer"}</p>
      <div className="metric-row is-headline">
        <span className="metric-name">Active time</span>
        <span className="metric-value">{formatHumanDuration(activeSeconds)}</span>
      </div>
      <div className="metric-row">
        <span className="metric-swatch swatch-human" aria-hidden="true" />
        <span className="metric-name">Human work <span className="metric-hint">(no agent running)</span></span>
        <span className="metric-value">{formatHumanDuration(concurrency.t0Seconds)}</span>
      </div>
      {concurrency.t1Seconds > 0 && (
        <div className="metric-row">
          <span className="metric-swatch swatch-agent1" aria-hidden="true" />
          <span className="metric-name">With 1 agent</span>
          <span className="metric-value">{formatHumanDuration(concurrency.t1Seconds)}</span>
        </div>
      )}
      {concurrency.t2Seconds > 0 && (
        <div className="metric-row">
          <span className="metric-swatch swatch-agent2" aria-hidden="true" />
          <span className="metric-name">With 2 agents</span>
          <span className="metric-value">{formatHumanDuration(concurrency.t2Seconds)}</span>
        </div>
      )}
      {concurrency.t3PlusSeconds > 0 && (
        <div className="metric-row">
          <span className="metric-swatch swatch-agent3" aria-hidden="true" />
          <span className="metric-name">With 3+ agents</span>
          <span className="metric-value">{formatHumanDuration(concurrency.t3PlusSeconds)}</span>
        </div>
      )}
      {agentSeconds > 0 && (
        <>
          <p className="group-label">{self ? "Agent runtime — summed, may exceed your hours" : "Agent runtime — summed, may exceed their hours"}</p>
          <div className="metric-row is-subtotal">
            <span className="metric-name">{self ? "While you were there" : "While they were there"}</span>
            <span className="metric-value">{formatHumanDuration(presentAgentSeconds)}</span>
          </div>
          {awaySeconds > 0 && (
            <div className="metric-row">
              <span className="metric-swatch swatch-away" aria-hidden="true" />
              <span className="metric-name">Agents while away <span className="metric-hint">({self ? "never your hours" : "never their hours"})</span></span>
              <span className="metric-value">{formatHumanDuration(awaySeconds)}</span>
            </div>
          )}
          <div className="metric-row is-subtotal is-headline">
            <span className="metric-name">Total agent time · leverage</span>
            <span className="metric-value">{formatHumanDuration(agentSeconds)}{ratio !== null && ` · ${ratio}×`}</span>
          </div>
        </>
      )}
    </div>
  );
};

/// Which runtimes actually ran, with the model each was driving, how many
/// sessions that was, how many overlapped at once, and how long a session
/// typically lasted - all already in the agent_sessions table, now presented
/// rather than folded into a note.
const AgentSessionsTable = ({ byAgent }: { byAgent: MeStatsResponse["byAgent"] }) => {
  if (byAgent.length === 0) return null;
  return (
    <div className="agent-sessions" data-testid="agent-sessions">
      <p className="group-label">Agent sessions</p>
      <table>
        <thead>
          <tr>
            <th>Runtime</th>
            <th>Model</th>
            <th className="numeric">Sessions</th>
            <th className="numeric">Max at once</th>
            <th className="numeric">Total</th>
            <th className="numeric">Median</th>
          </tr>
        </thead>
        <tbody>
          {byAgent.map((split) => (
            <tr key={`${split.source}|${split.model ?? ""}`}>
              <td>{agentRuntimeLabel(split.source)}</td>
              <td>{split.model ?? "-"}</td>
              <td className="numeric">{split.sessionCount ?? 0}</td>
              <td className="numeric">{split.maxConcurrent ?? 0}</td>
              <td className="numeric">{formatHumanDuration(split.durationSeconds)}</td>
              <td className="numeric">{formatHumanDuration(split.medianSeconds ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/// A compact count for token axes and readouts: 950, 12k, 3.4M. Token counts
/// dwarf durations, so the charts format them on their own scale.
const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
};

/// The structural slice of an hourly bucket the charts read. Each app's own
/// bucket type satisfies it, which is what lets the two copies of these
/// components stay byte-identical.
type ChartHourlyBucket = {
  hourStart: string;
  activeSeconds: number;
  agentSeconds: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
};

/// One week of an agent's paystub trend, as the API computes it.
type ChartTrendBucket = {
  periodStartAt: string;
  agentSeconds: number;
  shiftCount: number;
  heldRate: number | null;
};

type ChartSeries = {
  /// The data-series hook tests pin to; one per plotted measure, never a path count.
  id: string;
  label: string;
  /// The brand.css chart token the stroke, points, and gradient read.
  color: string;
  values: readonly (number | null)[];
};

/// The tooltip both charts share: the hovered or keyboard-focused moment, and
/// each series' value there. Positioned as a percentage of the plot width so
/// the SVG's viewBox scaling never desyncs it.
const ChartTooltip = ({
  left,
  title,
  rows,
}: {
  left: number;
  title: string;
  rows: readonly { color: string; label: string; value: string }[];
}) => (
  <div className="graph-tooltip" style={{ left: `${left}%` }}>
    <p className="graph-tooltip-title">{title}</p>
    {rows.map((row) => (
      <p key={row.label} className="graph-tooltip-row">
        <span className="legend-line" style={{ background: row.color }} aria-hidden="true" />
        {row.label} {row.value}
      </p>
    ))}
  </div>
);

/// The smallest 1/2/2.5/5 multiple of a power of ten at or above `raw`.
const niceStep = (raw: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const multiplier of [1, 2, 2.5, 5, 10]) {
    if (multiplier * magnitude >= raw) return multiplier * magnitude;
  }
  return 10 * magnitude;
};

/// SVG line chart - agents in the brand green, the person in gray, tokens in
/// blue and purple. No chart library: a fixed viewBox, one path per series,
/// and a gradient area under each. The server buckets to the caller's local
/// hours, so the x-axis reads midnight-to-midnight on the viewer's clock.
/// Token fields are null when nothing in the hour reported; the path breaks
/// there rather than dropping to a zero that never happened.
const HourlyGraph = ({
  buckets,
  personLabel = "You",
  formatDuration,
  tokenBlind = [],
}: {
  buckets: readonly ChartHourlyBucket[];
  personLabel?: string;
  formatDuration: (seconds: number) => string;
  /// Runtimes that ran in range but reported no tokens, named beneath the plot.
  tokenBlind?: readonly string[];
}) => {
  const [measure, setMeasure] = useState<"time" | "tokens">("time");
  const [readout, setReadout] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  if (buckets.length === 0) return null;

  const hasTokens = buckets.some((bucket) => bucket.inputTokens !== null || bucket.outputTokens !== null);
  // "In" is everything the model consumed: fresh input plus both cache sides.
  const tokensIn = (bucket: ChartHourlyBucket): number | null =>
    bucket.inputTokens === null
      ? null
      : bucket.inputTokens + (bucket.cacheCreationInputTokens ?? 0) + (bucket.cacheReadInputTokens ?? 0);
  const series: readonly ChartSeries[] = measure === "tokens"
    ? [
        { id: "tokens-in", label: "Tokens in", color: "var(--chart-token-in)", values: buckets.map(tokensIn) },
        { id: "tokens-out", label: "Tokens out", color: "var(--chart-token-out)", values: buckets.map((bucket) => bucket.outputTokens) },
      ]
    : [
        { id: "agent", label: "Agents", color: "var(--chart-agent)", values: buckets.map((bucket) => bucket.agentSeconds) },
        { id: "human", label: personLabel, color: "var(--chart-human)", values: buckets.map((bucket) => bucket.activeSeconds) },
      ];
  const formatValue = measure === "tokens" ? formatTokenCount : formatDuration;

  const width = 640;
  const height = 190;
  const margin = { left: 44, right: 12, top: 14, bottom: 24 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const rawMax = Math.max(
    measure === "tokens" ? 3 : 60,
    ...series.flatMap((entry) => entry.values.filter((value): value is number => value !== null)),
  );
  // Gridlines land on thirds of yMax, so the quantum stays divisible by three
  // and every labeled line reads a round number.
  const yMax = measure === "tokens"
    ? 3 * niceStep(Math.ceil(rawMax / 3))
    : Math.max(900, Math.ceil(rawMax / 900) * 900);
  const x = (index: number): number =>
    buckets.length === 1 ? margin.left + plotW / 2 : margin.left + (index / (buckets.length - 1)) * plotW;
  const y = (value: number): number => margin.top + plotH - (value / yMax) * plotH;

  /// One path per series; a null lifts the pen, so a gap reads as a gap
  /// instead of a plunge to the baseline.
  const linePath = (values: readonly (number | null)[]): string => {
    let d = "";
    let pen = false;
    values.forEach((value, index) => {
      if (value === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  type Run = { start: number; end: number };
  /// The contiguous non-null spans of a series; the gradient area fills one
  /// run at a time so it too breaks over gaps.
  const runs = (values: readonly (number | null)[]): Run[] => {
    const spans: Run[] = [];
    let start: number | null = null;
    values.forEach((value, index) => {
      if (value === null) {
        if (start !== null) spans.push({ start, end: index - 1 });
        start = null;
      } else if (start === null) {
        start = index;
      }
    });
    if (start !== null) spans.push({ start, end: values.length - 1 });
    return spans;
  };
  const areaPath = (values: readonly (number | null)[], run: Run): string => {
    let d = `M${x(run.start).toFixed(1)},${y(0).toFixed(1)}`;
    for (let index = run.start; index <= run.end; index += 1) {
      d += `L${x(index).toFixed(1)},${y(values[index] ?? 0).toFixed(1)}`;
    }
    return `${d}L${x(run.end).toFixed(1)},${y(0).toFixed(1)}Z`;
  };

  // Day ranges show every point; longer ranges thin to each series' local
  // extrema, plus wherever the read-out sits.
  const showEveryPoint = buckets.length <= 48;
  const isExtremum = (values: readonly (number | null)[], index: number): boolean => {
    const value = values[index];
    if (value === null || value === undefined) return false;
    const previous = values[index - 1];
    const next = values[index + 1];
    if (previous === null || previous === undefined || next === null || next === undefined) return true;
    return (value > previous && value > next) || (value < previous && value < next);
  };

  const tickCount = Math.min(7, buckets.length);
  const xTicks = Array.from({ length: tickCount }, (_, tick) => {
    const index = tickCount === 1 ? 0 : Math.round((tick / (tickCount - 1)) * (buckets.length - 1));
    const date = new Date(buckets[index]!.hourStart);
    const label = buckets.length <= 48
      ? String(date.getHours()).padStart(2, "0")
      : date.toLocaleDateString([], { month: "short", day: "numeric" });
    return { index, label };
  });

  const indexFromPointer = (clientX: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return null;
    const viewX = ((clientX - rect.left) / rect.width) * width;
    if (viewX < margin.left || viewX > width - margin.right) return null;
    if (buckets.length === 1) return 0;
    return Math.max(0, Math.min(buckets.length - 1, Math.round(((viewX - margin.left) / plotW) * (buckets.length - 1))));
  };

  /// Arrow keys walk the read-out point; Home/End jump to the edges. Returns
  /// false for keys the chart does not consume.
  const moveReadout = (key: string): boolean => {
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return false;
    setReadout((current) => {
      if (key === "Home") return 0;
      if (key === "End") return buckets.length - 1;
      const base = current ?? (key === "ArrowLeft" ? buckets.length : -1);
      return Math.max(0, Math.min(buckets.length - 1, base + (key === "ArrowRight" ? 1 : -1)));
    });
    return true;
  };

  const active = readout !== null && readout < buckets.length ? readout : null;
  const hourLabel = (index: number): string =>
    new Date(buckets[index]!.hourStart).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const summary = (index: number): string =>
    `${hourLabel(index)}: ${series
      .map((entry) => {
        const value = entry.values[index];
        return `${entry.label} ${value === null || value === undefined ? "no data" : formatValue(value)}`;
      })
      .join(", ")}`;

  return (
    <div className="graph" data-testid="hourly-graph">
      {hasTokens && (
        <div className="range-toggle graph-mode" role="group" aria-label="Chart measure">
          {(["time", "tokens"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={measure === value ? "is-active" : undefined}
              onClick={() => setMeasure(value)}
            >
              {value === "time" ? "Time" : "Tokens"}
            </button>
          ))}
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={measure === "tokens" ? "Hourly token usage" : "Hourly active and agent time"}
        tabIndex={0}
        onMouseMove={(event) => {
          const index = indexFromPointer(event.clientX);
          if (index !== null) setReadout(index);
        }}
        onMouseLeave={() => setReadout(null)}
        onKeyDown={(event) => {
          if (moveReadout(event.key)) event.preventDefault();
        }}
      >
        <defs>
          {series.map((entry) => (
            <linearGradient key={entry.id} id={`hourly-graph-fill-${entry.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={entry.color} stopOpacity="0.16" />
              <stop offset="1" stopColor={entry.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0, 1, 2, 3].map((third) => {
          const value = (yMax / 3) * third;
          return (
            <g key={third}>
              <line
                x1={margin.left}
                y1={y(value)}
                x2={width - margin.right}
                y2={y(value)}
                stroke={third === 0 ? "var(--chart-grid)" : "var(--chart-grid-soft)"}
              />
              <text x={margin.left - 6} y={y(value) + 3} fill="var(--chart-axis)" fontSize="9" textAnchor="end">
                {formatValue(value)}
              </text>
            </g>
          );
        })}
        {xTicks.map(({ index, label }) => (
          <text key={index} x={x(index)} y={height - 6} fill="var(--chart-axis)" fontSize="9" textAnchor="middle">{label}</text>
        ))}
        {series.map((entry) =>
          runs(entry.values)
            .filter((run) => run.end > run.start)
            .map((run) => (
              <path key={`${entry.id}-${run.start}`} d={areaPath(entry.values, run)} fill={`url(#hourly-graph-fill-${entry.id})`} stroke="none" />
            )),
        )}
        {active !== null && (
          <line x1={x(active)} y1={margin.top} x2={x(active)} y2={margin.top + plotH} stroke="var(--chart-grid)" />
        )}
        {series.map((entry) => (
          <path
            key={entry.id}
            data-series={entry.id}
            d={linePath(entry.values)}
            fill="none"
            stroke={entry.color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {series.map((entry) =>
          entry.values.map((value, index) => {
            if (value === null) return null;
            if (!showEveryPoint && !isExtremum(entry.values, index) && index !== active) return null;
            return (
              <circle
                key={`${entry.id}-${index}`}
                data-point={entry.id}
                cx={x(index)}
                cy={y(value)}
                r={index === active ? 3.5 : 2}
                fill="var(--chart-point)"
                stroke={entry.color}
                strokeWidth="1.5"
              />
            );
          }),
        )}
      </svg>
      {active !== null && (
        <ChartTooltip
          left={(x(active) / width) * 100}
          title={hourLabel(active)}
          rows={series.map((entry) => {
            const value = entry.values[active];
            return { color: entry.color, label: entry.label, value: value === null || value === undefined ? "-" : formatValue(value) };
          })}
        />
      )}
      <p className="visually-hidden" role="status">{active === null ? "" : summary(active)}</p>
      <ul className="legend">
        {series.map((entry) => (
          <li key={entry.id}><span className="legend-line" style={{ background: entry.color }} aria-hidden="true" />{entry.label}</li>
        ))}
      </ul>
      {hasTokens && tokenBlind.length > 0 && (
        <p className="graph-note">No token data from {tokenBlind.join(", ")}.</p>
      )}
    </div>
  );
};

/// The paystub trend as a compact bar strip: one bar per week, hours above
/// it, the week beneath, and the same hover and keyboard read-out grammar as
/// the hourly graph. Replaces the old text list; the aria summary keeps the
/// shift counts and held rate it carried.
const TrendStrip = ({
  buckets,
  formatDuration,
}: {
  buckets: readonly ChartTrendBucket[];
  formatDuration: (seconds: number) => string;
}) => {
  const [readout, setReadout] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  if (buckets.length === 0) return null;

  const width = 640;
  const height = 110;
  const margin = { left: 4, right: 4, top: 20, bottom: 22 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const yMax = Math.max(3600, Math.ceil(Math.max(...buckets.map((bucket) => bucket.agentSeconds)) / 3600) * 3600);
  const slot = plotW / buckets.length;
  const barWidth = Math.min(56, slot * 0.55);
  const barX = (index: number): number => margin.left + slot * index + (slot - barWidth) / 2;
  const barHeight = (value: number): number => (value <= 0 ? 0 : Math.max(2, (value / yMax) * plotH));
  const weekLabel = (index: number): string =>
    new Date(buckets[index]!.periodStartAt).toLocaleDateString([], { month: "short", day: "numeric" });
  const summary = (index: number): string => {
    const bucket = buckets[index]!;
    const held = bucket.heldRate === null ? "held rate pending" : `${Math.round(bucket.heldRate * 100)}% held`;
    return `Week of ${weekLabel(index)}: ${formatDuration(bucket.agentSeconds)}, ${bucket.shiftCount} shift${bucket.shiftCount === 1 ? "" : "s"}, ${held}`;
  };

  const indexFromPointer = (clientX: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return null;
    const viewX = ((clientX - rect.left) / rect.width) * width;
    const index = Math.floor((viewX - margin.left) / slot);
    return index < 0 || index >= buckets.length ? null : index;
  };

  const moveReadout = (key: string): boolean => {
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return false;
    setReadout((current) => {
      if (key === "Home") return 0;
      if (key === "End") return buckets.length - 1;
      const base = current ?? (key === "ArrowLeft" ? buckets.length : -1);
      return Math.max(0, Math.min(buckets.length - 1, base + (key === "ArrowRight" ? 1 : -1)));
    });
    return true;
  };

  const active = readout !== null && readout < buckets.length ? readout : null;

  return (
    <div className="graph trend-strip" data-testid="paystub-trend">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Weekly agent hours, oldest first"
        tabIndex={0}
        onMouseMove={(event) => {
          const index = indexFromPointer(event.clientX);
          if (index !== null) setReadout(index);
        }}
        onMouseLeave={() => setReadout(null)}
        onKeyDown={(event) => {
          if (moveReadout(event.key)) event.preventDefault();
        }}
      >
        <defs>
          <linearGradient id="trend-strip-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--chart-agent)" stopOpacity="0.9" />
            <stop offset="1" stopColor="var(--chart-agent)" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <line x1={margin.left} y1={margin.top + plotH} x2={width - margin.right} y2={margin.top + plotH} stroke="var(--chart-grid)" />
        {buckets.map((bucket, index) => (
          <g key={bucket.periodStartAt}>
            {active === index && (
              <rect
                x={margin.left + slot * index + 1}
                y={margin.top - 4}
                width={slot - 2}
                height={plotH + 4}
                fill="var(--chart-grid-soft)"
              />
            )}
            <rect
              data-series="week"
              x={barX(index)}
              y={margin.top + plotH - barHeight(bucket.agentSeconds)}
              width={barWidth}
              height={barHeight(bucket.agentSeconds)}
              rx={2}
              fill="url(#trend-strip-fill)"
            />
            <text
              x={barX(index) + barWidth / 2}
              y={margin.top + plotH - barHeight(bucket.agentSeconds) - 5}
              fill="var(--chart-axis)"
              fontSize="9"
              textAnchor="middle"
            >
              {formatDuration(bucket.agentSeconds)}
            </text>
            <text x={barX(index) + barWidth / 2} y={height - 6} fill="var(--chart-axis)" fontSize="9" textAnchor="middle">
              {weekLabel(index)}
            </text>
          </g>
        ))}
      </svg>
      {active !== null && (
        <ChartTooltip
          left={((margin.left + slot * active + slot / 2) / width) * 100}
          title={`Week of ${weekLabel(active)}`}
          rows={[{
            color: "var(--chart-agent)",
            label: formatDuration(buckets[active]!.agentSeconds),
            value: `${buckets[active]!.shiftCount} shift${buckets[active]!.shiftCount === 1 ? "" : "s"}${
              buckets[active]!.heldRate === null ? "" : ` · ${Math.round(buckets[active]!.heldRate! * 100)}% held`
            }`,
          }]}
        />
      )}
      <p className="visually-hidden" role="status">{active === null ? "" : summary(active)}</p>
    </div>
  );
};

const boardSorters: Record<BoardSort, (a: LeaderboardEntry, b: LeaderboardEntry) => number> = {
  active: (a, b) => b.activeSeconds - a.activeSeconds,
  agent: (a, b) => b.agentSeconds - a.agentSeconds,
  leverage: (a, b) => (leverage(b) ?? 0) - (leverage(a) ?? 0),
};

const messageFor = (error: unknown): string =>
  error instanceof ClientError ? error.message : "Something went wrong. Try again.";

/// Runtimes that ran shifts in range but reported no tokens - the honest gap
/// the tokens view names beneath the plot rather than zeroing over.
const tokenBlindRuntimes = (agents: readonly MeStatsAgent[] | undefined): string[] => [
  ...new Set(
    (agents ?? [])
      .filter((row) => row.shiftCount > 0 && !row.tokensReported)
      .map((row) => agentRuntimeLabel(row.agent.source)),
  ),
];

export const App = ({ client }: AppProps) => {
  const [booting, setBooting] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [justSignedUp, setJustSignedUp] = useState(false);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | undefined>();

  const [scope, setScope] = useState<ProjectScope>("all");
  const [range, setRange] = useState<Range>("30d");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [organization, setOrganization] = useState<Organization | undefined>();
  const [selfId, setSelfId] = useState<string | undefined>();
  const [projects, setProjects] = useState<readonly ProjectListItem[]>([]);
  const [entries, setEntries] = useState<readonly LeaderboardEntry[]>([]);
  const [boardSort, setBoardSort] = useState<BoardSort>("active");
  /// People is the existing leaderboard; Agents is the roster of worker
  /// identities, with a paystub in the detail region below.
  const [boardTab, setBoardTab] = useState<"people" | "agents">("people");
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [agentsReport, setAgentsReport] = useState<AgentsReportResponse | undefined>();
  const [agentsReportFailed, setAgentsReportFailed] = useState(false);
  const [agentBusyId, setAgentBusyId] = useState<string | undefined>();
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>();
  const [paystub, setPaystub] = useState<AgentPaystubResponse | undefined>();
  const [paystubFailed, setPaystubFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dataError, setDataError] = useState<string | undefined>();
  const [boardFailed, setBoardFailed] = useState(false);
  const [member, setMember] = useState<{ id: string; name: string } | undefined>();
  const [memberStats, setMemberStats] = useState<MeStatsResponse | undefined>();
  const [memberFailed, setMemberFailed] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionRows, setSessionRows] = useState<readonly ReportRow[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [sessionPage, setSessionPage] = useState(1);
  const [manageOpen, setManageOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | undefined>();
  const [helpOpen, setHelpOpen] = useState(false);

  const expireSession = useCallback(() => {
    setSignedIn(false);
    setAuthError("Your session expired. Sign in again.");
  }, []);

  const scopeParams = useCallback(
    (base: string): string => (scope === "all" ? base : withParams(base, { scope })),
    [scope],
  );

  // On page load, trade a persisted auth cookie for a JWT before choosing
  // between the sign-in form and the dashboard — no form flash for a live session.
  useEffect(() => {
    let cancelled = false;
    void client.restoreSession().then((restored) => {
      if (cancelled) return;
      if (restored) setSignedIn(true);
      setBooting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Workspaces that predate roles have no administrator at all, which locks
  // everyone out of project deletion. The first signed-in member claims the
  // role; every later call is refused by the server and ignored here.
  useEffect(() => {
    if (!signedIn) return;
    void client.claimAdmin().catch(() => undefined);
  }, [client, signedIn]);

  // Who and where: identity, workspace, projects, and the shared view state.
  // Preferences land BEFORE the first board fetch so the page opens where the
  // desktop app last was, with no flicker through the defaults.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void Promise.allSettled([client.organization(), client.me(), client.projects(), client.preferences()]).then(
      ([organizationResult, meResult, projectsResult, preferencesResult]) => {
        if (cancelled) return;
        const failures = [organizationResult, meResult, projectsResult, preferencesResult]
          .flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
        if (failures.some((reason) => reason instanceof ClientError && reason.kind === "auth")) {
          expireSession();
          return;
        }
        if (organizationResult.status === "fulfilled") setOrganization(organizationResult.value.organization);
        if (meResult.status === "fulfilled") setSelfId(meResult.value.user.id);
        if (projectsResult.status === "fulfilled") setProjects(projectsResult.value.projects);
        if (preferencesResult.status === "fulfilled") {
          // The unassigned scope is retired from the pickers; a stored one
          // reads as everything rather than as a blank select.
          setScope(preferencesResult.value.scope === "unassigned" ? "all" : preferencesResult.value.scope);
          setRange(preferencesResult.value.range);
        }
        setPreferencesReady(true);
        const [firstFailure] = failures;
        if (firstFailure !== undefined) setDataError(messageFor(firstFailure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, expireSession]);

  // The board, refetched whenever scope or range move.
  const reloadBoard = useCallback(async () => {
    setLoading(true);
    setBoardFailed(false);
    try {
      const board = await client.leaderboard(scopeParams(rangeQuery(range)));
      setEntries(board.entries);
      setDataError(undefined);
    } catch (error: unknown) {
      if (error instanceof ClientError && error.kind === "auth") {
        expireSession();
        return;
      }
      setBoardFailed(true);
      setEntries([]);
      setDataError(messageFor(error));
    } finally {
      setLoading(false);
    }
  }, [client, range, scopeParams, expireSession]);

  useEffect(() => {
    if (!signedIn || !preferencesReady) return;
    void reloadBoard();
  }, [signedIn, preferencesReady, reloadBoard]);

  // The shared view state follows every change, last write wins. The first
  // render after preferences load must not write back what it just read.
  const preferencesDirty = useRef(false);
  useEffect(() => {
    if (!signedIn || !preferencesReady) return;
    if (!preferencesDirty.current) {
      preferencesDirty.current = true;
      return;
    }
    void client.updatePreferences({ scope, range }).catch(() => undefined);
  }, [client, signedIn, preferencesReady, scope, range]);

  // The drill-down: one member's breakdown for the scope and range on screen.
  const viewedId = member?.id ?? selfId;
  const viewingSelf = member === undefined || member.id === selfId;
  useEffect(() => {
    if (!signedIn || !preferencesReady || viewedId === undefined) return undefined;
    let cancelled = false;
    setMemberStats(undefined);
    setMemberFailed(false);
    client.meStats(scopeParams(withParams(rangeQuery(range), { userId: viewedId }))).then(
      (result) => {
        if (!cancelled) setMemberStats(result);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ClientError && error.kind === "auth") {
          expireSession();
          return;
        }
        setMemberFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, preferencesReady, range, viewedId, scopeParams, expireSession]);

  // The roster loads when its tab opens; renames patch the row in place
  // rather than refetching the list.
  useEffect(() => {
    if (!signedIn || !preferencesReady || boardTab !== "agents") return undefined;
    let cancelled = false;
    setAgentsFailed(false);
    client.agents().then(
      (result) => {
        if (!cancelled) setAgents(result.agents);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ClientError && error.kind === "auth") {
          expireSession();
          return;
        }
        setAgentsFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, preferencesReady, boardTab, expireSession]);

  // The pay-run report: every roster agent's hours, shifts, and held share
  // over the range on screen, plus the headcount line above the list.
  useEffect(() => {
    if (!signedIn || !preferencesReady || boardTab !== "agents") return undefined;
    let cancelled = false;
    setAgentsReportFailed(false);
    client.agentsReport(scopeParams(rangeQuery(range))).then(
      (result) => {
        if (!cancelled) setAgentsReport(result);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ClientError && error.kind === "auth") {
          expireSession();
          return;
        }
        setAgentsReportFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, preferencesReady, boardTab, range, scopeParams, expireSession]);

  // The paystub: one agent's shifts, hours, and commit record over the range
  // on screen. Same detail region the member breakdown uses.
  useEffect(() => {
    if (!signedIn || !preferencesReady || boardTab !== "agents" || selectedAgentId === undefined) return undefined;
    let cancelled = false;
    setPaystub(undefined);
    setPaystubFailed(false);
    client.agentPaystub(selectedAgentId, rangeQuery(range)).then(
      (result) => {
        if (!cancelled) setPaystub(result);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ClientError && error.kind === "auth") {
          expireSession();
          return;
        }
        setPaystubFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, preferencesReady, boardTab, selectedAgentId, range, expireSession]);

  // Recent sessions load only while their tab is open, one page at a time.
  useEffect(() => {
    if (!signedIn || !preferencesReady || !sessionsOpen) return undefined;
    let cancelled = false;
    client.report(withParams(scopeParams(rangeQuery(range)), { page: String(sessionPage), pageSize: "25" })).then(
      (result) => {
        if (cancelled) return;
        setSessionRows((current) => (sessionPage === 1 ? result.rows : [...current, ...result.rows]));
        setSessionTotal(result.pagination.totalRows);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, preferencesReady, sessionsOpen, range, sessionPage, scopeParams]);

  // Reset on scope, range, or a fresh open: reopening the tab with a page
  // counter still at 2 would append page 2's rows on top of themselves.
  useEffect(() => {
    setSessionPage(1);
    setSessionRows([]);
  }, [scope, range, sessionsOpen]);

  const submitAuth = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(undefined);
    try {
      if (mode === "sign-up") {
        const code = inviteCode.trim();
        const workspace = workspaceName.trim();
        await client.signUp({
          email,
          password,
          name: name.trim(),
          ...(code === "" ? {} : { inviteCode: code }),
          ...(code === "" && workspace !== "" ? { workspaceName: workspace } : {}),
        });
      } else {
        await client.signIn({ email, password });
      }
      setPassword("");
      setName("");
      setInviteCode("");
      setWorkspaceName("");
      setJustSignedUp(mode === "sign-up");
      setSignedIn(true);
    } catch (error: unknown) {
      setAuthError(messageFor(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    await client.signOut();
    setSignedIn(false);
    setJustSignedUp(false);
    setOrganization(undefined);
    setSelfId(undefined);
    setProjects([]);
    setEntries([]);
    setMember(undefined);
    setMemberStats(undefined);
    setMemberFailed(false);
    setBoardFailed(false);
    setSessionsOpen(false);
    setSessionRows([]);
    setPreferencesReady(false);
    preferencesDirty.current = false;
    setAuthError(undefined);
  };

  const joinWorkspace = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setJoinBusy(true);
    setJoinError(undefined);
    try {
      await client.joinOrganization(joinCode.trim());
      setJoinCode("");
      const refreshed = await client.organization();
      setOrganization(refreshed.organization);
      await reloadBoard();
    } catch (error: unknown) {
      setJoinError(messageFor(error));
    } finally {
      setJoinBusy(false);
    }
  };

  /// Naming an agent is the registration ceremony: the rename goes alone and
  /// the API marks an anonymous agent registered in the same write.
  const renameAgent = async (agent: Agent, name: string): Promise<void> => {
    setAgentBusyId(agent.id);
    try {
      const updated = await client.patchAgent(agent.id, { name });
      setAgents((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      setDataError(undefined);
    } catch (error: unknown) {
      if (error instanceof ClientError && error.kind === "auth") {
        expireSession();
        return;
      }
      setDataError(messageFor(error));
    } finally {
      setAgentBusyId(undefined);
    }
  };

  const copyInviteCode = async (): Promise<void> => {
    if (organization === undefined) return;
    try {
      await navigator.clipboard.writeText(organization.inviteCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be denied; the code is on screen to copy by hand.
      setDataError("Could not copy. Select the code and copy it manually.");
    }
  };

  const refreshProjects = async (): Promise<void> => {
    const listed = await client.projects();
    setProjects(listed.projects);
    // A scope naming a project that no longer exists falls back to everything.
    if (scope !== "all" && !listed.projects.some((project) => project.id === scope)) {
      setScope("all");
    }
  };

  if (booting) {
    return (
      <main className="shell auth-shell">
        <WebGLShader />
      </main>
    );
  }

  if (!signedIn) {
    const isSignUp = mode === "sign-up";
    return (
      <main className="shell auth-shell">
        <WebGLShader />
        <section className="card glass" aria-labelledby="auth-title">
          <p className="eyebrow">Clock-In</p>
          <h1 id="auth-title">{isSignUp ? "Create your account" : "Sign in"}</h1>
          <p className="subtle">
            {isSignUp
              ? "Enter a teammate's invite code to join their workspace, or leave it blank to start your own."
              : "See your team's hours and export them."}
          </p>
          {authError && <p className="error" role="alert">{authError}</p>}
          <form onSubmit={submitAuth}>
            {isSignUp && (
              <label>Name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label>
            )}
            <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required /></label>
            <label>Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                minLength={isSignUp ? 8 : undefined}
                required
              />
            </label>
            {isSignUp && (
              <label>Invite code <span className="optional">optional</span>
                <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} autoComplete="off" spellCheck={false} />
              </label>
            )}
            {isSignUp && inviteCode.trim() === "" && (
              <label>Workspace name <span className="optional">optional</span>
                <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} autoComplete="organization" placeholder="You're starting a new workspace" maxLength={80} />
              </label>
            )}
            <button className="primary" type="submit" disabled={authBusy}>
              {authBusy ? "Working…" : isSignUp ? "Create account" : "Sign in"}
            </button>
          </form>
          <button className="link" type="button" onClick={() => { setMode(isSignUp ? "sign-in" : "sign-up"); setAuthError(undefined); setPassword(""); }}>
            {isSignUp ? "Already have an account? Sign in" : "New here? Create an account"}
          </button>
        </section>
      </main>
    );
  }

  if (justSignedUp) {
    return (
      <main className="shell welcome-shell">
        <WebGLShader />
        <section className="welcome" aria-labelledby="welcome-title">
          <p className="eyebrow">You're in</p>
          <h1 id="welcome-title" className="hero-title">One last thing — the app.</h1>
          <p className="hero-sub">
            Clock-In tracks time from your desktop. Download the app, sign in with this account,
            and your hours show up on the dashboard.
          </p>
          <DownloadInstaller placement="hero" />
          <button className="link" type="button" onClick={() => setJustSignedUp(false)}>
            Skip to your dashboard
          </button>
        </section>
      </main>
    );
  }

  const activeTotal = entries.reduce((total, entry) => total + entry.activeSeconds, 0);
  const boardHasTime = entries.some(
    (entry) => entry.activeSeconds > 0 || entry.agentSeconds > 0 || entry.durationSeconds > 0,
  );
  // Rank follows the column being sorted by; showing the server's active-time
  // rank under an agent-time sort reads as 1, 4, 2, 3.
  const sortedEntries = [...entries]
    .sort(boardSorters[boardSort])
    .map((entry, index) => ({ ...entry, rank: boardSort === "active" ? entry.rank : index + 1 }));
  const memberAppRows = memberStats === undefined ? [] : buildAppRows(memberStats.apps);

  return (
    <main className="shell">
      <WebGLShader />
      <header className="masthead">
        <div>
          <p className="eyebrow">Clock-In</p>
          <h1>{organization?.name ?? "Your workspace"}</h1>
        </div>
        <div className="masthead-actions">
          <DownloadInstaller />
          <button className="ghost" type="button" onClick={() => setManageOpen(true)}>Projects</button>
          <button
            className="ghost help-button"
            type="button"
            aria-label="How Clock-In works"
            title="How Clock-In works"
            onClick={() => setHelpOpen(true)}
          >
            ?
          </button>
          <button className="ghost" type="button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>

      {/* The two global filters. Everything below reflects both. */}
      <div className="control-bar">
        <label className="scope-picker">
          <span className="visually-hidden">Project scope</span>
          <select value={scope} onChange={(event) => setScope(event.target.value as ProjectScope)}>
            <option value="all">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
        <div className="range-toggle" role="group" aria-label="Date range">
          {(Object.keys(rangeLabels) as Range[]).map((value) => (
            <button
              key={value}
              type="button"
              className={range === value ? "is-active" : undefined}
              onClick={() => setRange(value)}
            >
              {rangeLabels[value]}
            </button>
          ))}
        </div>
      </div>

      {dataError && <p className="error" role="alert">{dataError}</p>}

      {organization && entries.length <= 1 && (
        <section className="card join-card" aria-labelledby="join-title">
          <div>
            <h2 id="join-title">Joining a teammate?</h2>
            <p className="subtle">Enter their invite code to move this account into their workspace.</p>
          </div>
          {joinError && <p className="error" role="alert">{joinError}</p>}
          <form className="join-form" onSubmit={joinWorkspace}>
            <label>
              <span className="visually-hidden">Invite code to join</span>
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="ABCDE-FGHJK" autoComplete="off" spellCheck={false} required />
            </label>
            <button className="ghost" type="submit" disabled={joinBusy}>{joinBusy ? "Joining…" : "Join"}</button>
          </form>
        </section>
      )}

      <section className="card" aria-labelledby="board-title">
        <div className="card-head">
          <h2 id="board-title" className="visually-hidden">Leaderboard</h2>
          {/* People is the human board; Agents is the roster. One card, one
              detail region, whichever workforce is on screen. */}
          <div className="range-toggle" role="group" aria-label="People or agents">
            <button
              type="button"
              className={boardTab === "people" ? "is-active" : undefined}
              onClick={() => setBoardTab("people")}
            >
              People
            </button>
            <button
              type="button"
              className={boardTab === "agents" ? "is-active" : undefined}
              onClick={() => setBoardTab("agents")}
            >
              Agents
            </button>
          </div>
          {boardTab === "people" && (
            <span className="board-tools">
              <span className="total">{boardFailed ? "Not loaded" : `${formatHumanDuration(activeTotal)} total`}</span>
              <label className="board-sort">
                <span className="visually-hidden">Sort by</span>
                <select value={boardSort} onChange={(event) => setBoardSort(event.target.value as BoardSort)}>
                  <option value="active">By active time</option>
                  <option value="agent">By agent time</option>
                  <option value="leverage">By leverage</option>
                </select>
              </label>
            </span>
          )}
        </div>
        {boardTab === "agents" ? (
          <RosterTab
            agents={agents}
            agentsFailed={agentsFailed}
            agentBusyId={agentBusyId}
            selectedAgentId={selectedAgentId}
            onSelect={setSelectedAgentId}
            onRename={(agent, name) => void renameAgent(agent, name)}
            paystub={paystub}
            paystubFailed={paystubFailed}
            rangeLabel={rangeSentence[range]}
            agentsReport={agentsReport}
            agentsReportFailed={agentsReportFailed}
          />
        ) : boardFailed ? (
          <p className="subtle">Could not load hours for this range.</p>
        ) : loading && entries.length === 0 ? (
          <p className="subtle" role="status">Loading hours…</p>
        ) : (
          <>
            {!boardHasTime && (
              <p className="subtle">
                {scope === "all"
                  ? "No recorded time in this range yet. Install the desktop app and it records on its own."
                  : "Nothing recorded here in this range. Pick another range, or All projects."}
              </p>
            )}
            {entries.length > 0 && (
              <ol className="board-list">
                {sortedEntries.map((entry) => (
                  <li key={entry.user.id} className={entry.user.id === viewedId ? "is-selected" : undefined}>
                    <button
                      type="button"
                      className="board-choice"
                      aria-pressed={entry.user.id === viewedId}
                      onClick={() => setMember({ id: entry.user.id, name: entry.user.name })}
                    >
                      <span className="board-rank">{entry.rank}</span>
                      <span className="board-name">
                        {entry.user.name}
                        {entry.user.id === selfId && <span className="you-tag"> you</span>}
                      </span>
                      <span className="board-times">
                        <span className="board-hours">{formatHumanDuration(entry.activeSeconds)}</span>
                        <span className="board-agent">
                          Agent {formatHumanDuration(entry.agentSeconds)}
                          {leverage(entry) !== null && ` · ${leverage(entry)}×`}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}

        {boardTab === "people" && viewedId !== undefined && (
          <section className="member-stats" aria-labelledby="member-stats-title">
            <div className="member-stats-head">
              <h3 id="member-stats-title">
                {(member?.name ?? entries.find((entry) => entry.user.id === selfId)?.user.name ?? "You")}
                {" · "}
                {rangeSentence[range]}
              </h3>
              {viewedId !== selfId && (
                <button type="button" className="member-self" onClick={() => setMember(undefined)}>
                  Show my own
                </button>
              )}
            </div>
            {memberFailed ? (
              <p className="subtle">Could not load this member's breakdown.</p>
            ) : memberStats === undefined ? (
              <p className="subtle" role="status">Loading…</p>
            ) : (
              <>
                <MemberBreakdown stats={memberStats} self={viewingSelf} />
                <AgentSessionsTable byAgent={memberStats.byAgent} />
                <HourlyGraph
                  buckets={memberStats.hourly ?? []}
                  personLabel={viewingSelf ? "You" : (member?.name ?? "Person")}
                  formatDuration={formatHumanDuration}
                  tokenBlind={tokenBlindRuntimes(memberStats.agents)}
                />
                {memberStats.projects.length > 0 && (
                  <ul className="stat-list">
                    {memberStats.projects.filter((entry) => entry.durationSeconds > 0).map((entry) => (
                      <li key={entry.project.id} className="stat-row">
                        <span className="stat-name">{entry.project.name}</span>
                        <span className="stat-duration">{formatHumanDuration(entry.durationSeconds)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {memberAppRows.length === 0 ? (
                  <p className="subtle">No recorded time in this range.</p>
                ) : (
                  <ul className="stat-list stat-apps">
                    {memberAppRows.map((row) => (
                      <li key={row.key} className="stat-row">
                        <span className={row.agent ? "stat-name is-agent" : "stat-name"}>{row.label}</span>
                        <span className="stat-duration">{formatHumanDuration(row.durationSeconds)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {memberStats.unattributedSeconds > 0 && (
                  <p className="member-foot">
                    {formatHumanDuration(memberStats.unattributedSeconds)} of that landed in the default project,
                    because nothing said which project it was for.
                  </p>
                )}
              </>
            )}
          </section>
        )}
      </section>

      {/* History lives out of the main scroll, one page at a time. */}
      <details
        className="card sessions-card"
        open={sessionsOpen}
        onToggle={(event) => setSessionsOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary>Recent sessions{sessionTotal > 0 ? ` (${sessionTotal})` : ""}</summary>
        {sessionRows.length === 0 ? (
          <p className="subtle">Nothing recorded in this range.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Project</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="numeric">Duration</th>
                </tr>
              </thead>
              <tbody>
                {sessionRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.user.name}</td>
                    <td>{row.project.name}</td>
                    <td>{new Date(row.startedAt).toLocaleString()}</td>
                    <td className="numeric hours">{formatHumanDuration(row.durationSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sessionRows.length < sessionTotal && (
              <button className="ghost" type="button" onClick={() => setSessionPage((page) => page + 1)}>
                Show more
              </button>
            )}
          </>
        )}
      </details>

      {organization && (
        <section className="card invite-card">
          <div>
            <h2>Invite your team</h2>
            <p className="subtle">Anyone who enters this code at sign-up joins this workspace.</p>
          </div>
          <div className="invite-actions">
            <code className="invite-code">{organization.inviteCode}</code>
            <button className="ghost" type="button" onClick={() => void copyInviteCode()}>{copied ? "Copied" : "Copy"}</button>
          </div>
        </section>
      )}

      {manageOpen && (
        <ManageProjects
          client={client}
          projects={projects}
          onChanged={() => {
            void refreshProjects()
              .then(() => reloadBoard())
              .catch((error: unknown) => setDataError(messageFor(error)));
          }}
          onClose={() => setManageOpen(false)}
        />
      )}

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
};

type RosterTabProps = {
  agents: readonly Agent[];
  agentsFailed: boolean;
  agentBusyId: string | undefined;
  selectedAgentId: string | undefined;
  onSelect: (agentId: string) => void;
  onRename: (agent: Agent, name: string) => void;
  paystub: AgentPaystubResponse | undefined;
  paystubFailed: boolean;
  rangeLabel: string;
  agentsReport: AgentsReportResponse | undefined;
  agentsReportFailed: boolean;
};

/// The roster in the board's own grammar, with an agent's paystub in the
/// detail region below. Hours come from the pay-run report, keyed by agent id.
const RosterTab = ({
  agents,
  agentsFailed,
  agentBusyId,
  selectedAgentId,
  onSelect,
  onRename,
  paystub,
  paystubFailed,
  rangeLabel,
  agentsReport,
  agentsReportFailed,
}: RosterTabProps) => {
  const [renamingId, setRenamingId] = useState<string | undefined>();
  const [renameDraft, setRenameDraft] = useState("");
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  const rowsByAgentId = new Map(agentsReport?.rows.map((row) => [row.agent.id, row]));
  return (
    <>
      {agentsReport !== undefined && !agentsReportFailed && (
        <p className="subtle" data-testid="roster-headcount">
          Headcount {agentsReport.headcount.total}
          {agentsReport.headcount.retired > 0 && ` - ${agentsReport.headcount.retired} retired`}
        </p>
      )}
      {agentsFailed ? (
        <p className="subtle">Could not load the roster.</p>
      ) : agents.length === 0 ? (
        <p className="subtle">No agents on the roster yet. Coding-agent shifts mint them automatically.</p>
      ) : (
        <ol className="board-list roster-list" data-testid="roster-list">
          {agents.map((agent) => {
            const models = rowsByAgentId.get(agent.id)?.models ?? [];
            return (
              <li
                key={agent.id}
                className={agent.id === selectedAgentId ? "is-selected" : undefined}
              >
                {renamingId === agent.id ? (
                  <form
                    className="manage-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const trimmed = renameDraft.trim();
                      if (trimmed === "") return;
                      setRenamingId(undefined);
                      onRename(agent, trimmed);
                    }}
                  >
                    <label>
                      <span className="visually-hidden">New name for {agent.name}</span>
                      <input value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} maxLength={200} required />
                    </label>
                    <button type="submit" disabled={agentBusyId === agent.id}>Save</button>
                    <button type="button" onClick={() => setRenamingId(undefined)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="board-choice"
                      aria-pressed={agent.id === selectedAgentId}
                      onClick={() => onSelect(agent.id)}
                    >
                      <span className="board-rank" aria-hidden="true" />
                      <span className="board-name">
                        {agent.name}
                        {agent.status === "retired" && <span className="you-tag"> retired</span>}
                      </span>
                      <span className="board-times">
                        <span className="board-hours">
                          {rowsByAgentId.get(agent.id)?.agentSeconds !== undefined
                            ? formatHumanDuration(rowsByAgentId.get(agent.id)!.agentSeconds)
                            : "-"}
                        </span>
                        <span className="board-agent">
                          {agentRuntimeLabel(agent.source)} · {agent.owner.name}
                          {models.length > 0 && ` · ${models.join(", ")}`}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ghost roster-rename"
                      disabled={agentBusyId === agent.id}
                      onClick={() => { setRenamingId(agent.id); setRenameDraft(agent.name); }}
                    >
                      {agentBusyId === agent.id ? "Saving…" : "Rename"}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {selected !== undefined && (
        <section className="member-stats" aria-labelledby="paystub-title" data-testid="agent-paystub">
          <div className="member-stats-head">
            <h3 id="paystub-title">{selected.name} · {rangeLabel}</h3>
          </div>
          {paystubFailed ? (
            <p className="subtle">Could not load this agent's paystub.</p>
          ) : paystub === undefined ? (
            <p className="subtle" role="status">Loading…</p>
          ) : (
            <>
              <div className="breakdown">
                <div className="metric-row is-headline">
                  <span className="metric-name">Hours</span>
                  <span className="metric-value">{formatHumanDuration(paystub.totals.agentSeconds)}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-name">Shifts</span>
                  <span className="metric-value">{paystub.totals.shiftCount}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-name">Commits recorded</span>
                  <span className="metric-value">{paystub.totals.commitsRecorded}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-name">
                    Held rate
                    <span className="metric-hint"> · self-reported by the machine that ran the shift</span>
                  </span>
                  <span className="metric-value">
                    {paystub.totals.heldRate === null ? "pending" : `${Math.round(paystub.totals.heldRate * 100)}%`}
                  </span>
                </div>
              </div>
              {paystub.shifts.length === 0 ? (
                <p className="subtle">No shifts in this range.</p>
              ) : (
                <>
                  <p className="subtle">Each shift below is one terminal session.</p>
                  <ul className="stat-list" data-testid="paystub-shifts">
                    {paystub.shifts.map((shift) => (
                      <li key={shift.id} className="stat-row">
                        <span className="stat-name">
                          {new Date(shift.startedAt).toLocaleString()}
                          {shift.model !== null && <span className="metric-hint"> · {shift.model}</span>}
                          {shift.commits.map((commit) => (
                            <span
                              key={commit.id}
                              className={`verify-badge is-${commit.verification}`}
                              title={`${commit.subject}${commit.verifiedAt === null ? "" : ` · verified ${new Date(commit.verifiedAt).toLocaleString()}`}`}
                            >
                              {commit.verification}
                            </span>
                          ))}
                        </span>
                        <span className="stat-duration">{formatHumanDuration(shift.durationSeconds)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <TrendStrip buckets={paystub.trend} formatDuration={formatHumanDuration} />
            </>
          )}
        </section>
      )}
    </>
  );
};

type ManageProjectsProps = {
  client: Client;
  projects: readonly ProjectListItem[];
  onChanged: () => void;
  onClose: () => void;
};

/** Create and the guarded delete: the whole management surface. */
const ManageProjects = ({ client, projects, onChanged, onClose }: ManageProjectsProps) => {
  const [error, setError] = useState<string | undefined>();
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<{ project: ProjectListItem; usage: ProjectUsageResponse } | undefined>();
  const [reassignTo, setReassignTo] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (actionError: unknown) {
      setError(messageFor(actionError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <section
        className="card modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="card-head">
          <h2 id="manage-title">Projects</h2>
          <button className="ghost" type="button" aria-label="Close projects" onClick={onClose}>✕</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}

        {deleting === undefined ? (
          <>
            <ul className="manage-list">
              {projects.map((project) => (
                <li key={project.id} className="manage-row">
                  <span className="manage-name">
                    {project.name}
                    {project.isDefault && <span className="you-tag"> default</span>}
                  </span>
                  {!project.isDefault && (
                    <button
                      className="ghost is-danger"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        // A read, not a mutation: opening the dialog must
                        // not refetch the whole board.
                        setBusy(true);
                        setError(undefined);
                        void client.projectUsage(project.id).then(
                          (usage) => {
                            setBusy(false);
                            // An empty project has nothing to guard: it goes
                            // on the click. Only recorded time needs the ask.
                            if (usage.sessionCount === 0 && usage.agentSessionCount === 0 && usage.agentCount === 0) {
                              void act(() => client.deleteProject(project.id, { reassignTo: null }));
                              return;
                            }
                            setDeleting({ project, usage });
                            setReassignTo("");
                          },
                          (usageError: unknown) => {
                            setError(messageFor(usageError));
                            setBusy(false);
                          },
                        );
                      }}
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <form
              className="manage-create"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  await client.createProject(newName.trim());
                  setNewName("");
                });
              }}
            >
              <label>
                <span className="visually-hidden">New project name</span>
                <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="New project…" maxLength={80} required />
              </label>
              <button className="ghost" type="submit" disabled={busy}>Create</button>
            </form>
          </>
        ) : (
          <div className="manage-delete">
            <p>
              Deleting <strong>{deleting.project.name}</strong> takes with it{" "}
              <strong>{deleting.usage.sessionCount} sessions</strong> ({formatHumanDuration(deleting.usage.durationSeconds)})
              and {deleting.usage.agentSessionCount} agent sessions, unless they move first.
            </p>
            {deleting.usage.agentCount > 0 && (
              <p className="subtle">
                {deleting.usage.agentCount} roster {deleting.usage.agentCount === 1 ? "agent moves" : "agents move"} with it,
                or retires where another agent already works the destination.
              </p>
            )}
            <label>
              What happens to its sessions?
              <select value={reassignTo} onChange={(event) => setReassignTo(event.target.value)}>
                <option value="">Delete them with the project</option>
                {projects.filter((project) => project.id !== deleting.project.id).map((project) => (
                  <option key={project.id} value={project.id}>Move to {project.name}</option>
                ))}
              </select>
            </label>
            <div className="manage-actions">
              <button
                className="ghost is-danger"
                type="button"
                disabled={busy}
                onClick={() => void act(async () => {
                  await client.deleteProject(deleting.project.id, { reassignTo: reassignTo === "" ? null : reassignTo });
                  setDeleting(undefined);
                })}
              >
                Delete {deleting.project.name}
              </button>
              <button className="ghost" type="button" disabled={busy} onClick={() => setDeleting(undefined)}>Cancel</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
