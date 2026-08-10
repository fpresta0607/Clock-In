import type { BootstrapSnapshot, RunningTimer, StartIntent, TimerProject, TimerUser } from "./timer-machine.js";

export type BridgeErrorKind = "auth" | "transient" | "conflict" | "validation" | "unknown";

export type BridgeError = {
  kind: BridgeErrorKind;
  message: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type SignupInput = LoginInput & {
  name: string;
  inviteCode?: string;
};

export type LeaderboardEntry = {
  rank: number;
  user: { id: string; name: string };
  durationSeconds: number;
  sessionCount: number;
};

export type OrganizationOverview = {
  organization: { id: string; name: string; inviteCode: string };
  entries: readonly LeaderboardEntry[];
};

export type StopInput = {
  sessionId: string;
  stoppedAt: string;
  /// `null` lets the host measure idle from its own segments; any number —
  /// including 0 — is the UI's authoritative away-prompt decision and wins
  /// over measurement.
  idleSeconds: number | null;
};

export type PendingRetryResult = {
  remaining: number;
};

export type HookRegistration = {
  source: string;
  detected: boolean;
  /// The CLI's config file exists: the CLI is on the machine, so the hook
  /// opt-in is offered. Hooks for absent CLIs are never rendered.
  installed: boolean;
  configPath: string;
};

/// Per-browser extension health, in the order a setup flows through them.
/// "registered" means the plumbing is done and only the store install is
/// left; "disabled" means no released extension ID was configured.
export type BrowserHealthState = "disabled" | "never-registered" | "binary-missing" | "registered" | "connected";

export type BrowserHealth = {
  browser: string;
  label: string;
  state: BrowserHealthState;
  storeUrl: string;
};

/// One suggestion the local tally earns: an unmatched origin and its focused
/// seconds. Local-only; never uploaded.
export type TallyEntry = {
  origin: string;
  seconds: number;
};

/// The outcome of an opt-in `hookRegister` call: the CLI's config was merged,
/// the hook was already there, or the host will not rewrite that CLI's config
/// and hands back the exact snippet to paste.
export type HookRegisterResult =
  | { status: "registered"; configPath: string }
  | { status: "already-registered"; configPath: string }
  | { status: "manual"; configPath: string; snippet: string };

/// The agent session currently holding the away override open — explains why
/// `sessionIdleSeconds` is frozen.
export type AgentActive = {
  source: string;
  since: string;
};

export type PendingSuggestion = {
  projectId: string;
  source: string;
  since: string;
};

export type AwayInfo = {
  startedAt: string;
  seconds: number;
  ongoing: boolean;
  exceedsHardLimit: boolean;
};

export type MonitorStatus = {
  enabled: boolean;
  running: boolean;
  lastUploadAt: string | null;
  segmentBacklog: number;
  agentBacklog: number;
  browserCapturePaused: boolean;
  hooks: readonly HookRegistration[];
  browsers: readonly BrowserHealth[];
  pendingSuggestion: PendingSuggestion | null;
  agentActive: AgentActive | null;
  sessionIdleSeconds: number | null;
  away: AwayInfo | null;
};

export type MonitorSettings = {
  enabled: boolean;
  awayThresholdMinutes: number;
  hardAwayLimitMinutes: number;
  autoStopOnLock: boolean;
  agentOverrideEnabled: boolean;
  /// The first-run flow (monitoring question + browser cards) completed.
  onboarded: boolean;
  deviceId: string;
};

export type SettingsPatch = Partial<Omit<MonitorSettings, "deviceId">>;

export type MeStats = {
  filters: {
    from?: string | undefined;
    to?: string | undefined;
    fromAt?: string | undefined;
    toExclusiveAt?: string | undefined;
  };
  totalDurationSeconds: number;
  corroboratedSeconds: number;
  projects: readonly MeStatsProject[];
  apps: readonly MeStatsApp[];
  sites: readonly MeStatsSite[];
};

export type MeStatsSite = {
  mapping: { id: string; pattern: string; projectId: string | null };
  durationSeconds: number;
};

export type MeStatsApp = {
  processName: string;
  durationSeconds: number;
};

export type MeStatsProject = {
  project: { id: string; name: string };
  durationSeconds: number;
  corroboratedSeconds: number;
  sessionCount: number;
};

export type PathMappingKind = "path_prefix" | "url_rule";

export type PathMapping = {
  id: string;
  kind: PathMappingKind;
  pathPrefix: string;
  repoUrl?: string | null | undefined;
  projectId: string;
};

export type PathMappingCreateInput = {
  kind?: PathMappingKind | undefined;
  pathPrefix: string;
  repoUrl?: string | undefined;
  projectId: string;
};

export type ProjectCreateInput = {
  name: string;
};

export type PathMappingUpdateInput = {
  pathPrefix?: string | undefined;
  repoUrl?: string | null | undefined;
  projectId?: string | undefined;
};

export interface TimerBridge {
  bootstrap(): Promise<BootstrapSnapshot>;
  login(input: LoginInput): Promise<BootstrapSnapshot>;
  signup(input: SignupInput): Promise<BootstrapSnapshot>;
  logout(): Promise<void>;
  start(input: StartIntent): Promise<RunningTimer>;
  stop(input: StopInput): Promise<void>;
  retryPending(): Promise<PendingRetryResult>;
  offlineSyncRetry?(): Promise<void>;
  browserCaptureResume?(): Promise<void>;
  useServerTimer(): Promise<BootstrapSnapshot>;
  retryLocalStart(input: StartIntent): Promise<BootstrapSnapshot>;
  orgOverview(): Promise<OrganizationOverview>;
  orgJoin(inviteCode: string): Promise<OrganizationOverview>;
  monitorStatus(): Promise<MonitorStatus>;
  hookRegister(source: string): Promise<HookRegisterResult>;
  browserRepair(browser: string): Promise<BrowserHealth>;
  browserOpenStorePage(browser: string): Promise<void>;
  suggestionsList(): Promise<readonly TallyEntry[]>;
  suggestionNeverSuggest(origin: string): Promise<void>;
  suggestionsClear(): Promise<void>;
  monitorSetEnabled(enabled: boolean): Promise<MonitorSettings>;
  monitorDismissSuggestion(): Promise<void>;
  settingsGet(): Promise<MonitorSettings>;
  settingsUpdate(input: SettingsPatch): Promise<MonitorSettings>;
  meStats(fromAt?: string, toExclusiveAt?: string): Promise<MeStats>;
  projectCreate(input: ProjectCreateInput): Promise<TimerProject>;
  pathMappingsList(): Promise<readonly PathMapping[]>;
  pathMappingsCreate(input: PathMappingCreateInput): Promise<PathMapping>;
  pathMappingsUpdate(id: string, input: PathMappingUpdateInput): Promise<PathMapping>;
  pathMappingsDelete(id: string): Promise<void>;
}

type TauriInvoke = <Result>(command: string, args?: Record<string, unknown>) => Promise<Result>;
type Decoder<Value> = (value: unknown) => Value;

const invalidResponse = (): never => {
  throw { kind: "unknown", message: "The desktop service returned an invalid response." } satisfies BridgeError;
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
};

const string = (value: unknown): string => {
  if (typeof value !== "string") invalidResponse();
  return value as string;
};

const uuid = (value: unknown): string => {
  const result = string(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) invalidResponse();
  return result;
};

const timestamp = (value: unknown): string => {
  const result = string(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || Number.isNaN(Date.parse(result))) invalidResponse();
  return result;
};

const nonnegativeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidResponse();
  return value as number;
};

