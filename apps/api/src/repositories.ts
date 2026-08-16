import type { ActivitySegmentKind, AgentSource, SessionAttribution } from "@clock-in/shared";

import type { AuthenticatedSubject } from "./auth.js";

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  archived: boolean;
  /** Where automatic time lands when nothing names a project; refuses deletion. */
  isDefault: boolean;
  createdAt: Date;
}

export interface SessionRecord {
  id: string;
  organizationId: string;
  userId: string;
  clientId: string;
  projectId: string;
  description: string | null;
  status: "running" | "stopped" | "needs_review";
  startedAt: Date;
  stoppedAt: Date | null;
  idleSeconds: number;
  durationSeconds: number | null;
  attribution: SessionAttribution;
}

export interface ProjectUsageRecord {
  sessionCount: number;
  durationSeconds: number;
  agentSessionCount: number;
  /** Roster identities filed under the project; deleting moves or retires them. */
  agentCount: number;
}

export interface ProjectRepository {
  listForMember(subject: AuthenticatedSubject): Promise<ProjectRecord[]>;
  findForMember(subject: AuthenticatedSubject, projectId: string): Promise<ProjectRecord | null>;
  /** Creates the project and the creator's membership in one transaction. */
  createForMember(subject: AuthenticatedSubject, name: string): Promise<ProjectRecord>;
  /** Renames or archives; null when the project is not the caller's to change. */
  updateForMember?(subject: AuthenticatedSubject, projectId: string, patch: { name?: string; archived?: boolean }): Promise<ProjectRecord | null>;
  /** What deleting the project would take with it, for the confirm dialog. */
  usageForOrganization?(subject: AuthenticatedSubject, projectId: string): Promise<ProjectUsageRecord>;
  /**
   * Deletes the project. `reassignTo` moves its sessions and agent evidence to
   * another project first (creating the memberships that move needs); null
   * deletes them with the project. One transaction.
   */
  deleteForOrganization?(subject: AuthenticatedSubject, projectId: string, reassignTo: string | null): Promise<void>;
  /** @deprecated Returns the member's preferred (default) project. */
  preferredForMember?(subject: AuthenticatedSubject): Promise<ProjectRecord | null>;
  /** @deprecated Records the member's last selected project. */
  rememberSelection?(subject: AuthenticatedSubject, projectId: string): Promise<void>;
}

export interface ViewPreferencesRecord {
  scope: string;
  range: string;
}

/** The one dashboard view state both surfaces share; one row per member, last write wins. */
export interface ViewPreferencesRepository {
  readForMember(subject: AuthenticatedSubject): Promise<ViewPreferencesRecord | null>;
  writeForMember(subject: AuthenticatedSubject, patch: { scope?: string | undefined; range?: string | undefined }): Promise<ViewPreferencesRecord>;
}

export interface CreateRunningSession {
  organizationId: string;
  userId: string;
  clientId: string;
  projectId: string;
  description: string | null;
  startedAt: Date;
}

/**
 * One finished session the desktop observed. It arrives complete: the monitor
 * decided the boundaries and the project before uploading, so the server never
 * holds an open observed session.
 */
export interface ObservedSessionInsert {
  organizationId: string;
  userId: string;
  clientId: string;
  projectId: string;
  attribution: Exclude<SessionAttribution, "manual">;
  startedAt: Date;
  stoppedAt: Date;
  idleSeconds: number;
  durationSeconds: number;
  status: "stopped" | "needs_review";
}

export interface StopRunningSession {
  stoppedAt: Date;
  idleSeconds: number;
  durationSeconds: number;
  status: "stopped" | "needs_review";
  updatedAt: Date;
}

export type SessionRepositoryConflict = "session_already_running" | "client_id";

export class SessionRepositoryError extends Error {
  public constructor(public readonly conflict: SessionRepositoryConflict) {
    super(conflict);
    this.name = "SessionRepositoryError";
  }
}

