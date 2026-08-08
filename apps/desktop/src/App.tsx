import { useEffect, useReducer, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  bridgeError,
  defaultBridge,
  type MeStats,
  type MeStatsApp,
  type MonitorSettings,
  type MonitorStatus,
  type OrganizationOverview,
  type PathMapping,
  type SettingsPatch,
  type TimerBridge,
} from "./bridge.js";
import { formatDuration } from "@clock-in/shared";
import {
  initialTimerState,
  stopIdleSeconds,
  timerReducer,
  type AwayDecision,
  type BootstrapSnapshot,
  type StartIntent,
} from "./timer-machine.js";
import { WebGLShader } from "./WebGLShader.js";

type AppProps = {
  bridge?: TimerBridge;
};

const elapsedSeconds = (startedAt: string, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));

/// Status polls stay well above the host's own 30-second activity tick; the
/// prompt latency this buys is fine for a tray utility.
const MONITOR_POLL_MS = 15_000;

const AGENT_SOURCE_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  kimi_code: "Kimi Code",
  cursor: "Cursor",
};

const sourceLabel = (source: string): string => AGENT_SOURCE_LABELS[source] ?? source;

/// Agent CLI executables surface in the foreground-process stats under their
/// binary name; they fold into a single row labelled via AGENT_SOURCE_LABELS.
const AGENT_PROCESS_SOURCES: Record<string, string> = {
  claude: "claude_code",
  codex: "codex",
  kimi: "kimi_code",
};

const FRIENDLY_APP_NAMES: Record<string, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  firefox: "Firefox",
  brave: "Brave",
  arc: "Arc",
  code: "VS Code",
  cursor: "Cursor",
  windowsterminal: "Windows Terminal",
  pwsh: "PowerShell",
  powershell: "Windows PowerShell",
  cmd: "Command Prompt",
  explorer: "File Explorer",
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  zoom: "Zoom",
  notion: "Notion",
  obsidian: "Obsidian",
  figma: "Figma",
  spotify: "Spotify",
};

/// "chrome.exe" -> "Google Chrome"; unknown processes lose the extension and
/// get title-cased ("app-09.exe" -> "App 09").
const friendlyAppName = (processName: string): string => {
  const base = processName.replace(/\.exe$/i, "");
  const known = FRIENDLY_APP_NAMES[base.toLowerCase()];
  if (known !== undefined) return known;
  return base
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

/// Compact durations for the Today card: "2h 12m", "45m", "30s".
const formatCompact = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
};

type AppRow = {
  key: string;
  label: string;
  durationSeconds: number;
  agent: boolean;
};

const TOP_APP_ROWS = 8;

