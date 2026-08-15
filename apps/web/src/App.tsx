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

type HourlyBucket = MeStatsResponse["hourly"][number];

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

/// Which models actually ran, how many sessions that was, how many overlapped
/// at once, and how long a session typically lasted - all already in the
/// agent_sessions table, now presented rather than folded into a note.
const AgentSessionsTable = ({ byAgent }: { byAgent: MeStatsResponse["byAgent"] }) => {
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
                {split.model ?? agentRuntimeLabel(split.source)}
                {split.model !== null && <span className="metric-hint"> · {agentRuntimeLabel(split.source)}</span>}
              </td>
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

/// Two-line SVG chart - agents in the brand green, the person in gray. No
/// chart library: a fixed viewBox and two polylines are all a day needs, and
/// the server already buckets to the caller's local hours.
const HourlyGraph = ({ buckets, personLabel = "You" }: { buckets: readonly HourlyBucket[]; personLabel?: string }) => {
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
        <text x={margin.left - 6} y={y(yMax) + 3} fill="#a3b3c2" fontSize="9" textAnchor="end">{formatHumanDuration(yMax)}</text>
        {xTicks.map(({ index, label }) => (
          <text key={index} x={x(index)} y={height - 6} fill="#a3b3c2" fontSize="9" textAnchor="middle">{label}</text>
        ))}
        <path d={line("activeSeconds")} fill="none" stroke="#8b98a8" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={line("agentSeconds")} fill="none" stroke="#00e59b" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <ul className="legend">
        <li><span className="legend-line legend-agents" aria-hidden="true" />Agents</li>
        <li><span className="legend-line legend-humans" aria-hidden="true" />{personLabel}</li>
      </ul>
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

  // The roster loads when its tab opens; renames and registrations patch the
  // row in place rather than refetching the list.
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

  /// One-click registration: the prefilled name and current owner are the
  /// confirmation - the PATCH restates them beside the status change.
  const registerAgent = async (agent: Agent): Promise<void> => {
    setAgentBusyId(agent.id);
    try {
      const updated = await client.patchAgent(agent.id, {
        status: "registered",
        name: agent.name,
        ownerUserId: agent.owner.id,
      });
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
            onRegister={(agent) => void registerAgent(agent)}
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
  onRegister: (agent: Agent) => void;
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
  onRegister,
  paystub,
  paystubFailed,
  rangeLabel,
  agentsReport,
  agentsReportFailed,
}: RosterTabProps) => {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  const rowsByAgentId = new Map(agentsReport?.rows.map((row) => [row.agent.id, row]));
  return (
    <>
      {agentsReport !== undefined && !agentsReportFailed && (
        <p className="subtle" data-testid="roster-headcount">
          Headcount {agentsReport.headcount.total}
          {agentsReport.headcount.anonymous > 0 && ` - ${agentsReport.headcount.anonymous} anonymous`}
        </p>
      )}
      {agentsFailed ? (
        <p className="subtle">Could not load the roster.</p>
      ) : agents.length === 0 ? (
        <p className="subtle">No agents on the roster yet. Coding-agent shifts mint them automatically.</p>
      ) : (
        <ol className="board-list" data-testid="roster-list">
          {agents.map((agent) => (
            <li
              key={agent.id}
              className={[
                agent.id === selectedAgentId ? "is-selected" : "",
                agent.status === "anonymous" ? "is-anonymous" : "",
              ].join(" ").trim() || undefined}
            >
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
                  </span>
                </span>
              </button>
              {agent.status === "anonymous" && (
                <button
                  type="button"
                  className="ghost register-button"
                  disabled={agentBusyId === agent.id}
                  onClick={() => onRegister(agent)}
                >
                  {agentBusyId === agent.id ? "Registering…" : "Register"}
                </button>
              )}
            </li>
          ))}
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
                  <span className="metric-name">Held rate</span>
                  <span className="metric-value">
                    {paystub.totals.heldRate === null ? "pending" : `${Math.round(paystub.totals.heldRate * 100)}%`}
                  </span>
                </div>
              </div>
              {paystub.shifts.length === 0 ? (
                <p className="subtle">No shifts in this range.</p>
              ) : (
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
              )}
              <ul className="stat-list" data-testid="paystub-trend">
                {paystub.trend.map((bucket) => (
                  <li key={bucket.periodStartAt} className="stat-row">
                    <span className="stat-name">Week of {new Date(bucket.periodStartAt).toLocaleDateString()}</span>
                    <span className="stat-duration">
                      {formatHumanDuration(bucket.agentSeconds)} · {bucket.shiftCount} shifts
                      {bucket.heldRate !== null && ` · ${Math.round(bucket.heldRate * 100)}% held`}
                    </span>
                  </li>
                ))}
              </ul>
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
                            if (usage.sessionCount === 0 && usage.agentSessionCount === 0) {
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
