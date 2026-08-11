import type { ActivitySegmentKind, AgentSource, SessionAttribution } from "@clock-in/shared";

import type { AuthenticatedSubject } from "./auth.js";

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  archived: boolean;
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

export interface ProjectRepository {
  listForMember(subject: AuthenticatedSubject): Promise<ProjectRecord[]>;
  findForMember(subject: AuthenticatedSubject, projectId: string): Promise<ProjectRecord | null>;
  /** Creates the project and the creator's membership in one transaction. */
  createForMember(subject: AuthenticatedSubject, name: string): Promise<ProjectRecord>;
  /** @deprecated Returns the member's preferred (default) project. */
  preferredForMember?(subject: AuthenticatedSubject): Promise<ProjectRecord | null>;
  /** @deprecated Records the member's last selected project. */
  rememberSelection?(subject: AuthenticatedSubject, projectId: string): Promise<void>;
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

export interface ReportRepository {
  findProjectForOrganization(subject: AuthenticatedSubject, projectId: string): Promise<ReportLookupRecord | null>;
  findUserForOrganization(subject: AuthenticatedSubject, userId: string): Promise<ReportLookupRecord | null>;
  readPageForOrganization(subject: AuthenticatedSubject, query: ReportQuery, options: ReportPageOptions): Promise<ReportPageRead>;
  readExportForOrganization(subject: AuthenticatedSubject, query: ReportQuery, maxRows: number): Promise<ReportExportRead>;
  readLeaderboardForOrganization(subject: AuthenticatedSubject, query: ReportQuery): Promise<LeaderboardRowRecord[]>;
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

export interface AgentSessionRecord {
  id: string;
  organizationId: string;
  userId: string;
  source: AgentSource;
  externalSessionId: string;
  projectId: string | null;
  cwd: string;
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
  externalSessionId: string;
  cwd: string;
  projectId: string | null;
  linkedSessionId: string | null;
  occurredAt: Date;
  receivedAt: Date;
}

export interface InsertEndedAgentSession {
  organizationId: string;
  userId: string;
  source: AgentSource;
  externalSessionId: string;
  cwd: string;
  projectId: string | null;
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
  /** Advances lastEventAt on a running row; false when nothing matched (unknown or already ended). */
  advanceLastEvent(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string, occurredAt: Date, now: Date): Promise<boolean>;
  /** Closes running rows whose lastEventAt is older than cutoff, ending them at lastEventAt. Returns the reaped count. */
  reapStale(subject: AuthenticatedSubject, cutoff: Date, now: Date): Promise<number>;
}

export interface PathMappingRecord {
  id: string;
  organizationId: string;
  userId: string;
  pathPrefix: string;
  repoUrl: string | null;
  projectId: string;
}

export interface CreatePathMapping {
  organizationId: string;
  userId: string;
  pathPrefix: string;
  repoUrl: string | null;
  projectId: string;
}

export interface UpdatePathMapping {
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
