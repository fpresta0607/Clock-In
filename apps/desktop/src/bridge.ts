import type { AccountSnapshot, TimerProject, TimerUser } from "./account.js";

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

export type HookRegistration = {
  source: string;
  detected: boolean;
  configPath: string;
};

/// The outcome of an opt-in `hookRegister` call: the CLI's config was merged,
/// the hook was already there, or the host will not rewrite that CLI's config
/// and hands back the exact snippet to paste.
export type HookRegisterResult =
  | { status: "registered"; configPath: string }
  | { status: "already-registered"; configPath: string }
  | { status: "manual"; configPath: string; snippet: string };

/// The agent session holding the open session through quiet time.
export type AgentActive = {
  source: string;
  since: string;
};

/// How a session learned which project it belongs to. Everything but
/// `default` means something named the project on purpose.
export type Attribution = "selected" | "agent" | "default";

/// One app's share of the open session, as the host counts it locally.
export type SessionApp = {
  /// The executable name only, exactly as segments record it.
  processName: string;
  durationSeconds: number;
};

/// The session recording right now. It exists whenever the machine is in use
/// and recording is on; nobody starts or stops it.
export type CurrentSession = {
  projectId: string;
  attribution: Attribution;
  since: string;
  idleSeconds: number;
  /// Where this session's time has gone, heaviest first. Local and live: the
  /// host counts the span still open, so these tick with the work rather than
  /// waiting for an upload.
  apps: readonly SessionApp[];
};

export type MonitorStatus = {
  enabled: boolean;
  running: boolean;
  /// Whether this machine is actually being sampled, as opposed to the tasks
  /// merely having been started. A poll task that dies leaves `running` true,
  /// so this is what the recording state is allowed to claim "on" from.
  observing: boolean;
  /// Seconds since the last completed poll; `null` before the first one.
  lastPollAgeSeconds: number | null;
  lastUploadAt: string | null;
  segmentBacklog: number;
  agentBacklog: number;
  sessionBacklog: number;
  hooks: readonly HookRegistration[];
  agentActive: AgentActive | null;
  currentSession: CurrentSession | null;
  selectedProjectId: string | null;
};

export type MonitorSettings = {
  enabled: boolean;
  awayThresholdMinutes: number;
  agentOverrideEnabled: boolean;
  deviceId: string;
};

export type SettingsPatch = Partial<Omit<MonitorSettings, "deviceId">>;

export type MeStats = {
  filters: { from?: string | undefined; to?: string | undefined };
  totalDurationSeconds: number;
  attributedSeconds: number;
  unattributedSeconds: number;
  projects: readonly MeStatsProject[];
  apps: readonly MeStatsApp[];
};

export type MeStatsApp = {
  processName: string;
  durationSeconds: number;
};

export type MeStatsProject = {
  project: { id: string; name: string };
  durationSeconds: number;
  attributedSeconds: number;
  unattributedSeconds: number;
  sessionCount: number;
};

export type PathMapping = {
  id: string;
  pathPrefix: string;
  repoUrl?: string | null | undefined;
  projectId: string;
};

export type PathMappingCreateInput = {
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
  bootstrap(): Promise<AccountSnapshot>;
  login(input: LoginInput): Promise<AccountSnapshot>;
  signup(input: SignupInput): Promise<AccountSnapshot>;
  logout(): Promise<void>;
  orgOverview(): Promise<OrganizationOverview>;
  orgJoin(inviteCode: string): Promise<OrganizationOverview>;
  monitorStatus(): Promise<MonitorStatus>;
  /// Pins recording to one project, or clears the pin with `null`.
  sessionSelectProject(projectId: string | null): Promise<MonitorStatus>;
  hookRegister(source: string): Promise<HookRegisterResult>;
  monitorSetEnabled(enabled: boolean): Promise<MonitorSettings>;
  settingsGet(): Promise<MonitorSettings>;
  settingsUpdate(input: SettingsPatch): Promise<MonitorSettings>;
  meStats(from?: string, to?: string): Promise<MeStats>;
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

const decodeUser = (value: unknown): TimerUser => {
  const candidate = record(value);
  return { id: uuid(candidate.id), email: string(candidate.email), name: string(candidate.name) };
};

const decodeProject = (value: unknown): TimerProject => {
  const candidate = record(value);
  if (candidate.color !== null && typeof candidate.color !== "string") invalidResponse();
  return { id: uuid(candidate.id), name: string(candidate.name), color: candidate.color as string | null };
};

const uuidOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : uuid(value));