export interface SessionRepository {
  findByClientId(subject: AuthenticatedSubject, clientId: string): Promise<SessionRecord | null>;
  findRunning(subject: AuthenticatedSubject): Promise<SessionRecord | null>;
  findById(subject: AuthenticatedSubject, sessionId: string): Promise<SessionRecord | null>;
  createRunning(input: CreateRunningSession): Promise<SessionRecord>;
  stopRunning(subject: AuthenticatedSubject, sessionId: string, input: StopRunningSession): Promise<SessionRecord | null>;
  /** Inserts finished observed sessions, ignoring client ids already stored, so replays are safe. */
  insertObservedBatch(sessions: ObservedSessionInsert[]): Promise<void>;
}

export interface ReportLookupRecord {
  id: string;
  name: string;
}

export interface ReportRowRecord {
  id: string;
  user: ReportLookupRecord;
  project: ReportLookupRecord;
  description: string | null;
  status: "stopped" | "needs_review";
  startedAt: Date;
  stoppedAt: Date;
  idleSeconds: number;
  durationSeconds: number;
  /** How the session learned its project; everything but `default` is attributed time. */
  attribution: SessionAttribution;
}

export interface ReportQuery {
  from?: Date;
  toExclusive?: Date;
  projectId?: string;
  userId?: string;
  /** The dashboard's Unassigned scope: only sessions nothing named a project for. */
  unassignedOnly?: boolean;
}

export interface ReportPageOptions {
  limit: number;
  offset: number;
}

export interface ReportSummaryRecord {
  totalRows: number | string | bigint;
  totalDurationSeconds: number | string | bigint | null;
}

export interface ReportPageRead {
  summary: ReportSummaryRecord;
  rows: ReportRowRecord[];
}

export interface ReportExportRead {
  summary: ReportSummaryRecord;
  rows?: ReportRowRecord[];
}

export interface LeaderboardRowRecord {
  user: ReportLookupRecord;
  durationSeconds: number | string | bigint | null;
  sessionCount: number | string | bigint;
  /** Duration summed over sessions whose project was named by something; sql sums surface as string/bigint. */
  attributedSeconds: number | string | bigint | null;
}

export interface ProjectTotalRecord {
  project: ReportLookupRecord;
  durationSeconds: number | string | bigint | null;
  attributedSeconds: number | string | bigint | null;
  sessionCount: number | string | bigint;
}

export interface AppTotalRecord {
  processName: string;
  /** sql sums surface as string/bigint. */
  durationSeconds: number | string | bigint | null;
}

export interface SiteTotalRecord {
  mapping: {
    id: string;
    /** The url-rule pattern, stored in the mapping's pathPrefix column. */
    pattern: string;
    projectId: string | null;
  };
  /** sql sums surface as string/bigint. */
  durationSeconds: number | string | bigint | null;
}

/** One person's machine-presence interval — an active OS segment, no project attached. */
export interface PresenceIntervalRecord {
  user: ReportLookupRecord;
  startedAt: Date;
  endedAt: Date;
}

/** One completed session's interval, with what the time model needs to scope and count it. */
export interface SessionIntervalRecord {
  user: ReportLookupRecord;
  projectId: string;
  attribution: SessionAttribution;
  startedAt: Date;
  stoppedAt: Date;
}

/** One agent session's runtime interval; running sessions end at their last event. */
export interface AgentIntervalRecord {
  user: ReportLookupRecord;
  source: string;
  model: string | null;
  projectId: string | null;
  /** Null for legacy sessions recorded before roster minting shipped. */
  agentId: string | null;
  startedAt: Date;
  endedAt: Date;
}

