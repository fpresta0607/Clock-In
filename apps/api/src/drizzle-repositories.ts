import { and, asc, eq } from "drizzle-orm";
import {
  projectMemberships,
  projects,
  timeSessions,
  type DatabaseConnection,
} from "@clock-in/database";

import type { AuthenticatedSubject } from "./auth.js";
import {
  SessionRepositoryError,
  type CreateRunningSession,
  type ProjectRecord,
  type ProjectRepository,
  type SessionRecord,
  type SessionRepository,
  type StopRunningSession,
} from "./repositories.js";

function asSessionRecord(row: typeof timeSessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    clientId: row.clientId,
    projectId: row.projectId,
    description: row.description,
    status: row.status,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    idleSeconds: row.idleSeconds,
    durationSeconds: row.durationSeconds,
  };
}

function uniqueConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  return record.code === "23505" && typeof record.constraint_name === "string" ? record.constraint_name : null;
}

function mapCreateError(error: unknown): SessionRepositoryError | null {
  const constraint = uniqueConstraint(error);
  if (constraint === "time_sessions_one_running_user_unique") return new SessionRepositoryError("session_already_running");
  if (constraint === "time_sessions_organization_user_client_unique") return new SessionRepositoryError("client_id");
  return null;
}

export class DrizzleProjectRepository implements ProjectRepository {
  public constructor(private readonly db: DatabaseConnection["db"]) {}

  public async listForMember(subject: AuthenticatedSubject): Promise<ProjectRecord[]> {
    return this.db
      .select({ id: projects.id, organizationId: projects.organizationId, name: projects.name, archived: projects.archived })
      .from(projects)
      .innerJoin(projectMemberships, and(
        eq(projectMemberships.organizationId, projects.organizationId),
        eq(projectMemberships.projectId, projects.id),
      ))
      .where(and(
        eq(projects.organizationId, subject.organizationId),
        eq(projectMemberships.userId, subject.userId),
        eq(projectMemberships.organizationId, subject.organizationId),
        eq(projects.archived, false),
      ))
      .orderBy(asc(projects.name), asc(projects.id));
  }

  public async findForMember(subject: AuthenticatedSubject, projectId: string): Promise<ProjectRecord | null> {
    const rows = await this.db
      .select({ id: projects.id, organizationId: projects.organizationId, name: projects.name, archived: projects.archived })
      .from(projects)
      .innerJoin(projectMemberships, and(
        eq(projectMemberships.organizationId, projects.organizationId),
        eq(projectMemberships.projectId, projects.id),
      ))
      .where(and(
        eq(projects.id, projectId),
        eq(projects.organizationId, subject.organizationId),
        eq(projectMemberships.organizationId, subject.organizationId),
        eq(projectMemberships.userId, subject.userId),
      ))
      .limit(1);
    return rows[0] ?? null;
  }
}

export class DrizzleSessionRepository implements SessionRepository {
  public constructor(private readonly db: DatabaseConnection["db"]) {}

  public async findByClientId(subject: AuthenticatedSubject, clientId: string): Promise<SessionRecord | null> {
    const rows = await this.db.select().from(timeSessions).where(and(
      eq(timeSessions.organizationId, subject.organizationId),
      eq(timeSessions.userId, subject.userId),
      eq(timeSessions.clientId, clientId),
    )).limit(1);
    return rows[0] === undefined ? null : asSessionRecord(rows[0]);
  }

  public async findRunning(subject: AuthenticatedSubject): Promise<SessionRecord | null> {
    const rows = await this.db.select().from(timeSessions).where(and(
      eq(timeSessions.organizationId, subject.organizationId),
      eq(timeSessions.userId, subject.userId),
      eq(timeSessions.status, "running"),
    )).limit(1);
    return rows[0] === undefined ? null : asSessionRecord(rows[0]);
  }

  public async findById(subject: AuthenticatedSubject, sessionId: string): Promise<SessionRecord | null> {
    const rows = await this.db.select().from(timeSessions).where(and(
      eq(timeSessions.id, sessionId),
      eq(timeSessions.organizationId, subject.organizationId),
      eq(timeSessions.userId, subject.userId),
    )).limit(1);
    return rows[0] === undefined ? null : asSessionRecord(rows[0]);
  }

  public async createRunning(input: CreateRunningSession): Promise<SessionRecord> {
    try {
      const rows = await this.db.transaction(async (transaction) => transaction
        .insert(timeSessions)
        .values({ ...input, status: "running", stoppedAt: null, idleSeconds: 0, durationSeconds: null })
        .returning());
      return asSessionRecord(rows[0]!);
    } catch (error) {
      const mapped = mapCreateError(error);
      if (mapped !== null) throw mapped;
      throw error;
    }
  }

  public async stopRunning(subject: AuthenticatedSubject, sessionId: string, input: StopRunningSession): Promise<SessionRecord | null> {
    const rows = await this.db.transaction(async (transaction) => transaction
      .update(timeSessions)
      .set({
        status: input.status,
        stoppedAt: input.stoppedAt,
        idleSeconds: input.idleSeconds,
        durationSeconds: input.durationSeconds,
        updatedAt: input.updatedAt,
      })
      .where(and(
        eq(timeSessions.id, sessionId),
        eq(timeSessions.organizationId, subject.organizationId),
        eq(timeSessions.userId, subject.userId),
        eq(timeSessions.status, "running"),
      ))
      .returning());
    return rows[0] === undefined ? null : asSessionRecord(rows[0]);
  }
}
