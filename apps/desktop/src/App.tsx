import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { AccountSnapshot, SignedInAccount } from "./account.js";
import { sourceLabel } from "./agent-sources.js";
import {
  bridgeError,
  defaultBridge,
  type BrowserHealth,
  type MeStats,
  type MeStatsApp,
  type MonitorSettings,
  type MonitorStatus,
  type OrganizationOverview,
  type ProjectUsage,
  type AgentQuota,
  type QuotaSnapshot,
  type SessionApp,
  type SettingsPatch,
  type TimerBridge,
} from "./bridge.js";
import { AgentRuntimeIcon } from "./agent-icons.js";
import { QuotaDial } from "./QuotaDial.js";
import { agentRuntimeForBinary, formatDuration, formatHumanDuration as formatHuman, friendlyAppName, leverage } from "@clock-in/shared";
import { RecordingPanel, recordingState, type RecordingState } from "./RecordingPanel.js";
import { WebGLShader } from "./WebGLShader.js";

type AppProps = {
  bridge?: TimerBridge;
};

/// Status polls stay well above the host's own 30-second activity tick; the
/// latency this buys is fine for a tray utility.
const MONITOR_POLL_MS = 15_000;

/// Plan quota moves slowly and each read shells out to another tool, so it is
/// asked for far less often than the recording status.
const QUOTA_POLL_MS = 120_000;

/// The host answers the first call from an empty cache and reads the
/// providers behind it, which takes about ten seconds. Waiting out the slow
/// poll would leave the dial saying "checking" for two minutes on every
/// launch, so a pending answer is followed up promptly.
const QUOTA_PENDING_POLL_MS = 3_000;

/// The reading for one agent source (`claude_code` → the `claude` provider).
const quotaFor = (snapshot: QuotaSnapshot | undefined, source: string): AgentQuota | undefined =>
  snapshot?.providers.find((provider) => provider.sources.includes(source));

const elapsedSeconds = (since: string, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));

type AppRow = {
  key: string;
  label: string;
  durationSeconds: number;
  agent: boolean;
};

const TOP_APP_ROWS = 8;

/// Heaviest-first app rows for the Today card: agent CLIs fold into one row
/// that never folds further into "Everything else" (so the agent runtimes
/// stay visible), and everything else past the top rows folds into
/// "Everything else". Which executables count as an agent comes from the
/// shared runtime roster, so a newly declared CLI folds in without a second
/// list to remember.
const buildAppRows = (apps: readonly MeStatsApp[]): AppRow[] => {
  let agentSeconds = 0;
  const agentSources = new Set<string>();
  const rows: AppRow[] = [];
  for (const app of apps) {
    const agentSource = agentRuntimeForBinary(app.processName);
    if (agentSource !== undefined) {
      agentSeconds += app.durationSeconds;
      agentSources.add(agentSource);
      continue;
    }
    rows.push({ key: app.processName, label: friendlyAppName(app.processName), durationSeconds: app.durationSeconds, agent: false });
  }
  if (agentSeconds > 0) {
    const sources = [...agentSources];
    rows.push({
      key: "agent-clis",
      label: sources.length === 1 ? sourceLabel(sources[0] ?? "") : "Agent CLIs",
      durationSeconds: agentSeconds,
      agent: true,
    });
  }
  rows.sort((a, b) => b.durationSeconds - a.durationSeconds || a.label.localeCompare(b.label));
  if (rows.length <= TOP_APP_ROWS) return rows;
  // The agent row never folds into the tail: the fold would hide the agent
  // runtimes inside "Everything else".
  const kept = [...rows.slice(0, TOP_APP_ROWS), ...rows.slice(TOP_APP_ROWS).filter((row) => row.agent)];
  const rest = rows.slice(TOP_APP_ROWS).filter((row) => !row.agent)
    .reduce((sum, row) => sum + row.durationSeconds, 0);
  if (rest === 0) return kept;
  return [...kept, { key: "everything-else", label: "Everything else", durationSeconds: rest, agent: false }];
};

/// The human/agent split laid out as labeled rows instead of one cramped
/// sentence: active time up top (Solo is now "Human work"), agent runtime
/// below, and the leverage ratio as the agent-side headline.
const MemberBreakdown = ({ stats, self }: { stats: MeStats; self: boolean }) => {
  const { activeSeconds, agentSeconds, concurrency } = stats;
  const awaySeconds = concurrency.awaySeconds;
  const presentAgentSeconds = Math.max(0, agentSeconds - awaySeconds);
  const ratio = leverage(stats);
  return (
    <div className="breakdown" data-testid="breakdown">
      <p className="group-label">{self ? "Your active time — the hours you were at this computer" : "Active time — the hours they were at this computer"}</p>
      <div className="metric-row is-headline">
        <span className="metric-name">Active time</span>
        <span className="metric-value">{formatHuman(activeSeconds)}</span>
      </div>
      <div className="metric-row">
        <span className="metric-swatch swatch-human" aria-hidden="true" />
        <span className="metric-name">Human work <span className="metric-hint">(no agent running)</span></span>
        <span className="metric-value">{formatHuman(concurrency.t0Seconds)}</span>
      </div>
      {concurrency.t1Seconds > 0 && (
        <div className="metric-row">
          <span className="metric-swatch swatch-agent1" aria-hidden="true" />
          <span className="metric-name">With 1 agent</span>
          <span className="metric-value">{formatHuman(concurrency.t1Seconds)}</span>
        </div>
      )}
      {concurrency.t2Seconds > 0 && (
        <div className="metric-row">
          <span className="metric-swatch swatch-agent2" aria-hidden="true" />
          <span className="metric-name">With 2 agents</span>
          <span className="metric-value">{formatHuman(concurrency.t2Seconds)}</span>
        </div>
      )}
      {concurrency.t3PlusSeconds > 0 && (
        <div className="metric-row">
          <span className="metric-swatch swatch-agent3" aria-hidden="true" />
          <span className="metric-name">With 3+ agents</span>
          <span className="metric-value">{formatHuman(concurrency.t3PlusSeconds)}</span>
        </div>
      )}
      {agentSeconds > 0 && (
        <>
          <p className="group-label">{self ? "Agent runtime — summed, may exceed your hours" : "Agent runtime — summed, may exceed their hours"}</p>
          <div className="metric-row is-subtotal">
            <span className="metric-name">{self ? "While you were there" : "While they were there"}</span>
            <span className="metric-value">{formatHuman(presentAgentSeconds)}</span>
          </div>
          {awaySeconds > 0 && (
            <div className="metric-row">
              <span className="metric-swatch swatch-away" aria-hidden="true" />
              <span className="metric-name">Agents while away <span className="metric-hint">({self ? "never your hours" : "never their hours"})</span></span>
              <span className="metric-value">{formatHuman(awaySeconds)}</span>
            </div>
          )}
          <div className="metric-row is-subtotal is-headline">
            <span className="metric-name">Total agent time · leverage</span>
            <span className="metric-value">{formatHuman(agentSeconds)}{ratio !== null && ` · ${ratio}×`}</span>
          </div>
        </>
      )}
    </div>
  );
};