export interface ReportRepository {
  findProjectForOrganization(subject: AuthenticatedSubject, projectId: string): Promise<ReportLookupRecord | null>;
  findUserForOrganization(subject: AuthenticatedSubject, userId: string): Promise<ReportLookupRecord | null>;
  /** Active-kind OS segments overlapping the range, org-wide or one member. Presence carries no project, so project scopes intersect these with session intervals in the service. */
  readPresenceIntervals(subject: AuthenticatedSubject, query: ReportQuery): Promise<PresenceIntervalRecord[]>;
  /** Completed sessions overlapping the range, after project/unassigned scoping. */
  readSessionIntervals(subject: AuthenticatedSubject, query: ReportQuery): Promise<SessionIntervalRecord[]>;
  /** Agent-session runtimes overlapping the range, after project scoping. */
  readAgentIntervals(subject: AuthenticatedSubject, query: ReportQuery): Promise<AgentIntervalRecord[]>;
  readPageForOrganization(subject: AuthenticatedSubject, query: ReportQuery, options: ReportPageOptions): Promise<ReportPageRead>;
  readExportForOrganization(subject: AuthenticatedSubject, query: ReportQuery, maxRows: number): Promise<ReportExportRead>;
  readLeaderboardForOrganization(subject: AuthenticatedSubject, query: ReportQuery): Promise<LeaderboardRowRecord[]>;
  /** Every member of the workspace, so the board can list them all - zeros included. */
  readMembersForOrganization(subject: AuthenticatedSubject): Promise<ReportLookupRecord[]>;
  /** Per-project totals for one member — the reporting math scoped to the caller for /me/stats. */
  readProjectTotalsForMember(subject: AuthenticatedSubject, query: ReportQuery): Promise<ProjectTotalRecord[]>;
  /** Per-foreground-process totals for one member from active segments, for the /me/stats app breakdown. */
  readAppTotalsForMember(subject: AuthenticatedSubject, query: ReportQuery): Promise<AppTotalRecord[]>;
  /** Per-url-rule browser-span totals for one member, clipped to fresh active segments, for /me/stats. */
  readSiteTotalsForMember(subject: AuthenticatedSubject, query: ReportQuery): Promise<SiteTotalRecord[]>;
}

export interface ActivitySegmentInsert {
  organizationId: string;
  userId: string;
  clientId: string;
  deviceId: string;
  kind: ActivitySegmentKind;
  processName: string | null;
  startedAt: Date;
  endedAt: Date;
  receivedAt: Date;
}

export interface ActivitySegmentRepository {
  /** Inserts segments, ignoring rows whose client id was already uploaded, so replays are safe. */
  insertBatch(segments: ActivitySegmentInsert[]): Promise<void>;
}

export type AgentStatus = "anonymous" | "registered" | "retired";

/** One roster identity, with its owner and project already looked up for display. */
export interface AgentRecord {
  id: string;
  organizationId: string;
  name: string;
  source: AgentSource;
  status: AgentStatus;
  owner: ReportLookupRecord;
  project: ReportLookupRecord | null;
  createdAt: Date;
}

export interface UpsertAgentForKey {
  organizationId: string;
  ownerUserId: string;
  source: AgentSource;
  projectId: string | null;
  /**
   * The runtime's display label. The insert path composes the row's default
   * name from it and the project's name ("<label> @ <project|unassigned>");
   * a replay never overwrites the name, owner, or status already stored.
   */
  name: string;
  now: Date;
}

export interface AgentUpdatePatch {
  name?: string;
  status?: "registered" | "retired";
  ownerUserId?: string;
  updatedAt: Date;
}

/** One shift on an agent's paystub; a running shift's effective end is its last event. */
export interface AgentShiftRecord {
  id: string;
  model: string | null;
  status: "running" | "ended";
  startedAt: Date;
  endedAt: Date | null;
  lastEventAt: Date;
}

export interface AgentRepository {
  /** Mints or finds the identity for (org, source, project); replay yields the same id. */
  upsertForKey(input: UpsertAgentForKey): Promise<{ id: string }>;
  listForOrganization(subject: AuthenticatedSubject): Promise<AgentRecord[]>;
  findById(subject: AuthenticatedSubject, agentId: string): Promise<AgentRecord | null>;
  /** Applies the patch; null when the agent is not in the caller's organization. */
  update(subject: AuthenticatedSubject, agentId: string, patch: AgentUpdatePatch): Promise<AgentRecord | null>;
  /** Re-points the loser's shifts at the winner and retires the loser, in one transaction. */
  merge(subject: AuthenticatedSubject, winnerId: string, loserId: string): Promise<void>;
  /** This agent's shifts overlapping the range, newest first; running shifts overlap up to lastEventAt. */
  listSessionsForAgent(subject: AuthenticatedSubject, agentId: string, query: ReportQuery): Promise<AgentShiftRecord[]>;
}

