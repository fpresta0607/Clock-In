import { useEffect, useReducer, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  bridgeError,
  defaultBridge,
  type BrowserHealth,
  type MeStats,
  type MeStatsApp,
  type MonitorSettings,
  type MonitorStatus,
  type OrganizationOverview,
  type PathMapping,
  type SettingsPatch,
  type TallyEntry,
  type TimerBridge,
} from "./bridge.js";
import { formatDuration } from "@clock-in/shared";
import { narrowedPattern, planRule } from "./patterns.js";
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

const CALENDAR_TIME_ZONE_POLL_MS = 60_000;

/// Browser cards must flip to "connected" on their own while onboarding is on
/// screen, so that screen polls faster than the steady-state monitor poll.
const ONBOARDING_POLL_MS = 2_500;

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
  claude: "Claude",
  chatgpt: "ChatGPT",
  gmail: "Gmail",
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

type ActivityAppIconName = "agent" | "claude" | "chatgpt" | "gmail" | "browser" | "code" | "cursor" | "terminal" | "slack" | "design" | "notes" | "generic-web" | "generic-app";

const ACTIVITY_APP_ICONS: Record<string, ActivityAppIconName> = {
  claude: "claude",
  chatgpt: "chatgpt",
  gmail: "gmail",
  chrome: "browser",
  msedge: "browser",
  firefox: "browser",
  brave: "browser",
  arc: "browser",
  code: "code",
  cursor: "cursor",
  windowsterminal: "terminal",
  pwsh: "terminal",
  powershell: "terminal",
  cmd: "terminal",
  slack: "slack",
  figma: "design",
  notion: "notes",
  obsidian: "notes",
  webview2: "generic-web",
};