/// Which models actually ran, how many sessions that was, how many overlapped
/// at once, and how long a session typically lasted - all already in the
/// agent_sessions table, now presented rather than folded into a note.
const AgentSessionsTable = ({ byAgent }: { byAgent: readonly MeStats["byAgent"][number][] }) => {
  if (byAgent.length === 0) return null;
  return (
    <div className="agent-sessions" data-testid="agent-sessions">
      <p className="group-label">Agent sessions</p>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th className="numeric">Sessions</th>
            <th className="numeric">Max at once</th>
            <th className="numeric">Total</th>
            <th className="numeric">Median</th>
          </tr>
        </thead>
        <tbody>
          {byAgent.map((split) => (
            <tr key={`${split.source}|${split.model ?? ""}`}>
              <td>
                {split.model ?? sourceLabel(split.source)}
                {split.model !== null && <span className="metric-hint"> · {sourceLabel(split.source)}</span>}
              </td>
              {/* Null means the deployed API predates the field: absence
                  shown as absence, never as a zero that never happened. */}
              <td className="numeric">{split.sessionCount ?? "-"}</td>
              <td className="numeric">{split.maxConcurrent ?? "-"}</td>
              <td className="numeric">{formatHuman(split.durationSeconds)}</td>
              <td className="numeric">{split.medianSeconds === null ? "-" : formatHuman(split.medianSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/// Two-line SVG chart - agents in the brand green, the person in gray. No
/// chart library: a fixed viewBox and two polylines are all a day needs, and
/// the server already buckets to the caller's local hours.
const HourlyGraph = ({ buckets }: { buckets: readonly MeStats["hourly"][number][] }) => {
  if (buckets.length === 0) return null;
  const width = 640;
  const height = 190;
  const margin = { left: 38, right: 12, top: 14, bottom: 24 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const rawMax = Math.max(60, ...buckets.map((bucket) => Math.max(bucket.activeSeconds, bucket.agentSeconds)));
  const yMax = Math.max(900, Math.ceil(rawMax / 900) * 900);
  const x = (index: number): number =>
    buckets.length === 1 ? margin.left + plotW / 2 : margin.left + (index / (buckets.length - 1)) * plotW;
  const y = (value: number): number => margin.top + plotH - (value / yMax) * plotH;
  const line = (key: "activeSeconds" | "agentSeconds"): string =>
    buckets.map((bucket, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(bucket[key]).toFixed(1)}`).join(" ");
  const tickCount = Math.min(7, buckets.length);
  const xTicks = Array.from({ length: tickCount }, (_, tick) => {
    const index = tickCount === 1 ? 0 : Math.round((tick / (tickCount - 1)) * (buckets.length - 1));
    const date = new Date(buckets[index]!.hourStart);
    const label = buckets.length <= 48
      ? String(date.getHours()).padStart(2, "0")
      : date.toLocaleDateString([], { month: "short", day: "numeric" });
    return { index, label };
  });
  return (
    <div className="graph" data-testid="hourly-graph">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Hourly active and agent time">
        <line x1={margin.left} y1={y(0)} x2={width - margin.right} y2={y(0)} stroke="rgba(163,179,194,.25)" />
        <line x1={margin.left} y1={y(yMax)} x2={width - margin.right} y2={y(yMax)} stroke="rgba(163,179,194,.12)" />
        <text x={margin.left - 6} y={y(0) + 3} fill="#a3b3c2" fontSize="9" textAnchor="end">0</text>
        <text x={margin.left - 6} y={y(yMax) + 3} fill="#a3b3c2" fontSize="9" textAnchor="end">{formatHuman(yMax)}</text>
        {xTicks.map(({ index, label }) => (
          <text key={index} x={x(index)} y={height - 6} fill="#a3b3c2" fontSize="9" textAnchor="middle">{label}</text>
        ))}
        <polyline points={line("activeSeconds")} fill="none" stroke="#8b98a8" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={line("agentSeconds")} fill="none" stroke="#00e59b" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <ul className="legend">
        <li><span className="legend-line legend-agents" aria-hidden="true" />Agents</li>
        <li><span className="legend-line legend-humans" aria-hidden="true" />You</li>
      </ul>
    </div>
  );
};

/// Every sentence the main page says about recording, keyed by the one shared
/// recording state. Keeping them in tables rather than inline conditionals is
/// what stops a surface from asserting something the state never claimed.
const MONITOR_LINE: Record<RecordingState, string> = {
  on: "Recording on",
  stalled: "Recording stopped responding",
  paused: "Recording paused",
  off: "Recording off",
  unknown: "Checking this computer…",
};

const IDLE_HEADING: Record<RecordingState, string> = {
  on: "Nothing to record yet",
  stalled: "Recording stopped responding",
  paused: "Recording is starting",
  off: "Recording is off",
  unknown: "Checking this computer…",
};

const IDLE_BLURB: Record<RecordingState, string> = {
  on: "Clock-In starts writing your hours down as soon as you use this computer. There is nothing to press.",
  stalled: "Clock-In has not looked at this computer for a while. Restarting the app starts it again.",
  paused: "It starts on its own in a moment.",
  off: "Turn recording on and Clock-In keeps your hours without you doing anything.",
  unknown: "Clock-In is asking this computer what it is doing.",
};

const TODAY_EMPTY: Record<RecordingState, string> = {
  on: "Nothing has been added up yet. Your hours appear here as they are sent to your workspace.",
  stalled: "Nothing new is being written down, because recording stopped responding.",
  paused: "Nothing yet. Recording is about to start.",
  off: "Nothing yet. Turn recording on to see where your time goes.",
  unknown: "Clock-In can't reach the recorder on this computer, so it can't say.",
};

/// One app's share of the day, as the home surface renders it.
type MeterRow = {
  key: string;
  label: string;
  /// The agent runtime this executable belongs to, when it is one. Drives the
  /// runtime mark, and is how a CLI gets called "Claude Code" rather than
  /// "Claude.exe".
  source: string | undefined;
  /// The executable behind the row, for the OS icon lookup. Absent on the
  /// folded "Everything else" row.
  processName: string | undefined;
  /// Extra words beside the name - the folder an agent session is working in.
  detail?: string | undefined;
  durationSeconds: number;
  /// Percentage of the longest row, for the bar in the row.
  share: number;
};

/// Turns per-app seconds into meter rows. Agent CLIs keep their own row rather
/// than folding into one: which tool the time went to is the whole question
/// this surface answers. Everything past the top rows folds into one.
const buildMeterRows = (apps: readonly SessionApp[]): MeterRow[] => {
  const longest = apps.reduce((most, app) => Math.max(most, app.durationSeconds), 0);
  const share = (durationSeconds: number): number =>
    longest === 0 ? 0 : Math.round((durationSeconds / longest) * 100);
  const rows = apps
    .filter((app) => app.durationSeconds > 0)
    .map((app) => {
      const source = agentRuntimeForBinary(app.processName);
      return {
        key: app.processName,
        label: source === undefined ? friendlyAppName(app.processName) : sourceLabel(source),
        source,
        processName: app.processName,
        durationSeconds: app.durationSeconds,
        share: share(app.durationSeconds),
      };
    })
    .sort((a, b) => b.durationSeconds - a.durationSeconds || a.label.localeCompare(b.label));
  if (rows.length <= TOP_APP_ROWS) return rows;
  const rest = rows.slice(TOP_APP_ROWS).reduce((sum, row) => sum + row.durationSeconds, 0);
  return [...rows.slice(0, TOP_APP_ROWS), {
    key: "everything-else",
    label: "Everything else",
    source: undefined,
    processName: undefined,
    durationSeconds: rest,
    share: share(rest),
  }];
};

type StatsRange = "today" | "week" | "all";

const RANGE_LABEL: Record<StatsRange, string> = {
  today: "Today",
  week: "This week",
  all: "All time",
};

/// The range as instants on this computer's clock: "today" runs from local
/// midnight to the next one, "week" from local midnight on Monday. Calendar
/// dates would be read as a UTC day, which rolls over in the afternoon
/// anywhere west of Greenwich - the day's total would reset hours before
/// midnight and carry the previous evening's work. "All time" sends no bounds
/// at all, which is how the server reads "everything".
const rangeBounds = (range: StatsRange): { fromAt: string; toExclusiveAt: string } | undefined => {
  if (range === "all") return undefined;
  const start = new Date();
  if (range === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + (range === "week" ? 7 : 1));
  return { fromAt: start.toISOString(), toExclusiveAt: end.toISOString() };
};

type TitlebarProps = {
  onOpenSettings?: (() => void) | undefined;
};

/// Slim frameless-window titlebar: drag region on the bar itself (buttons stay
/// clickable - the Tauri drag script skips clickable elements), window
/// controls on the right.
const Titlebar = ({ onOpenSettings }: TitlebarProps) => {
  const appWindow = getCurrentWindow();
  return (
    <header className="titlebar" data-tauri-drag-region>
      <span className="titlebar-title" data-tauri-drag-region>Clock-In</span>
      <div className="titlebar-controls">
        {onOpenSettings && (
          <button type="button" className="titlebar-button" aria-label="Settings" title="Settings" onClick={onOpenSettings}>⚙</button>
        )}
        <button type="button" className="titlebar-button" aria-label="Minimize" onClick={() => void appWindow.minimize()}>–</button>
        <button type="button" className="titlebar-button" aria-label="Maximize" onClick={() => void appWindow.toggleMaximize()}>▢</button>
        <button type="button" className="titlebar-button titlebar-close" aria-label="Close" onClick={() => void appWindow.close()}>✕</button>
      </div>
    </header>
  );
};

export const App = ({ bridge = defaultBridge }: AppProps) => {
  const [account, setAccount] = useState<AccountSnapshot | undefined>();
  const [authError, setAuthError] = useState<string | undefined>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [authBusy, setAuthBusy] = useState(false);
  const [overview, setOverview] = useState<OrganizationOverview | undefined>();
  const [overviewError, setOverviewError] = useState<string | undefined>();
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | undefined>();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | undefined>();
  const [updateVersion, setUpdateVersion] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [allStatsOpen, setAllStatsOpen] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [stats, setStats] = useState<MeStats | undefined>();
  const [statsError, setStatsError] = useState<string | undefined>();
  /// The All stats overlay keeps its own range and its own reading, so opening
  /// someone's week there never rewrites the day the main screen is showing.
  const [boardRange, setBoardRange] = useState<StatsRange>("today");
  const [boardMember, setBoardMember] = useState<{ id: string; name: string } | undefined>();
  const [boardStats, setBoardStats] = useState<MeStats | undefined>();
  const [boardStatsError, setBoardStatsError] = useState<string | undefined>();
  const [settings, setSettings] = useState<MonitorSettings | undefined>();
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const [quietDraft, setQuietDraft] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [renamingProjectId, setRenamingProjectId] = useState<string | undefined>();
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingProject, setDeletingProject] = useState<{ id: string; name: string; usage: ProjectUsage } | undefined>();
  const [deleteReassignTo, setDeleteReassignTo] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [appIcons, setAppIcons] = useState<Record<string, string | null>>({});
  const [quota, setQuota] = useState<QuotaSnapshot | undefined>();
  const [statsTick, setStatsTick] = useState(0);
  const [hookChoice, setHookChoice] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState<string | undefined>();
  /// Manual hook-setup snippets returned by `hookRegister`, keyed by CLI source.
  const [hookSnippets, setHookSnippets] = useState<Readonly<Record<string, string>>>({});
  /// One card per installed browser, refreshed while the recording panel is open.
  const [browsers, setBrowsers] = useState<readonly BrowserHealth[]>([]);
  const latestBridge = useRef(bridge);
  const mounted = useRef(true);
  const bridgeGeneration = useRef(0);
  /// Consecutive-failure counters for the background polls: one failed
  /// request keeps the last-good reading; the banner waits for three in a
  /// row, unless there is no data to keep showing at all.
  const statsFailures = useRef(0);
  const overviewFailures = useRef(0);
  const boardStatsFailures = useRef(0);

  if (latestBridge.current !== bridge) bridgeGeneration.current += 1;
  latestBridge.current = bridge;

  const isCurrent = (service: TimerBridge, generation: number): boolean =>
    mounted.current && latestBridge.current === service && bridgeGeneration.current === generation;

  const clearAccountFields = (): void => {
    setPassword("");
    setName("");
    setInviteCode("");
    setJoinCode("");
    setOverview(undefined);
    setOverviewError(undefined);
    setMonitorStatus(undefined);
    setStats(undefined);
    setStatsError(undefined);
    setBoardMember(undefined);
    setBoardStats(undefined);
    setBoardStatsError(undefined);
    statsFailures.current = 0;
    overviewFailures.current = 0;
    boardStatsFailures.current = 0;
    setSettings(undefined);
    setSettingsError(undefined);
    setHookSnippets({});
    setSettingsOpen(false);
    setRecordingOpen(false);
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // The updater announces itself once per launch at most; the banner stays
  // up until the install restarts the app.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void bridge.onUpdateAvailable((version) => {
      if (active && mounted.current) setUpdateVersion(version);
    }).then(
      (stop) => {
        if (active) unlisten = stop;
        else stop();
      },
      () => undefined,
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, [bridge]);

  useEffect(() => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    void service.bootstrap().then(
      (snapshot) => {
        if (!isCurrent(service, generation)) return;
        clearAccountFields();
        setAccount(snapshot);
      },
      (error: unknown) => {
        if (!isCurrent(service, generation)) return;
        clearAccountFields();
        setAccount({ kind: "signed-out" });
        setAuthError(bridgeError(error).message);
      },
    );
  }, [bridge]);

  const signedIn = account?.kind === "ready" ? account : undefined;

  // The elapsed reading on the recording card ticks like a clock.
  useEffect(() => {
    if (monitorStatus?.currentSession == null) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [monitorStatus?.currentSession?.since]);

  useEffect(() => {
    if (signedIn === undefined) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    void service.orgOverview().then(
      (result) => {
        if (active && isCurrent(service, generation)) {
          overviewFailures.current = 0;
          setOverview(result);
          setOverviewError(undefined);
        }
      },
      (error: unknown) => {
        if (!active || !isCurrent(service, generation)) return;
        const problem = bridgeError(error);
        // An expired session is handled by whatever the user does next; the
        // board going stale is not worth a sign-in bounce.
        if (problem.kind === "auth") return;
        overviewFailures.current += 1;
        if (overviewFailures.current >= 3 || overview === undefined) setOverviewError(problem.message);
      },
    );
    return () => { active = false; };
    // `overview` is read only to tell "nothing to show" from "stale";
    // re-running on its change would refetch after every success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, signedIn?.user.id]);

  useEffect(() => {
    if (signedIn === undefined) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    // The main screen is a day, always. It used to follow the All stats range
    // picker, so choosing "this week" over there quietly turned the heading's
    // own date into a week's total.
    const bounds = rangeBounds("today");
    void service.meStats(bounds?.fromAt, bounds?.toExclusiveAt).then(
      (result) => {
        if (active && isCurrent(service, generation)) {
          statsFailures.current = 0;
          setStats(result);
          setStatsError(undefined);
        }
      },
      (error: unknown) => {
        if (!active || !isCurrent(service, generation)) return;
        const problem = bridgeError(error);
        if (problem.kind === "auth") return;
        statsFailures.current += 1;
        if (statsFailures.current >= 3 || stats === undefined) setStatsError(problem.message);
      },
    );
    return () => { active = false; };
    // `stats` is read only to tell "nothing to show" from "stale"; re-running
    // on its change would refetch after every success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, signedIn?.user.id, statsTick]);

  // The All stats overlay reads on its own account: whichever member is being
  // looked at, over whichever range that overlay is set to. Only while it is
  // open — nobody is served by fetching a teammate's year in the background.
  // Your own "today" is the exception: the overlay reuses the main screen's
  // live reading rather than fetching a second copy of the same day.
  //
  // The reading is only blanked when who or what changed, so the minutely
  // refresh tick replaces the numbers in place instead of flashing "Loading…".
  const lastBoardKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (signedIn === undefined || !allStatsOpen) return undefined;
    const boardKey = `${boardRange}|${boardMember?.id ?? ""}`;
    // Blanked means who or what changed: there is no last-good reading to
    // keep, so a failure surfaces immediately rather than after three.
    const blanked = lastBoardKey.current !== boardKey;
    if (blanked) {
      lastBoardKey.current = boardKey;
      boardStatsFailures.current = 0;
      setBoardStats(undefined);
      setBoardStatsError(undefined);
    }
    if ((boardMember === undefined || boardMember.id === signedIn.user.id) && boardRange === "today") return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const bounds = rangeBounds(boardRange);
    void service.meStats(
      bounds?.fromAt,
      bounds?.toExclusiveAt,
      boardMember?.id,
    ).then(
      (result) => {
        if (active && isCurrent(service, generation)) {
          boardStatsFailures.current = 0;
          setBoardStats(result);
          setBoardStatsError(undefined);
        }
      },
      (error: unknown) => {
        if (!active || !isCurrent(service, generation)) return;
        const problem = bridgeError(error);
        if (problem.kind === "auth") return;
        boardStatsFailures.current += 1;
        if (boardStatsFailures.current >= 3 || blanked || boardStats === undefined) setBoardStatsError(problem.message);
      },
    );
    return () => { active = false; };
    // `boardStats` is read only to tell "nothing to show" from "stale";
    // re-running on its change would refetch after every success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, allStatsOpen, boardRange, boardMember?.id, signedIn?.user.id, statsTick]);

  // The board itself follows the overlay's range too: hours beside a name and
  // the breakdown under it must answer for the same days. All time sends no
  // bounds, which is also what the masthead's one boot-time read shows.
  useEffect(() => {
    if (signedIn === undefined || !allStatsOpen) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const bounds = rangeBounds(boardRange);
    void service.orgOverview(
      bounds?.fromAt,
      bounds?.toExclusiveAt,
    ).then(
      (result) => {
        if (active && isCurrent(service, generation)) {
          overviewFailures.current = 0;
          setOverview(result);
          setOverviewError(undefined);
        }
      },
      (error: unknown) => {
        if (!active || !isCurrent(service, generation)) return;
        const problem = bridgeError(error);
        if (problem.kind === "auth") return;
        overviewFailures.current += 1;
        if (overviewFailures.current >= 3 || overview === undefined) setOverviewError(problem.message);
      },
    );
    return () => { active = false; };
    // `overview` is read only to tell "nothing to show" from "stale";
    // re-running on its change would refetch after every success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, allStatsOpen, boardRange, signedIn?.user.id, statsTick]);

  // Agent plan quota, read from this machine. Advisory and never on the
  // critical path: a failure leaves the dials unknown rather than saying so.
  useEffect(() => {
    if (signedIn === undefined) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    let timer: number | undefined;
    const read = (): void => {
      void service.quotaStatus().then(
        (snapshot) => {
          if (!active || !isCurrent(service, generation)) return;
          setQuota(snapshot);
          timer = window.setTimeout(
            read,
            snapshot.status === "pending" ? QUOTA_PENDING_POLL_MS : QUOTA_POLL_MS,
          );
        },
        () => {
          if (active) timer = window.setTimeout(read, QUOTA_POLL_MS);
        },
      );
    };
    read();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [bridge, signedIn?.user.id]);

  // Keeps the Today panel close to live: a slow tick refreshes the totals.
  useEffect(() => {
    if (signedIn === undefined) return undefined;
    const timer = window.setInterval(() => setStatsTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [signedIn?.user.id]);

  // One immediate refresh follows each finished stretch, delayed a beat so
  // the host's own upload of that session has landed before the refetch.
  const lastSessionSince = useRef<string | null>(null);
  useEffect(() => {
    const since = monitorStatus?.currentSession?.since ?? null;
    const ended = lastSessionSince.current !== null && since === null;
    lastSessionSince.current = since;
    if (!ended) return undefined;
    const timer = window.setTimeout(() => setStatsTick((tick) => tick + 1), 3_000);
    return () => window.clearTimeout(timer);
  }, [monitorStatus?.currentSession?.since]);

  // OS icons for the app rows on screen. Missing answers stay null so each
  // executable is looked up once per launch.
  useEffect(() => {
    if (signedIn === undefined || stats === undefined) return undefined;
    const wanted = stats.apps
      .map((app) => app.processName)
      .filter((name) => agentRuntimeForBinary(name) === undefined && !(name in appIcons));
    if (wanted.length === 0) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    void service.appIcons(wanted).then(
      (icons) => {
        if (active && isCurrent(service, generation)) {
          setAppIcons((current) => ({ ...icons, ...current }));
        }
      },
      () => undefined,
    );
    return () => { active = false; };
    // appIcons is read for the dedupe only; re-running on its change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, stats, signedIn?.user.id]);

  // Status poll. Failures — signed out, unsupported, offline — leave the
  // surfaces hidden rather than noisy; there is no state where recording
  // happens without the UI saying so.
  useEffect(() => {
    if (signedIn === undefined) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const poll = (): void => {
      void service.monitorStatus().then(
        (status) => {
          if (active && isCurrent(service, generation)) setMonitorStatus(status);
        },
        () => undefined,
      );
    };
    poll();
    const timer = window.setInterval(poll, MONITOR_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [bridge, signedIn?.user.id]);

  // The browser cards' connection state changes only when a browser launches
  // the host, so it is polled while the panel is open rather than always.
  // Failures leave the last cards rather than blanking the list.
  useEffect(() => {
    if (!recordingOpen) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const poll = (): void => {
      void service.browserStatus().then(
        (next) => {
          if (active && isCurrent(service, generation)) setBrowsers(next);
        },
        () => undefined,
      );
    };
    poll();
    const timer = window.setInterval(poll, MONITOR_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [bridge, recordingOpen]);

  // Settings only load while the settings overlay is open.
  useEffect(() => {
    if (!settingsOpen) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    void service.settingsGet().then(
      (result) => {
        if (!active || !isCurrent(service, generation)) return;
        setSettings(result);
        setQuietDraft(String(result.awayThresholdMinutes));
        setSettingsError(undefined);
      },
      (error: unknown) => {
        if (!active || !isCurrent(service, generation)) return;
        const problem = bridgeError(error);
        if (problem.kind !== "auth") setSettingsError(problem.message);
      },
    );
    return () => { active = false; };
  }, [bridge, settingsOpen]);

  // The settings overlay closes on Escape. The "what's recorded" panel opens
  // over the top of it and owns Escape while it is up, so one press closes
  // one dialog.
  useEffect(() => {
    if (!settingsOpen || recordingOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, recordingOpen]);

  const submitAuth = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(undefined);
    const service = bridge;
    const generation = bridgeGeneration.current;
    try {
      const snapshot = authMode === "sign-up"
        ? await service.signup({
            email,
            password,
            name: name.trim(),
            ...(inviteCode.trim() === "" ? {} : { inviteCode: inviteCode.trim() }),
          })
        : await service.login({ email, password });
      if (!isCurrent(service, generation)) return;
      clearAccountFields();
      setAccount(snapshot);
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setAuthError(bridgeError(error).message);
    } finally {
      if (isCurrent(service, generation)) setAuthBusy(false);
    }
  };

  const applyStatus = (status: MonitorStatus): void => setMonitorStatus(status);

  /// Copies the invite code and says so on the button itself, which is the
  /// only confirmation a copy needs.
  const copyInviteCode = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2_000);
    } catch {
      // A refused clipboard is not worth an error banner: the code is on
      // screen and can be typed.
      setInviteCopied(false);
    }
  };

  const selectProject = async (projectId: string): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    setAccountError(undefined);
    try {
      const status = await service.sessionSelectProject(projectId === "" ? null : projectId);
      if (isCurrent(service, generation)) {
        applyStatus(status);
        // Choosing collapses the picker back to the one-line reading.
        setProjectPickerOpen(false);
      }
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setAccountError(bridgeError(error).message);
    }
  };

  /// Creates a project and pins recording to it, which is the only reason to
  /// make one from this screen.
  const createProject = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = newProjectName.trim();
    if (newProjectBusy || trimmed === "") return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    setNewProjectBusy(true);
    setNewProjectError(undefined);
    try {
      const created = await service.projectCreate({ name: trimmed });
      const snapshot = await service.bootstrap();
      if (!isCurrent(service, generation)) return;
      setAccount(snapshot);
      setNewProjectName("");
      setNewProjectOpen(false);
      await selectProject(created.id);
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setNewProjectError(bridgeError(error).message);
    } finally {
      if (isCurrent(service, generation)) setNewProjectBusy(false);
    }
  };

  /// Runs one project-management call, then re-bootstraps so every surface
  /// sees the new project list.
  const manageProject = async (action: (service: TimerBridge) => Promise<void>): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    setProjectBusy(true);
    setSettingsError(undefined);
    try {
      await action(service);
      const snapshot = await service.bootstrap();
      if (isCurrent(service, generation)) setAccount(snapshot);
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setSettingsError(bridgeError(error).message);
    } finally {
      if (isCurrent(service, generation)) setProjectBusy(false);
    }
  };

  const applySettings = async (patch: SettingsPatch): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    setSettingsError(undefined);
    try {
      const next = await service.settingsUpdate(patch);
      if (isCurrent(service, generation)) setSettings(next);
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setSettingsError(bridgeError(error).message);
    }
  };

  const applyRecordingEnabled = async (enabled: boolean): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    setSettingsError(undefined);
    try {
      const next = await service.monitorSetEnabled(enabled);
      if (!isCurrent(service, generation)) return;
      setSettings(next);
      // The status line reflects the new state immediately rather than at the
      // next poll tick.
      const status = await service.monitorStatus();
      if (isCurrent(service, generation)) applyStatus(status);
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setSettingsError(bridgeError(error).message);
    }
  };

  const registerHook = async (source: string): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    setSettingsError(undefined);
    try {
      const result = await service.hookRegister(source);
      if (!isCurrent(service, generation)) return;
      if (result.status === "manual") {
        setHookSnippets((current) => ({ ...current, [source]: result.snippet }));
      } else {
        setHookSnippets((current) => {
          if (!(source in current)) return current;
          const next = { ...current };
          delete next[source];
          return next;
        });
      }
      const status = await service.monitorStatus();
      if (isCurrent(service, generation)) applyStatus(status);
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setSettingsError(bridgeError(error).message);
    }
  };

  /// Opens the browser's extension store page; the one step a person must take
  /// because the browser will not let anyone install an extension for them.
  const openBrowserStore = (browserId: string): void => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    setSettingsError(undefined);
    void service.browserOpenStore(browserId).catch((error: unknown) => {
      if (isCurrent(service, generation)) setSettingsError(bridgeError(error).message);
    });
  };

  /// Re-registers the host for one browser, then re-reads the cards from the
  /// answer so a repaired row flips immediately.
  const repairBrowser = async (browserId: string): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    setSettingsError(undefined);
    try {
      await service.browserRepair(browserId);
      if (!isCurrent(service, generation)) return;
      const next = await service.browserStatus();
      if (isCurrent(service, generation)) setBrowsers(next);
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setSettingsError(bridgeError(error).message);
    }
  };

  const commitQuietMinutes = (raw: string): void => {
    const minutes = Number.parseInt(raw, 10);
    if (!settings || !Number.isSafeInteger(minutes) || minutes < 1 || settings.awayThresholdMinutes === minutes) return;
    void applySettings({ awayThresholdMinutes: minutes });
  };

  const joinWorkspace = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (joinBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    setJoinBusy(true);
    setOverviewError(undefined);
    try {
      const result = await service.orgJoin(joinCode.trim());
      const snapshot = await service.bootstrap();
      if (isCurrent(service, generation)) {
        setOverview(result);
        setAccount(snapshot);
        setJoinCode("");
      }
    } catch (error: unknown) {
      if (!isCurrent(service, generation)) return;
      setOverviewError(bridgeError(error).message);
    } finally {
      if (isCurrent(service, generation)) setJoinBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    if (logoutBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    setLogoutBusy(true);
    setAccountError(undefined);
    try {
      await service.logout();
      if (!isCurrent(service, generation)) return;
      clearAccountFields();
      setEmail("");
      setAccount({ kind: "signed-out" });
      setAuthError("You have signed out.");
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setAccountError(bridgeError(error).message);
    } finally {
      if (isCurrent(service, generation)) setLogoutBusy(false);
    }
  };

  if (account === undefined) {
    return (
      <main className="app-shell">
        <WebGLShader />
        <Titlebar />
        <div className="center-stage" aria-busy="true">
          <p className="boot-message" role="status">Connecting to clock service…</p>
        </div>
      </main>
    );
  }

  if (account.kind === "signed-out") {
    const isSignUp = authMode === "sign-up";
    return (
      <main className="app-shell">
        <WebGLShader />
        <Titlebar />
        <div className="center-stage">
          {/* The titlebar already says the app's name; the card says only
              what to do here. */}
          <section className="sign-in-panel card" aria-labelledby="sign-in-title">
            <h1 id="sign-in-title">{isSignUp ? "Create your account" : "Sign in"}</h1>
            <p className="subtle">
              {isSignUp
                ? "Your workspace and first project are set up automatically."
                : "Clock-In keeps your hours for you."}
            </p>
            {authError && <p className="form-error" role="alert">{authError}</p>}
            <form onSubmit={submitAuth}>
              {isSignUp && <label>Name<input value={name} onChange={(event) => setName(event.target.value)} type="text" autoComplete="name" required /></label>}
              <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required /></label>
              <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={isSignUp ? "new-password" : "current-password"} minLength={isSignUp ? 8 : undefined} required /></label>
              {isSignUp && (
                <label>
                  Invite code <span className="optional">optional</span>
                  <input
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Join a team, or leave blank"
                  />
                </label>
              )}
              <button className="signal-button" type="submit" disabled={authBusy}>
                {authBusy ? (isSignUp ? "Creating account…" : "Signing in…") : (isSignUp ? "Create account" : "Sign in")}
              </button>
            </form>
            <button
              className="link-button"
              type="button"
              onClick={() => { setAuthMode(isSignUp ? "sign-in" : "sign-up"); setAuthError(undefined); setPassword(""); }}
            >
              {isSignUp ? "Already have an account? Sign in" : "New here? Create an account"}
            </button>
          </section>
        </div>
      </main>
    );
  }

  const ready: SignedInAccount = account;
  // One derivation, shared with the recording panel. The main page used to
  // decide this for itself, which is how the timer could say it was recording
  // while the card under it said recording was off.
  const state = recordingState(monitorStatus);
  const current = monitorStatus?.currentSession ?? null;
  const currentProject = current ? ready.projects.find((item) => item.id === current.projectId) : undefined;
  const pinnedProject = monitorStatus?.selectedProjectId ?? ready.selectedProjectId ?? "";
  const pinnedProjectName = pinnedProject === ""
    ? undefined
    : ready.projects.find((item) => item.id === pinnedProject)?.name ?? "Unknown project";
  // With nothing pinned, the header still names where time is landing right
  // now rather than leaving the question open.
  const liveProjectName = currentProject?.name;
  // The dot beside the project name wears that project's color - the same
  // color its row wears below - so the two never disagree.
  const headerProjectColor = (pinnedProject === ""
    ? currentProject?.color
    : ready.projects.find((item) => item.id === pinnedProject)?.color) ?? null;
  const defaultProject = ready.projects.find((item) => item.id === ready.defaultProjectId);
  const backlog = monitorStatus === undefined
    ? 0
    : monitorStatus.segmentBacklog + monitorStatus.agentBacklog + monitorStatus.sessionBacklog;
  // Whose breakdown the All stats overlay is showing. It opens on you, and
  // follows whichever row of the board gets picked.
  const viewedMember = boardMember ?? { id: ready.user.id, name: ready.user.name };
  const viewingSelf = viewedMember.id === ready.user.id;
  // Uploaded evidence stops at the last span that closed, so the app in front
  // right now is either frozen at its last total or missing from the day
  // entirely. Its open span is added here, which is what makes these rows tick
  // with the clock instead of jumping every few minutes.
  const openSpan = monitorStatus?.openSpan ?? null;
  const openSpanSeconds = openSpan === null ? 0 : elapsedSeconds(openSpan.since, now);
  const liveApps = stats === undefined ? [] : (() => {
    if (openSpan === null || openSpanSeconds <= 0) return [...stats.apps];
    const merged = stats.apps.map((app) => (
      app.processName === openSpan.processName
        ? { ...app, durationSeconds: app.durationSeconds + openSpanSeconds }
        : app
    ));
    return merged.some((app) => app.processName === openSpan.processName)
      ? merged
      : [...merged, { processName: openSpan.processName, durationSeconds: openSpanSeconds }];
  })();
  // An agent working inside an editor's terminal never owns the foreground,
  // so it earns no row of its own from window activity. When one is working
  // its own time is what it has been running for, and that row carries the
  // plan reading - so quota only ever appears for an agent actually in use.
  const todayRows = buildMeterRows(liveApps);
  // One row per tool, not per terminal: five Claude Code processes are one
  // tool that has been working since the earliest of them started. Counting
  // them separately would read as five times the work actually done.
  const agentRows = [...(monitorStatus?.agentSessions ?? [])
    .reduce((bySource, session) => {
      const existing = bySource.get(session.source);
      const projectName = ready.projects.find((item) => item.id === session.projectId)?.name;
      bySource.set(session.source, {
        since: existing === undefined || session.since < existing.since ? session.since : existing.since,
        sessions: (existing?.sessions ?? 0) + 1,
        projects: projectName === undefined
          ? existing?.projects ?? []
          : [...(existing?.projects ?? []), projectName],
      });
      return bySource;
    }, new Map<string, { since: string; sessions: number; projects: string[] }>())
    .entries()]
    .map(([source, group]) => ({
      key: `agent-${source}`,
      label: sourceLabel(source),
      // Name the projects when the hooks knew them, else say how many are up.
      detail: group.projects.length > 0
        ? [...new Set(group.projects)].join(", ")
        : group.sessions > 1 ? `${group.sessions} sessions` : undefined,
      source,
      processName: undefined,
      // Deliberately not the time since it started. An agent runs beside the
      // editor and the terminal it lives in, so its wall-clock overlaps
      // theirs; counting it as its own slice would total more hours than the
      // day had. Every row here measures the same thing - time this machine
      // spent with that app in front - and the row says "working" instead.
      durationSeconds: 0,
      share: 0,
    }));
  // A tool gets exactly one row. The same agent can arrive twice - once as a
  // running session, once as foreground time under its own executable - and
  // the two measure overlapping wall-clock, so the longer reading stands
  // rather than the two being added into a total that never happened.
  // A tool gets exactly one row: an agent that also spent time in front folds
  // its foreground minutes into the same line rather than appearing twice.
  const meterRows = [
    ...agentRows.map((row) => {
      const sameTool = todayRows.find((candidate) => candidate.source === row.source);
      return sameTool === undefined ? row : { ...row, durationSeconds: sameTool.durationSeconds };
    }),
    ...todayRows.filter((row) => !agentRows.some((agent) => agent.source === row.source)),
  ].sort((left, right) => right.durationSeconds - left.durationSeconds);
  // Finished time already on the server plus the stretch still being written.
  // The open stretch also lands on its project's row below, so the breakdown
  // ticks with the clock instead of trailing it by a whole session.
  const liveSeconds = current === null ? 0 : elapsedSeconds(current.since, now);
  const todayTotalSeconds = (stats?.totalDurationSeconds ?? 0) + liveSeconds;
  const projectTotals = new Map<string, { name: string; color: string | null; durationSeconds: number }>();
  for (const entry of stats?.projects ?? []) {
    if (entry.durationSeconds <= 0) continue;
    projectTotals.set(entry.project.id, {
      name: entry.project.name,
      color: ready.projects.find((item) => item.id === entry.project.id)?.color ?? null,
      durationSeconds: entry.durationSeconds,
    });
  }
  if (current !== null && liveSeconds > 0) {
    const liveProject = ready.projects.find((item) => item.id === current.projectId);
    const row = projectTotals.get(current.projectId)
      ?? { name: liveProject?.name ?? "Unknown project", color: liveProject?.color ?? null, durationSeconds: 0 };
    projectTotals.set(current.projectId, { ...row, durationSeconds: row.durationSeconds + liveSeconds });
  }
  const projectRows = [...projectTotals.entries()]
    .map(([key, row]) => ({
      key,
      ...row,
      share: todayTotalSeconds === 0 ? 0 : Math.round((row.durationSeconds / todayTotalSeconds) * 100),
    }))
    .sort((a, b) => b.durationSeconds - a.durationSeconds || a.name.localeCompare(b.name));
  // The app rows measure time spent in front of something; the day's total is
  // session wall-clock, which also counts the gaps too short to end a stretch.
  // The two were never going to be equal, so the difference gets a row of its
  // own rather than reading as a column that quietly does not add up.
  const foregroundSeconds = meterRows.reduce((sum, row) => sum + row.durationSeconds, 0);
  const quietSeconds = Math.max(0, todayTotalSeconds - foregroundSeconds);

  // Your own "today" in the overlay is the very day the clock above is
  // counting, live stretch and all: it reuses those rows rather than
  // re-deriving them, because two numbers for one day is the whole confusion.
  const showingLiveDay = viewingSelf && boardRange === "today";
  const boardLoading = showingLiveDay ? stats === undefined : boardStats === undefined;
  const boardError = showingLiveDay ? statsError : boardStatsError;
  const boardTotalSeconds = showingLiveDay ? todayTotalSeconds : boardStats?.totalDurationSeconds ?? 0;
  const boardUnattributedSeconds = (showingLiveDay ? stats : boardStats)?.unattributedSeconds ?? 0;
  const boardMeasurement = showingLiveDay ? stats : boardStats;
  const boardAppRows = buildAppRows(showingLiveDay ? liveApps : boardStats?.apps ?? []);
  const boardProjectRows = showingLiveDay
    ? projectRows.map((row) => ({ id: row.key, name: row.name, durationSeconds: row.durationSeconds }))
    : (boardStats?.projects ?? [])
        .filter((entry) => entry.durationSeconds > 0)
        .map((entry) => ({ id: entry.project.id, name: entry.project.name, durationSeconds: entry.durationSeconds }));

  return (
    <main className="app-shell">
      <WebGLShader />
      <Titlebar onOpenSettings={() => setSettingsOpen(true)} />
      <div className="screen">
        {updateVersion && (
          <p className="update-banner" role="status" data-testid="update-banner">
            Version {updateVersion} is on its way — Clock-In restarts itself when it&apos;s ready.
          </p>
        )}
        {accountError && !settingsOpen && <p className="form-error" role="alert">{accountError}</p>}

        {/* Where the time is filing, named in words rather than hidden behind
            an icon: the workspace, then the project, then a plain link to
            change it. */}
        <div className="filing-header">
          <p className="filing-where" data-testid="filing-where">
            {overview && <span className="filing-org">{overview.organization.name}</span>}
            <span className="filing-project">
              <span
                className={`monitor-dot is-${state}`}
                aria-hidden="true"
                title={MONITOR_LINE[state]}
                style={headerProjectColor === null ? undefined : { background: headerProjectColor }}
              />
              {pinnedProjectName ?? liveProjectName ?? "Picked automatically"}
            </span>
            <span className="visually-hidden">{MONITOR_LINE[state]}</span>
          </p>
          <button
            className="filing-change"
            type="button"
            data-testid="filing-change"
            aria-expanded={projectPickerOpen}
            onClick={() => setProjectPickerOpen((open) => !open)}
          >
            {projectPickerOpen ? "Done" : "Change"}
          </button>
        </div>

        {/* The clock and nothing else: a label, the stretch being written now,
            and the day's total under it. Every explanatory sentence this card
            used to carry lives in the "what's recorded" panel instead. */}
        <section className="hero card recording-card" aria-labelledby="recording-heading">
          {/* One number: everything this day has accumulated, whether the app
              was open for it or not. A separate stretch timer only ever
              raised the question of which of the two was the real total. */}
          <h2 id="recording-heading" className="hero-title">
            {new Date(now).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          </h2>
          <output className="elapsed" data-testid="elapsed-time" aria-label="Time recorded today">
            {formatDuration(todayTotalSeconds)}
          </output>
          {current === null && <p className="subtle hero-note">{IDLE_BLURB[state]}</p>}
          {projectPickerOpen && (
            <div className="filing-picker">
              {/* One project at a time, so this is a radio group wearing a
                  tick rather than a row of checkboxes that could imply two. */}
              <div className="project-picker" role="radiogroup" aria-label="File my time under" data-testid="project-picker">
                <button
                  type="button"
                  role="radio"
                  aria-checked={pinnedProject === ""}
                  className="project-choice"
                  onClick={() => void selectProject("")}
                >
                  <span className="project-tick" aria-hidden="true">{pinnedProject === "" ? "✓" : ""}</span>
                  {defaultProject ? `Work it out for me (${defaultProject.name})` : "Work it out for me"}
                </button>
                {ready.projects.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={pinnedProject === item.id}
                    className="project-choice"
                    onClick={() => void selectProject(item.id)}
                  >
                    <span className="project-tick" aria-hidden="true">{pinnedProject === item.id ? "✓" : ""}</span>
                    {item.name}
                  </button>
                ))}
              </div>
              {newProjectOpen ? (
                <form className="new-project-form" onSubmit={createProject}>
                  <label>New project name<input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} maxLength={80} placeholder="e.g. Client work" autoComplete="off" required /></label>
                  {newProjectError && <p className="form-error" role="alert">{newProjectError}</p>}
                  <div className="new-project-actions">
                    <button className="signal-button" type="submit" disabled={newProjectBusy || newProjectName.trim() === ""}>{newProjectBusy ? "Creating…" : "Create project"}</button>
                    <button className="outline-button" type="button" disabled={newProjectBusy} onClick={() => { setNewProjectOpen(false); setNewProjectName(""); setNewProjectError(undefined); }}>Cancel</button>
                  </div>
                </form>
              ) : (
                <button className="new-project-trigger" type="button" onClick={() => setNewProjectOpen(true)}>New project…</button>
              )}
            </div>
          )}
        </section>

        {/* The main surface below the clock: where today's time went, grouped
            by the projects the monitor filed it under, then by app. Everything
            historical lives behind "All stats" at the bottom. */}
        <section className="session-stats card" aria-labelledby="today-panel-title">
          <div className="panel-head">
            <h2 id="today-panel-title">Today</h2>
          </div>
          {statsError && <p className="form-error" role="alert">{statsError}</p>}
          {meterRows.length === 0 && projectRows.length === 0 && statsError === undefined ? (
            <p className="subtle" data-testid="today-panel-empty">{TODAY_EMPTY[state]}</p>
          ) : (
            <>
              {projectRows.length > 0 && (
                <ul className="meter-list" data-testid="project-list">
                  {projectRows.map((row) => (
                    <li key={row.key} className="meter-row">
                      <span
                        className="project-dot"
                        aria-hidden="true"
                        style={row.color === null ? undefined : { background: row.color }}
                      />
                      <span className="meter-name">{row.name}</span>
                      <span
                        className="meter-bar"
                        aria-hidden="true"
                        style={{ "--share": `${row.share}%` } as React.CSSProperties}
                      />
                      <span className="meter-duration">{formatHuman(row.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {meterRows.length > 0 && (
                <ul className="meter-list meter-apps" data-testid="session-app-list">
                  {meterRows.map((row) => (
                    <li key={row.key} className="meter-row">
                      {row.source !== undefined
                        ? <AgentRuntimeIcon source={row.source} />
                        : row.processName !== undefined && appIcons[row.processName] != null
                          ? <img className="app-mark" src={appIcons[row.processName] ?? undefined} alt="" />
                          : <span className="app-mark is-plain" aria-hidden="true" />}
                      <span className="meter-name">
                        {row.label}
                        {row.detail !== undefined && <span className="meter-detail"> · {row.detail}</span>}
                      </span>
                      {row.source === undefined ? (
                        <span
                          className="meter-bar"
                          aria-hidden="true"
                          style={{ "--share": `${row.share}%` } as React.CSSProperties}
                        />
                      ) : (
                        // An agent row answers a different question than a
                        // share of the day: how much of its plan is left.
                        <QuotaDial
                          agentLabel={sourceLabel(row.source)}
                          quota={quotaFor(quota, row.source)}
                          pending={quota === undefined || quota.status === "pending"}
                        />
                      )}
                      <span className="meter-duration">
                        {/* "connected", not "working": the row exists because
                            the tool registered a session, which is not the
                            same as it having done anything yet. */}
                        {row.durationSeconds === 0 && row.source !== undefined
                          ? <span className="app-active">connected</span>
                          : formatHuman(row.durationSeconds)}
                      </span>
                    </li>
                  ))}
                  {quietSeconds >= 60 && (
                    <li className="meter-row" data-testid="quiet-row">
                      <span className="app-mark is-plain" aria-hidden="true" />
                      <span className="meter-name">Quiet time</span>
                      <span aria-hidden="true" />
                      <span className="meter-duration">{formatHuman(quietSeconds)}</span>
                    </li>
                  )}
                </ul>
              )}
              <HourlyGraph buckets={stats?.hourly ?? []} />
            </>
          )}
        </section>

        {/* The two ways out of this screen, kept to icons at the foot of it:
            neither is what the app is for. */}
        <div className="screen-foot">
          <button
            className="foot-button"
            type="button"
            onClick={() => setAllStatsOpen(true)}
            data-testid="all-stats-trigger"
          >
            All stats
          </button>
          <button
            className="foot-button is-icon"
            type="button"
            aria-label="What's recorded?"
            title="What's recorded?"
            onClick={() => setRecordingOpen(true)}
          >
            ⓘ
          </button>
        </div>
      </div>

      {allStatsOpen && (
        <div className="modal-overlay" onClick={() => setAllStatsOpen(false)}>
        <section
          className="today-card card modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="today-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="panel-head">
            <h2 id="today-title">{overview?.organization.name ?? "All stats"}</h2>
            <div className="range-toggle" role="group" aria-label="Date range">
              {(["today", "week", "all"] as const).map((range) => (
                <button
                  key={range}
                  type="button"
                  className={boardRange === range ? "is-active" : undefined}
                  onClick={() => setBoardRange(range)}
                >
                  {RANGE_LABEL[range]}
                </button>
              ))}
            </div>
            <button className="outline-button modal-close" type="button" aria-label="Close all stats" onClick={() => setAllStatsOpen(false)}>✕</button>
          </div>

          {/* The board is the selector, not just a scoreboard: whoever is
              picked here is whose breakdown the panel underneath shows. It
              opens on you, and every member's is open to the whole team. */}
          {overview && (
            <>
              {overviewError && <p className="form-error" role="alert">{overviewError}</p>}
              {overview.entries.length === 0 ? (
                <p className="subtle">No recorded time yet.</p>
              ) : (
                <ol className="board-list" data-testid="board-list">
                  {overview.entries.map((entry) => (
                    <li key={entry.user.id} className={entry.user.id === viewedMember.id ? "is-selected" : undefined}>
                      <button
                        type="button"
                        className="board-choice"
                        aria-pressed={entry.user.id === viewedMember.id}
                        onClick={() => setBoardMember({ id: entry.user.id, name: entry.user.name })}
                      >
                        <span className="board-rank">{entry.rank}</span>
                        <span className="board-name">
                          {entry.user.name}
                          {entry.user.id === ready.user.id && <span className="you-tag"> you</span>}
                        </span>
                        <span className="board-times">
                          <span className="board-hours">{formatHuman(entry.activeSeconds)}</span>
                          <span className="board-agent">
                            Agent {formatHuman(entry.agentSeconds)}
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

          <section className="member-stats" aria-labelledby="member-stats-title" data-testid="member-stats">
            <div className="member-stats-head">
              <h3 id="member-stats-title">{viewedMember.name} · {RANGE_LABEL[boardRange]}</h3>
              {!viewingSelf && (
                <button type="button" className="member-self" onClick={() => setBoardMember(undefined)}>
                  Show my own
                </button>
              )}
            </div>
            {boardError && <p className="form-error" role="alert">{boardError}</p>}
            {boardLoading ? (
              !boardError && <p className="subtle">Loading…</p>
            ) : (
              <>
                <p className="today-total"><strong>{formatHuman(boardTotalSeconds)}</strong> recorded</p>
                {boardMeasurement !== undefined && (
                  <>
                    <MemberBreakdown stats={boardMeasurement} self={viewingSelf} />
                    <AgentSessionsTable byAgent={boardMeasurement.byAgent} />
                  </>
                )}
                {boardProjectRows.length > 0 && (
                  <ul className="app-list" data-testid="member-project-list">
                    {boardProjectRows.map((entry) => (
                      <li key={entry.id} className="app-row">
                        <span className="app-name">{entry.name}</span>
                        <span className="app-duration">{formatHuman(entry.durationSeconds)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {boardAppRows.length === 0 ? (
                  // Only the caller's own emptiness can be explained by this
                  // machine's recording state; a teammate's is just empty.
                  <p className="subtle" data-testid="today-empty">
                    {viewingSelf ? TODAY_EMPTY[state] : "No recorded time in this range."}
                  </p>
                ) : (
                  <ul className="app-list" data-testid="member-app-list">
                    {boardAppRows.map((row) => (
                      <li key={row.key} className={row.agent ? "app-row is-agent" : "app-row"}>
                        <span className="app-name">
                          {row.label}
                          {row.agent && viewingSelf && monitorStatus?.agentActive && <span className="app-active"> · active now</span>}
                        </span>
                        <span className="app-duration">{formatHuman(row.durationSeconds)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {boardUnattributedSeconds > 0 && (
                  <p className="verified-foot" data-testid="unattributed-foot">
                    {formatHuman(boardUnattributedSeconds)} of that landed in the default project,
                    because nothing said which project it was for.
                  </p>
                )}
              </>
            )}
          </section>
        </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            className="card modal settings-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-head">
              <h2 id="settings-title">Settings</h2>
              <button className="outline-button modal-close" type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            {settingsError && <p className="form-error" role="alert">{settingsError}</p>}
            {accountError && <p className="form-error" role="alert">{accountError}</p>}
            {settings === undefined ? (
              !settingsError && <p className="subtle">Loading…</p>
            ) : (
              <>
                {/* One group open at a time keeps the panel scannable; native
                    details/summary so there is no tab machinery to maintain. */}
                <details className="settings-group" open>
                  <summary>Recording</summary>
                  <div className="setting-rows">
                    <label className="toggle-row">
                      <span>Record my work time on this computer</span>
                      <input type="checkbox" checked={settings.enabled} onChange={(event) => void applyRecordingEnabled(event.target.checked)} />
                    </label>
                    <label className="setting-field">
                      <span>End a stretch after this many quiet minutes</span>
                      <input
                        type="number"
                        min={1}
                        value={quietDraft}
                        onChange={(event) => setQuietDraft(event.target.value)}
                        onBlur={(event) => commitQuietMinutes(event.target.value)}
                      />
                    </label>
                    <label className="toggle-row">
                      <span>Keep recording while an AI tool is working</span>
                      <input type="checkbox" checked={settings.agentOverrideEnabled} onChange={(event) => void applySettings({ agentOverrideEnabled: event.target.checked })} />
                    </label>
                  </div>
                  <button className="link-button privacy-open" type="button" onClick={() => setRecordingOpen(true)}>
                    See exactly what&apos;s recorded — and what never is
                  </button>
                </details>

                {monitorStatus !== undefined && monitorStatus.hooks.length > 0 && (
                  <details className="settings-group">
                    <summary>AI tools</summary>
                    {monitorStatus.hooks.some((hook) => hook.detected) && (
                      <ul className="hook-connected" data-testid="hook-connected">
                        {monitorStatus.hooks.filter((hook) => hook.detected).map((hook) => (
                          <li key={hook.source} className="hook-badge is-detected" title={hook.configPath}>
                            {sourceLabel(hook.source)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {monitorStatus.hooks.some((hook) => !hook.detected) && (
                      <div className="hook-add">
                        <label>
                          <span className="visually-hidden">Tool to connect</span>
                          <select value={hookChoice} onChange={(event) => setHookChoice(event.target.value)}>
                            <option value="">Connect a tool…</option>
                            {monitorStatus.hooks.filter((hook) => !hook.detected).map((hook) => (
                              <option key={hook.source} value={hook.source}>{sourceLabel(hook.source)}</option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="outline-button"
                          type="button"
                          disabled={hookChoice === ""}
                          onClick={() => { void registerHook(hookChoice); setHookChoice(""); }}
                        >
                          Connect
                        </button>
                      </div>
                    )}
                    {Object.entries(hookSnippets).map(([source, snippet]) => (
                      <div key={source}>
                        <p className="subtle">{sourceLabel(source)} needs this pasted into its config:</p>
                        <pre className="hook-snippet">{snippet}</pre>
                      </div>
                    ))}
                  </details>
                )}

                <details className="settings-group">
                  <summary>Projects</summary>
                  {deletingProject === undefined ? (
                    <ul className="manage-list" data-testid="project-manage-list">
                      {ready.projects.map((item) => (
                        <li key={item.id} className="manage-row">
                          {renamingProjectId === item.id ? (
                            <form
                              className="manage-rename"
                              onSubmit={(event) => {
                                event.preventDefault();
                                const trimmed = renameDraft.trim();
                                if (trimmed === "") return;
                                void manageProject(async (service) => {
                                  await service.projectUpdate(item.id, { name: trimmed });
                                  setRenamingProjectId(undefined);
                                });
                              }}
                            >
                              <label>
                                <span className="visually-hidden">New name for {item.name}</span>
                                <input value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} maxLength={80} required />
                              </label>
                              <button type="submit" disabled={projectBusy}>Save</button>
                              <button type="button" onClick={() => setRenamingProjectId(undefined)}>Cancel</button>
                            </form>
                          ) : (
                            <>
                              <span className="manage-name">
                                <span className="project-dot" aria-hidden="true" style={item.color === null ? undefined : { background: item.color }} />
                                {item.name}
                                {item.id === ready.defaultProjectId && <span className="you-tag"> default</span>}
                              </span>
                              <span className="manage-actions">
                                <button type="button" disabled={projectBusy} onClick={() => { setRenamingProjectId(item.id); setRenameDraft(item.name); }}>Rename</button>
                                {item.id !== ready.defaultProjectId && (
                                  <button
                                    type="button"
                                    disabled={projectBusy}
                                    onClick={() => {
                                      void manageProject(async (service) => {
                                        const usage = await service.projectUsage(item.id);
                                        // An empty project has nothing to guard:
                                        // it goes on the click.
                                        if (usage.sessionCount === 0 && usage.agentSessionCount === 0) {
                                          await service.projectDelete(item.id, null);
                                          return;
                                        }
                                        setDeletingProject({ id: item.id, name: item.name, usage });
                                        setDeleteReassignTo("");
                                      });
                                    }}
                                  >
                                    Delete
                                  </button>
                                )}
                              </span>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="manage-delete" data-testid="project-delete-confirm">
                      <p className="subtle">
                        Deleting <strong>{deletingProject.name}</strong> takes {deletingProject.usage.sessionCount} sessions
                        ({formatHuman(deletingProject.usage.durationSeconds)}) and {deletingProject.usage.agentSessionCount} agent sessions with it - unless they move first.
                      </p>
                      <label className="setting-field">
                        What happens to its sessions?
                        <select value={deleteReassignTo} onChange={(event) => setDeleteReassignTo(event.target.value)}>
                          <option value="">Delete them with the project</option>
                          {ready.projects.filter((item) => item.id !== deletingProject.id).map((item) => (
                            <option key={item.id} value={item.id}>Move to {item.name}</option>
                          ))}
                        </select>
                      </label>
                      <div className="manage-actions">
                        <button
                          type="button"
                          disabled={projectBusy}
                          onClick={() => {
                            void manageProject(async (service) => {
                              await service.projectDelete(deletingProject.id, deleteReassignTo === "" ? null : deleteReassignTo);
                              setDeletingProject(undefined);
                            });
                          }}
                        >
                          Delete {deletingProject.name}
                        </button>
                        <button type="button" disabled={projectBusy} onClick={() => setDeletingProject(undefined)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </details>

                {overview && (
                  <details className="settings-group">
                    <summary>Team</summary>
                    <p className="subtle">
                      You are keeping time with <strong>{overview.organization.name}</strong>.
                    </p>
                    <div className="team-code-row">
                      <span className="team-code" data-testid="invite-code">{overview.organization.inviteCode}</span>
                      <button className="outline-button" type="button" onClick={() => void copyInviteCode(overview.organization.inviteCode)}>
                        {inviteCopied ? "Copied" : "Copy code"}
                      </button>
                    </div>
                    <form className="join-form" onSubmit={joinWorkspace}>
                      <label className="team-join-label">
                        Their invite code
                        <input
                          value={joinCode}
                          onChange={(event) => setJoinCode(event.target.value)}
                          placeholder="Join another team: ABCDE-FGHJK"
                          autoComplete="off"
                          spellCheck={false}
                          required
                        />
                      </label>
                      <button className="signal-button" type="submit" disabled={joinBusy || joinCode.trim() === ""}>
                        {joinBusy ? "Joining…" : "Join this team"}
                      </button>
                    </form>
                    {overviewError && <p className="form-error" role="alert">{overviewError}</p>}
                  </details>
                )}

                <button className="link-button" type="button" disabled={logoutBusy} onClick={() => void logout()}>{logoutBusy ? "Logging out…" : "Log out"}</button>
              </>
            )}
          </section>
        </div>
      )}

      <RecordingPanel
        open={recordingOpen}
        onClose={() => setRecordingOpen(false)}
        status={monitorStatus}
        projectName={currentProject?.name}
        defaultProjectName={defaultProject?.name}
        hookSnippets={hookSnippets}
        browsers={browsers}
        onTurnOnRecording={() => void applyRecordingEnabled(true)}
        onConnectAgent={(source) => void registerHook(source)}
        onConnectBrowser={openBrowserStore}
        onRepairBrowser={(browserId) => void repairBrowser(browserId)}
      />
    </main>
  );
};