export const decodeStartIntent = (value: unknown): StartIntent => {
  const candidate = record(value);
  return {
    clientId: uuid(candidate.clientId),
    projectId: uuid(candidate.projectId),
    description: string(candidate.description),
    startedAt: timestamp(candidate.startedAt),
  };
};

export const decodeRunningTimer = (value: unknown): RunningTimer => {
  const candidate = record(value);
  return { ...decodeStartIntent(candidate), sessionId: uuid(candidate.sessionId) };
};

const decodeUser = (value: unknown): TimerUser => {
  const candidate = record(value);
  return { id: uuid(candidate.id), email: string(candidate.email), name: string(candidate.name) };
};

const decodeProject = (value: unknown): TimerProject => {
  const candidate = record(value);
  if (candidate.color !== null && typeof candidate.color !== "string") invalidResponse();
  return {
    id: uuid(candidate.id),
    name: string(candidate.name),
    color: candidate.color as string | null,
    isDefault: candidate.isDefault === undefined ? false : boolean(candidate.isDefault),
  };
};

type DecodedAccount = { user: TimerUser; projects: readonly TimerProject[]; selectedProjectId: string | null };

const decodeAccount = (candidate: Record<string, unknown>): DecodedAccount => {
  const projects = candidate.projects;
  if (!Array.isArray(projects)) invalidResponse();
  const selectedProjectId = candidate.selectedProjectId;
  return {
    user: decodeUser(candidate.user),
    projects: (projects as unknown[]).map(decodeProject),
    selectedProjectId: selectedProjectId === undefined || selectedProjectId === null ? null : uuid(selectedProjectId),
  };
};

