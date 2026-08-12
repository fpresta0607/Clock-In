import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { AccountSnapshot, SignedInAccount } from "./account.js";
import { sourceLabel } from "./agent-sources.js";
import {
  bridgeError,
  defaultBridge,
  type MeStats,
  type MeStatsApp,
  type MonitorSettings,
  type MonitorStatus,
  type OrganizationOverview,
  type PathMapping,
  type SessionApp,
  type SettingsPatch,
  type TimerBridge,
} from "./bridge.js";
import { AgentRuntimeIcon } from "./agent-icons.js";
import { agentRuntimeForBinary, formatDuration } from "@clock-in/shared";
import { RecordingPanel, recordingState, type RecordingState } from "./RecordingPanel.js";
import { WebGLShader } from "./WebGLShader.js";

type AppProps = {
  bridge?: TimerBridge;
};

/// Status polls stay well above the host's own 30-second activity tick; the
/// latency this buys is fine for a tray utility.
const MONITOR_POLL_MS = 15_000;

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

const elapsedSeconds = (since: string, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));

type AppRow = {
  key: string;
  label: string;
  durationSeconds: number;
  agent: boolean;
};

const TOP_APP_ROWS = 8;

/// Heaviest-first app rows for the Today card: agent CLIs fold into one row,
/// and everything past the top rows folds into "Everything else". Which
/// executables count as an agent comes from the shared runtime roster, so a
/// newly declared CLI folds in without a second list to remember.
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
  const rest = rows.slice(TOP_APP_ROWS).reduce((sum, row) => sum + row.durationSeconds, 0);
  return [...rows.slice(0, TOP_APP_ROWS), { key: "everything-else", label: "Everything else", durationSeconds: rest, agent: false }];
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

const SESSION_EMPTY: Record<RecordingState, string> = {
  on: "Nothing yet. The moment you use an app, it shows up here.",
  stalled: "Nothing is being measured, because recording stopped responding.",
  paused: "Recording is about to start.",
  off: "Recording is off, so nothing is being measured.",
  unknown: "Clock-In can't reach the recorder on this computer.",
};

/// One app's share of the open session, as the live surface renders it.
type SessionRow = {
  key: string;
  label: string;
  /// The agent runtime this executable belongs to, when it is one. Drives the
  /// runtime mark, and is how a CLI gets called "Claude Code" rather than
  /// "Claude.exe".
  source: string | undefined;
  durationSeconds: number;
  /// Percentage of the session, for the bar behind the row.
  share: number;
};

/// Turns the host's per-app seconds into rows for the live surface. Agent CLIs
/// keep their own row here rather than folding into one: which tool the time
/// went to is the whole question this surface answers.
const buildSessionRows = (apps: readonly SessionApp[]): SessionRow[] => {
  const longest = apps.reduce((most, app) => Math.max(most, app.durationSeconds), 0);
  return apps
    .filter((app) => app.durationSeconds > 0)
    .map((app) => {
      const source = agentRuntimeForBinary(app.processName);
      return {
        key: app.processName,
        label: source === undefined ? friendlyAppName(app.processName) : sourceLabel(source),
        source,
        durationSeconds: app.durationSeconds,
        share: longest === 0 ? 0 : Math.round((app.durationSeconds / longest) * 100),
      };
    });
};

type StatsRange = "today" | "week";

