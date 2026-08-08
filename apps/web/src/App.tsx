import { useCallback, useEffect, useState } from "react";

import { formatDuration, type LeaderboardEntry, type Organization, type ReportRow } from "@clock-in/shared";

import { ClientError, type Client } from "./client.js";
import { DownloadApp } from "./DownloadApp.js";
import { HelpModal } from "./HelpModal.js";
import { WebGLShader } from "./WebGLShader.js";

type AppProps = { client: Client };

type Range = "7" | "30" | "365";

const rangeLabels: Record<Range, string> = {
  "7": "Last 7 days",
  "30": "Last 30 days",
  "365": "Last year",
};

/** Inclusive UTC calendar bounds, matching how the API reads from/to. */
function rangeQuery(range: Range, today = new Date()): string {
  const to = today.toISOString().slice(0, 10);
  const fromDate = new Date(today.getTime() - (Number(range) - 1) * 24 * 60 * 60 * 1_000);
  return `?from=${fromDate.toISOString().slice(0, 10)}&to=${to}`;
}

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

  const [range, setRange] = useState<Range>("30");
  const [organization, setOrganization] = useState<Organization | undefined>();
  const [entries, setEntries] = useState<readonly LeaderboardEntry[]>([]);
  const [rows, setRows] = useState<readonly ReportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dataError, setDataError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | undefined>();
  const [helpOpen, setHelpOpen] = useState(false);

  const load = useCallback(async (selected: Range) => {
    setLoading(true);
    setDataError(undefined);
    try {
      const query = rangeQuery(selected);
      const [organizationResult, board, report] = await Promise.all([
        client.organization(),
        client.leaderboard(query),
        client.report(`${query}&pageSize=25`),
      ]);
      setOrganization(organizationResult.organization);
      setEntries(board.entries);
      setTotal(board.totalDurationSeconds);
      setRows(report.rows);
    } catch (error: unknown) {
      if (error instanceof ClientError && error.kind === "auth") {
        setSignedIn(false);
        setAuthError("Your session expired. Sign in again.");
        return;
      }
      setDataError(messageFor(error));
    } finally {
      setLoading(false);
    }
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
    setEntries([]);
    setRows([]);
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
          <DownloadApp className="primary cta" />
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
          <label className="range-picker">
            <span className="visually-hidden">Date range</span>
            <select value={range} onChange={(event) => setRange(event.target.value as Range)}>
              {Object.entries(rangeLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <DownloadApp />
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
          <span className="total">{formatDuration(total)} total</span>
        </div>
        {loading && entries.length === 0 ? (
          <p className="subtle" role="status">Loading hours…</p>
        ) : entries.length === 0 ? (
          <p className="subtle">No recorded time in this range yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th scope="col">#</th><th scope="col">Member</th><th scope="col">Sessions</th><th scope="col">Hours</th></tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.user.id}>
                  <td className="rank">{entry.rank}</td>
                  <td>{entry.user.name}</td>
                  <td className="numeric">{entry.sessionCount}</td>
                  <td className="numeric hours">{formatDuration(entry.durationSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="sessions-title">
        <div className="card-head"><h2 id="sessions-title">Recent sessions</h2></div>
        {rows.length === 0 ? (
          <p className="subtle">Nothing recorded in this range.</p>
        ) : (
          <table>
            <thead>
              <tr><th scope="col">Member</th><th scope="col">Project</th><th scope="col">Description</th><th scope="col">Started</th><th scope="col">Duration</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.user.name}</td>
                  <td>{row.project.name}</td>
                  <td className="description">{row.description ?? "—"}</td>
                  <td>{new Date(row.startedAt).toLocaleString()}</td>
                  <td className="numeric hours">{formatDuration(row.durationSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
};
