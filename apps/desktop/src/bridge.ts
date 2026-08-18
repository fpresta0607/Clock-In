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
  activeSeconds: number;
  agentSeconds: number;
};

export type OrganizationOverview = {
  organization: { id: string; name: string; inviteCode: string };
  entries: readonly LeaderboardEntry[];
};

export type HookRegistration = {
  source: string;
  detected: boolean;
  /// Whether the CLI looks present on this machine at all.
  installed: boolean;
  /// Installed, not connected, and not something the host can wire up itself.
  /// The only rows that should ask a person for anything.
  needsYou: boolean;
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
  /// The active span still open on this machine, which no upload covers yet.
  openSpan: { processName: string; since: string } | null;
  /// Every agent session running right now - one per terminal or window, each
  /// with the project its working directory resolved to.
  agentSessions: readonly AgentSessionRow[];
  selectedProjectId: string | null;
};

/// One agent session running right now. Several run side by side, so each is
/// identified by the lifecycle the tool itself reported.
export type AgentSessionRow = {
  source: string;
  externalSessionId: string;
  projectId: string | null;
  since: string;
};

/// How one browser's connection stands. Only installed browsers appear.
export type BrowserHealthState =
  | "disabled"
  | "never-registered"
  | "binary-missing"
  | "registered"
  | "connected";

export type BrowserHealth = {
  /// The stable wire id (`chrome`, `edge`, `firefox`).
  browser: string;
  /// The plain name the card shows.
  label: string;
  state: BrowserHealthState;
  /// The store page the [Add extension] button opens.
  storeUrl: string;
};

/// One limit a coding-agent provider reports — a rolling session window, a
/// weekly window, or a per-model bound. Several apply at once; the smallest is
/// what the dial shows.
export type QuotaWindow = {
  id: string;
  label: string;
  kind: string;
  percentRemaining: number;
  resetsAt: string | null;
};

/// The provider login a reading belongs to. Read from the machine's own
/// credentials for display only; it never leaves the device.
export type QuotaAccount = {
  email: string | null;
  organization: string | null;
};

/// What one provider has left, for the account signed in to it on this machine
/// right now — not for whoever recorded a past session. `unknown` covers every
/// way a reading can fail (no tooling installed, signed out, unreadable state)
/// and always carries a `detail` sentence saying which.
export type AgentQuota = {
  provider: string;
  label: string;
  /// Agent-session sources this provider backs (`claude_code` → `claude`), so
  /// an attributed row finds its dial without a second lookup table.
  sources: readonly string[];
  status: "known" | "unknown";
  account: QuotaAccount | null;
  plan: string | null;
  percentRemaining: number | null;
  bindingWindowId: string | null;
  windows: readonly QuotaWindow[];
  detail: string | null;
  /// The provider's own error code, for the expandable detail.
  reason: string | null;
  stale: boolean;
};

/// `pending` is the host still reading; `unavailable` means no source answered
/// at all. Both leave every dial in its unknown state.
export type QuotaSnapshot = {
  status: "pending" | "ready" | "unavailable";
  checkedAt: string | null;
  detail: string | null;
  providers: readonly AgentQuota[];
};

export type MonitorSettings = {
  enabled: boolean;
  awayThresholdMinutes: number;
  agentOverrideEnabled: boolean;
  browserAutoInstall: boolean;
  agentUsageCapture: boolean;
  deviceId: string;
};

export type SettingsPatch = Partial<Omit<MonitorSettings, "deviceId">>;

export type MeStats = {
  filters: { from?: string | undefined; to?: string | undefined };
  totalDurationSeconds: number;
  attributedSeconds: number;
  unattributedSeconds: number;
  /// Union of the member's working intervals - never exceeds wall clock.
  activeSeconds: number;
  /// Summed agent runtime; exceeding activeSeconds is leverage, not an error.
  agentSeconds: number;
  concurrency: MeStatsConcurrency;
  byAgent: readonly MeStatsAgentSplit[];
  /// Hourly series for the line graph, bucketed to the caller's local hours.
  hourly: readonly MeStatsHourlyBucket[];
  projects: readonly MeStatsProject[];
  apps: readonly MeStatsApp[];
  /// The caller's own agent activity in range; empty on an API that predates it.
  agents: readonly MeStatsAgentActivity[];
};