export const decodeBootstrapSnapshot = (value: unknown): BootstrapSnapshot => {
  const candidate = record(value);
  switch (candidate.kind) {
    case "signed-out":
      return { kind: "signed-out" };
    case "idle":
      return { kind: "idle", ...decodeAccount(candidate) };
    case "running": {
      const source = candidate.source;
      if (source !== "local-server-match" && source !== "server-only") invalidResponse();
      return { kind: "running", ...decodeAccount(candidate), running: decodeRunningTimer(candidate.running), source: source as "local-server-match" | "server-only" };
    }
    case "retry-local-start":
      return { kind: "retry-local-start", ...decodeAccount(candidate), start: decodeStartIntent(candidate.start) };
    case "pending-sync":
      return { kind: "pending-sync", ...decodeAccount(candidate), pendingCount: nonnegativeInteger(candidate.pendingCount) };
    case "conflict":
      return {
        kind: "conflict",
        ...decodeAccount(candidate),
        localStart: decodeStartIntent(candidate.localStart),
        serverRunning: decodeRunningTimer(candidate.serverRunning),
      };
    default:
      return invalidResponse();
  }
};

const decodeLeaderboardEntry = (value: unknown): LeaderboardEntry => {
  const candidate = record(value);
  const member = record(candidate.user);
  return {
    rank: nonnegativeInteger(candidate.rank),
    user: { id: uuid(member.id), name: string(member.name) },
    durationSeconds: nonnegativeInteger(candidate.durationSeconds),
    sessionCount: nonnegativeInteger(candidate.sessionCount),
  };
};

export const decodeOrganizationOverview = (value: unknown): OrganizationOverview => {
  const candidate = record(value);
  const organization = record(candidate.organization);
  const entries = candidate.entries;
  if (!Array.isArray(entries)) invalidResponse();
  return {
    organization: {
      id: uuid(organization.id),
      name: string(organization.name),
      inviteCode: string(organization.inviteCode),
    },
    entries: (entries as unknown[]).map(decodeLeaderboardEntry),
  };
};

export const decodePendingRetryResult = (value: unknown): PendingRetryResult => {
  const candidate = record(value);
  return { remaining: nonnegativeInteger(candidate.remaining) };
};

const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") invalidResponse();
  return value as boolean;
};

const stringOrNull = (value: unknown): string | null => {
  if (value === null) return null;
  return string(value);
};

const timestampOrNull = (value: unknown): string | null => {
  if (value === null) return null;
  return timestamp(value);
};

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return string(value);
};