const AGENT_SOURCE_ICONS: Record<string, ActivityAppIconName> = {
  claude_code: "claude",
  cursor: "cursor",
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

const activityAppIcon = (processName: string): ActivityAppIconName =>
  ACTIVITY_APP_ICONS[processName.replace(/\.exe$/i, "").toLowerCase()] ?? "generic-app";

const ActivityAppIcon = ({ icon, label }: { icon: ActivityAppIconName; label: string }) => {
  const mark = (() => {
    switch (icon) {
      case "agent":
        return <><rect x="3" y="4" width="18" height="16" rx="3" fill="#4f46e5" /><path d="m8 9 3 3-3 3M13 15h3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></>;
      case "claude":
        return <><rect x="3" y="3" width="18" height="18" rx="5" fill="#d97706" /><path d="M15.5 8.5a4.5 4.5 0 1 0 0 7" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" /></>;
      case "chatgpt":
        return <><circle cx="12" cy="12" r="9" fill="#10a37f" /><path d="M12 6.5 15.8 8.7v4.5L12 15.5l-3.8-2.3V8.7L12 6.5Zm0 9V20M8.2 8.7 4.5 10.8m11.3-2.1 3.7 2.1" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>;
      case "gmail":
        return <><rect x="3" y="5" width="18" height="14" rx="2" fill="white" /><path d="m4 7 8 6 8-6M4 18V7l4.5 4M20 18V7l-4.5 4" fill="none" stroke="#ea4335" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>;
      case "browser":
        return <><circle cx="12" cy="12" r="9" fill="#fbbc05" /><path d="M12 3a9 9 0 0 1 7.8 4.5H12Z" fill="#ea4335" /><path d="M4.2 7.5 8.5 15l-2.2 3.8A9 9 0 0 1 4.2 7.5Z" fill="#34a853" /><circle cx="12" cy="12" r="4" fill="#4285f4" stroke="white" strokeWidth="1.4" /></>;
      case "code":
        return <><rect x="3" y="3" width="18" height="18" rx="4" fill="#2563eb" /><path d="m10 8-3 4 3 4M14 16l3-4-3-4M13 7l-2 10" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>;
      case "cursor":
        return <><rect x="3" y="3" width="18" height="18" rx="4" fill="#171717" /><path d="m8 6 8 6-4.2.8L10 17Z" fill="#f8fafc" stroke="#a3e635" strokeWidth="1.3" strokeLinejoin="round" /></>;
      case "terminal":
        return <><rect x="3" y="4" width="18" height="16" rx="3" fill="#334155" /><path d="m8 9 3 3-3 3M13 15h3" stroke="#a3e635" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></>;
      case "slack":
        return <><circle cx="9" cy="6.5" r="2" fill="#36c5f0" /><circle cx="17.5" cy="9" r="2" fill="#2eb67d" /><circle cx="15" cy="17.5" r="2" fill="#ecb22e" /><circle cx="6.5" cy="15" r="2" fill="#e01e5a" /><path d="M9 8.5v4M11.5 9h4M15 11.5v4M12.5 15H9" stroke="white" strokeWidth="1.5" strokeLinecap="round" /></>;
      case "design":
        return <><path d="M12 3v9H3a4.5 4.5 0 0 1 9-4.5V3Z" fill="#a259ff" /><path d="M12 3h4.5a4.5 4.5 0 0 1 0 9H12Z" fill="#f24e1e" /><path d="M3 12h9v9a4.5 4.5 0 0 1-9-4.5Z" fill="#0acf83" /><path d="M12 12h9v4.5a4.5 4.5 0 0 1-9 0Z" fill="#ff7262" /></>;
      case "notes":
        return <><rect x="4" y="3" width="16" height="18" rx="3" fill="#f8fafc" /><path d="M8 8h8M8 12h8M8 16h5" stroke="#64748b" strokeWidth="1.6" strokeLinecap="round" /></>;
      case "generic-web":
        return <><circle cx="12" cy="12" r="9" fill="#0ea5e9" /><path d="M3.5 12h17M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3C9.6 5.5 8.4 8.5 8.4 12s1.2 6.5 3.6 9" fill="none" stroke="white" strokeWidth="1.4" strokeLinecap="round" /></>;
      case "generic-app":
        return <><rect x="3" y="3" width="18" height="18" rx="5" fill="#64748b" /><circle cx="8.5" cy="8.5" r="1.4" fill="white" /><circle cx="15.5" cy="8.5" r="1.4" fill="white" /><circle cx="8.5" cy="15.5" r="1.4" fill="white" /><circle cx="15.5" cy="15.5" r="1.4" fill="white" /></>;
    }
  })();
  return <span className="app-icon" role="img" aria-label={`${label} icon`} data-icon={icon}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{mark}</svg></span>;
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

/// The site question's plain time figure: "3 hours", "45 minutes".
const siteTimeLabel = (seconds: number): string => {
  const hours = seconds / 3_600;
  if (hours >= 1) {
    const rounded = Math.max(1, Math.round(hours));
    return `${rounded} hour${rounded === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

type AppRow = {
  key: string;
  label: string;
  icon: ActivityAppIconName;
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
    rows.push({ key: app.processName, label: friendlyAppName(app.processName), icon: activityAppIcon(app.processName), durationSeconds: app.durationSeconds, agent: false });
  }
  if (agentSeconds > 0) {
    const sources = [...agentSources];
    rows.push({
      key: "agent-clis",
      label: sources.length === 1 ? sourceLabel(sources[0] ?? "") : "Agent CLIs",
      icon: sources.length === 1 ? AGENT_SOURCE_ICONS[sources[0] ?? ""] ?? "agent" : "agent",
      durationSeconds: agentSeconds,
      agent: true,
    });
  }
  rows.sort((a, b) => b.durationSeconds - a.durationSeconds || a.label.localeCompare(b.label));
  if (rows.length <= TOP_APP_ROWS) return rows;
  const rest = rows.slice(TOP_APP_ROWS).reduce((sum, row) => sum + row.durationSeconds, 0);
  return [...rows.slice(0, TOP_APP_ROWS), { key: "everything-else", label: "Everything else", icon: "generic-app", durationSeconds: rest, agent: false }];
};

export type StatsRange = "today" | "week";

export const statsRangeBounds = (range: StatsRange, now = new Date()): { fromAt: string; toExclusiveAt: string } => {
  const start = new Date(now);
  if (range === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  const toExclusive = new Date(now);
  toExclusive.setHours(0, 0, 0, 0);
  toExclusive.setDate(toExclusive.getDate() + 1);
  return { fromAt: start.toISOString(), toExclusiveAt: toExclusive.toISOString() };
};

export const nextLocalCalendarBoundaryAt = (now = new Date()): number => {
  const next = new Date(now);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + 1);
  return next.getTime();
};

const localTimeZone = (): string | undefined => Intl.DateTimeFormat().resolvedOptions().timeZone;

type BrowserCardProps = {
  health: BrowserHealth;
  busy: boolean;
  error?: string | undefined;
  onRepair: (browser: string) => void;
  onConnect: (browser: string) => void;
};

/// One browser's connection state as a single plain sentence plus at most one
/// button: connected states itself, a registered browser offers the store
/// page, disabled browsers state the release prerequisite, and anything broken
/// offers [Fix]. Shared by onboarding and settings.
const BrowserCard = ({ health, busy, error, onRepair, onConnect }: BrowserCardProps) => (
  <div className="browser-card">
    <p className="browser-name">{health.label}</p>
    {health.state === "connected" ? (
      <p className="browser-status is-connected">{health.label} is connected ✓</p>
    ) : health.state === "disabled" ? (
      <p className="subtle">Browser attribution is unavailable until its verified extension is released.</p>
    ) : health.state === "registered" ? (
      <>
        <p className="subtle">This opens the {health.label} extension page. Click Add to {health.label} there.</p>
        <button className="signal-button" type="button" disabled={busy} onClick={() => onConnect(health.browser)}>
          {busy ? "Opening…" : `Connect ${health.label}`}
        </button>
      </>
    ) : (
      <>
        <p className="subtle">The {health.label} connection needs a quick repair.</p>
        <button className="outline-button" type="button" disabled={busy} onClick={() => onRepair(health.browser)}>
          {busy ? "Fixing…" : "Fix"}
        </button>
      </>
    )}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>
);

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
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState<string | undefined>();
  const [switchBusy, setSwitchBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [retryPendingBusy, setRetryPendingBusy] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsRange, setStatsRange] = useState<StatsRange>("today");
  const [statsCalendarVersion, setStatsCalendarVersion] = useState(0);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [stats, setStats] = useState<MeStats | undefined>();
  const [statsError, setStatsError] = useState<string | undefined>();
  const [confirmedStops, setConfirmedStops] = useState(0);
  const [settings, setSettings] = useState<MonitorSettings | undefined>();
  /// A failed first settings read must not strand a fresh install on the boot
  /// screen: fail open to the main screen, and the overlay retries on open.
  const [settingsUnavailable, setSettingsUnavailable] = useState(false);
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const [awayThresholdDraft, setAwayThresholdDraft] = useState("");
  const [hardLimitDraft, setHardLimitDraft] = useState("");
  const [mappings, setMappings] = useState<readonly PathMapping[] | undefined>();
  const [mappingPrefix, setMappingPrefix] = useState("");
  const [mappingProjectId, setMappingProjectId] = useState("");
  const [mappingBusy, setMappingBusy] = useState(false);
  /// Raw site-rule add form behind the Advanced disclosure.
  const [rulePattern, setRulePattern] = useState("");
  const [ruleProjectId, setRuleProjectId] = useState("");
  const [ruleBusy, setRuleBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /// First-run flow: "monitor" asks the one tracking question, "browsers"
  /// shows one card per detected browser. Plain component state; onboarding
  /// is gated on `settings.onboarded`, not the reducer.
  const [onboardingStep, setOnboardingStep] = useState<"monitor" | "browsers">("monitor");
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | undefined>();
  /// The browser key currently repairing/connecting, and per-browser action
  /// errors shown as one sentence inside the card.
  const [browserBusy, setBrowserBusy] = useState<string | undefined>();
  const [browserErrors, setBrowserErrors] = useState<Readonly<Record<string, string>>>({});
  /// Local site tally from `suggestionsList`; answered origins are removed
  /// locally so the next entry shows on the next poll.
  const [suggestions, setSuggestions] = useState<readonly TallyEntry[]>([]);
  const [answeredOrigins, setAnsweredOrigins] = useState<readonly string[]>([]);
  const [siteProjectId, setSiteProjectId] = useState("");
  const [siteNarrowing, setSiteNarrowing] = useState(false);
  const [siteNarrowingOrigin, setSiteNarrowingOrigin] = useState<string | undefined>();
  const [siteSegment, setSiteSegment] = useState("");
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteError, setSiteError] = useState<string | undefined>();
  const [clearAnswersBusy, setClearAnswersBusy] = useState(false);
  const [clearAnswersMessage, setClearAnswersMessage] = useState<string | undefined>();
  /// Manual hook-setup snippets returned by `hookRegister`, keyed by CLI source.
  const [hookSnippets, setHookSnippets] = useState<Readonly<Record<string, string>>>({});
  const latestBridge = useRef(bridge);
  const bootstrapRequests = useRef(new WeakMap<TimerBridge, Promise<BootstrapSnapshot>>());
  const recoveryRequests = useRef(new WeakMap<TimerBridge, Map<string, Promise<BootstrapSnapshot>>>());
  const mounted = useRef(true);
  const bridgeGeneration = useRef(0);
  const accountEpoch = useRef(0);
  const currentAccountId = useRef<string | undefined>(undefined);
  const suggestedOrigin = suggestions.find((entry) => !answeredOrigins.includes(entry.origin))?.origin;
  const snapshotProjects = state.kind === "booting" || state.kind === "sign-in" ? [] : state.projects;
  const snapshotSelectedProjectId = state.kind === "booting" || state.kind === "sign-in"
    ? null
    : state.selectedProjectId;

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
    setNewProjectOpen(false);
    setNewProjectName("");
    setNewProjectError(undefined);
    setSwitchBusy(false);
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
    setSettingsUnavailable(false);
    setSettingsError(undefined);
    setMappings(undefined);
    setMappingPrefix("");
    setMappingProjectId("");
    setRulePattern("");
    setRuleProjectId("");
    setAdvancedOpen(false);
    setOnboardingStep("monitor");
    setOnboardingBusy(false);
    setOnboardingError(undefined);
    setBrowserBusy(undefined);
    setBrowserErrors({});
    setSuggestions([]);
    setAnsweredOrigins([]);
    setSiteProjectId("");
    setSiteNarrowing(false);
    setSiteNarrowingOrigin(undefined);
    setSiteSegment("");
    setSiteError(undefined);
    setClearAnswersMessage(undefined);
    setHookSnippets({});
    setSettingsOpen(false);
    if (clearEmail) setEmail("");
  };

  const applyAccountFields = (
    snapshot: Exclude<BootstrapSnapshot, { kind: "signed-out" }>,
    clearWorkspace = false,
  ): void => {
    if (clearWorkspace || currentAccountId.current !== snapshot.user.id) {
      clearAccountFields();
      setWorkspaceVersion((version) => version + 1);
    }
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
    clearWorkspace = false,
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
    applyAccountFields(snapshot, clearWorkspace);
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
        if (problem.kind === "auth") {
          resetToSignIn(problem.message);
          return;
        }
        dispatch({ type: "bootstrap-failed", message: problem.message });
      },
    );
    return () => { active = false; };
  }, [bridge]);

  useEffect(() => {
    setAuthBusy(false);
    setRetryPendingBusy(false);
    setConflictBusy(false);
    setLogoutBusy(false);
    setNewProjectBusy(false);
    setSwitchBusy(false);
  }, [bridge]);

  // Suggestion polling can reorder the tally while the narrowing question is
  // open. Never carry a segment typed for one origin into the next origin.
  useEffect(() => {
    setSiteNarrowing(false);
    setSiteNarrowingOrigin(undefined);
    setSiteSegment("");
    setSiteError(undefined);
  }, [suggestedOrigin]);

  useEffect(() => {
    if (state.kind !== "running") return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state.kind]);

  useEffect(() => {
    const preferred = snapshotSelectedProjectId
      ?? snapshotProjects.find((project) => project.isDefault === true)?.id
      ?? snapshotProjects[0]?.id
      ?? "";
    setProjectId((current) => snapshotProjects.some((project) => project.id === current) ? current : preferred);
  }, [snapshotProjects, snapshotSelectedProjectId]);

  useEffect(() => {
    if (state.kind === "booting" || state.kind === "sign-in") return undefined;
    let timeZone = localTimeZone();
    let boundaryTimer: number | undefined;
    const refresh = (): void => setStatsCalendarVersion((version) => version + 1);
    const scheduleBoundary = (): void => {
      if (boundaryTimer !== undefined) window.clearTimeout(boundaryTimer);
      boundaryTimer = window.setTimeout(() => {
        refresh();
        scheduleBoundary();
      }, Math.max(1, nextLocalCalendarBoundaryAt() - Date.now()));
    };
    const refreshForTimeZoneChange = (): void => {
      const nextTimeZone = localTimeZone();
      if (nextTimeZone !== timeZone) {
        timeZone = nextTimeZone;
        refresh();
        scheduleBoundary();
      }
    };
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === "visible") refreshForTimeZoneChange();
    };
    scheduleBoundary();
    const timeZoneTimer = window.setInterval(refreshForTimeZoneChange, CALENDAR_TIME_ZONE_POLL_MS);
    window.addEventListener("focus", refreshForTimeZoneChange);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      if (boundaryTimer !== undefined) window.clearTimeout(boundaryTimer);
      window.clearInterval(timeZoneTimer);
      window.removeEventListener("focus", refreshForTimeZoneChange);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [state.kind === "booting" || state.kind === "sign-in"]);

  // The team board lives in settings now, so it loads with the overlay. A
  // failed read only blanks the team section, never the timer.
  useEffect(() => {
    if (state.kind === "booting" || state.kind === "sign-in") return undefined;
    if (!settingsOpen) return undefined;
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
        if (problem.kind !== "auth") setOverviewError(problem.message);
      },
    );
    return () => { active = false; };
  }, [bridge, settingsOpen, confirmedStops, workspaceVersion, state.kind === "booting" || state.kind === "sign-in"]);

  // The Today card is always on screen, so stats load with the account and
  // refresh on the same transitions as the board (a stopped timer changes
  // today's total) plus whenever the range switches.
  useEffect(() => {
    if (state.kind === "booting" || state.kind === "sign-in") return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const bounds = statsRangeBounds(statsRange);
    void service.meStats(bounds.fromAt, bounds.toExclusiveAt).then(
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
  }, [bridge, statsRange, statsCalendarVersion, workspaceVersion, confirmedStops, state.kind === "idle", state.kind === "booting" || state.kind === "sign-in"]);

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
      // The local site tally rides the same cadence; failures leave the
      // question hidden rather than noisy, same as the status poll.
      void service.suggestionsList().then(
        (entries) => {
          if (active && isCurrent(service, generation, epoch)) setSuggestions(entries);
        },
        () => undefined,
      );
    };
    poll();
    const timer = window.setInterval(poll, MONITOR_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [bridge, state, workspaceVersion]);

  // Settings load with the account, not just with the overlay: the first-run
  // flow keys off `onboarded`, so a fresh install must know before the main
  // screen settles. A failure leaves the main screen up (fail-open); the
  // overlay retries on open.
  useEffect(() => {
    if (state.kind === "booting" || state.kind === "sign-in") return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    void service.settingsGet().then(
      (result) => {
        if (!active || !isCurrent(service, generation, epoch)) return;
        setSettings(result);
        setAwayThresholdDraft(String(result.awayThresholdMinutes));
        setHardLimitDraft(String(result.hardAwayLimitMinutes));
      },
      () => {
        if (active && isCurrent(service, generation, epoch)) setSettingsUnavailable(true);
      },
    );
    return () => { active = false; };
  }, [bridge, workspaceVersion, state.kind === "booting" || state.kind === "sign-in"]);

  const onboardingActive = settings !== undefined
    && !settings.onboarded
    && state.kind !== "booting"
    && state.kind !== "sign-in";

  // While onboarding shows the browser cards, poll fast so a card flips to
  // connected on its own the moment the extension handshake lands.
  useEffect(() => {
    if (!onboardingActive) return undefined;
    let active = true;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const poll = (): void => {
      void service.monitorStatus().then(
        (status) => {
          if (active && isCurrent(service, generation, epoch)) setMonitorStatus(status);
        },
        () => undefined,
      );
    };
    poll();
    const timer = window.setInterval(poll, ONBOARDING_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [bridge, onboardingActive]);

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
  }, [bridge, settingsOpen, workspaceVersion]);

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

  /// Creates a project from the start form, then re-bootstraps so the picker
  /// gains it everywhere (idle form, running hero, mapping form) from one
  /// authoritative account read. The new project is preselected on success.
  const createProject = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (newProjectBusy || name === "") return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setNewProjectBusy(true);
    setNewProjectError(undefined);
    try {
      const created = await service.projectCreate({ name });
      if (!isRequestCurrent()) return;
      const request = service.bootstrap();
      bootstrapRequests.current.set(service, request);
      const snapshot = await request;
      if (!isRequestCurrent()) return;
      await applySnapshot(snapshot, service, () => isCurrent(service, generation), epoch);
      if (!isRequestCurrent()) return;
      setProjectId(created.id);
      setNewProjectName("");
      setNewProjectOpen(false);
    } catch (error: unknown) {
      if (isRequestCurrent()) setNewProjectError(bridgeError(error).message);
    } finally {
      if (isRequestCurrent()) setNewProjectBusy(false);
    }
  };

  /// One-click project switch while running: stop the current session, then
  /// start a fresh one on the picked project. A failed stop aborts the switch
  /// and lands on the same error surface as a manual stop.
  const switchProject = async (nextProjectId: string): Promise<void> => {
    if (state.kind !== "running" || switchBusy) return;
    if (nextProjectId === state.running.projectId || !state.projects.some((project) => project.id === nextProjectId)) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setSwitchBusy(true);
    const stopInput = {
      sessionId: state.running.sessionId,
      stoppedAt: new Date().toISOString(),
      idleSeconds: stopIdleSeconds(state.away, monitorStatus?.sessionIdleSeconds),
    };
    dispatch({ type: "stop-requested", stoppedAt: stopInput.stoppedAt });
    try {
      await service.stop(stopInput);
    } catch (error: unknown) {
      if (isRequestCurrent()) {
        const problem = bridgeError(error);
        if (problem.kind === "auth") resetToSignIn(problem.message);
        else if (problem.kind === "transient") dispatch({ type: "stop-pending", message: problem.message });
        else dispatch({ type: "stop-failed", message: problem.message });
        setSwitchBusy(false);
      }
      return;
    }
    if (!isRequestCurrent()) return;
    dispatch({ type: "stop-confirmed" });
    setConfirmedStops((count) => count + 1);
    const start: StartIntent = {
      clientId: crypto.randomUUID(),
      projectId: nextProjectId,
      description: "",
      startedAt: new Date().toISOString(),
    };
    dispatch({ type: "start-requested", start });
    setDescription("");
    try {
      const running = await service.start(start);
      if (isRequestCurrent()) dispatch({ type: "start-confirmed", running });
    } catch (error: unknown) {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      if (problem.kind === "auth") resetToSignIn(problem.message);
      else dispatch({ type: "start-failed", message: problem.message });
    } finally {
      if (isRequestCurrent()) setSwitchBusy(false);
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
      if (isRequestCurrent()) {
        dispatch({ type: "stop-confirmed" });
        setConfirmedStops((count) => count + 1);
      }
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

  /// Raw site-rule add form behind the Advanced disclosure; answers to site
  /// questions create the same rows through `createSiteRule` below.
  const addRule = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (ruleBusy || ruleProjectId === "") return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setRuleBusy(true);
    setSettingsError(undefined);
    try {
      const created = await service.pathMappingsCreate({ kind: "url_rule", pathPrefix: rulePattern.trim(), projectId: ruleProjectId });
      if (isRequestCurrent()) {
        setMappings((current) => [...(current ?? []), created]);
        setRulePattern("");
      }
    } catch (error: unknown) {
      if (isRequestCurrent()) setSettingsError(bridgeError(error).message);
    } finally {
      if (isRequestCurrent()) setRuleBusy(false);
    }
  };

  const turnOnMonitoring = async (): Promise<void> => {
    if (onboardingBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setOnboardingBusy(true);
    setOnboardingError(undefined);
    try {
      const next = await service.monitorSetEnabled(true);
      if (!isRequestCurrent()) return;
      setSettings(next);
      setOnboardingStep("browsers");
      // Seed the browser cards immediately; the fast poll keeps them current.
      try {
        const status = await service.monitorStatus();
        if (isRequestCurrent()) setMonitorStatus(status);
      } catch {
        // The fast poll retries; a missing first read is not worth an error.
      }
    } catch (error: unknown) {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      // Same contract as every sibling handler: an expired session goes back
      // to sign-in rather than stranding the user on the question screen.
      if (problem.kind === "auth") resetToSignIn(problem.message);
      else setOnboardingError(problem.message);
    } finally {
      if (isRequestCurrent()) setOnboardingBusy(false);
    }
  };

  const finishOnboarding = async (): Promise<void> => {
    if (onboardingBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setOnboardingBusy(true);
    setOnboardingError(undefined);
    try {
      const next = await service.settingsUpdate({ onboarded: true });
      if (isRequestCurrent()) setSettings(next);
    } catch (error: unknown) {
      if (!isRequestCurrent()) return;
      const problem = bridgeError(error);
      if (problem.kind === "auth") resetToSignIn(problem.message);
      else setOnboardingError(problem.message);
    } finally {
      if (isRequestCurrent()) setOnboardingBusy(false);
    }
  };

  const repairBrowser = async (browser: string): Promise<void> => {
    if (browserBusy !== undefined) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setBrowserBusy(browser);
    setBrowserErrors((current) => {
      if (!(browser in current)) return current;
      const next = { ...current };
      delete next[browser];
      return next;
    });
    try {
      const health = await service.browserRepair(browser);
      if (isRequestCurrent()) {
        // The repaired health replaces the card's state without waiting for a poll.
        setMonitorStatus((current) => current === undefined
          ? current
          : { ...current, browsers: current.browsers.map((item) => item.browser === browser ? health : item) });
      }
    } catch (error: unknown) {
      if (isRequestCurrent()) setBrowserErrors((current) => ({ ...current, [browser]: bridgeError(error).message }));
    } finally {
      if (isRequestCurrent()) setBrowserBusy(undefined);
    }
  };

  const connectBrowser = async (browser: string): Promise<void> => {
    if (browserBusy !== undefined) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setBrowserBusy(browser);
    setBrowserErrors((current) => {
      if (!(browser in current)) return current;
      const next = { ...current };
      delete next[browser];
      return next;
    });
    try {
      await service.browserOpenStorePage(browser);
    } catch (error: unknown) {
      if (isRequestCurrent()) setBrowserErrors((current) => ({ ...current, [browser]: bridgeError(error).message }));
    } finally {
      if (isRequestCurrent()) setBrowserBusy(undefined);
    }
  };

  /// A "Yes" answer creates the URL rule and drops the origin from the local
  /// list; the next poll then shows the following entry, if any.
  const createSiteRule = async (origin: string, pattern: string, chosenProjectId: string): Promise<void> => {
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setSiteBusy(true);
    setSiteError(undefined);
    try {
      const created = await service.pathMappingsCreate({ kind: "url_rule", pathPrefix: pattern, projectId: chosenProjectId });
      if (!isRequestCurrent()) return;
      setMappings((current) => current === undefined ? current : [...current, created]);
      setAnsweredOrigins((current) => [...current, origin]);
      setSiteNarrowing(false);
      setSiteNarrowingOrigin(undefined);
      setSiteSegment("");
    } catch (error: unknown) {
      if (isRequestCurrent()) setSiteError(bridgeError(error).message);
    } finally {
      if (isRequestCurrent()) setSiteBusy(false);
    }
  };

  const answerSiteYes = async (origin: string, chosenProjectId: string): Promise<void> => {
    if (siteBusy || chosenProjectId === "") return;
    const plan = planRule(origin);
    if (plan === null) {
      setSiteError("That site address could not be turned into a rule.");
      return;
    }
    if (plan.kind === "path-narrowed") {
      // One site spans many projects here; ask which part before ruling.
      setSiteNarrowing(true);
      setSiteNarrowingOrigin(origin);
      setSiteSegment("");
      setSiteError(undefined);
      return;
    }
    await createSiteRule(origin, plan.pattern, chosenProjectId);
  };

  const submitNarrowedSite = async (event: React.FormEvent<HTMLFormElement>, origin: string, chosenProjectId: string): Promise<void> => {
    event.preventDefault();
    if (siteBusy) return;
    const pattern = narrowedPattern(origin, siteSegment);
    if (pattern === null) {
      setSiteError("Use only letters, numbers, and hyphens - like the name in the site's address.");
      return;
    }
    await createSiteRule(origin, pattern, chosenProjectId);
  };

  const answerSiteNo = async (origin: string): Promise<void> => {
    if (siteBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setSiteBusy(true);
    setSiteError(undefined);
    try {
      await service.suggestionNeverSuggest(origin);
      if (!isRequestCurrent()) return;
      setAnsweredOrigins((current) => [...current, origin]);
      setSiteNarrowing(false);
      setSiteNarrowingOrigin(undefined);
      setSiteSegment("");
    } catch (error: unknown) {
      if (isRequestCurrent()) setSiteError(bridgeError(error).message);
    } finally {
      if (isRequestCurrent()) setSiteBusy(false);
    }
  };

  const clearSiteAnswers = async (): Promise<void> => {
    if (clearAnswersBusy) return;
    const service = bridge;
    const generation = bridgeGeneration.current;
    const epoch = accountEpoch.current;
    const isRequestCurrent = (): boolean => isCurrent(service, generation, epoch);
    setClearAnswersBusy(true);
    setClearAnswersMessage(undefined);
    setSettingsError(undefined);
    try {
      await service.suggestionsClear();
      if (!isRequestCurrent()) return;
      setSuggestions([]);
      setAnsweredOrigins([]);
      setClearAnswersMessage("Cleared - Clock-In will ask about sites again as you use them.");
    } catch (error: unknown) {
      if (isRequestCurrent()) setSettingsError(bridgeError(error).message);
    } finally {
      if (isRequestCurrent()) setClearAnswersBusy(false);
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
        const snapshot = await service.bootstrap();
        if (!isRequestCurrent()) return;
        const workspaceEpoch = await applySnapshot(snapshot, service, () => isCurrent(service, generation), epoch, true, true);
        if (workspaceEpoch === undefined || !isCurrent(service, generation, workspaceEpoch)) return;
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
        <div className="center-stage" aria-busy={state.error === undefined}>
          <p className="boot-message" role="status">{state.error ?? "Connecting to clock service…"}</p>
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
                : "Sign in with the same email and password as the dashboard."}
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

  // A fresh install must not flash the main screen before the first-run flow
  // knows whether to appear; a failed settings read fails open instead.
  if (settings === undefined && !settingsUnavailable) {
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

  // First run: two screens replace the main screen until `onboarded` is set.
  // Screen 1 is one question and one button; screen 2 is one card per browser
  // plus the finish button. Nothing else.
  if (onboardingActive) {
    const browsers = monitorStatus?.browsers;
    return (
      <main className="app-shell onboarding">
        <WebGLShader />
        <Titlebar />
        <div className="center-stage">
          {onboardingStep === "monitor" ? (
            <section className="card onboarding-panel" aria-labelledby="onboarding-title">
              <h1 id="onboarding-title">Track your work time on this computer?</h1>
              {onboardingError && <p className="form-error" role="alert">{onboardingError}</p>}
              <button className="signal-button" type="button" disabled={onboardingBusy} onClick={() => void turnOnMonitoring()}>
                {onboardingBusy ? "Turning on…" : "Turn on"}
              </button>
              <button className="link-button" type="button" disabled={onboardingBusy} onClick={() => void finishOnboarding()}>
                Skip for now
              </button>
            </section>
          ) : (
            <section className="card onboarding-panel" aria-labelledby="onboarding-browsers-title">
              <h1 id="onboarding-browsers-title">Connect your browser</h1>
              {browsers === undefined ? (
                <p className="subtle" role="status">Checking for browsers...</p>
              ) : browsers.length === 0 ? (
                <p className="subtle">No supported browser found on this computer - you can connect one later from Settings.</p>
              ) : (
                <div className="browser-list">
                  {browsers.map((health) => (
                    <BrowserCard
                      key={health.browser}
                      health={health}
                      busy={browserBusy === health.browser}
                      error={browserErrors[health.browser]}
                      onRepair={(browser) => void repairBrowser(browser)}
                      onConnect={(browser) => void connectBrowser(browser)}
                    />
                  ))}
                </div>
              )}
              {onboardingError && <p className="form-error" role="alert">{onboardingError}</p>}
              <button className="signal-button" type="button" disabled={onboardingBusy} onClick={() => void finishOnboarding()}>
                {onboardingBusy ? "Saving…" : "Start using Clock-In"}
              </button>
            </section>
          )}
          <button
            className="link-button onboarding-sign-out"
            type="button"
            disabled={logoutBusy}
            onClick={() => void logout()}
          >
            {logoutBusy ? "Signing out…" : "Sign out"}
          </button>
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
  // One site question at a time, and only while no other prompt card is up.
  const siteSuggestion = awayPrompt === undefined && suggestion === undefined
    ? suggestions.find((entry) => entry.origin === suggestedOrigin)
    : undefined;
  const siteChoice = siteProjectId !== ""
    ? siteProjectId
    : hasSelectedProject ? projectId : account.projects[0]?.id ?? "";
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
            {monitorState === "on" ? "Tracking is on" : monitorState === "paused" ? "Monitoring paused" : "Monitoring off"}
          </p>
        )}
        {accountError && !settingsOpen && <p className="form-error" role="alert">{accountError}</p>}

        {awayPrompt && (
          <div className="prompt-card card">
            <p className="eyebrow">Away</p>
            <p>You were away {Math.max(1, Math.round(awayPrompt.seconds / 60))} minutes. Count that time?</p>
            <div className="prompt-actions">
              <button className="signal-button" type="button" onClick={() => answerAway("keep")}>Yes</button>
              <button className="outline-button" type="button" onClick={() => answerAway("discard")}>No</button>
            </div>
          </div>
        )}
        {suggestion && (
          <div className="prompt-card card">
            <p className="eyebrow">Suggested start</p>
            {suggestion.source === "browser" ? (
              <p>Working on <strong>{suggestedProject?.name ?? "the mapped project"}</strong>?</p>
            ) : (
              <p>{sourceLabel(suggestion.source)} active - start tracking <strong>{suggestedProject?.name ?? "the mapped project"}</strong>?</p>
            )}
            <div className="prompt-actions">
              {suggestedProject && (
                <button className="signal-button" type="button" onClick={() => void startTimer(suggestion.projectId)}>
                  {suggestion.source === "browser" ? "Start timer" : "Start"}
                </button>
              )}
              <button className="outline-button" type="button" onClick={() => void dismissSuggestion()}>
                {suggestion.source === "browser" ? "Not now" : "Dismiss"}
              </button>
            </div>
          </div>
        )}
        {siteSuggestion && state.kind === "idle" && (
          <div className="prompt-card card site-card">
            <p className="eyebrow">New site</p>
            <p>You spent {siteTimeLabel(siteSuggestion.seconds)} on {siteSuggestion.origin} this week. Is that work?</p>
            {siteError && <p className="form-error" role="alert">{siteError}</p>}
            {siteNarrowing && siteNarrowingOrigin === siteSuggestion.origin ? (
              <form className="site-narrow-form" onSubmit={(event) => void submitNarrowedSite(event, siteSuggestion.origin, siteChoice)}>
                <label>Organization or team name
                  <input value={siteSegment} onChange={(event) => setSiteSegment(event.target.value)} autoComplete="off" spellCheck={false} required />
                </label>
                <div className="prompt-actions">
                  <button className="signal-button" type="submit" disabled={siteBusy}>{siteBusy ? "Saving…" : "Yes, track it"}</button>
                  <button className="outline-button" type="button" disabled={siteBusy} onClick={() => { setSiteNarrowing(false); setSiteNarrowingOrigin(undefined); setSiteSegment(""); setSiteError(undefined); }}>Back</button>
                </div>
              </form>
            ) : (
              <>
                <label className="site-project">Yes, for
                  <select aria-label="Project for this site" value={siteChoice} onChange={(event) => setSiteProjectId(event.target.value)}>
                    {account.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <div className="prompt-actions">
                  <button className="signal-button" type="button" disabled={siteBusy || siteChoice === ""} onClick={() => void answerSiteYes(siteSuggestion.origin, siteChoice)}>
                    {siteBusy ? "Saving…" : "Yes"}
                  </button>
                  <button className="outline-button" type="button" disabled={siteBusy} onClick={() => void answerSiteNo(siteSuggestion.origin)}>
                    No - don&apos;t ask again
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {state.kind === "conflict" ? (
          <section className="hero card conflict-panel" aria-labelledby="conflict-title">
            <h2 id="conflict-title">We found two timers - pick one to keep</h2>
            <p>Your device recorded <strong>{state.localStart.description || "a local start"}</strong>; the service has an active timer. Neither record has been discarded.</p>
            {state.error && <p role="alert" className="form-error">{state.error}</p>}
            <div className="action-stack">
              <button className="signal-button" type="button" disabled={conflictBusy} onClick={() => void recover("server")}>{conflictBusy ? "Resolving…" : "Use server timer"}</button>
              <button className="outline-button" type="button" disabled={conflictBusy} onClick={() => void recover("local")}>Retry local start</button>
            </div>
          </section>
        ) : activeRunning ? (
          <section className="hero card running-panel" aria-label="Running timer">
            <p className="eyebrow">Working on: {project?.name ?? "General Work"}</p>
            <output className="elapsed" data-testid="elapsed-time" aria-label="Elapsed time">{formatDuration(elapsedSeconds(activeRunning.startedAt, elapsedAt))}</output>
            <p className="started-at">since {new Date(activeRunning.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
            {monitorStatus?.enabled && monitorStatus.sessionIdleSeconds !== null && (
              <p className="session-meta" data-testid="idle-trimmed">Idle trimmed so far {formatDuration(monitorStatus.sessionIdleSeconds)}</p>
            )}
            {monitorStatus?.enabled && monitorStatus.agentActive && (
              <p className="session-meta agent-active" data-testid="agent-active">
                {sourceLabel(monitorStatus.agentActive.source)} active - idle trim paused
              </p>
            )}
            {state.kind === "running" && state.error && <p className="form-error" role="alert">{state.error}</p>}
            {awayDecision && (
              <p className="session-meta">{awayDecision === "keep" ? "Away time kept - it stays on the timer." : "Away time will be trimmed at stop."}</p>
            )}
            <label className="hero-project">Move this time to....
              <select
                value={activeRunning.projectId}
                disabled={state.kind === "stopping" || switchBusy}
                onChange={(event) => void switchProject(event.target.value)}
              >
                {account.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <button className="stop-button" type="button" disabled={state.kind === "stopping"} onClick={() => void stopTimer()}>{state.kind === "stopping" ? "Stopping…" : "Pause tracking"}</button>
          </section>
        ) : (
          <section className="hero card idle-panel" aria-labelledby="timer-title">
            <h2 id="timer-title">Working on: {account.projects.find((item) => item.id === projectId)?.name ?? "General Work"}</h2>
            {state.kind === "idle" && state.error && <p className="form-error" role="alert">{state.error}</p>}
            {state.kind === "pending-sync" && <><div className="sync-banner" role="status"><span>{state.message}</span><button type="button" disabled={retryPendingBusy} onClick={() => void retryPending()}>{retryPendingBusy ? "Retrying…" : "Retry sync"}</button></div>{state.error && <p className="form-error" role="alert">{state.error}</p>}</>}
            <label>Change project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{account.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
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
            <label className="description-field">Description <span className="optional">optional</span><input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} placeholder="One line, if it helps" /></label>
            <div className="entry-foot"><button className="signal-button" type="button" disabled={state.kind === "starting" || state.kind === "pending-sync" || !hasSelectedProject} onClick={() => void startTimer()}>{state.kind === "starting" ? "Starting…" : "Start timer"}</button></div>
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
                        <ActivityAppIcon icon={row.icon} label={row.label} />
                        <span className="app-label">
                          {row.label}
                          {row.agent && monitorStatus?.agentActive && <span className="app-active"> · active now</span>}
                        </span>
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
                  <label className="toggle-row">
                    <span>Stop the timer when the machine locks</span>
                    <input type="checkbox" checked={settings.autoStopOnLock} onChange={(event) => void applySettings({ autoStopOnLock: event.target.checked })} />
                  </label>
                  <label className="toggle-row">
                    <span>Count agent sessions as work while I&apos;m away</span>
                    <input type="checkbox" checked={settings.agentOverrideEnabled} onChange={(event) => void applySettings({ agentOverrideEnabled: event.target.checked })} />
                  </label>
                </div>

                {monitorStatus !== undefined && monitorStatus.browsers.length > 0 && (
                  <div className="browsers-setup">
                    <h3>Browsers</h3>
                    <div className="browser-list">
                      {monitorStatus.browsers.map((health) => (
                        <BrowserCard
                          key={health.browser}
                          health={health}
                          busy={browserBusy === health.browser}
                          error={browserErrors[health.browser]}
                          onRepair={(browser) => void repairBrowser(browser)}
                          onConnect={(browser) => void connectBrowser(browser)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div className="team-setup">
                  <h3>Your team</h3>
                  {overview === undefined ? (
                    overviewError
                      ? <p className="form-error" role="alert">{overviewError}</p>
                      : <p className="subtle">Loading…</p>
                  ) : (
                    <>
                      <p className="team-line">
                        <strong>{overview.organization.name}</strong>
                        {" · invite code "}
                        <span className="invite-code" title="Share this code so teammates join this workspace">{overview.organization.inviteCode}</span>
                      </p>
                      {overviewError && <p className="form-error" role="alert">{overviewError}</p>}
                      <form className="join-form" onSubmit={joinWorkspace}>
                        <label>
                          <span className="visually-hidden">Invite code to join a teammate</span>
                          <input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="Join a team: ABCDE-FGHJK" autoComplete="off" spellCheck={false} required />
                        </label>
                        <button type="submit" disabled={joinBusy}>{joinBusy ? "Joining…" : "Join"}</button>
                      </form>
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
                    </>
                  )}
                </div>

                <div className="answers-setup">
                  <h3>Saved site answers</h3>
                  <p className="subtle">Clock-In asks whether a new site is work. Clearing this makes it ask again. Nothing here ever leaves this computer.</p>
                  {clearAnswersMessage && <p className="subtle" role="status">{clearAnswersMessage}</p>}
                  <button className="outline-button" type="button" disabled={clearAnswersBusy} onClick={() => void clearSiteAnswers()}>
                    {clearAnswersBusy ? "Clearing…" : "Clear saved site answers"}
                  </button>
                </div>

                <div className="advanced">
                  <button
                    type="button"
                    className="advanced-toggle"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((open) => !open)}
                  >
                    Advanced
                  </button>
                  {advancedOpen && (
                    <>
                      <div className="setting-rows">
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
                      </div>

                      <div className="mappings">
                        <h3>Path mappings</h3>
                        <p className="subtle">Agent activity in these directories counts toward the matching project.</p>
                        {mappings === undefined ? (
                          <p className="subtle">Loading…</p>
                        ) : mappings.filter((mapping) => mapping.kind === "path_prefix").length === 0 ? (
                          <p className="subtle">No path mappings yet.</p>
                        ) : (
                          <ul className="mapping-list">
                            {mappings.filter((mapping) => mapping.kind === "path_prefix").map((mapping) => (
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

                      <div className="mappings">
                        <h3>Site rules</h3>
                        <p className="subtle">Time on these sites counts toward the matching project. Most rules come from answering the site questions; edit patterns here only if you know the syntax.</p>
                        {mappings === undefined ? (
                          <p className="subtle">Loading…</p>
                        ) : mappings.filter((mapping) => mapping.kind === "url_rule").length === 0 ? (
                          <p className="subtle">No site rules yet.</p>
                        ) : (
                          <ul className="mapping-list">
                            {mappings.filter((mapping) => mapping.kind === "url_rule").map((mapping) => (
                              <li key={mapping.id} className="mapping-row">
                                <span className="mapping-path" title={mapping.pathPrefix}>{mapping.pathPrefix}</span>
                                <span className="mapping-project">{account.projects.find((item) => item.id === mapping.projectId)?.name ?? "Unknown project"}</span>
                                <button type="button" onClick={() => void deleteMapping(mapping.id)}>Delete</button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <form className="mapping-form" onSubmit={addRule}>
                          <label>
                            Site pattern
                            <input value={rulePattern} onChange={(event) => setRulePattern(event.target.value)} placeholder="*.quickbooks.com" spellCheck={false} autoComplete="off" required />
                          </label>
                          <label>
                            Project
                            <select value={ruleProjectId} onChange={(event) => setRuleProjectId(event.target.value)} required>
                              <option value="">Select project</option>
                              {account.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                            </select>
                          </label>
                          <button className="signal-button" type="submit" disabled={ruleBusy}>{ruleBusy ? "Adding…" : "Add rule"}</button>
                        </form>
                      </div>

                      {monitorStatus !== undefined && monitorStatus.hooks.some((hook) => hook.installed) && (
                        <div className="hooks-setup">
                          <h3>Watch my agent CLIs</h3>
                          <p className="subtle">
                            Opt in per tool: Clock-In adds its hook to the tool&apos;s own config, and only when you ask.
                          </p>
                          <ul className="hook-list">
                            {monitorStatus.hooks.filter((hook) => hook.installed).map((hook) => (
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
                    </>
                  )}
                </div>

                <div className="privacy-note">
                  <h3>What&apos;s recorded</h3>
                  <p className="subtle">
                    While monitoring is on, Clock-In samples the foreground process name every 30 seconds and notes idle,
                    lock, and sleep transitions. It never records window titles, URLs, document names, or keystrokes.
                    Agent tools report only session start and end with their working directory. The browser extension
                    reports only which of your approved site rules matched - never addresses or history. Evidence waits
                    in a local spool file under %APPDATA%\clock-in and uploads in batches every few minutes. Pausing
                    monitoring never stops your timer - time your computer can&apos;t confirm still counts, it&apos;s
                    just not marked verified.
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
