import { useEffect, useReducer, useRef, useState } from "react";

import { bridgeError, defaultBridge, type OrganizationOverview, type TimerBridge } from "./bridge.js";
import { formatDuration } from "@clock-in/shared";
import { initialTimerState, timerReducer, type BootstrapSnapshot, type StartIntent } from "./timer-machine.js";

type AppProps = {
  bridge?: TimerBridge;
};

const elapsedSeconds = (startedAt: string, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));

export const App = ({ bridge = defaultBridge }: AppProps) => {
  const [state, dispatch] = useReducer(timerReducer, initialTimerState);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [overview, setOverview] = useState<OrganizationOverview | undefined>();
  const [overviewError, setOverviewError] = useState<string | undefined>();
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | undefined>();
  const [accountError, setAccountError] = useState<string | undefined>();
  const [projectId, setProjectId] = useState("");
  const [description, setDescription] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [retryPendingBusy, setRetryPendingBusy] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const latestBridge = useRef(bridge);
  const bootstrapRequests = useRef(new WeakMap<TimerBridge, Promise<BootstrapSnapshot>>());
  const recoveryRequests = useRef(new WeakMap<TimerBridge, Map<string, Promise<BootstrapSnapshot>>>());
  const mounted = useRef(true);
  const bridgeGeneration = useRef(0);
  const accountEpoch = useRef(0);
  const currentAccountId = useRef<string | undefined>(undefined);

  if (latestBridge.current !== bridge) bridgeGeneration.current += 1;
  latestBridge.current = bridge;

  const isCurrent = (service: TimerBridge, generation: number, epoch?: number): boolean =>
    mounted.current
    && latestBridge.current === service
    && bridgeGeneration.current === generation
    && (epoch === undefined || accountEpoch.current === epoch);

  const invalidateAccount = (): number => {
    accountEpoch.current += 1;
    return accountEpoch.current;
  };

  const clearAccountFields = (clearEmail = false): void => {
    setProjectId("");
    setDescription("");
    setPassword("");
    setName("");
    setInviteCode("");
    setOverview(undefined);
    setOverviewError(undefined);
    if (clearEmail) setEmail("");
  };

  const applyAccountFields = (snapshot: Exclude<BootstrapSnapshot, { kind: "signed-out" }>): void => {
    if (currentAccountId.current !== snapshot.user.id) clearAccountFields();
    currentAccountId.current = snapshot.user.id;
  };

  const clearSignedOutAccount = (): void => {
    currentAccountId.current = undefined;
    clearAccountFields(true);
  };

  const resetToSignIn = (message: string, invalidate = true): void => {
    if (invalidate) invalidateAccount();
    clearSignedOutAccount();
    dispatch({ type: "auth-failed", message });
  };

  const applySnapshot = async (
    snapshot: BootstrapSnapshot,
    service: TimerBridge,
    isServiceCurrent: () => boolean,
    expectedEpoch?: number,
    establishAccount = false,
  ): Promise<number | undefined> => {
    if (!isServiceCurrent() || (expectedEpoch !== undefined && accountEpoch.current !== expectedEpoch)) return undefined;
    if (snapshot.kind === "signed-out") {
      const snapshotEpoch = invalidateAccount();
      clearSignedOutAccount();
      dispatch({ type: "bootstrapped", snapshot });
      return snapshotEpoch;
    }

    const snapshotEpoch = establishAccount ? invalidateAccount() : accountEpoch.current;
    const isSnapshotCurrent = (): boolean => isServiceCurrent() && accountEpoch.current === snapshotEpoch;
    if (!isSnapshotCurrent()) return undefined;
    applyAccountFields(snapshot);
    dispatch({ type: "bootstrapped", snapshot });
    if (snapshot.kind !== "retry-local-start") return snapshotEpoch;

    let recoveryRequest: Promise<BootstrapSnapshot> | undefined;
    try {
      let requests = recoveryRequests.current.get(service);
      if (requests === undefined) {
        requests = new Map();
        recoveryRequests.current.set(service, requests);
      }
      recoveryRequest = requests.get(snapshot.start.clientId);
      if (recoveryRequest === undefined) {
        recoveryRequest = service.retryLocalStart(snapshot.start);
        requests.set(snapshot.start.clientId, recoveryRequest);
      }
      const retriedSnapshot = await recoveryRequest;
      if (isSnapshotCurrent()) {
        if (retriedSnapshot.kind === "signed-out") {
          const signedOutEpoch = invalidateAccount();
          clearSignedOutAccount();
          dispatch({ type: "bootstrapped", snapshot: retriedSnapshot });
          return signedOutEpoch;
        }
        bootstrapRequests.current.set(service, Promise.resolve(retriedSnapshot));
        applyAccountFields(retriedSnapshot);
        dispatch({ type: "bootstrapped", snapshot: retriedSnapshot });
      }
    } catch (error: unknown) {
      if (!isSnapshotCurrent()) return undefined;
      const problem = bridgeError(error);
      if (problem.kind === "auth") {
        resetToSignIn(problem.message);
        return accountEpoch.current;
      }
      dispatch({ type: "start-failed", message: problem.message });
    } finally {
      const requests = recoveryRequests.current.get(service);
      if (requests !== undefined && requests.get(snapshot.start.clientId) === recoveryRequest) {
        requests.delete(snapshot.start.clientId);
        if (requests.size === 0) recoveryRequests.current.delete(service);
      }
    }
    return isSnapshotCurrent() ? snapshotEpoch : undefined;
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    let request = bootstrapRequests.current.get(bridge);
    if (request === undefined) {
      request = bridge.bootstrap();
      bootstrapRequests.current.set(bridge, request);
    }
    const isRequestCurrent = (): boolean => active && isCurrent(bridge, generation);

    void request.then(
      (snapshot) => applySnapshot(snapshot, bridge, isRequestCurrent, epoch, true),
      (error: unknown) => {
        if (!isRequestCurrent() || accountEpoch.current !== epoch) return;
        const problem = bridgeError(error);
        resetToSignIn(problem.message);
      },
    );
    return () => { active = false; };
  }, [bridge]);

  useEffect(() => {
    setAuthBusy(false);
    setRetryPendingBusy(false);
    setConflictBusy(false);
    setLogoutBusy(false);
  }, [bridge]);

  useEffect(() => {
    if (state.kind !== "running") return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state.kind]);

  // The board is worth refreshing whenever a timer stops, so a finished session
  // shows up without the user reopening the app.
  useEffect(() => {
    if (state.kind === "booting" || state.kind === "sign-in") return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    void service.orgOverview().then(
      (result) => {
        if (active && isCurrent(service, generation, epoch)) {
          setOverview(result);
          setOverviewError(undefined);
        }
      },
      (error: unknown) => {
        if (!active || !isCurrent(service, generation, epoch)) return;
        const problem = bridgeError(error);
        // An expired session is handled by whatever the user does next; the board
        // going stale is not worth throwing them back to sign-in over.
        if (problem.kind !== "auth") setOverviewError(problem.message);
      },
    );
    return () => { active = false; };
  }, [bridge, state.kind === "idle", state.kind === "sign-in"]);

  const submitAuth = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(undefined);
    const service = bridge;
    const generation = bridgeGeneration.current;
    const requestEpoch = invalidateAccount();
    const isRequestCurrent = (): boolean => isCurrent(service, generation, requestEpoch);
    let snapshotEpoch: number | undefined;
    try {
      const snapshot = authMode === "sign-up"
        ? await service.signup({
            email,
            password,
            name: name.trim(),
            ...(inviteCode.trim() === "" ? {} : { inviteCode: inviteCode.trim() }),
          })
        : await service.login({ email, password });
      snapshotEpoch = await applySnapshot(snapshot, service, () => isCurrent(service, generation), requestEpoch, true);
      if (snapshotEpoch !== undefined && isCurrent(service, generation, snapshotEpoch)) {
        setPassword("");
        setName("");
        setInviteCode("");
      }
    } catch (error: unknown) {
      if (isRequestCurrent()) setAuthError(bridgeError(error).message);
    } finally {
      if ((snapshotEpoch !== undefined && isCurrent(service, generation, snapshotEpoch)) || isRequestCurrent()) setAuthBusy(false);
    }
  };

  const startTimer = async (): Promise<void> => {
    if (state.kind !== "idle" || projectId === "" || !state.projects.some((project) => project.id === projectId)) return;
    const start: StartIntent = {
      clientId: crypto.randomUUID(),
      projectId,
      description: description.trim(),
      startedAt: new Date().toISOString(),
    };
    dispatch({ type: "start-requested", start });
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    try {
      const running = await service.start(start);
      if (isRequestCurrent()) dispatch({ type: "start-confirmed", running });
    } catch (error: unknown) {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      if (problem.kind === "auth") resetToSignIn(problem.message);
      else dispatch({ type: "start-failed", message: problem.message });
    }
  };

  const stopTimer = async (): Promise<void> => {
    if (state.kind !== "running") return;
    const input = { sessionId: state.running.sessionId, stoppedAt: new Date().toISOString(), idleSeconds: 0 as const };
    dispatch({ type: "stop-requested", stoppedAt: input.stoppedAt });
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    try {
      await service.stop(input);
      if (isRequestCurrent()) dispatch({ type: "stop-confirmed" });
    } catch (error: unknown) {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      if (problem.kind === "auth") resetToSignIn(problem.message);
      else if (problem.kind === "transient") dispatch({ type: "stop-pending", message: problem.message });
      else dispatch({ type: "stop-failed", message: problem.message });
    }
  };

  const retryPending = async (): Promise<void> => {
    if (state.kind !== "pending-sync" || retryPendingBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setRetryPendingBusy(true);
    try {
      const result = await service.retryPending();
      if (isRequestCurrent()) dispatch({ type: "pending-retried", ...result });
    } catch (error: unknown) {
      const problem = bridgeError(error);
      if (!isRequestCurrent()) return;
      if (problem.kind === "auth") resetToSignIn(problem.message);
      else dispatch({ type: "pending-retry-failed", message: problem.message });
    } finally {
      if (isRequestCurrent()) setRetryPendingBusy(false);
    }
  };

  const recover = async (choice: "server" | "local"): Promise<void> => {
    if (state.kind !== "conflict" || conflictBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setConflictBusy(true);
    try {
      const snapshot = choice === "server" ? await service.useServerTimer() : await service.retryLocalStart(state.localStart);
      if (isRequestCurrent()) await applySnapshot(snapshot, service, () => isCurrent(service, generation), epoch);
    } catch (error: unknown) {
      const problem = bridgeError(error);
      if (isRequestCurrent()) {
        if (problem.kind === "auth") resetToSignIn(problem.message);
        else dispatch({ type: "conflict-retry-failed", message: problem.message });
      }
    } finally {
      if (isRequestCurrent()) setConflictBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    if (logoutBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setLogoutBusy(true);
    setAccountError(undefined);
    try {
      await service.logout();
      if (isRequestCurrent()) resetToSignIn("You have signed out.");
    } catch (error: unknown) {
      if (isRequestCurrent()) setAccountError(bridgeError(error).message);
    } finally {
      if (isRequestCurrent()) setLogoutBusy(false);
    }
  };

  if (state.kind === "booting") {
    return <main className="chronometer boot" aria-busy="true"><p role="status">Connecting to clock service…</p></main>;
  }

  if (state.kind === "sign-in") {
    const error = authError ?? state.error;
    const isSignUp = authMode === "sign-up";
    return (
      <main className="chronometer sign-in-shell">
        <section className="sign-in-panel" aria-labelledby="sign-in-title">
          <p className="eyebrow">Manual time terminal</p>
          <h1 id="sign-in-title">{isSignUp ? "Create your account" : "Clock in"}</h1>
          <p className="subtle">
            {isSignUp
              ? "Your workspace and first project are set up automatically."
              : "Connect to your secure workstation session."}
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
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
      </main>
    );
  }

  const account = state;
  const hasSelectedProject = account.projects.some((project) => project.id === projectId);
  const activeRunning = state.kind === "running" || state.kind === "stopping" ? state.running : undefined;
  const project = activeRunning ? account.projects.find((item) => item.id === activeRunning.projectId) : undefined;
  const elapsedAt = state.kind === "stopping" ? Date.parse(state.stoppedAt) : now;

  return (
    <main className={`chronometer ${state.kind}`}>
      <aside className="status-rail" aria-hidden="true"><span /><span /><span /></aside>
      <header className="instrument-header">
        <div><p className="eyebrow">Manual time terminal</p><h1>Field chronometer</h1></div>
        <button className="logout" type="button" disabled={logoutBusy} onClick={() => void logout()}>{logoutBusy ? "Logging out…" : "Log out"}</button>
      </header>
      {accountError && <p className="form-error" role="alert">{accountError}</p>}

      {state.kind === "conflict" ? (
        <section className="conflict-panel" aria-labelledby="conflict-title">
          <p className="eyebrow">Recovery hold</p><h2 id="conflict-title">Timer needs reconciliation</h2>
          <p>Your device recorded <strong>{state.localStart.description || "a local start"}</strong>; the service has an active timer. Neither record has been discarded.</p>
          {state.error && <p role="alert" className="form-error">{state.error}</p>}
          <div className="action-stack">
            <button className="signal-button" type="button" disabled={conflictBusy} onClick={() => void recover("server")}>{conflictBusy ? "Resolving…" : "Use server timer"}</button>
            <button className="outline-button" type="button" disabled={conflictBusy} onClick={() => void recover("local")}>Retry local start</button>
          </div>
        </section>
      ) : activeRunning ? (
        <section className="running-panel" aria-label="Running timer">
          <div className="dial" aria-hidden="true"><span className="dial-core" /></div>
          <p className="eyebrow">Recording · {project?.name ?? "Unknown project"}</p>
          <output className="elapsed" data-testid="elapsed-time" aria-label="Elapsed time">{formatDuration(elapsedSeconds(activeRunning.startedAt, elapsedAt))}</output>
          <p className="started-at">Started {new Date(activeRunning.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
          {state.kind === "running" && state.error && <p className="form-error" role="alert">{state.error}</p>}
          <button className="stop-button" type="button" disabled={state.kind === "stopping"} onClick={() => void stopTimer()}>{state.kind === "stopping" ? "Stopping…" : "Stop timer"}</button>
        </section>
      ) : (
        <section className="idle-panel" aria-labelledby="timer-title">
          <p className="eyebrow">Ready for a new entry</p><h2 id="timer-title">Start a timer</h2>
          {state.kind === "idle" && state.error && <p className="form-error" role="alert">{state.error}</p>}
          {state.kind === "pending-sync" && <><div className="sync-banner" role="status"><span>{state.message}</span><button type="button" disabled={retryPendingBusy} onClick={() => void retryPending()}>{retryPendingBusy ? "Retrying…" : "Retry sync"}</button></div>{state.error && <p className="form-error" role="alert">{state.error}</p>}</>}
          <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Select active project</option>{account.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={3} placeholder="What are you working on?" /></label>
          <div className="entry-foot"><span>{description.length}/1000</span><button className="signal-button" type="button" disabled={state.kind === "starting" || state.kind === "pending-sync" || !hasSelectedProject} onClick={() => void startTimer()}>{state.kind === "starting" ? "Starting…" : "Start timer"}</button></div>
        </section>
      )}

      {overview && (
        <section className="board-panel" aria-labelledby="board-title">
          <div className="board-head">
            <h2 id="board-title">{overview.organization.name}</h2>
            <span className="invite-code" title="Share this code so teammates join this workspace">
              {overview.organization.inviteCode}
            </span>
          </div>
          {overviewError && <p className="form-error" role="alert">{overviewError}</p>}
          {overview.entries.length === 0 ? (
            <p className="subtle">No recorded time yet. Stop a timer to appear here.</p>
          ) : (
            <ol className="board-list">
              {overview.entries.slice(0, 5).map((entry) => (
                <li key={entry.user.id} className={entry.user.id === account.user.id ? "is-you" : undefined}>
                  <span className="board-rank">{entry.rank}</span>
                  <span className="board-name">
                    {entry.user.name}
                    {entry.user.id === account.user.id && <span className="you-tag"> you</span>}
                  </span>
                  <span className="board-hours">{formatDuration(entry.durationSeconds)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </main>
  );
};