const decodeHookRegistration = (value: unknown): HookRegistration => {
  const candidate = record(value);
  return {
    source: string(candidate.source),
    detected: boolean(candidate.detected),
    installed: boolean(candidate.installed),
    configPath: string(candidate.configPath),
  };
};

export const decodeHookRegisterResult = (value: unknown): HookRegisterResult => {
  const candidate = record(value);
  const configPath = string(candidate.configPath);
  switch (candidate.status) {
    case "registered":
      return { status: "registered", configPath };
    case "already-registered":
      return { status: "already-registered", configPath };
    case "manual":
      return { status: "manual", configPath, snippet: string(candidate.snippet) };
    default:
      return invalidResponse();
  }
};

const decodeAgentActive = (value: unknown): AgentActive => {
  const candidate = record(value);
  return { source: string(candidate.source), since: timestamp(candidate.since) };
};

const decodePendingSuggestion = (value: unknown): PendingSuggestion => {
  const candidate = record(value);
  return {
    projectId: uuid(candidate.projectId),
    source: string(candidate.source),
    since: timestamp(candidate.since),
  };
};

const decodeAwayInfo = (value: unknown): AwayInfo => {
  const candidate = record(value);
  return {
    startedAt: timestamp(candidate.startedAt),
    seconds: nonnegativeInteger(candidate.seconds),
    ongoing: boolean(candidate.ongoing),
    exceedsHardLimit: boolean(candidate.exceedsHardLimit),
  };
};

const decodeBrowserHealth = (value: unknown): BrowserHealth => {
  const candidate = record(value);
  const state = candidate.state;
  if (state !== "disabled" && state !== "never-registered" && state !== "binary-missing" && state !== "registered" && state !== "connected") {
    invalidResponse();
  }
  return {
    browser: string(candidate.browser),
    label: string(candidate.label),
    state: state as BrowserHealthState,
    storeUrl: string(candidate.storeUrl),
  };
};

const decodeTallyEntry = (value: unknown): TallyEntry => {
  const candidate = record(value);
  return {
    origin: string(candidate.origin),
    seconds: nonnegativeInteger(candidate.seconds),
  };
};

export const decodeTallyEntries = (value: unknown): readonly TallyEntry[] => {
  if (!Array.isArray(value)) invalidResponse();
  return (value as unknown[]).map(decodeTallyEntry);
};

export const decodeMonitorStatus = (value: unknown): MonitorStatus => {
  const candidate = record(value);
  const hooks = candidate.hooks;
  if (!Array.isArray(hooks)) invalidResponse();
  const browsers = candidate.browsers;
  if (!Array.isArray(browsers)) invalidResponse();
  return {
    enabled: boolean(candidate.enabled),
    running: boolean(candidate.running),
    lastUploadAt: timestampOrNull(candidate.lastUploadAt),
    segmentBacklog: nonnegativeInteger(candidate.segmentBacklog),
    agentBacklog: nonnegativeInteger(candidate.agentBacklog),
    browserCapturePaused: candidate.browserCapturePaused === undefined ? false : boolean(candidate.browserCapturePaused),
    hooks: (hooks as unknown[]).map(decodeHookRegistration),
    browsers: (browsers as unknown[]).map(decodeBrowserHealth),
    pendingSuggestion: candidate.pendingSuggestion === null ? null : decodePendingSuggestion(candidate.pendingSuggestion),
    agentActive: candidate.agentActive === null ? null : decodeAgentActive(candidate.agentActive),
    sessionIdleSeconds: candidate.sessionIdleSeconds === null ? null : nonnegativeInteger(candidate.sessionIdleSeconds),
    away: candidate.away === null ? null : decodeAwayInfo(candidate.away),
  };
};