/// Heaviest-first app rows for the Today card: agent CLIs fold into one row,
/// and everything past the top rows folds into "Everything else".
const buildAppRows = (apps: readonly MeStatsApp[]): AppRow[] => {
  let agentSeconds = 0;
  const agentSources = new Set<string>();
  const rows: AppRow[] = [];
  for (const app of apps) {
    const base = app.processName.replace(/\.exe$/i, "").toLowerCase();
    const agentSource = AGENT_PROCESS_SOURCES[base];
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
  const rest = rows.slice(TOP_APP_ROWS).reduce((sum, row) => sum + row.durationSeconds, 0);
  return [...rows.slice(0, TOP_APP_ROWS), { key: "everything-else", label: "Everything else", durationSeconds: rest, agent: false }];
};

type StatsRange = "today" | "week";

/// Local midnight today, or local midnight on Monday for "this week".
const rangeStart = (range: StatsRange): string => {
  const start = new Date();
  if (range === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
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
  const [state, dispatch] = useReducer(timerReducer, initialTimerState);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [overview, setOverview] = useState<OrganizationOverview | undefined>();
  const [overviewError, setOverviewError] = useState<string | undefined>();
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | undefined>();
  const [accountError, setAccountError] = useState<string | undefined>();
  const [projectId, setProjectId] = useState("");
  const [description, setDescription] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [retryPendingBusy, setRetryPendingBusy] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsRange, setStatsRange] = useState<StatsRange>("today");
  const [stats, setStats] = useState<MeStats | undefined>();
  const [statsError, setStatsError] = useState<string | undefined>();
  const [settings, setSettings] = useState<MonitorSettings | undefined>();
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const [awayThresholdDraft, setAwayThresholdDraft] = useState("");
  const [hardLimitDraft, setHardLimitDraft] = useState("");
  const [mappings, setMappings] = useState<readonly PathMapping[] | undefined>();
  const [mappingPrefix, setMappingPrefix] = useState("");
  const [mappingProjectId, setMappingProjectId] = useState("");
  const [mappingBusy, setMappingBusy] = useState(false);
  /// Manual hook-setup snippets returned by `hookRegister`, keyed by CLI source.
  const [hookSnippets, setHookSnippets] = useState<Readonly<Record<string, string>>>({});
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
    setJoinCode("");
    setOverview(undefined);
    setOverviewError(undefined);
    setMonitorStatus(undefined);
    setStats(undefined);
    setStatsError(undefined);
    setSettings(undefined);
    setSettingsError(undefined);
    setMappings(undefined);
    setMappingPrefix("");
    setMappingProjectId("");
    setHookSnippets({});
    setSettingsOpen(false);
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

  // The Today card is always on screen, so stats load with the account and
  // refresh on the same transitions as the board (a stopped timer changes
  // today's total) plus whenever the range switches.
  useEffect(() => {
    if (state.kind === "booting" || state.kind === "sign-in") return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    void service.meStats(rangeStart(statsRange)).then(
      (result) => {
        if (active && isCurrent(service, generation, epoch)) {
          setStats(result);
          setStatsError(undefined);
        }
      },
      (error: unknown) => {
        if (!active || !isCurrent(service, generation, epoch)) return;
        const problem = bridgeError(error);
        if (problem.kind !== "auth") setStatsError(problem.message);
      },
    );
    return () => { active = false; };
  }, [bridge, statsRange, state.kind === "idle", state.kind === "sign-in"]);

  // Monitor status poll: fires on every state change (so a sign-in, start, or
  // stop refreshes it immediately, and a fresh account epoch is captured after
  // each bootstrap) and on a slow interval in between. Failures — signed out,
  // unsupported, offline — leave the surfaces hidden rather than noisy; there
  // is no state where recording happens without the UI saying so.
  useEffect(() => {
    if (state.kind === "booting" || state.kind === "sign-in") return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const poll = (): void => {
      void service.monitorStatus().then(
        (status) => {
          if (!active || !isCurrent(service, generation, epoch)) return;
          setMonitorStatus(status);
          if (status.pendingSuggestion) dispatch({ type: "suggestion-received", suggestion: status.pendingSuggestion });
          else dispatch({ type: "suggestion-cleared" });
          const away = status.away;
          if (away && !away.ongoing) {
            dispatch({
              type: "away-detected",
              away: { startedAt: away.startedAt, seconds: away.seconds, exceedsHardLimit: away.exceedsHardLimit },
            });
          }
        },
        () => undefined,
      );
    };
    poll();
    const timer = window.setInterval(poll, MONITOR_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [bridge, state]);

  // Settings and path mappings only load while the settings overlay is open.
  useEffect(() => {
    if (!settingsOpen) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => active && isCurrent(service, generation, epoch);
    const fail = (error: unknown): void => {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      if (problem.kind !== "auth") setSettingsError(problem.message);
    };
    void service.settingsGet().then((result) => {
      if (!isRequestCurrent()) return;
      setSettings(result);
      setAwayThresholdDraft(String(result.awayThresholdMinutes));
      setHardLimitDraft(String(result.hardAwayLimitMinutes));
      setSettingsError(undefined);
    }, fail);
    void service.pathMappingsList().then((result) => {
      if (isRequestCurrent()) setMappings(result);
    }, fail);
    return () => { active = false; };
  }, [bridge, settingsOpen]);

  // The settings overlay closes on Escape, like the web app's help dialog.
  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

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

  const startTimer = async (suggestedProjectId?: string): Promise<void> => {
    const chosenProjectId = suggestedProjectId ?? projectId;
    if (state.kind !== "idle" || chosenProjectId === "" || !state.projects.some((project) => project.id === chosenProjectId)) return;
    const start: StartIntent = {
      clientId: crypto.randomUUID(),
      projectId: chosenProjectId,
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

  const dismissSuggestion = async (): Promise<void> => {
    dispatch({ type: "suggestion-cleared" });
    try {
      await bridge.monitorDismissSuggestion();
    } catch {
      // A failed dismiss is self-healing: the next status poll re-raises the
      // prompt if the host still holds the suggestion.
    }
  };

  const answerAway = (decision: AwayDecision): void => {
    dispatch({ type: "away-answered", decision });
  };

  const stopTimer = async (): Promise<void> => {
    if (state.kind !== "running") return;
    // null leaves measurement to the host; a "keep" answer sends an explicit
    // figure — possibly 0 — so the away span is not trimmed (other measured
    // idle still is).
    const idleSeconds = stopIdleSeconds(state.away, monitorStatus?.sessionIdleSeconds);
    const input = { sessionId: state.running.sessionId, stoppedAt: new Date().toISOString(), idleSeconds };
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

  const applySettings = async (patch: SettingsPatch): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setSettingsError(undefined);
    try {
      const next = await service.settingsUpdate(patch);
      if (isRequestCurrent()) setSettings(next);
    } catch (error: unknown) {
      if (isRequestCurrent()) setSettingsError(bridgeError(error).message);
    }
  };

  const applyMonitoringEnabled = async (enabled: boolean): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setSettingsError(undefined);
    try {
      const next = await service.monitorSetEnabled(enabled);
      if (!isRequestCurrent()) return;
      setSettings(next);
      // The status line reflects the new monitoring state immediately rather
      // than at the next poll tick.
      const status = await service.monitorStatus();
      if (isRequestCurrent()) setMonitorStatus(status);
    } catch (error: unknown) {
      if (isRequestCurrent()) setSettingsError(bridgeError(error).message);
    }
  };

  const registerHook = async (source: string): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setSettingsError(undefined);
    try {
      const result = await service.hookRegister(source);
      if (!isRequestCurrent()) return;
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
      // The list reflects the new registration immediately rather than at the
      // next status poll.
      const status = await service.monitorStatus();
      if (isRequestCurrent()) setMonitorStatus(status);
    } catch (error: unknown) {
      if (isRequestCurrent()) setSettingsError(bridgeError(error).message);
    }
  };

  const commitMinutes = (field: "awayThresholdMinutes" | "hardAwayLimitMinutes", raw: string): void => {
    const minutes = Number.parseInt(raw, 10);
    if (!settings || !Number.isSafeInteger(minutes) || minutes < 1 || settings[field] === minutes) return;
    void applySettings({ [field]: minutes });
  };

  const addMapping = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (mappingBusy || mappingProjectId === "") return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setMappingBusy(true);
    setSettingsError(undefined);
    try {
      const created = await service.pathMappingsCreate({ pathPrefix: mappingPrefix.trim(), projectId: mappingProjectId });
      if (isRequestCurrent()) {
        setMappings((current) => [...(current ?? []), created]);
        setMappingPrefix("");
      }
    } catch (error: unknown) {
      if (isRequestCurrent()) setSettingsError(bridgeError(error).message);
    } finally {
      if (isRequestCurrent()) setMappingBusy(false);
    }
  };

  const deleteMapping = async (id: string): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setSettingsError(undefined);
    try {
      await service.pathMappingsDelete(id);
      if (isRequestCurrent()) setMappings((current) => current?.filter((mapping) => mapping.id !== id));
    } catch (error: unknown) {
      if (isRequestCurrent()) setSettingsError(bridgeError(error).message);
    }
  };

  const joinWorkspace = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (joinBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setJoinBusy(true);
    setOverviewError(undefined);
    try {
      const result = await service.orgJoin(joinCode.trim());
      if (isRequestCurrent()) {
        setOverview(result);
        setJoinCode("");
      }
    } catch (error: unknown) {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      if (problem.kind === "auth") resetToSignIn(problem.message);
      else setOverviewError(problem.message);
    } finally {
      if (isRequestCurrent()) setJoinBusy(false);
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

  if (state.kind === "sign-in") {
    const error = authError ?? state.error;
    const isSignUp = authMode === "sign-up";
    return (
      <main className="app-shell">
        <WebGLShader />
        <Titlebar />
        <div className="center-stage">
          <section className="sign-in-panel card" aria-labelledby="sign-in-title">
            <p className="eyebrow">Clock-In</p>
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
        </div>
      </main>
    );
  }

  const account = state;
  const hasSelectedProject = account.projects.some((project) => project.id === projectId);
  const activeRunning = state.kind === "running" || state.kind === "stopping" ? state.running : undefined;
  const project = activeRunning ? account.projects.find((item) => item.id === activeRunning.projectId) : undefined;
  const elapsedAt = state.kind === "stopping" ? Date.parse(state.stoppedAt) : now;
  const suggestion = state.kind === "idle" ? state.suggestion : undefined;
  const suggestedProject = suggestion ? account.projects.find((item) => item.id === suggestion.projectId) : undefined;
  const awayPrompt = state.kind === "running" && state.away?.decision === undefined ? state.away : undefined;
  const awayDecision = state.kind === "running" ? state.away?.decision : undefined;
  const monitorState = monitorStatus === undefined
    ? undefined
    : monitorStatus.enabled
      ? monitorStatus.running ? "on" : "paused"
      : "off";
  const appRows = stats === undefined ? [] : buildAppRows(stats.apps);

  return (
    <main className={`app-shell ${state.kind}`}>
      <WebGLShader />
      <Titlebar onOpenSettings={() => setSettingsOpen(true)} />
      <div className="screen">
        {monitorStatus && monitorState && (
          <p className="monitor-line">
            <span className={`monitor-dot is-${monitorState}`} aria-hidden="true" />
            {monitorState === "on" ? "Monitoring on" : monitorState === "paused" ? "Monitoring paused" : "Monitoring off"}
          </p>
        )}
        {accountError && !settingsOpen && <p className="form-error" role="alert">{accountError}</p>}

        {awayPrompt && (
          <div className="prompt-card card">
            <p className="eyebrow">Away</p>
            <p>You were away {Math.max(1, Math.round(awayPrompt.seconds / 60))} minutes — discard or keep?</p>
            <div className="prompt-actions">
              <button className="signal-button" type="button" onClick={() => answerAway("discard")}>Discard</button>
              <button className="outline-button" type="button" onClick={() => answerAway("keep")}>Keep</button>
            </div>
          </div>
        )}
        {suggestion && (
          <div className="prompt-card card">
            <p className="eyebrow">Suggested start</p>
            <p>{sourceLabel(suggestion.source)} active — start tracking <strong>{suggestedProject?.name ?? "the mapped project"}</strong>?</p>
            <div className="prompt-actions">
              {suggestedProject && (
                <button className="signal-button" type="button" onClick={() => void startTimer(suggestion.projectId)}>Start</button>
              )}
              <button className="outline-button" type="button" onClick={() => void dismissSuggestion()}>Dismiss</button>
            </div>
          </div>
        )}

        {state.kind === "conflict" ? (
          <section className="hero card conflict-panel" aria-labelledby="conflict-title">
            <h2 id="conflict-title">We found two timers — pick one to keep</h2>
            <p>Your device recorded <strong>{state.localStart.description || "a local start"}</strong>; the service has an active timer. Neither record has been discarded.</p>
            {state.error && <p role="alert" className="form-error">{state.error}</p>}
            <div className="action-stack">
              <button className="signal-button" type="button" disabled={conflictBusy} onClick={() => void recover("server")}>{conflictBusy ? "Resolving…" : "Use server timer"}</button>
              <button className="outline-button" type="button" disabled={conflictBusy} onClick={() => void recover("local")}>Retry local start</button>
            </div>
          </section>
        ) : activeRunning ? (
          <section className="hero card running-panel" aria-label="Running timer">
            <p className="eyebrow">Recording · {project?.name ?? "Unknown project"}</p>
            <output className="elapsed" data-testid="elapsed-time" aria-label="Elapsed time">{formatDuration(elapsedSeconds(activeRunning.startedAt, elapsedAt))}</output>
            <p className="started-at">since {new Date(activeRunning.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
            {monitorStatus?.enabled && monitorStatus.sessionIdleSeconds !== null && (
              <p className="session-meta" data-testid="idle-trimmed">Idle trimmed so far {formatDuration(monitorStatus.sessionIdleSeconds)}</p>
            )}
            {monitorStatus?.enabled && monitorStatus.agentActive && (
              <p className="session-meta agent-active" data-testid="agent-active">
                {sourceLabel(monitorStatus.agentActive.source)} active — idle trim paused
              </p>
            )}
            {state.kind === "running" && state.error && <p className="form-error" role="alert">{state.error}</p>}
            {awayDecision && (
              <p className="session-meta">{awayDecision === "keep" ? "Away time kept — it stays billable." : "Away time will be trimmed at stop."}</p>
            )}
            <button className="stop-button" type="button" disabled={state.kind === "stopping"} onClick={() => void stopTimer()}>{state.kind === "stopping" ? "Stopping…" : "Stop timer"}</button>
          </section>
        ) : (
          <section className="hero card idle-panel" aria-labelledby="timer-title">
            <h2 id="timer-title">Start a timer</h2>
            {state.kind === "idle" && state.error && <p className="form-error" role="alert">{state.error}</p>}
            {state.kind === "pending-sync" && <><div className="sync-banner" role="status"><span>{state.message}</span><button type="button" disabled={retryPendingBusy} onClick={() => void retryPending()}>{retryPendingBusy ? "Retrying…" : "Retry sync"}</button></div>{state.error && <p className="form-error" role="alert">{state.error}</p>}</>}
            <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Select active project</option>{account.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={3} placeholder="What are you working on?" /></label>
            <div className="entry-foot"><span>{description.length}/1000</span><button className="signal-button" type="button" disabled={state.kind === "starting" || state.kind === "pending-sync" || !hasSelectedProject} onClick={() => void startTimer()}>{state.kind === "starting" ? "Starting…" : "Start timer"}</button></div>
          </section>
        )}

        <section className="today-card card" aria-labelledby="today-title">
          <div className="panel-head">
            <h2 id="today-title">{statsRange === "today" ? "Today so far" : "This week"}</h2>
            <div className="range-toggle" role="group" aria-label="Date range">
              <button type="button" className={statsRange === "today" ? "is-active" : undefined} onClick={() => setStatsRange("today")}>Today</button>
              <button type="button" className={statsRange === "week" ? "is-active" : undefined} onClick={() => setStatsRange("week")}>This week</button>
            </div>
          </div>
          {statsError && <p className="form-error" role="alert">{statsError}</p>}
          {stats === undefined ? (
            !statsError && <p className="subtle">Loading…</p>
          ) : (
            <>
              <p className="today-total"><strong>{formatCompact(stats.totalDurationSeconds)}</strong> tracked</p>
              {appRows.length === 0 ? (
                <p className="subtle">No activity yet. Turn on monitoring in settings to see where your time goes.</p>
              ) : (
                <ul className="app-list">
                  {appRows.map((row) => (
                    <li key={row.key} className="app-row">
                      <span className="app-name">
                        {row.label}
                        {row.agent && monitorStatus?.agentActive && <span className="app-active"> · active now</span>}
                      </span>
                      <span className="app-duration">{formatCompact(row.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {monitorStatus?.enabled === true && stats.corroboratedSeconds > 0 && (
                <p className="verified-foot">{formatCompact(stats.corroboratedSeconds)} of {statsRange === "today" ? "today" : "this week"} verified</p>
              )}
            </>
          )}
        </section>

        {overview && (
          <section className="board-panel card" aria-labelledby="board-title">
            <div className="board-head">
              <h2 id="board-title">{overview.organization.name}</h2>
              <span className="invite-code" title="Share this code so teammates join this workspace">
                {overview.organization.inviteCode}
              </span>
            </div>
            {overviewError && <p className="form-error" role="alert">{overviewError}</p>}
            {overview.entries.length <= 1 && (
              <form className="join-form" onSubmit={joinWorkspace}>
                <label>
                  <span className="visually-hidden">Invite code to join a teammate</span>
                  <input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="Join a team: ABCDE-FGHJK" autoComplete="off" spellCheck={false} required />
                </label>
                <button type="submit" disabled={joinBusy}>{joinBusy ? "Joining…" : "Join"}</button>
              </form>
            )}
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
      </div>

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
                <div className="setting-rows">
                  <label className="toggle-row">
                    <span>Activity monitoring</span>
                    <input type="checkbox" checked={settings.enabled} onChange={(event) => void applyMonitoringEnabled(event.target.checked)} />
                  </label>
                  <label className="setting-field">
                    <span>Away threshold (minutes)</span>
                    <input
                      type="number"
                      min={1}
                      value={awayThresholdDraft}
                      onChange={(event) => setAwayThresholdDraft(event.target.value)}
                      onBlur={(event) => commitMinutes("awayThresholdMinutes", event.target.value)}
                    />
                  </label>
                  <label className="setting-field">
                    <span>Hard away limit (minutes)</span>
                    <input
                      type="number"
                      min={1}
                      value={hardLimitDraft}
                      onChange={(event) => setHardLimitDraft(event.target.value)}
                      onBlur={(event) => commitMinutes("hardAwayLimitMinutes", event.target.value)}
                    />
                  </label>
                  <label className="toggle-row">
                    <span>Stop the timer when the machine locks</span>
                    <input type="checkbox" checked={settings.autoStopOnLock} onChange={(event) => void applySettings({ autoStopOnLock: event.target.checked })} />
                  </label>
                  <label className="toggle-row">
                    <span>Count active agent sessions as work while away</span>
                    <input type="checkbox" checked={settings.agentOverrideEnabled} onChange={(event) => void applySettings({ agentOverrideEnabled: event.target.checked })} />
                  </label>
                </div>
                <div className="mappings">
                  <h3>Path mappings</h3>
                  <p className="subtle">Agent activity in these directories is attributed to the matching project.</p>
                  {mappings === undefined ? (
                    <p className="subtle">Loading…</p>
                  ) : mappings.length === 0 ? (
                    <p className="subtle">No mappings yet.</p>
                  ) : (
                    <ul className="mapping-list">
                      {mappings.map((mapping) => (
                        <li key={mapping.id} className="mapping-row">
                          <span className="mapping-path" title={mapping.pathPrefix}>{mapping.pathPrefix}</span>
                          <span className="mapping-project">{account.projects.find((item) => item.id === mapping.projectId)?.name ?? "Unknown project"}</span>
                          <button type="button" onClick={() => void deleteMapping(mapping.id)}>Delete</button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form className="mapping-form" onSubmit={addMapping}>
                    <label>
                      Path prefix
                      <input value={mappingPrefix} onChange={(event) => setMappingPrefix(event.target.value)} placeholder="C:/dev/project" spellCheck={false} autoComplete="off" required />
                    </label>
                    <label>
                      Project
                      <select value={mappingProjectId} onChange={(event) => setMappingProjectId(event.target.value)} required>
                        <option value="">Select project</option>
                        {account.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                    <button className="signal-button" type="submit" disabled={mappingBusy}>{mappingBusy ? "Adding…" : "Add mapping"}</button>
                  </form>
                </div>
                {monitorStatus !== undefined && monitorStatus.hooks.length > 0 && (
                  <div className="hooks-setup">
                    <h3>Watch my agent CLIs</h3>
                    <p className="subtle">
                      Opt in per tool: Clock-In adds its hook to the tool&apos;s own config, and only when you ask.
                    </p>
                    <ul className="hook-list">
                      {monitorStatus.hooks.map((hook) => (
                        <li key={hook.source} className="hook-row">
                          <span
                            className={`hook-badge ${hook.detected ? "is-detected" : "is-missing"}`}
                            title={hook.configPath}
                          >
                            {sourceLabel(hook.source)}
                          </span>
                          {hook.detected ? (
                            <span className="hook-state">Registered</span>
                          ) : (
                            <button type="button" onClick={() => void registerHook(hook.source)}>Register</button>
                          )}
                          {hookSnippets[hook.source] !== undefined && (
                            <pre className="hook-snippet">{hookSnippets[hook.source]}</pre>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="privacy-note">
                  <h3>What&apos;s recorded</h3>
                  <p className="subtle">
                    While monitoring is on, Clock-In samples the foreground process name every 30 seconds and notes idle,
                    lock, and sleep transitions. It never records window titles, URLs, document names, or keystrokes.
                    Agent tools report only session start and end with their working directory. Evidence waits in a local
                    spool file under %APPDATA%\clock-in and uploads in batches every few minutes. Pausing monitoring never
                    stops your timer - time your computer can&apos;t confirm still counts, it&apos;s just not marked verified.
                  </p>
                </div>
                <button className="link-button" type="button" disabled={logoutBusy} onClick={() => void logout()}>{logoutBusy ? "Logging out…" : "Log out"}</button>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
};
