import { useCallback, useEffect, useRef, useState } from "react";

import {
  agentRuntimeForBinary,
  agentRuntimeLabel,
  formatHumanDuration,
  friendlyAppName,
  leverage,
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
/// friendly names for everything else, heaviest first, long tail folded.
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
  const rest = rows.slice(TOP_APP_ROWS).reduce((sum, row) => sum + row.durationSeconds, 0);
  return [...rows.slice(0, TOP_APP_ROWS), { key: "everything-else", label: "Everything else", agent: false, durationSeconds: rest }];
};

type BoardSort = "active" | "agent" | "leverage";

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
          setScope(preferencesResult.value.scope);
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
    if (scope !== "all" && scope !== "unassigned" && !listed.projects.some((project) => project.id === scope)) {
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
  // Rank follows the column being sorted by; showing the server's active-time
  // rank under an agent-time sort reads as 1, 4, 2, 3.
  const sortedEntries = [...entries]
    .sort(boardSorters[boardSort])
    .map((entry, index) => ({ ...entry, rank: boardSort === "active" ? entry.rank : index + 1 }));
  const memberAppRows = memberStats === undefined ? [] : buildAppRows(memberStats.apps);
  const concurrencyLine = (stats: MeStatsResponse): string => {
    const parts = [
      `Unassisted ${formatHumanDuration(stats.concurrency.t0Seconds)}`,
      `1 agent ${formatHumanDuration(stats.concurrency.t1Seconds)}`,
      `2 agents ${formatHumanDuration(stats.concurrency.t2Seconds)}`,
      `3+ ${formatHumanDuration(stats.concurrency.t3PlusSeconds)}`,
    ];
    if (stats.concurrency.awaySeconds > 0) parts.push(`agents while away ${formatHumanDuration(stats.concurrency.awaySeconds)}`);
    return parts.join(" · ");
  };

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
            <option value="unassigned">Unassigned</option>
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
          <h2 id="board-title">Leaderboard</h2>
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
        </div>
        {boardFailed ? (
          <p className="subtle">Could not load hours for this range.</p>
        ) : loading && entries.length === 0 ? (
          <p className="subtle" role="status">Loading hours…</p>
        ) : entries.length === 0 ? (
          <p className="subtle">
            {scope === "all"
              ? "No recorded time in this range yet. Install the desktop app and it records on its own."
              : "Nothing recorded here in this range. Pick another range, or All projects."}
          </p>
        ) : (
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

        {viewedId !== undefined && (
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
                <p className="member-total">
                  <strong>{formatHumanDuration(memberStats.activeSeconds)}</strong> active
                  <span className="member-agent-total">
                    · Agent {formatHumanDuration(memberStats.agentSeconds)}
                    {leverage(memberStats) !== null && ` · ${leverage(memberStats)}×`}
                  </span>
                </p>
                {/* Two different cuts, kept visibly apart: the concurrency
                    split sums to active time; the by-agent split sums to
                    agent time and never to hours worked. */}
                <p className="member-line" data-testid="concurrency-line">{concurrencyLine(memberStats)}</p>
                {memberStats.byAgent.length > 0 && (
                  <p className="member-line is-agents" data-testid="by-agent-line">
                    {memberStats.byAgent.map((split) =>
                      `${agentRuntimeLabel(split.source)}${split.model === null ? "" : ` (${split.model})`} ${formatHumanDuration(split.durationSeconds)}`).join(" · ")}
                  </p>
                )}
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
  const [confirmName, setConfirmName] = useState("");
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
                  <span className="manage-name">{project.name}</span>
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
                            setDeleting({ project, usage });
                            setConfirmName("");
                            setReassignTo("");
                            setBusy(false);
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
            <label>
              Type the project's name to confirm
              <input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={deleting.project.name} autoComplete="off" />
            </label>
            <div className="manage-actions">
              <button
                className="ghost is-danger"
                type="button"
                disabled={busy || confirmName.trim() !== deleting.project.name}
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
