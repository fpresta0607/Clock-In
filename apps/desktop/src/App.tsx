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
  type AgentQuota,
  type QuotaSnapshot,
  type SessionApp,
  type SettingsPatch,
  type TimerBridge,
} from "./bridge.js";
import { AgentRuntimeIcon } from "./agent-icons.js";
import { QuotaDial } from "./QuotaDial.js";
import { agentRuntimeForBinary, formatDuration } from "@clock-in/shared";
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

/// Human-readable durations: "2 hr 14 min", "14 min", "32 sec".
const formatHuman = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  if (minutes > 0) return `${minutes} min`;
  return `${total} sec`;
};

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

type StatsRange = "today" | "week";

/// Local midnight today, or local midnight on Monday for "this week".
/// The range as instants on this computer's clock: "today" runs from local
/// midnight to the next one. Calendar dates would be read as a UTC day, which
/// rolls over in the afternoon anywhere west of Greenwich - the day's total
/// would reset hours before midnight and carry the previous evening's work.
const rangeBounds = (range: StatsRange): { fromAt: string; toExclusiveAt: string } => {
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
    const bounds = rangeBounds(statsRange);
    void service.meStats(bounds.fromAt, bounds.toExclusiveAt).then(
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
  }, [bridge, statsRange, signedIn?.user.id, statsTick]);

  // Agent plan quota, read from this machine. Advisory and never on the
  // critical path: a failure leaves the dials unknown rather than saying so.
  useEffect(() => {
    if (signedIn === undefined) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const read = (): void => {
      void service.quotaStatus().then(
        (snapshot) => {
          if (active && isCurrent(service, generation)) setQuota(snapshot);
        },
        () => undefined,
      );
    };
    read();
    const timer = window.setInterval(read, QUOTA_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
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
  const defaultProject = ready.projects.find((item) => item.id === ready.defaultProjectId);
  const backlog = monitorStatus === undefined
    ? 0
    : monitorStatus.segmentBacklog + monitorStatus.agentBacklog + monitorStatus.sessionBacklog;
  const appRows = stats === undefined ? [] : buildAppRows(stats.apps);
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
  // One row per running session - four terminals in one editor is an ordinary
  // day - named by the project its working directory resolved to.
  const agentRows = (monitorStatus?.agentSessions ?? []).map((session) => ({
    key: `agent-${session.source}-${session.externalSessionId}`,
    label: sourceLabel(session.source),
    detail: ready.projects.find((item) => item.id === session.projectId)?.name,
    source: session.source,
    processName: undefined,
    durationSeconds: elapsedSeconds(session.since, now),
    share: 0,
  }));
  const meterRows = [...agentRows, ...todayRows];
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
              <span className={`monitor-dot is-${state}`} aria-hidden="true" />
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
          {current ? (
            <>
              <h2 id="recording-heading" className="hero-title">At it since {new Date(current.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</h2>
              <output className="elapsed" data-testid="elapsed-time" aria-label="Time in this stretch of work">
                {formatDuration(elapsedSeconds(current.since, now))}
              </output>
              <p className="today-line" data-testid="today-line">
                <strong>{formatHuman(todayTotalSeconds)}</strong> so far today
              </p>
            </>
          ) : (
            <>
              <h2 id="recording-heading" className="hero-title">{IDLE_HEADING[state]}</h2>
              <p className="subtle">{IDLE_BLURB[state]}</p>
              {todayTotalSeconds > 0 && (
                <p className="today-line" data-testid="today-line">
                  <strong>{formatHuman(todayTotalSeconds)}</strong> so far today
                </p>
              )}
            </>
          )}
          {projectPickerOpen && (
            <>
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
            </>
          )}
        </section>

        {/* The main surface below the clock: where today's time went, grouped
            by the projects the monitor filed it under, then by app. Everything
            historical lives behind "All stats" at the bottom. */}
        <section className="session-stats card" aria-labelledby="today-panel-title">
          <div className="panel-head">
            <h2 id="today-panel-title">Today</h2>
          </div>
          {meterRows.length === 0 && projectRows.length === 0 ? (
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
                      <span className="meter-duration">{formatHuman(row.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              )}
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
              <p className="today-total"><strong>{formatHuman(stats.totalDurationSeconds)}</strong> recorded</p>
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
                      <span className="app-duration">{formatHuman(row.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {stats.unattributedSeconds > 0 && (
                <p className="verified-foot" data-testid="unattributed-foot">
                  {formatHuman(stats.unattributedSeconds)} of it landed in {defaultProject?.name ?? "your default project"},
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
                  <summary>Folders and projects</summary>
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
        onTurnOnRecording={() => void applyRecordingEnabled(true)}
        onConnectAgent={(source) => void registerHook(source)}
      />
    </main>
  );
};
