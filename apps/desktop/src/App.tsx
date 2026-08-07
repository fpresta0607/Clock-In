import { useEffect, useReducer, useState } from "react";

import { bridgeError, defaultBridge, type TimerBridge } from "./bridge.js";
import { formatDuration } from "@clock-in/shared";
import { initialTimerState, timerReducer, type StartIntent } from "./timer-machine.js";

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
  const [projectId, setProjectId] = useState("");
  const [description, setDescription] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void bridge.bootstrap().then(
      (snapshot) => dispatch({ type: "bootstrapped", snapshot }),
      (error: unknown) => {
        const problem = bridgeError(error);
        dispatch({ type: "auth-failed", message: problem.message });
      },
    );
  }, [bridge]);

  useEffect(() => {
    if (state.kind !== "running" && state.kind !== "stopping") return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state.kind]);

  const signIn = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(undefined);
    try {
      dispatch({ type: "bootstrapped", snapshot: await bridge.login({ email, password }) });
      setPassword("");
    } catch (error: unknown) {
      setAuthError(bridgeError(error).message);
    } finally {
      setAuthBusy(false);
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
    try {
      dispatch({ type: "start-confirmed", running: await bridge.start(start) });
    } catch (error: unknown) {
      const problem = bridgeError(error);
      dispatch(problem.kind === "auth" ? { type: "auth-failed", message: problem.message } : { type: "start-failed", message: problem.message });
    }
  };

  const stopTimer = async (): Promise<void> => {
    if (state.kind !== "running") return;
    const input = { sessionId: state.running.sessionId, stoppedAt: new Date().toISOString(), idleSeconds: 0 as const };
    dispatch({ type: "stop-requested", stoppedAt: input.stoppedAt });
    try {
      await bridge.stop(input);
      dispatch({ type: "stop-confirmed" });
    } catch (error: unknown) {
      const problem = bridgeError(error);
      if (problem.kind === "auth") dispatch({ type: "auth-failed", message: problem.message });
      else if (problem.kind === "transient") dispatch({ type: "stop-pending", message: problem.message });
      else dispatch({ type: "stop-failed", message: problem.message });
    }
  };

  const retryPending = async (): Promise<void> => {
    if (state.kind !== "pending-sync") return;
    try {
      dispatch({ type: "pending-retried", ...(await bridge.retryPending()) });
    } catch (error: unknown) {
      const problem = bridgeError(error);
      if (problem.kind === "auth") dispatch({ type: "auth-failed", message: problem.message });
    }
  };

  const recover = async (choice: "server" | "local"): Promise<void> => {
    if (state.kind !== "conflict") return;
    try {
      const snapshot = choice === "server" ? await bridge.useServerTimer() : await bridge.retryLocalStart(state.localStart);
      dispatch({ type: "bootstrapped", snapshot });
    } catch (error: unknown) {
      const problem = bridgeError(error);
      dispatch(problem.kind === "auth" ? { type: "auth-failed", message: problem.message } : { type: "conflict-retry-failed", message: problem.message });
    }
  };

  const logout = async (): Promise<void> => {
    await bridge.logout();
    dispatch({ type: "auth-failed", message: "You have signed out." });
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

  return (
    <main className={`chronometer ${state.kind}`}>
      <aside className="status-rail" aria-hidden="true"><span /><span /><span /></aside>
      <header className="instrument-header">
        <div><p className="eyebrow">Manual time terminal</p><h1>Field chronometer</h1></div>
        <button className="logout" type="button" onClick={() => void logout()}>Log out</button>
      </header>

      {state.kind === "conflict" ? (
        <section className="conflict-panel" aria-labelledby="conflict-title">
          <p className="eyebrow">Recovery hold</p><h2 id="conflict-title">Timer needs reconciliation</h2>
          <p>Your device recorded <strong>{state.localStart.description || "a local start"}</strong>; the service has an active timer. Neither record has been discarded.</p>
          {state.error && <p role="alert" className="form-error">{state.error}</p>}
          <div className="action-stack">
            <button className="signal-button" type="button" onClick={() => void recover("server")}>Use server timer</button>
            <button className="outline-button" type="button" onClick={() => void recover("local")}>Retry local start</button>
          </div>
        </section>
      ) : activeRunning ? (
        <section className="running-panel" aria-label="Running timer">
          <div className="dial" aria-hidden="true"><span className="dial-core" /></div>
          <p className="eyebrow">Recording · {project?.name ?? "Unknown project"}</p>
          <output className="elapsed" data-testid="elapsed-time" aria-label="Elapsed time">{formatDuration(elapsedSeconds(activeRunning.startedAt, now))}</output>
          <p className="started-at">Started {new Date(activeRunning.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
          {state.kind === "running" && state.error && <p className="form-error" role="alert">{state.error}</p>}
          <button className="stop-button" type="button" disabled={state.kind === "stopping"} onClick={() => void stopTimer()}>{state.kind === "stopping" ? "Stopping…" : "Stop timer"}</button>
        </section>
      ) : (
        <section className="idle-panel" aria-labelledby="timer-title">
          <p className="eyebrow">Ready for a new entry</p><h2 id="timer-title">Start a timer</h2>
          {state.kind === "idle" && state.error && <p className="form-error" role="alert">{state.error}</p>}
          {state.kind === "pending-sync" && <div className="sync-banner" role="status"><span>{state.message}</span><button type="button" onClick={() => void retryPending()}>Retry sync</button></div>}
          <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Select active project</option>{account.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={3} placeholder="What are you working on?" /></label>
          <div className="entry-foot"><span>{description.length}/1000</span><button className="signal-button" type="button" disabled={state.kind === "starting" || state.kind === "pending-sync" || projectId === ""} onClick={() => void startTimer()}>{state.kind === "starting" ? "Starting…" : "Start timer"}</button></div>
        </section>
      )}
    </main>
  );
};