export interface AgentSessionRecord {
  id: string;
  organizationId: string;
  userId: string;
  source: AgentSource;
  /** What the runtime was driving, when its hook said so; never inferred from the runtime. */
  model: string | null;
  externalSessionId: string;
  projectId: string | null;
  cwd: string | null;
  /** The matched url-rule mapping id for browser spans; null for agent events. */
  ruleId: string | null;
  /** The roster identity this shift belongs to; legacy rows stay null. */
  agentId: string | null;
  status: "running" | "ended";
  startedAt: Date;
  endedAt: Date | null;
  lastEventAt: Date;
  linkedSessionId: string | null;
}

export interface UpsertStartedAgentSession {
  organizationId: string;
  userId: string;
  source: AgentSource;
  model: string | null;
  externalSessionId: string;
  cwd: string | null;
  ruleId: string | null;
  projectId: string | null;
  agentId: string | null;
  linkedSessionId: string | null;
  occurredAt: Date;
  receivedAt: Date;
}

export interface InsertEndedAgentSession {
  organizationId: string;
  userId: string;
  source: AgentSource;
  model: string | null;
  externalSessionId: string;
  cwd: string | null;
  ruleId: string | null;
  projectId: string | null;
  agentId: string | null;
  occurredAt: Date;
  receivedAt: Date;
}

export interface AgentSessionRepository {
  findByExternalKey(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string): Promise<AgentSessionRecord | null>;
  /** Inserts a running row; a replayed start only refreshes lastEventAt and never reopens an ended row. */
  upsertStarted(input: UpsertStartedAgentSession): Promise<AgentSessionRecord>;
  /** Closes a running row at endedAt; returns null when no running row matches the key. */
  closeRunning(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string, endedAt: Date, now: Date): Promise<AgentSessionRecord | null>;
  /** Tolerated end-before-start: stores the row directly as ended at occurredAt. */
  insertEnded(input: InsertEndedAgentSession): Promise<void>;
  /**
   * Advances lastEventAt on a running row; false when nothing matched (unknown
   * or already ended). A heartbeat naming a model fills a still-null model;
   * an existing model is never overwritten (first assignment wins).
   */
  advanceLastEvent(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string, model: string | null, occurredAt: Date, now: Date): Promise<boolean>;
  /** Closes running rows whose lastEventAt is older than cutoff, ending them at lastEventAt. Returns the reaped count. */
  reapStale(subject: AuthenticatedSubject, cutoff: Date, now: Date): Promise<number>;
  /**
   * Assigns an identity to a session whose agent_id is still null - how a
   * shift that started before the roster existed takes commits after it. The
   * guard keeps the first assignment: an already-stamped row never changes.
   */
  stampAgent(subject: AuthenticatedSubject, sessionId: string, agentId: string, now: Date): Promise<void>;
}

export type ShiftCommitVerificationState = "pending" | "merged" | "reverted" | "orphaned";

export interface ShiftCommitRecord {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  agentSessionId: string;
  clientId: string;
  repoRoot: string;
  branch: string | null;
  sha: string;
  subject: string;
  authoredAt: Date;
  verification: ShiftCommitVerificationState;
  verifiedAt: Date | null;
}

export interface InsertShiftCommit {
  organizationId: string;
  userId: string;
  agentId: string;
  agentSessionId: string;
  clientId: string;
  repoRoot: string;
  branch: string | null;
  sha: string;
  subject: string;
  authoredAt: Date;
  verification: ShiftCommitVerificationState;
  verifiedAt: Date | null;
  recordedAt: Date;
}