/// One agent's activity in `/me/stats`, decoded only as far as the charts
/// need: which runtime ran, and whether it reported tokens. A null
/// tokensReported means the API predates the field and cannot say.
export type MeStatsAgentActivity = {
  source: string;
  shiftCount: number;
  tokensReported: boolean | null;
};

export type MeStatsConcurrency = {
  t0Seconds: number;
  t1Seconds: number;
  t2Seconds: number;
  t3PlusSeconds: number;
  awaySeconds: number;
};

/// One (runtime, model) pair's share of a member's agent time. The session
/// facts the API also sends stay behind: the desktop reads this split only to
/// name the models a runtime has driven, and the Agents tab measures shifts
/// from the paystub instead.
export type MeStatsAgentSplit = {
  source: string;
  model: string | null;
  durationSeconds: number;
};

/// The four token counters a runtime's own session logs report, summed over
/// a scope. Null on a row when the API predates token reporting: absence is
/// shown as absence, never as a zero the server cannot legitimately send.
export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export type MeStatsHourlyBucket = {
  hourStart: string;
  activeSeconds: number;
  agentSeconds: number;
  /// Null when nothing in the hour reported tokens; never an invented zero.
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
};

/// The dashboard view state shared with the web app. Only `scope` is
/// synchronised between surfaces: each offers its own ranges on purpose.
export type ViewPreferences = {
  scope: string;
  range: string;
};

