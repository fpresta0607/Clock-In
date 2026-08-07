import { useEffect, useReducer, useRef, useState } from "react";

import { bridgeError, defaultBridge, type TimerBridge } from "./bridge.js";
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

  if (latestBridge.current !== bridge) bridgeGeneration.current += 1;
  latestBridge.current = bridge;

  const isCurrent = (service: TimerBridge, generation: number): boolean =>
    mounted.current && latestBridge.current === service && bridgeGeneration.current === generation;

  const applySnapshot = async (
    snapshot: BootstrapSnapshot,
    service: TimerBridge,
    isRequestCurrent: () => boolean,
  ): Promise<void> => {
    if (!isRequestCurrent()) return;
    dispatch({ type: "bootstrapped", snapshot });
    if (snapshot.kind !== "retry-local-start") return;

    try {
      let requests = recoveryRequests.current.get(service);
      if (requests === undefined) {
        requests = new Map();
        recoveryRequests.current.set(service, requests);
      }
      let request = requests.get(snapshot.start.clientId);
      if (request === undefined) {
        request = service.retryLocalStart(snapshot.start);
        requests.set(snapshot.start.clientId, request);
      }
      const retriedSnapshot = await request;
      if (isRequestCurrent()) dispatch({ type: "bootstrapped", snapshot: retriedSnapshot });
    } catch (error: unknown) {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      dispatch(problem.kind === "auth" ? { type: "auth-failed", message: problem.message } : { type: "start-failed", message: problem.message });
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const generation = bridgeGeneration.current;
    let request = bootstrapRequests.current.get(bridge);
    if (request === undefined) {
      request = bridge.bootstrap();
      bootstrapRequests.current.set(bridge, request);
    }
    const isRequestCurrent = (): boolean => active && isCurrent(bridge, generation);

    void request.then(
      (snapshot) => applySnapshot(snapshot, bridge, isRequestCurrent),
      (error: unknown) => {
        if (!isRequestCurrent()) return;
        const problem = bridgeError(error);
        dispatch({ type: "auth-failed", message: problem.message });
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

  const signIn = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(undefined);
    const service = bridge;
    const generation = bridgeGeneration.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation);
    try {
      await applySnapshot(await service.login({ email, password }), service, isRequestCurrent);
      if (isRequestCurrent()) setPassword("");
    } catch (error: unknown) {
      if (isRequestCurrent()) setAuthError(bridgeError(error).message);
    } finally {
      if (isRequestCurrent()) setAuthBusy(false);
    }
  };

  const startTimer = async (): Promise<void> => {
    if (state.kind !== "idle" || projectId === "") return;
    const start: StartIntent = {
      clientId: crypto.randomUUID(),
      projectId,
      description: description.trim(),
      startedAt: new Date().toISOString(),
    };
    dispatch({ type: "start-requested", start });
    const service = bridge;
    const generation = bridgeGeneration.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation);
    try {
      const running = await service.start(start);
      if (isRequestCurrent()) dispatch({ type: "start-confirmed", running });
    } catch (error: unknown) {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      dispatch(problem.kind === "auth" ? { type: "auth-failed", message: problem.message } : { type: "start-failed", message: problem.message });
    }
  };

  const stopTimer = async (): Promise<void> => {
    if (state.kind !== "running") return;
    const input = { sessionId: state.running.sessionId, stoppedAt: new Date().toISOString(), idleSeconds: 0 as const };
    dispatch({ type: "stop-requested", stoppedAt: input.stoppedAt });
    const service = bridge;
    const generation = bridgeGeneration.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation);
    try {
      await service.stop(input);
      if (isRequestCurrent()) dispatch({ type: "stop-confirmed" });
    } catch (error: unknown) {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      if (problem.kind === "auth") dispatch({ type: "auth-failed", message: problem.message });
      else if (problem.kind === "transient") dispatch({ type: "stop-pending", message: problem.message });
      else dispatch({ type: "stop-failed", message: problem.message });
    }
  };

  const retryPending = async (): Promise<void> => {
    if (state.kind !== "pending-sync" || retryPendingBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation);
    setRetryPendingBusy(true);
    try {
      const result = await service.retryPending();
      if (isRequestCurrent()) dispatch({ type: "pending-retried", ...result });
    } catch (error: unknown) {
      const problem = bridgeError(error);
      if (isRequestCurrent() && problem.kind === "auth") dispatch({ type: "auth-failed", message: problem.message });
    } finally {
      if (isRequestCurrent()) setRetryPendingBusy(false);
    }
  };

  const recover = async (choice: "server" | "local"): Promise<void> => {
    if (state.kind !== "conflict" || conflictBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation);
    setConflictBusy(true);
    try {
      const snapshot = choice === "server" ? await service.useServerTimer() : await service.retryLocalStart(state.localStart);
      if (isRequestCurrent()) await applySnapshot(snapshot, service, isRequestCurrent);
    } catch (error: unknown) {
      const problem = bridgeError(error);
      if (isRequestCurrent()) dispatch(problem.kind === "auth" ? { type: "auth-failed", message: problem.message } : { type: "conflict-retry-failed", message: problem.message });
    } finally {
      if (isRequestCurrent()) setConflictBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    if (logoutBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation);
    setLogoutBusy(true);
    setAccountError(undefined);
    try {
      await service.logout();
      if (isRequestCurrent()) dispatch({ type: "auth-failed", message: "You have signed out." });
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
    return (
      <main className="chronometer sign-in-shell">
        <section className="sign-in-panel" aria-labelledby="sign-in-title">
          <p className="eyebrow">Manual time terminal</p>
          <h1 id="sign-in-title">Clock in</h1>
          <p className="subtle">Connect to your secure workstation session.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <form onSubmit={signIn}>
            <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required /></label>
            <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
            <button className="signal-button" type="submit" disabled={authBusy}>{authBusy ? "Signing in…" : "Sign in"}</button>
          </form>
        </section>
      </main>
    );
  }

  const account = state;
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
          {state.kind === "pending-sync" && <div className="sync-banner" role="status"><span>{state.message}</span><button type="button" disabled={retryPendingBusy} onClick={() => void retryPending()}>{retryPendingBusy ? "Retrying…" : "Retry sync"}</button></div>}
          <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Select active project</option>{account.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={3} placeholder="What are you working on?" /></label>
          <div className="entry-foot"><span>{description.length}/1000</span><button className="signal-button" type="button" disabled={state.kind === "starting" || state.kind === "pending-sync" || projectId === ""} onClick={() => void startTimer()}>{state.kind === "starting" ? "Starting…" : "Start timer"}</button></div>
        </section>
      )}
    </main>
  );
};