/** One agent's commit tally over a range, for the pay-run report and paystub totals. */
export interface ShiftCommitCountsRecord {
  agentId: string;
  recorded: number | string | bigint;
  pending: number | string | bigint;
  merged: number | string | bigint;
  reverted: number | string | bigint;
  orphaned: number | string | bigint;
}

export interface ShiftCommitRepository {
  findByClientId(subject: AuthenticatedSubject, clientId: string): Promise<ShiftCommitRecord | null>;
  /**
   * Inserts with ON CONFLICT DO NOTHING and no target: whichever unique
   * absorbs the row - client replay or same-agent same-sha - the answer is
   * "duplicate", which the service treats as an accepted no-op.
   */
  insert(input: InsertShiftCommit): Promise<"inserted" | "duplicate">;
  /** Advances pending -> decided, setting verifiedAt once; a decided row never moves again. */
  advanceVerification(
    subject: AuthenticatedSubject,
    commitId: string,
    verification: Exclude<ShiftCommitVerificationState, "pending">,
    verifiedAt: Date,
    now: Date,
  ): Promise<boolean>;
  /** Per-agent commit tallies over the range (authoredAt bounds). */
  countsByAgent(subject: AuthenticatedSubject, query: ReportQuery): Promise<ShiftCommitCountsRecord[]>;
  /** One agent's commits in the range (authoredAt bounds), for the paystub. */
  listForAgent(subject: AuthenticatedSubject, agentId: string, query: ReportQuery): Promise<ShiftCommitRecord[]>;
}

export interface AgentUsageRecord {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  agentSessionId: string;
  clientId: string;
  bucketStartAt: Date;
  model: string | null;
  sidechain: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface UpsertAgentUsageBucket {
  organizationId: string;
  userId: string;
  agentId: string;
  agentSessionId: string;
  clientId: string;
  bucketStartAt: Date;
  model: string | null;
  sidechain: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  recordedAt: Date;
}

export interface AgentUsageRepository {
  findByClientId(subject: AuthenticatedSubject, clientId: string): Promise<AgentUsageRecord | null>;
  /**
   * Inserts the bucket row or, on the (org, session, bucket, model, sidechain)
   * conflict, moves each counter to GREATEST(existing, incoming): counters are
   * cumulative totals, so a re-read of the same transcript region can only
   * restate a number upward, never add to it.
   */
  upsertBucket(input: UpsertAgentUsageBucket): Promise<void>;
}

export interface PathMappingRecord {
  id: string;
  organizationId: string;
  userId: string;
  kind: "path_prefix" | "url_rule";
  pathPrefix: string;
  repoUrl: string | null;
  projectId: string;
}

export interface CreatePathMapping {
  organizationId: string;
  userId: string;
  kind: "path_prefix" | "url_rule";
  pathPrefix: string;
  repoUrl: string | null;
  projectId: string;
}

export interface UpdatePathMapping {
  kind?: "path_prefix" | "url_rule";
  pathPrefix?: string;
  repoUrl?: string | null;
  projectId?: string;
  updatedAt: Date;
}

export type PathMappingRepositoryConflict = "path_prefix";

export class PathMappingRepositoryError extends Error {
  public constructor(public readonly conflict: PathMappingRepositoryConflict) {
    super(conflict);
    this.name = "PathMappingRepositoryError";
  }
}

export interface PathMappingRepository {
  listForSubject(subject: AuthenticatedSubject): Promise<PathMappingRecord[]>;
  findById(subject: AuthenticatedSubject, mappingId: string): Promise<PathMappingRecord | null>;
  findByPathPrefix(subject: AuthenticatedSubject, pathPrefix: string): Promise<PathMappingRecord | null>;
  create(input: CreatePathMapping): Promise<PathMappingRecord>;
  update(subject: AuthenticatedSubject, mappingId: string, input: UpdatePathMapping): Promise<PathMappingRecord | null>;
  remove(subject: AuthenticatedSubject, mappingId: string): Promise<boolean>;
}