/// What deleting a project takes with it.
export type ProjectUsage = {
  sessionCount: number;
  durationSeconds: number;
  agentSessionCount: number;
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

/// One shift as the Agents tab reads it: a terminal session with the facts
/// it attested itself. `endedAt` is the last event while the shift still
/// runs, never "still open".
export type AgentShiftRow = {
  id: string;
  source: string;
  owner: { id: string; name: string };
  model: string | null;
  startedAt: string;
  endedAt: string;
  agentSeconds: number;
  commitCount: number;
};

/// One codebase's group: summed runtime and the shifts that worked it,
/// newest first. `repo` is a folder name, never a path; null groups the
/// shifts that recorded neither a commit root nor a working directory.
/// `heldRate` stays null until a commit is decided - no rate is a fact
/// before then, and the tab says nothing rather than "pending".
export type AgentShiftsGroup = {
  repo: string | null;
  agentSeconds: number;
  shiftCount: number;
  heldRate: number | null;
  shifts: readonly AgentShiftRow[];
};

export type AgentShifts = {
  totalAgentSeconds: number;
  groups: readonly AgentShiftsGroup[];
};


export type ProjectCreateInput = {
  name: string;
};

export interface TimerBridge {
  bootstrap(): Promise<AccountSnapshot>;
  login(input: LoginInput): Promise<AccountSnapshot>;
  signup(input: SignupInput): Promise<AccountSnapshot>;
  logout(): Promise<void>;
  /// The workspace board. Instant bounds scope the entries; both absent
  /// means all time. `scope` narrows to one project or the unassigned bucket.
  orgOverview(fromAt?: string, toExclusiveAt?: string, scope?: string): Promise<OrganizationOverview>;
  /// The scope shared with the web dashboard.
  preferencesGet(): Promise<ViewPreferences>;
  preferencesSet(input: { scope?: string; range?: string }): Promise<ViewPreferences>;
  orgJoin(inviteCode: string): Promise<OrganizationOverview>;
  monitorStatus(): Promise<MonitorStatus>;
  /// One card per installed browser, for the "what's switched on" list.
  browserStatus(): Promise<BrowserHealth[]>;
  /// Re-registers the host for one browser and reports the resulting health.
  browserRepair(browserId: string): Promise<BrowserHealth>;
  /// Opens one browser's extension store page in the system browser.
  browserOpenStore(browserId: string): Promise<void>;
  /// Pins recording to one project, or clears the pin with `null`.
  sessionSelectProject(projectId: string | null): Promise<MonitorStatus>;
  hookRegister(source: string): Promise<HookRegisterResult>;
  monitorSetEnabled(enabled: boolean): Promise<MonitorSettings>;
  settingsGet(): Promise<MonitorSettings>;
  settingsUpdate(input: SettingsPatch): Promise<MonitorSettings>;
  /// Instant bounds, so "today" means the caller's local day rather than a
  /// UTC one that rolls over mid-afternoon. Both absent asks for all time.
  /// `userId` names a teammate, which is how the leaderboard opens one
  /// member's breakdown; absent means the caller.
  meStats(fromAt?: string, toExclusiveAt?: string, userId?: string, scope?: string): Promise<MeStats>;
  /// Every shift in the range grouped by the codebase it worked, for the
  /// Agents tab. Both bounds absent asks for all time.
  agentShifts(fromAt?: string, toExclusiveAt?: string): Promise<AgentShifts>;
  projectCreate(input: ProjectCreateInput): Promise<TimerProject>;
  projectUpdate(id: string, input: { name?: string; isArchived?: boolean }): Promise<TimerProject>;
  projectUsage(id: string): Promise<ProjectUsage>;
  /// Deletes a project; reassignTo moves its data to another project first.
  projectDelete(id: string, reassignTo: string | null): Promise<void>;
  /// OS icons for executables, as data URIs; null where the OS has none.
  appIcons(processNames: readonly string[]): Promise<Record<string, string | null>>;
  /// How much of each coding agent's plan is left, read locally. Advisory:
  /// unknown readings are normal and never an error.
  quotaStatus(): Promise<QuotaSnapshot>;
  /// Subscribes to "an update is downloading" notices; resolves to the
  /// unsubscribe function.
  onUpdateAvailable(handler: (version: string) => void): Promise<() => void>;
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

const decodeAppIcons = (value: unknown): Record<string, string | null> => {
  const raw = record(value);
  const icons: Record<string, string | null> = {};
  for (const [name, icon] of Object.entries(raw)) {
    if (icon !== null && typeof icon !== "string") invalidResponse();
    icons[name] = icon as string | null;
  }
  return icons;
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

const nonnegativeIntegerOrNull = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  return nonnegativeInteger(value);
};

/// A merged/decided ratio in [0, 1], or null while nothing has been decided.
const unitRateOrNull = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalidResponse();
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

/// A field an older API may not send yet decodes to the empty list, not an error.
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
    activeSeconds: nonnegativeInteger(candidate.activeSeconds),
    agentSeconds: nonnegativeInteger(candidate.agentSeconds),
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

const percentage = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) invalidResponse();
  return value as number;
};

const decodeQuotaWindow = (value: unknown): QuotaWindow => {
  const candidate = record(value);
  return {
    id: string(candidate.id),
    label: string(candidate.label),
    kind: string(candidate.kind),
    percentRemaining: percentage(candidate.percentRemaining),
    // Left as the provider wrote it rather than validated as a timestamp: the
    // dial only ever prints it, and a formatting quirk from another tool is no
    // reason to throw a whole reading away.
    resetsAt: stringOrNull(candidate.resetsAt ?? null),
  };
};

const decodeQuotaAccount = (value: unknown): QuotaAccount | null => {
  if (value === null || value === undefined) return null;
  const candidate = record(value);
  return {
    email: stringOrNull(candidate.email ?? null),
    organization: stringOrNull(candidate.organization ?? null),
  };
};