export const decodeMonitorSettings = (value: unknown): MonitorSettings => {
  const candidate = record(value);
  return {
    enabled: boolean(candidate.enabled),
    awayThresholdMinutes: nonnegativeInteger(candidate.awayThresholdMinutes),
    hardAwayLimitMinutes: nonnegativeInteger(candidate.hardAwayLimitMinutes),
    autoStopOnLock: boolean(candidate.autoStopOnLock),
    agentOverrideEnabled: boolean(candidate.agentOverrideEnabled),
    onboarded: boolean(candidate.onboarded),
    deviceId: string(candidate.deviceId),
  };
};

const decodeMeStatsProject = (value: unknown): MeStatsProject => {
  const candidate = record(value);
  const project = record(candidate.project);
  return {
    project: { id: uuid(project.id), name: string(project.name) },
    durationSeconds: nonnegativeInteger(candidate.durationSeconds),
    corroboratedSeconds: nonnegativeInteger(candidate.corroboratedSeconds),
    sessionCount: nonnegativeInteger(candidate.sessionCount),
  };
};

const decodeMeStatsApp = (value: unknown): MeStatsApp => {
  const candidate = record(value);
  return {
    processName: string(candidate.processName),
    durationSeconds: nonnegativeInteger(candidate.durationSeconds),
  };
};

const decodeMeStatsSite = (value: unknown): MeStatsSite => {
  const candidate = record(value);
  const mapping = record(candidate.mapping);
  return {
    mapping: {
      id: uuid(mapping.id),
      pattern: string(mapping.pattern),
      projectId: mapping.projectId === null ? null : uuid(mapping.projectId),
    },
    durationSeconds: nonnegativeInteger(candidate.durationSeconds),
  };
};

export const decodeMeStats = (value: unknown): MeStats => {
  const candidate = record(value);
  const filters = record(candidate.filters);
  const projects = candidate.projects;
  const apps = candidate.apps;
  const sites = candidate.sites;
  if (!Array.isArray(projects) || !Array.isArray(apps) || !Array.isArray(sites)) invalidResponse();
  const totalDurationSeconds = nonnegativeInteger(candidate.totalDurationSeconds);
  const corroboratedSeconds = nonnegativeInteger(candidate.corroboratedSeconds);
  if (corroboratedSeconds > totalDurationSeconds) invalidResponse();
  return {
    filters: {
      from: optionalString(filters.from),
      to: optionalString(filters.to),
      fromAt: optionalString(filters.fromAt),
      toExclusiveAt: optionalString(filters.toExclusiveAt),
    },
    totalDurationSeconds,
    corroboratedSeconds,
    projects: (projects as unknown[]).map(decodeMeStatsProject),
    apps: (apps as unknown[]).map(decodeMeStatsApp),
    sites: (sites as unknown[]).map(decodeMeStatsSite),
  };
};

export const decodePathMapping = (value: unknown): PathMapping => {
  const candidate = record(value);
  const kind = candidate.kind;
  if (kind !== "path_prefix" && kind !== "url_rule") invalidResponse();
  return {
    id: uuid(candidate.id),
    kind: kind as PathMappingKind,
    pathPrefix: string(candidate.pathPrefix),
    repoUrl: candidate.repoUrl === undefined ? undefined : stringOrNull(candidate.repoUrl),
    projectId: uuid(candidate.projectId),
  };
};

export const decodePathMappings = (value: unknown): readonly PathMapping[] => {
  if (!Array.isArray(value)) invalidResponse();
  return (value as unknown[]).map(decodePathMapping);
};

const decodeVoid = (value: unknown): void => {
  if (value !== undefined && value !== null) invalidResponse();
};

const tauriInvoke = async <Result>(command: string, args?: Record<string, unknown>): Promise<Result> => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Result>(command, args);
};

const invoke = <Result>(command: string, args?: Record<string, unknown>): Promise<Result> =>
  (tauriInvoke as TauriInvoke)(command, args);

const invokeDecoded = <Result>(command: string, decoder: Decoder<Result>, args?: Record<string, unknown>): Promise<Result> =>
  invoke<unknown>(command, args).then(decoder);