/// Local midnight today, or local midnight on Monday for "this week".
const rangeStart = (range: StatsRange): string => {
  const start = new Date();
  if (range === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  // The API reads calendar days, not timestamps: a full ISO datetime is a 400.
  return start.toISOString().slice(0, 10);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [allStatsOpen, setAllStatsOpen] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [statsRange, setStatsRange] = useState<StatsRange>("today");
  const [stats, setStats] = useState<MeStats | undefined>();
  const [statsError, setStatsError] = useState<string | undefined>();
  const [settings, setSettings] = useState<MonitorSettings | undefined>();
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const [quietDraft, setQuietDraft] = useState("");
  const [mappings, setMappings] = useState<readonly PathMapping[] | undefined>();
  const [mappingPrefix, setMappingPrefix] = useState("");
  const [mappingProjectId, setMappingProjectId] = useState("");
  const [mappingBusy, setMappingBusy] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState<string | undefined>();
  /// Manual hook-setup snippets returned by `hookRegister`, keyed by CLI source.
  const [hookSnippets, setHookSnippets] = useState<Readonly<Record<string, string>>>({});
  const latestBridge = useRef(bridge);
  const mounted = useRef(true);
  const bridgeGeneration = useRef(0);

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
    setSettings(undefined);
    setSettingsError(undefined);
    setMappings(undefined);
    setMappingPrefix("");
    setMappingProjectId("");
    setHookSnippets({});
    setSettingsOpen(false);
    setRecordingOpen(false);
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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
          setOverview(result);
          setOverviewError(undefined);
        }
      },
      (error: unknown) => {
        if (!active || !isCurrent(service, generation)) return;
        const problem = bridgeError(error);
        // An expired session is handled by whatever the user does next; the
        // board going stale is not worth a sign-in bounce.
        if (problem.kind !== "auth") setOverviewError(problem.message);
      },
    );
    return () => { active = false; };
  }, [bridge, signedIn?.user.id]);

  useEffect(() => {
    if (signedIn === undefined) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    void service.meStats(rangeStart(statsRange)).then(
      (result) => {
        if (active && isCurrent(service, generation)) {
          setStats(result);
          setStatsError(undefined);
        }
      },
      (error: unknown) => {
        if (!active || !isCurrent(service, generation)) return;
        const problem = bridgeError(error);
        if (problem.kind !== "auth") setStatsError(problem.message);
      },
    );
    return () => { active = false; };
  }, [bridge, statsRange, signedIn?.user.id]);

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

  // Settings and path mappings only load while the settings overlay is open.
  useEffect(() => {
    if (!settingsOpen) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const isRequestCurrent = (): boolean => active && isCurrent(service, generation);
    const fail = (error: unknown): void => {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      if (problem.kind !== "auth") setSettingsError(problem.message);
    };
    void service.settingsGet().then((result) => {
      if (!isRequestCurrent()) return;
      setSettings(result);
      setQuietDraft(String(result.awayThresholdMinutes));
      setSettingsError(undefined);
    }, fail);
    void service.pathMappingsList().then((result) => {
      if (isRequestCurrent()) setMappings(result);
    }, fail);
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
      if (isCurrent(service, generation)) applyStatus(status);
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

  const commitQuietMinutes = (raw: string): void => {
    const minutes = Number.parseInt(raw, 10);
    if (!settings || !Number.isSafeInteger(minutes) || minutes < 1 || settings.awayThresholdMinutes === minutes) return;
    void applySettings({ awayThresholdMinutes: minutes });
  };

  const addMapping = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (mappingBusy || mappingProjectId === "") return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    setMappingBusy(true);
    setSettingsError(undefined);
    try {
      const created = await service.pathMappingsCreate({ pathPrefix: mappingPrefix.trim(), projectId: mappingProjectId });
      if (isCurrent(service, generation)) {
        setMappings((current) => [...(current ?? []), created]);
        setMappingPrefix("");
      }
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setSettingsError(bridgeError(error).message);
    } finally {
      if (isCurrent(service, generation)) setMappingBusy(false);
    }
  };

  const deleteMapping = async (id: string): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    setSettingsError(undefined);
    try {
      await service.pathMappingsDelete(id);
      if (isCurrent(service, generation)) setMappings((current) => current?.filter((mapping) => mapping.id !== id));
    } catch (error: unknown) {
      if (isCurrent(service, generation)) setSettingsError(bridgeError(error).message);
    }
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
      if (isCurrent(service, generation)) {
        setOverview(result);
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
          <section className="sign-in-panel card" aria-labelledby="sign-in-title">
            <p className="eyebrow">Clock-In</p>
            <h1 id="sign-in-title">{isSignUp ? "Create your account" : "Clock in"}</h1>
            <p className="subtle">
              {isSignUp
                ? "Your workspace and first project are set up automatically."
                : "Sign in and Clock-In keeps your hours for you."}
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
  const defaultProject = ready.projects.find((item) => item.id === ready.defaultProjectId);
  const appRows = stats === undefined ? [] : buildAppRows(stats.apps);
  const sessionRows = current === null ? [] : buildSessionRows(current.apps);

  return (
    <main className="app-shell">
      <WebGLShader />
      <Titlebar onOpenSettings={() => setSettingsOpen(true)} />
      <div className="screen">
        {monitorStatus && (
          <p className="monitor-line">
            <span className={`monitor-dot is-${state}`} aria-hidden="true" />
            <span className="monitor-state">{MONITOR_LINE[state]}</span>
            <button className="monitor-explain" type="button" onClick={() => setRecordingOpen(true)}>
              What&apos;s recorded?
            </button>
          </p>
        )}
        {accountError && !settingsOpen && <p className="form-error" role="alert">{accountError}</p>}

        <section className="hero card recording-card" aria-labelledby="recording-heading">
          {current ? (
            <>
              <p className="eyebrow">Recording · {currentProject?.name ?? "Unknown project"}</p>
              <h2 id="recording-heading" className="visually-hidden">Recording now</h2>
              <output className="elapsed" data-testid="elapsed-time" aria-label="Time in this stretch of work">
                {formatDuration(elapsedSeconds(current.since, now))}
              </output>
              <p className="started-at">since {new Date(current.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
              {current.idleSeconds > 0 && (
                <p className="session-meta" data-testid="idle-trimmed">Quiet time taken off so far {formatDuration(current.idleSeconds)}</p>
              )}
              {monitorStatus?.agentActive && (
                <p className="session-meta agent-active" data-testid="agent-active">
                  {sourceLabel(monitorStatus.agentActive.source)} is working, so this keeps running
                </p>
              )}
              <p className="session-meta">
                {current.attribution === "agent"
                  ? "Filed here because that is the folder your AI tool is working in."
                  : current.attribution === "selected"
                    ? "Filed here because you picked this project."
                    : "Filed here because nothing else said otherwise."}
              </p>
            </>
          ) : (
            <>
              <h2 id="recording-heading">{IDLE_HEADING[state]}</h2>
              <p className="subtle">{IDLE_BLURB[state]}</p>
            </>
          )}

          <label className="hero-project">
            File my time under
            <select value={pinnedProject} onChange={(event) => void selectProject(event.target.value)}>
              <option value="">
                {defaultProject ? `Work it out for me (${defaultProject.name})` : "Work it out for me"}
              </option>
              {ready.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
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
        </section>

        {/* The main surface: the record card above, then where this session's
            time is going, and nothing else competing. Everything historical
            lives behind "All stats" at the bottom. */}
        <section className="session-stats card" aria-labelledby="session-stats-title">
          <div className="panel-head">
            <h2 id="session-stats-title">This session</h2>
            {current && (
              <span className="session-stats-total" data-testid="session-total">
                {formatDuration(elapsedSeconds(current.since, now))}
              </span>
            )}
          </div>
          {sessionRows.length === 0 ? (
            <p className="subtle" data-testid="session-stats-empty">{SESSION_EMPTY[state]}</p>
          ) : (
            <ul className="session-app-list" data-testid="session-app-list">
              {sessionRows.map((row) => (
                <li key={row.key} className="session-app-row">
                  <span className="session-app-name">
                    {row.source === undefined
                      ? <span className="app-mark is-plain" aria-hidden="true" />
                      : <AgentRuntimeIcon source={row.source} />}
                    {row.label}
                    {row.source !== undefined && monitorStatus?.agentActive?.source === row.source && (
                      <span className="app-active"> · working now</span>
                    )}
                  </span>
                  {/* Share of the session, so the split reads at a glance. */}
                  <span
                    className="session-app-bar"
                    aria-hidden="true"
                    style={{ "--share": `${row.share}%` } as React.CSSProperties}
                  />
                  <span className="session-app-duration">{formatCompact(row.durationSeconds)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Two different things that both involve a code, so each gets its own
            heading, its own sentence saying what it does, and one control.
            The old card put a bare code beside a "JOIN A TEAM" box and left
            you to work out which was which. */}
        {overview && (
          <section className="team-card card" aria-labelledby="team-title">
            <h2 id="team-title">Your team</h2>
            <p className="subtle">
              You are keeping time with <strong>{overview.organization.name}</strong>.
            </p>

            <div className="team-action">
              <h3>Invite someone</h3>
              <p className="subtle">Send them this code and they can join {overview.organization.name}.</p>
              <div className="team-code-row">
                <span className="team-code" data-testid="invite-code">{overview.organization.inviteCode}</span>
                <button className="outline-button" type="button" onClick={() => void copyInviteCode(overview.organization.inviteCode)}>
                  {inviteCopied ? "Copied" : "Copy code"}
                </button>
              </div>
            </div>

            <div className="team-action">
              <h3>Join a different team</h3>
              <p className="subtle">If someone sent you their code, paste it here to move to their team.</p>
              <form className="join-form" onSubmit={joinWorkspace}>
                <label className="team-join-label">
                  Their invite code
                  <input
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value)}
                    placeholder="ABCDE-FGHJK"
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
            </div>
          </section>
        )}

        <button
          className="all-stats-trigger"
          type="button"
          onClick={() => setAllStatsOpen(true)}
          data-testid="all-stats-trigger"
        >
          All stats
        </button>
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
            <h2 id="today-title">{statsRange === "today" ? "Today so far" : "This week"}</h2>
            <div className="range-toggle" role="group" aria-label="Date range">
              <button type="button" className={statsRange === "today" ? "is-active" : undefined} onClick={() => setStatsRange("today")}>Today</button>
              <button type="button" className={statsRange === "week" ? "is-active" : undefined} onClick={() => setStatsRange("week")}>This week</button>
            </div>
            <button className="outline-button modal-close" type="button" aria-label="Close all stats" onClick={() => setAllStatsOpen(false)}>✕</button>
          </div>
          {statsError && <p className="form-error" role="alert">{statsError}</p>}
          {stats === undefined ? (
            !statsError && <p className="subtle">Loading…</p>
          ) : (
            <>
              <p className="today-total"><strong>{formatCompact(stats.totalDurationSeconds)}</strong> recorded</p>
              {appRows.length === 0 ? (
                // Derived from the same state as the timer above it. Hard-coding
                // "turn on recording" here is what made one screen contradict
                // itself while recording was demonstrably on.
                <p className="subtle" data-testid="today-empty">{TODAY_EMPTY[state]}</p>
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
              {stats.unattributedSeconds > 0 && (
                <p className="verified-foot" data-testid="unattributed-foot">
                  {formatCompact(stats.unattributedSeconds)} of it landed in {defaultProject?.name ?? "your default project"},
                  because nothing said which project it was for.
                </p>
              )}
            </>
          )}

        {/* The workspace board is history too, so it belongs behind the same
            button rather than on the record surface. */}
        {overview && (
          <section className="board-panel" aria-labelledby="board-title">
            <div className="board-head">
              <h2 id="board-title">{overview.organization.name}</h2>
            </div>
            {overviewError && <p className="form-error" role="alert">{overviewError}</p>}
            {overview.entries.length === 0 ? (
              <p className="subtle">No recorded time yet.</p>
            ) : (
              <ol className="board-list">
                {overview.entries.slice(0, 5).map((entry) => (
                  <li key={entry.user.id} className={entry.user.id === ready.user.id ? "is-you" : undefined}>
                    <span className="board-rank">{entry.rank}</span>
                    <span className="board-name">
                      {entry.user.name}
                      {entry.user.id === ready.user.id && <span className="you-tag"> you</span>}
                    </span>
                    <span className="board-hours">{formatDuration(entry.durationSeconds)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
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
                <div className="mappings">
                  <h3>Folders and projects</h3>
                  <p className="subtle">Work your AI tools do in these folders is filed under the matching project.</p>
                  {mappings === undefined ? (
                    <p className="subtle">Loading…</p>
                  ) : mappings.length === 0 ? (
                    <p className="subtle">No folders yet.</p>
                  ) : (
                    <ul className="mapping-list">
                      {mappings.map((mapping) => (
                        <li key={mapping.id} className="mapping-row">
                          <span className="mapping-path" title={mapping.pathPrefix}>{mapping.pathPrefix}</span>
                          <span className="mapping-project">{ready.projects.find((item) => item.id === mapping.projectId)?.name ?? "Unknown project"}</span>
                          <button type="button" onClick={() => void deleteMapping(mapping.id)}>Delete</button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form className="mapping-form" onSubmit={addMapping}>
                    <label>
                      Folder
                      <input value={mappingPrefix} onChange={(event) => setMappingPrefix(event.target.value)} placeholder="C:/dev/project" spellCheck={false} autoComplete="off" required />
                    </label>
                    <label>
                      Project
                      <select value={mappingProjectId} onChange={(event) => setMappingProjectId(event.target.value)} required>
                        <option value="">Select project</option>
                        {ready.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                    <button className="signal-button" type="submit" disabled={mappingBusy}>{mappingBusy ? "Adding…" : "Add folder"}</button>
                  </form>
                </div>
                {monitorStatus !== undefined && monitorStatus.hooks.length > 0 && (
                  <div className="hooks-setup">
                    <h3>Watch my AI tools</h3>
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
                            <span className="hook-state">Connected</span>
                          ) : (
                            <button type="button" onClick={() => void registerHook(hook.source)}>Connect</button>
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
                    Clock-In notes when this computer was busy and which app was in front, by name. It never records
                    what you type, pictures of your screen, window titles, or web addresses. Turning recording off
                    stops all of it, and your earlier hours stay where they are.
                  </p>
                  <button className="outline-button privacy-open" type="button" onClick={() => setRecordingOpen(true)}>
                    See exactly what&apos;s recorded
                  </button>
                </div>
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
        onTurnOnRecording={() => void applyRecordingEnabled(true)}
        onConnectAgent={(source) => void registerHook(source)}
      />
    </main>
  );
};
