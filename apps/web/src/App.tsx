import { useCallback, useEffect, useState } from "react";

import {
  agentRuntimeForBinary,
  agentRuntimeLabel,
  formatHumanDuration,
  friendlyAppName,
  type LeaderboardEntry,
  type MeStatsResponse,
  type Organization,
} from "@clock-in/shared";

import { ClientError, type Client } from "./client.js";
import { DownloadInstaller } from "./DownloadInstaller.js";
import { HelpModal } from "./HelpModal.js";
import { WebGLShader } from "./WebGLShader.js";

type AppProps = { client: Client };

/// The same three ranges the desktop app's All stats offers, measured on the
/// viewer's own clock.
type Range = "today" | "week" | "all";

const rangeLabels: Record<Range, string> = {
  today: "Today",
  week: "This week",
  all: "All time",
};

/// Instant bounds on the viewer's local calendar: "today" runs midnight to
/// midnight, "week" from Monday. Calendar-date params would be read as UTC
/// days, which roll over mid-afternoon west of Greenwich. "All time" sends no
/// bounds at all.
export function rangeQuery(range: Range, now = new Date()): string {
  if (range === "all") return "";
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "week") from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
  const toExclusive = new Date(from);
  toExclusive.setDate(toExclusive.getDate() + (range === "week" ? 7 : 1));
  return `?fromAt=${encodeURIComponent(from.toISOString())}&toExclusiveAt=${encodeURIComponent(toExclusive.toISOString())}`;
}

/// The member-stats query: the range bounds plus who to read.
const statsQuery = (range: Range, userId: string): string => {
  const bounds = rangeQuery(range);
  return bounds === "" ? `?userId=${encodeURIComponent(userId)}` : `${bounds}&userId=${encodeURIComponent(userId)}`;
};

type AppRow = { key: string; label: string; agent: boolean; durationSeconds: number };

const TOP_APP_ROWS = 8;

/// The same fold the desktop's stats use: one row per agent runtime (so "how
/// much Claude Code" is a single line), friendly names for everything else,
/// heaviest first, and the long tail gathered into "Everything else".
export const buildAppRows = (apps: MeStatsResponse["apps"]): AppRow[] => {
  const totals = new Map<string, AppRow>();
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

  const [range, setRange] = useState<Range>("today");
  const [organization, setOrganization] = useState<Organization | undefined>();
  const [selfId, setSelfId] = useState<string | undefined>();
  const [entries, setEntries] = useState<readonly LeaderboardEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dataError, setDataError] = useState<string | undefined>();
  // Tracked per card, because "we could not load this" and "there is nothing
  // here" are different facts and a zero total is a lie about the first.
  const [boardFailed, setBoardFailed] = useState(false);
  // Whose breakdown the drill-down shows: you by default, then whoever on the
  // board was picked last.
  const [member, setMember] = useState<{ id: string; name: string } | undefined>();
  const [memberStats, setMemberStats] = useState<MeStatsResponse | undefined>();
  const [memberFailed, setMemberFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | undefined>();
  const [helpOpen, setHelpOpen] = useState(false);

  const load = useCallback(async (selected: Range) => {
    setLoading(true);
    setDataError(undefined);
    setBoardFailed(false);
    const query = rangeQuery(selected);
    // Settled rather than all: these calls fail independently, and one refused
    // report must not throw away the workspace that loaded beside it. While it
    // did, a rejected report blanked the masthead and the invite code too, so
    // a server-side failure read as an empty account.
    const [organizationResult, board, meResult] = await Promise.allSettled([
      client.organization(),
      client.leaderboard(query),
      client.me(),
    ]);
    const failures = [organizationResult, board, meResult]
      .flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));

    if (failures.some((reason) => reason instanceof ClientError && reason.kind === "auth")) {
      setSignedIn(false);
      setAuthError("Your session expired. Sign in again.");
      setLoading(false);
      return;
    }

    if (organizationResult.status === "fulfilled") setOrganization(organizationResult.value.organization);
    if (meResult.status === "fulfilled") setSelfId(meResult.value.user.id);
    setBoardFailed(board.status === "rejected");
    setEntries(board.status === "fulfilled" ? board.value.entries : []);
    setTotal(board.status === "fulfilled" ? board.value.totalDurationSeconds : 0);

    const [firstFailure] = failures;
    if (firstFailure !== undefined) setDataError(messageFor(firstFailure));
    setLoading(false);
  }, [client]);

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

  useEffect(() => {
    if (!signedIn) return;
    void load(range);
  }, [signedIn, range, load]);

  // The drill-down: one member's breakdown for the range on screen. It opens
  // on you and follows whichever board row was picked.
  const viewedId = member?.id ?? selfId;
  useEffect(() => {
    if (!signedIn || viewedId === undefined) return undefined;
    let cancelled = false;
    setMemberStats(undefined);
    setMemberFailed(false);
    client.meStats(statsQuery(range, viewedId)).then(
      (result) => {
        if (!cancelled) setMemberStats(result);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ClientError && error.kind === "auth") {
          setSignedIn(false);
          setAuthError("Your session expired. Sign in again.");
          return;
        }
        setMemberFailed(true);
        setDataError(messageFor(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, signedIn, range, viewedId]);

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
    setEntries([]);
    setMember(undefined);
    setMemberStats(undefined);
    setMemberFailed(false);
    setBoardFailed(false);
    setAuthError(undefined);
  };

  const joinWorkspace = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setJoinBusy(true);
    setJoinError(undefined);
    try {
      await client.joinOrganization(joinCode.trim());
      setJoinCode("");
      await load(range);
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

  return (
    <main className="shell">
      <WebGLShader />
      <header className="masthead">
        <div>
          <p className="eyebrow">Clock-In</p>
          <h1>{organization?.name ?? "Your workspace"}</h1>
        </div>
        <div className="masthead-actions">
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
          <DownloadInstaller />
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

      {dataError && <p className="error" role="alert">{dataError}</p>}

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
          <span className="total">{boardFailed ? "Not loaded" : `${formatHumanDuration(total)} total`}</span>
        </div>
        {boardFailed ? (
          <p className="subtle">Could not load hours for this range.</p>
        ) : loading && entries.length === 0 ? (
          <p className="subtle" role="status">Loading hours…</p>
        ) : entries.length === 0 ? (
          <p className="subtle">No recorded time in this range yet.</p>
        ) : (
          // Each row picks whose breakdown the panel underneath shows. You are
          // highlighted from the start; picking a teammate moves the highlight.
          <ol className="board-list">
            {entries.map((entry) => (
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
                  <span className="board-hours">{formatHumanDuration(entry.durationSeconds)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        {viewedId !== undefined && (
          <section className="member-stats" aria-labelledby="member-stats-title">
            <h3 id="member-stats-title">
              {(member?.name ?? entries.find((entry) => entry.user.id === selfId)?.user.name ?? "You")}
              {" · "}
              {rangeLabels[range]}
            </h3>
            {memberFailed ? (
              <p className="subtle">Could not load this member's breakdown.</p>
            ) : memberStats === undefined ? (
              <p className="subtle" role="status">Loading…</p>
            ) : (
              <>
                <p className="member-total"><strong>{formatHumanDuration(memberStats.totalDurationSeconds)}</strong> recorded</p>
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
                {buildAppRows(memberStats.apps).length === 0 ? (
                  <p className="subtle">No recorded time in this range.</p>
                ) : (
                  <ul className="stat-list stat-apps">
                    {buildAppRows(memberStats.apps).map((row) => (
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

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
};