const decodeAgentQuota = (value: unknown): AgentQuota => {
  const candidate = record(value);
  const sources = candidate.sources;
  const windows = candidate.windows;
  if (!Array.isArray(sources) || !Array.isArray(windows)) invalidResponse();
  const status = candidate.status;
  if (status !== "known" && status !== "unknown") invalidResponse();
  const percentRemaining = candidate.percentRemaining === null || candidate.percentRemaining === undefined
    ? null
    : percentage(candidate.percentRemaining);
  // A "known" reading without a number would draw an arc over nothing.
  if (status === "known" && percentRemaining === null) invalidResponse();
  return {
    provider: string(candidate.provider),
    label: string(candidate.label),
    sources: (sources as unknown[]).map(string),
    status: status as "known" | "unknown",
    account: decodeQuotaAccount(candidate.account),
    plan: stringOrNull(candidate.plan ?? null),
    percentRemaining,
    bindingWindowId: stringOrNull(candidate.bindingWindowId ?? null),
    windows: (windows as unknown[]).map(decodeQuotaWindow),
    detail: stringOrNull(candidate.detail ?? null),
    reason: stringOrNull(candidate.reason ?? null),
    stale: boolean(candidate.stale),
  };
};

export const decodeQuotaSnapshot = (value: unknown): QuotaSnapshot => {
  const candidate = record(value);
  const providers = candidate.providers;
  if (!Array.isArray(providers)) invalidResponse();
  const status = candidate.status;
  if (status !== "pending" && status !== "ready" && status !== "unavailable") invalidResponse();
  return {
    status: status as "pending" | "ready" | "unavailable",
    checkedAt: stringOrNull(candidate.checkedAt ?? null),
    detail: stringOrNull(candidate.detail ?? null),
    providers: (providers as unknown[]).map(decodeAgentQuota),
  };
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
    needsYou: boolean(candidate.needsYou),
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
    openSpan: candidate.openSpan === null || candidate.openSpan === undefined
      ? null
      : { processName: string(record(candidate.openSpan).processName), since: timestamp(record(candidate.openSpan).since) },
    agentSessions: (Array.isArray(candidate.agentSessions) ? candidate.agentSessions : []).map((entry) => {
      const session = record(entry);
      return {
        source: string(session.source),
        externalSessionId: string(session.externalSessionId),
        projectId: uuidOrNull(session.projectId ?? null),
        since: timestamp(session.since),
      };
    }),
    selectedProjectId: uuidOrNull(candidate.selectedProjectId),
  };
};

const decodeBrowserHealth = (value: unknown): BrowserHealth => {
  const candidate = record(value);
  const state = string(candidate.state);
  if (
    state !== "disabled"
    && state !== "never-registered"
    && state !== "binary-missing"
    && state !== "registered"
    && state !== "connected"
  ) invalidResponse();
  return {
    browser: string(candidate.browser),
    label: string(candidate.label),
    state: state as BrowserHealthState,
    storeUrl: string(candidate.storeUrl),
  };
};

const decodeBrowserHealthList = (value: unknown): BrowserHealth[] => {
  if (!Array.isArray(value)) invalidResponse();
  return (value as unknown[]).map(decodeBrowserHealth);
};