export const decodeAccountSnapshot = (value: unknown): AccountSnapshot => {
  const candidate = record(value);
  if (candidate.kind === "signed-out") return { kind: "signed-out" };
  if (candidate.kind !== "ready") return invalidResponse();
  const projects = candidate.projects;
  if (!Array.isArray(projects)) invalidResponse();
  return {
    kind: "ready",
    user: decodeUser(candidate.user),
    projects: (projects as unknown[]).map(decodeProject),
    defaultProjectId: uuidOrNull(candidate.defaultProjectId),
    selectedProjectId: uuidOrNull(candidate.selectedProjectId),
  };
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

const decodeAttribution = (value: unknown): Attribution => {
  if (value !== "selected" && value !== "agent" && value !== "default") invalidResponse();
  return value as Attribution;
};

const decodeSessionApp = (value: unknown): SessionApp => {
  const candidate = record(value);
  return {
    processName: string(candidate.processName),
    durationSeconds: nonnegativeInteger(candidate.durationSeconds),
  };
};

const decodeCurrentSession = (value: unknown): CurrentSession => {
  const candidate = record(value);
  const apps = candidate.apps;
  if (!Array.isArray(apps)) invalidResponse();
  return {
    projectId: uuid(candidate.projectId),
    attribution: decodeAttribution(candidate.attribution),
    since: timestamp(candidate.since),
    idleSeconds: nonnegativeInteger(candidate.idleSeconds),
    apps: (apps as unknown[]).map(decodeSessionApp),
  };
};

export const decodeMonitorStatus = (value: unknown): MonitorStatus => {
  const candidate = record(value);
  const hooks = candidate.hooks;
  if (!Array.isArray(hooks)) invalidResponse();
  return {
    enabled: boolean(candidate.enabled),
    running: boolean(candidate.running),
    observing: boolean(candidate.observing),
    lastPollAgeSeconds:
      candidate.lastPollAgeSeconds === null || candidate.lastPollAgeSeconds === undefined
        ? null
        : nonnegativeInteger(candidate.lastPollAgeSeconds),
    lastUploadAt: timestampOrNull(candidate.lastUploadAt),
    segmentBacklog: nonnegativeInteger(candidate.segmentBacklog),
    agentBacklog: nonnegativeInteger(candidate.agentBacklog),
    sessionBacklog: nonnegativeInteger(candidate.sessionBacklog),
    hooks: (hooks as unknown[]).map(decodeHookRegistration),
    agentActive: candidate.agentActive === null ? null : decodeAgentActive(candidate.agentActive),
    currentSession: candidate.currentSession === null ? null : decodeCurrentSession(candidate.currentSession),
    selectedProjectId: uuidOrNull(candidate.selectedProjectId),
  };
};

export const decodeMonitorSettings = (value: unknown): MonitorSettings => {
  const candidate = record(value);
  return {
    enabled: boolean(candidate.enabled),
    awayThresholdMinutes: nonnegativeInteger(candidate.awayThresholdMinutes),
    agentOverrideEnabled: boolean(candidate.agentOverrideEnabled),
    deviceId: string(candidate.deviceId),
  };
};

const decodeMeStatsProject = (value: unknown): MeStatsProject => {
  const candidate = record(value);
  const project = record(candidate.project);
  return {
    project: { id: uuid(project.id), name: string(project.name) },
    durationSeconds: nonnegativeInteger(candidate.durationSeconds),
    attributedSeconds: nonnegativeInteger(candidate.attributedSeconds),
    unattributedSeconds: nonnegativeInteger(candidate.unattributedSeconds),
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

export const decodeMeStats = (value: unknown): MeStats => {
  const candidate = record(value);
  const filters = record(candidate.filters);
  const projects = candidate.projects;
  const apps = candidate.apps;
  if (!Array.isArray(projects) || !Array.isArray(apps)) invalidResponse();
  const totalDurationSeconds = nonnegativeInteger(candidate.totalDurationSeconds);
  const attributedSeconds = nonnegativeInteger(candidate.attributedSeconds);
  if (attributedSeconds > totalDurationSeconds) invalidResponse();
  return {
    filters: { from: optionalString(filters.from), to: optionalString(filters.to) },
    totalDurationSeconds,
    attributedSeconds,
    unattributedSeconds: nonnegativeInteger(candidate.unattributedSeconds),
    projects: (projects as unknown[]).map(decodeMeStatsProject),
    apps: (apps as unknown[]).map(decodeMeStatsApp),
  };
};

export const decodePathMapping = (value: unknown): PathMapping => {
  const candidate = record(value);
  return {
    id: uuid(candidate.id),
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
  bootstrap: () => invokeDecoded("timer_bootstrap", decodeAccountSnapshot),
  login: (input) => invokeDecoded("auth_login", decodeAccountSnapshot, { input }),
  signup: (input) => invokeDecoded("auth_signup", decodeAccountSnapshot, { input }),
  logout: () => invokeDecoded("auth_logout", decodeVoid),
  orgOverview: () => invokeDecoded("org_overview", decodeOrganizationOverview),
  orgJoin: (inviteCode) => invokeDecoded("org_join", decodeOrganizationOverview, { input: { inviteCode } }),
  monitorStatus: () => invokeDecoded("monitor_status", decodeMonitorStatus),
  sessionSelectProject: (projectId) => invokeDecoded("session_select_project", decodeMonitorStatus, { projectId }),
  hookRegister: (source) => invokeDecoded("hook_register", decodeHookRegisterResult, { source }),
  monitorSetEnabled: (enabled) => invokeDecoded("monitor_set_enabled", decodeMonitorSettings, { enabled }),
  settingsGet: () => invokeDecoded("settings_get", decodeMonitorSettings),
  settingsUpdate: (input) => invokeDecoded("settings_update", decodeMonitorSettings, { input }),
  meStats: (from, to) =>
    invokeDecoded("me_stats", decodeMeStats, {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
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