export const defaultBridge: TimerBridge = {
  bootstrap: () => invokeDecoded("timer_bootstrap", decodeBootstrapSnapshot),
  login: (input) => invokeDecoded("auth_login", decodeBootstrapSnapshot, { input }),
  signup: (input) => invokeDecoded("auth_signup", decodeBootstrapSnapshot, { input }),
  logout: () => invokeDecoded("auth_logout", decodeVoid),
  start: (input) => invokeDecoded("timer_start", decodeRunningTimer, { input }),
  stop: (input) => invokeDecoded("timer_stop", decodeVoid, { input }),
  retryPending: () => invokeDecoded("timer_retry_pending", decodePendingRetryResult),
  offlineSyncRetry: () => invokeDecoded("offline_sync_retry", decodeVoid),
  browserCaptureResume: () => invokeDecoded("browser_capture_resume", decodeVoid),
  useServerTimer: () => invokeDecoded("timer_use_server", decodeBootstrapSnapshot),
  retryLocalStart: (input) => invokeDecoded("timer_retry_local_start", decodeBootstrapSnapshot, { input }),
  orgOverview: () => invokeDecoded("org_overview", decodeOrganizationOverview),
  orgJoin: (inviteCode) => invokeDecoded("org_join", decodeOrganizationOverview, { input: { inviteCode } }),
  monitorStatus: () => invokeDecoded("monitor_status", decodeMonitorStatus),
  hookRegister: (source) => invokeDecoded("hook_register", decodeHookRegisterResult, { source }),
  browserRepair: (browser) => invokeDecoded("browser_repair", decodeBrowserHealth, { browser }),
  browserOpenStorePage: (browser) => invokeDecoded("browser_open_store_page", decodeVoid, { browser }),
  suggestionsList: () => invokeDecoded("suggestions_list", decodeTallyEntries),
  suggestionNeverSuggest: (origin) => invokeDecoded("suggestion_never_suggest", decodeVoid, { origin }),
  suggestionsClear: () => invokeDecoded("suggestions_clear", decodeVoid),
  monitorSetEnabled: (enabled) => invokeDecoded("monitor_set_enabled", decodeMonitorSettings, { enabled }),
  monitorDismissSuggestion: () => invokeDecoded("monitor_dismiss_suggestion", decodeVoid),
  settingsGet: () => invokeDecoded("settings_get", decodeMonitorSettings),
  settingsUpdate: (input) => invokeDecoded("settings_update", decodeMonitorSettings, { input }),
  meStats: (fromAt, toExclusiveAt) =>
    invokeDecoded("me_stats", decodeMeStats, {
      ...(fromAt === undefined ? {} : { fromAt }),
      ...(toExclusiveAt === undefined ? {} : { toExclusiveAt }),
    }),
  projectCreate: (input) => invokeDecoded("project_create", decodeProject, { input }),
  pathMappingsList: () => invokeDecoded("path_mappings_list", decodePathMappings),
  pathMappingsCreate: (input) => invokeDecoded("path_mappings_create", decodePathMapping, { input }),
  pathMappingsUpdate: (id, input) => invokeDecoded("path_mappings_update", decodePathMapping, { id, input }),
  pathMappingsDelete: (id) => invokeDecoded("path_mappings_delete", decodeVoid, { id }),
};

export const bridgeError = (error: unknown): BridgeError => {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { kind?: unknown; message?: unknown; code?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "The desktop service did not complete the request.";
    if (
      candidate.kind === "auth"
      || candidate.kind === "transient"
      || candidate.kind === "conflict"
      || candidate.kind === "validation"
      || candidate.kind === "unknown"
    ) {
      return { kind: candidate.kind, message };
    }
    if (candidate.code === "unauthorized" || candidate.code === "invalid_credentials") return { kind: "auth", message };
  }
  return { kind: "unknown", message: "The desktop service did not complete the request." };
};