export const decodeMonitorSettings = (value: unknown): MonitorSettings => {
  const candidate = record(value);
  return {
    enabled: boolean(candidate.enabled),
    awayThresholdMinutes: nonnegativeInteger(candidate.awayThresholdMinutes),
    agentOverrideEnabled: boolean(candidate.agentOverrideEnabled),
    browserAutoInstall: boolean(candidate.browserAutoInstall),
    agentUsageCapture: boolean(candidate.agentUsageCapture),
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

const decodeConcurrency = (value: unknown): MeStatsConcurrency => {
  const candidate = record(value);
  return {
    t0Seconds: nonnegativeInteger(candidate.t0Seconds),
    t1Seconds: nonnegativeInteger(candidate.t1Seconds),
    t2Seconds: nonnegativeInteger(candidate.t2Seconds),
    t3PlusSeconds: nonnegativeInteger(candidate.t3PlusSeconds),
    awaySeconds: nonnegativeInteger(candidate.awaySeconds),
  };
};

const decodeAgentSplit = (value: unknown): MeStatsAgentSplit => {
  const candidate = record(value);
  return {
    source: string(candidate.source),
    model: stringOrNull(candidate.model ?? null),
    durationSeconds: nonnegativeInteger(candidate.durationSeconds),
  };
};

const decodeHourlyBucket = (value: unknown): MeStatsHourlyBucket => {
  const candidate = record(value);
  return {
    hourStart: string(candidate.hourStart),
    activeSeconds: nonnegativeInteger(candidate.activeSeconds),
    agentSeconds: nonnegativeInteger(candidate.agentSeconds),
    // Absent on an older API decodes to null - absence shown as absence.
    inputTokens: nonnegativeIntegerOrNull(candidate.inputTokens),
    outputTokens: nonnegativeIntegerOrNull(candidate.outputTokens),
    cacheCreationInputTokens: nonnegativeIntegerOrNull(candidate.cacheCreationInputTokens),
    cacheReadInputTokens: nonnegativeIntegerOrNull(candidate.cacheReadInputTokens),
  };
};

export const decodeMeStats = (value: unknown): MeStats => {
  const candidate = record(value);
  const filters = record(candidate.filters);
  const projects = candidate.projects;
  const apps = candidate.apps;
  const byAgent = candidate.byAgent;
  const hourly = candidate.hourly;
  const agents = candidate.agents;
  if (!Array.isArray(projects) || !Array.isArray(apps) || !Array.isArray(byAgent)) invalidResponse();
  if (hourly !== undefined && hourly !== null && !Array.isArray(hourly)) invalidResponse();
  if (agents !== undefined && agents !== null && !Array.isArray(agents)) invalidResponse();
  const totalDurationSeconds = nonnegativeInteger(candidate.totalDurationSeconds);
  const attributedSeconds = nonnegativeInteger(candidate.attributedSeconds);
  if (attributedSeconds > totalDurationSeconds) invalidResponse();
  return {
    filters: { from: optionalString(filters.from), to: optionalString(filters.to) },
    totalDurationSeconds,
    attributedSeconds,
    unattributedSeconds: nonnegativeInteger(candidate.unattributedSeconds),
    activeSeconds: nonnegativeInteger(candidate.activeSeconds),
    agentSeconds: nonnegativeInteger(candidate.agentSeconds),
    concurrency: decodeConcurrency(candidate.concurrency),
    byAgent: (byAgent as unknown[]).map(decodeAgentSplit),
    hourly: (Array.isArray(hourly) ? hourly : []).map(decodeHourlyBucket),
    projects: (projects as unknown[]).map(decodeMeStatsProject),
    apps: (apps as unknown[]).map(decodeMeStatsApp),
    // Absent on an older API decodes as none known, never an error.
    agents: (Array.isArray(agents) ? agents : []).map(decodeMeStatsAgentActivity),
  };
};

/// Only the fields the charts read; the rest of the row is the web's business.
const decodeMeStatsAgentActivity = (value: unknown): MeStatsAgentActivity => {
  const candidate = record(value);
  const agent = record(candidate.agent);
  return {
    source: string(agent.source),
    shiftCount: nonnegativeInteger(candidate.shiftCount),
    // Absent on an older API means it cannot say, which decodes to null.
    tokensReported: candidate.tokensReported === undefined || candidate.tokensReported === null
      ? null
      : boolean(candidate.tokensReported),
  };
};

/// Token totals an older API may not send yet decode to null, not zeros.
const decodeTokenTotalsOrNull = (value: unknown): TokenTotals | null => {
  if (value === undefined || value === null) return null;
  const candidate = record(value);
  return {
    inputTokens: nonnegativeInteger(candidate.inputTokens),
    outputTokens: nonnegativeInteger(candidate.outputTokens),
    cacheCreationInputTokens: nonnegativeInteger(candidate.cacheCreationInputTokens),
    cacheReadInputTokens: nonnegativeInteger(candidate.cacheReadInputTokens),
  };
};

const decodeAgentShiftRow = (value: unknown): AgentShiftRow => {
  const candidate = record(value);
  const owner = record(candidate.owner);
  return {
    id: uuid(candidate.id),
    source: string(candidate.source),
    owner: { id: uuid(owner.id), name: string(owner.name) },
    model: stringOrNull(candidate.model),
    startedAt: string(candidate.startedAt),
    endedAt: string(candidate.endedAt),
    agentSeconds: nonnegativeInteger(candidate.agentSeconds),
    commitCount: nonnegativeInteger(candidate.commitCount ?? 0),
  };
};

/// An absent group list decodes to none, never a crash: the deployed API can
/// be older than this build, and an Agents tab with nothing to say beats one
/// that dies decoding.
export const decodeAgentShifts = (value: unknown): AgentShifts => {
  const candidate = record(value);
  return {
    totalAgentSeconds: nonnegativeInteger(candidate.totalAgentSeconds ?? 0),
    groups: (Array.isArray(candidate.groups) ? candidate.groups : []).map((entry) => {
      const group = record(entry);
      return {
        repo: stringOrNull(group.repo),
        agentSeconds: nonnegativeInteger(group.agentSeconds ?? 0),
        shiftCount: nonnegativeInteger(group.shiftCount ?? 0),
        heldRate: unitRateOrNull(group.heldRate),
        shifts: (Array.isArray(group.shifts) ? group.shifts : []).map(decodeAgentShiftRow),
      };
    }),
  };
};

export const decodeViewPreferences = (value: unknown): ViewPreferences => {
  const candidate = record(value);
  return { scope: string(candidate.scope), range: string(candidate.range) };
};

export const decodeProjectUsage = (value: unknown): ProjectUsage => {
  const candidate = record(value);
  return {
    sessionCount: nonnegativeInteger(candidate.sessionCount),
    durationSeconds: nonnegativeInteger(candidate.durationSeconds),
    agentSessionCount: nonnegativeInteger(candidate.agentSessionCount),
  };
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
  orgOverview: (fromAt, toExclusiveAt, scope) => invokeDecoded("org_overview", decodeOrganizationOverview, { fromAt, toExclusiveAt, scope }),
  preferencesGet: () => invokeDecoded("preferences_get", decodeViewPreferences),
  preferencesSet: (input) => invokeDecoded("preferences_set", decodeViewPreferences, { input }),
  orgJoin: (inviteCode) => invokeDecoded("org_join", decodeOrganizationOverview, { input: { inviteCode } }),
  monitorStatus: () => invokeDecoded("monitor_status", decodeMonitorStatus),
  browserStatus: () => invokeDecoded("browser_status", decodeBrowserHealthList),
  browserRepair: (browserId) => invokeDecoded("browser_repair", decodeBrowserHealth, { browserId }),
  browserOpenStore: (browserId) => invokeDecoded("browser_open_store", decodeVoid, { browserId }),
  sessionSelectProject: (projectId) => invokeDecoded("session_select_project", decodeMonitorStatus, { projectId }),
  hookRegister: (source) => invokeDecoded("hook_register", decodeHookRegisterResult, { source }),
  monitorSetEnabled: (enabled) => invokeDecoded("monitor_set_enabled", decodeMonitorSettings, { enabled }),
  settingsGet: () => invokeDecoded("settings_get", decodeMonitorSettings),
  settingsUpdate: (input) => invokeDecoded("settings_update", decodeMonitorSettings, { input }),
  meStats: (fromAt, toExclusiveAt, userId, scope) => invokeDecoded("me_stats", decodeMeStats, { fromAt, toExclusiveAt, userId, scope }),
  agentShifts: (fromAt, toExclusiveAt) => invokeDecoded("agent_shifts", decodeAgentShifts, { fromAt, toExclusiveAt }),
  projectCreate: (input) => invokeDecoded("project_create", decodeProject, { input }),
  projectUpdate: (id, input) => invokeDecoded("project_update", decodeProject, { id, input }),
  projectUsage: (id) => invokeDecoded("project_usage", decodeProjectUsage, { id }),
  projectDelete: (id, reassignTo) => invokeDecoded("project_delete", decodeVoid, { id, reassignTo }),
  appIcons: (processNames) => invokeDecoded("app_icons", decodeAppIcons, { processNames }),
  quotaStatus: () => invokeDecoded("quota_status", decodeQuotaSnapshot),
  onUpdateAvailable: async (handler) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<string>("update-available", (event) => handler(event.payload));
  },
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
