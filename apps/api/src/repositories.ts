import type { ActivitySegmentKind, AgentSource, PathMappingKind } from "@clock-in/shared";

import type { AuthenticatedSubject } from "./auth.js";

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  archived: boolean;
  isDefault?: boolean;
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
}

export interface ProjectRepository {
  listForMember(subject: AuthenticatedSubject): Promise<ProjectRecord[]>;
  findForMember(subject: AuthenticatedSubject, projectId: string): Promise<ProjectRecord | null>;
  /** Creates the project and the creator's membership in one transaction. */
  createForMember(subject: AuthenticatedSubject, name: string): Promise<ProjectRecord>;
  /** The per-member active selection, falling back to the organization default. */
  preferredForMember?(subject: AuthenticatedSubject): Promise<ProjectRecord | null>;
  /** Records an active, member-visible project as the caller's selection. */
  rememberSelection?(subject: AuthenticatedSubject, projectId: string): Promise<void>;
  /** Admin-only project lifecycle changes, including default replacement. */
  updateForAdmin?(
    subject: AuthenticatedSubject,
    projectId: string,
    input: { name?: string; archived?: boolean; replacementProjectId?: string },
  ): Promise<ProjectRecord | null>;
}

export interface CreateRunningSession {
  organizationId: string;
  userId: string;
  clientId: string;
  projectId: string;
  description: string | null;
  startedAt: Date;
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
  /** Overlap with fresh evidence, capped at durationSeconds; sql sums surface as string/bigint. */
  corroboratedSeconds: number | string | bigint | null;
}

export interface ReportQuery {
  from?: Date;
  toExclusive?: Date;
  clipToRange?: boolean;
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
  corroboratedSeconds: number | string | bigint | null;
}

export interface ProjectTotalRecord {
  project: ReportLookupRecord;
  durationSeconds: number | string | bigint | null;
  corroboratedSeconds: number | string | bigint | null;
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
  /** Null for browser spans, which carry no working directory. */
  cwd: string | null;
  /** The url-rule mapping a browser span matched; null for agent-source rows. */
  ruleId: string | null;
  status: "running" | "ended" | "stale";
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
  cwd: string | null;
  ruleId: string | null;
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
  cwd: string | null;
  ruleId: string | null;
  projectId: string | null;
  occurredAt: Date;
  receivedAt: Date;
}

/** Browser spans heart beat every minute and reap fast; agent CLI sessions keep the long window. */
export interface AgentSessionStaleCutoffs {
  /** Running rows from non-browser sources with lastEventAt older than this close. */
  default: Date;
  /** Running browser spans with lastEventAt older than this close. */
  browser: Date;
}

export interface AgentSessionRepository {
  findByExternalKey(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string): Promise<AgentSessionRecord | null>;
  /** Inserts a running row; a replayed start only refreshes lastEventAt and never reopens a terminal row. */
  upsertStarted(input: UpsertStartedAgentSession): Promise<AgentSessionRecord>;
  /** Closes an active row at endedAt; returns null when no active row matches the key. */
  closeRunning(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string, endedAt: Date, now: Date): Promise<AgentSessionRecord | null>;
  /** Tolerated end-before-start: stores the row directly as ended at occurredAt. */
  insertEnded(input: InsertEndedAgentSession): Promise<void>;
  /** Advances lastEventAt on an active row; false when nothing matched (unknown or terminal). */
  advanceLastEvent(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string, occurredAt: Date, now: Date): Promise<boolean>;
  /** Marks active rows stale at lastEventAt when their source's cutoff elapses. Returns the reaped count. */
  reapStale(subject: AuthenticatedSubject, cutoffs: AgentSessionStaleCutoffs, now: Date): Promise<number>;
}

export interface PathMappingRecord {
  id: string;
  organizationId: string;
  userId: string;
  kind: PathMappingKind;
  pathPrefix: string;
  repoUrl: string | null;
  projectId: string;
}

export interface CreatePathMapping {
  organizationId: string;
  userId: string;
  kind: PathMappingKind;
  pathPrefix: string;
  repoUrl: string | null;
  projectId: string;
}

export interface UpdatePathMapping {
  kind?: PathMappingKind;
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
