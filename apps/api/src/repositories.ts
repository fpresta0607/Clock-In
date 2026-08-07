import type { AuthenticatedSubject } from "./auth.js";

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  archived: boolean;
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
}

export interface ReportRepository {
  findProjectForOrganization(subject: AuthenticatedSubject, projectId: string): Promise<ReportLookupRecord | null>;
  findUserForOrganization(subject: AuthenticatedSubject, userId: string): Promise<ReportLookupRecord | null>;
  readPageForOrganization(subject: AuthenticatedSubject, query: ReportQuery, options: ReportPageOptions): Promise<ReportPageRead>;
  readExportForOrganization(subject: AuthenticatedSubject, query: ReportQuery, maxRows: number): Promise<ReportExportRead>;
  readLeaderboardForOrganization(subject: AuthenticatedSubject, query: ReportQuery): Promise<LeaderboardRowRecord[]>;
}
