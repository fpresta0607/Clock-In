import { randomBytes } from "node:crypto";

import { generateInviteCode } from "@clock-in/shared";
import { and, asc, count, desc, eq, gte, lt, or, sum } from "drizzle-orm";
import {
  organizations,
  projectMemberships,
  projects,
  timeSessions,
  users,
  type DatabaseConnection,
} from "@clock-in/database";

import type {
  AccountStore,
  AuthenticatedSubject,
  AuthenticatedUser,
  AuthIdentity,
  OrganizationRecord,
} from "./auth.js";
import { AppError } from "./errors.js";
import {
  SessionRepositoryError,
  type CreateRunningSession,
  type LeaderboardRowRecord,
  type ProjectRecord,
  type ProjectRepository,
  type ReportExportRead,
  type ReportLookupRecord,
  type ReportPageOptions,
  type ReportPageRead,
  type ReportQuery,
  type ReportRepository,
  type ReportRowRecord,
  type ReportSummaryRecord,
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

export class DrizzleAccountStore implements AccountStore {
  public constructor(private readonly db: DatabaseConnection["db"]) {}

  public async resolve(identity: AuthIdentity, inviteCode?: string): Promise<AuthenticatedUser> {
    const existing = await this.find(identity.authUserId);
    if (existing !== null) {
      return existing.email === identity.email && existing.name === identity.name
        ? existing
        : this.syncProfile(identity);
    }
    try {
      return inviteCode === undefined
        ? await this.provision(identity)
        : await this.join(identity, inviteCode);
    } catch (error) {
      // ponytail: a concurrent first request may have provisioned this account,
      // which rolls this transaction back on the users primary key.
      const raced = await this.find(identity.authUserId);
      if (raced !== null) return raced;
      throw error;
    }
  }

  public async joinOrganization(
    subject: AuthenticatedSubject,
    inviteCode: string,
  ): Promise<AuthenticatedUser> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.inviteCode, inviteCode))
        .limit(1);
      if (target === undefined) {
        throw new AppError("not_found", "That invite code does not match an organization.");
      }

      const [current] = await tx
        .select({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId })
        .from(users)
        .where(eq(users.id, subject.userId))
        .limit(1);
      if (current === undefined) throw new AppError("not_found", "Account not found.");
      // Re-entering the same workspace is a no-op rather than an error.
      if (current.organizationId === target.id) return current;

      // A recorded session points at a project in the workspace being left, and
      // that project does not exist in the new one. Rather than invent a mapping
      // or silently drop the time, refuse and say why.
      const [recorded] = await tx
        .select({ total: count(timeSessions.id) })
        .from(timeSessions)
        .where(eq(timeSessions.userId, subject.userId));
      if (Number(recorded?.total ?? 0) > 0) {
        throw new AppError(
          "conflict",
          "This account has already recorded time in its current workspace, so it cannot be moved.",
        );
      }

      const previousOrganizationId = current.organizationId;
      await tx.delete(projectMemberships).where(eq(projectMemberships.userId, subject.userId));
      const [moved] = await tx
        .update(users)
        .set({ organizationId: target.id, updatedAt: new Date() })
        .where(eq(users.id, subject.userId))
        .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId });
      if (moved === undefined) throw new Error("Failed to move the account into its new organization.");

      const active = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.organizationId, target.id), eq(projects.archived, false)));
      if (active.length > 0) {
        await tx.insert(projectMemberships).values(
          active.map((project) => ({ organizationId: target.id, projectId: project.id, userId: moved.id })),
        );
      }

      // Drop the workspace left behind once nobody remains in it, so abandoned
      // personal organizations do not accumulate.
      const [remaining] = await tx
        .select({ total: count(users.id) })
        .from(users)
        .where(eq(users.organizationId, previousOrganizationId));
      if (Number(remaining?.total ?? 0) === 0) {
        await tx.delete(organizations).where(eq(organizations.id, previousOrganizationId));
      }

      return moved;
    });
  }

  public async findOrganization(organizationId: string): Promise<OrganizationRecord | null> {
    const rows = await this.db
      .select({ id: organizations.id, name: organizations.name, inviteCode: organizations.inviteCode })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Places a new account in the organization an invite code names, with access
   * to every project that organization is currently running.
   */
  private async join(identity: AuthIdentity, inviteCode: string): Promise<AuthenticatedUser> {
    return this.db.transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.inviteCode, inviteCode))
        .limit(1);
      if (organization === undefined) {
        throw new AppError("not_found", "That invite code does not match an organization.");
      }

      const [user] = await tx
        .insert(users)
        .values({
          id: identity.authUserId,
          organizationId: organization.id,
          email: identity.email,
          name: identity.name,
        })
        .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId });
      if (user === undefined) throw new Error("Failed to create a user for a joining account.");

      const active = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.organizationId, organization.id), eq(projects.archived, false)));
      if (active.length > 0) {
        await tx.insert(projectMemberships).values(
          active.map((project) => ({
            organizationId: organization.id,
            projectId: project.id,
            userId: user.id,
          })),
        );
      }

      return user;
    });
  }

  private async find(authUserId: string): Promise<AuthenticatedUser | null> {
    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId })
      .from(users)
      .where(eq(users.id, authUserId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async syncProfile(identity: AuthIdentity): Promise<AuthenticatedUser> {
    const rows = await this.db
      .update(users)
      .set({ email: identity.email, name: identity.name, updatedAt: new Date() })
      .where(eq(users.id, identity.authUserId))
      .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId });
    const row = rows[0];
    if (row === undefined) throw new Error("The signed-in account disappeared during profile sync.");
    return row;
  }

  private async provision(identity: AuthIdentity): Promise<AuthenticatedUser> {
    return this.db.transaction(async (tx) => {
      const [organization] = await tx
        .insert(organizations)
        .values({
          name: `${identity.name}'s workspace`,
          inviteCode: generateInviteCode((size) => randomBytes(size)),
        })
        .returning({ id: organizations.id });
      if (organization === undefined) throw new Error("Failed to create an organization for a new account.");

      const [user] = await tx
        .insert(users)
        .values({
          id: identity.authUserId,
          organizationId: organization.id,
          email: identity.email,
          name: identity.name,
        })
        .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId });
      if (user === undefined) throw new Error("Failed to create a user for a new account.");

      const [project] = await tx
        .insert(projects)
        .values({ organizationId: organization.id, name: "General" })
        .returning({ id: projects.id });
      if (project === undefined) throw new Error("Failed to create a starter project for a new account.");

      await tx
        .insert(projectMemberships)
        .values({ organizationId: organization.id, projectId: project.id, userId: user.id });

      return user;
    });
  }
}

export class DrizzleReportRepository implements ReportRepository {
  public constructor(private readonly db: DatabaseConnection["db"]) {}

  public async findProjectForOrganization(subject: AuthenticatedSubject, projectId: string): Promise<ReportLookupRecord | null> {
    const rows = await this.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, subject.organizationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  public async findUserForOrganization(subject: AuthenticatedSubject, userId: string): Promise<ReportLookupRecord | null> {
    const rows = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organizationId, subject.organizationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private predicates(subject: AuthenticatedSubject, query: ReportQuery) {
    const conditions = [
      eq(timeSessions.organizationId, subject.organizationId),
      or(eq(timeSessions.status, "stopped"), eq(timeSessions.status, "needs_review")),
    ];
    if (query.from !== undefined) conditions.push(gte(timeSessions.startedAt, query.from));
    if (query.toExclusive !== undefined) conditions.push(lt(timeSessions.startedAt, query.toExclusive));
    if (query.projectId !== undefined) conditions.push(eq(timeSessions.projectId, query.projectId));
    if (query.userId !== undefined) conditions.push(eq(timeSessions.userId, query.userId));
    return conditions;
  }

  private async summaryFor(db: Pick<DatabaseConnection["db"], "select">, subject: AuthenticatedSubject, query: ReportQuery): Promise<ReportSummaryRecord> {
    const rows = await db
      .select({ totalRows: count(timeSessions.id), totalDurationSeconds: sum(timeSessions.durationSeconds) })
      .from(timeSessions)
      .where(and(...this.predicates(subject, query)));
    return rows[0] ?? { totalRows: 0, totalDurationSeconds: 0 };
  }

  private async rowsFor(
    db: Pick<DatabaseConnection["db"], "select">,
    subject: AuthenticatedSubject,
    query: ReportQuery,
    options: ReportPageOptions,
  ): Promise<ReportRowRecord[]> {
    const conditions = [
      ...this.predicates(subject, query),
      eq(users.organizationId, subject.organizationId),
      eq(projects.organizationId, subject.organizationId),
    ];
    const rows = await db
      .select({
        id: timeSessions.id,
        userId: users.id,
        userName: users.name,
        projectId: projects.id,
        projectName: projects.name,
        description: timeSessions.description,
        status: timeSessions.status,
        startedAt: timeSessions.startedAt,
        stoppedAt: timeSessions.stoppedAt,
        idleSeconds: timeSessions.idleSeconds,
        durationSeconds: timeSessions.durationSeconds,
      })
      .from(timeSessions)
      .innerJoin(users, and(
        eq(users.organizationId, timeSessions.organizationId),
        eq(users.id, timeSessions.userId),
      ))
      .innerJoin(projects, and(
        eq(projects.organizationId, timeSessions.organizationId),
        eq(projects.id, timeSessions.projectId),
      ))
      .where(and(...conditions))
      .orderBy(desc(timeSessions.startedAt), asc(timeSessions.id))
      .limit(options.limit)
      .offset(options.offset);

    return rows.map((row) => {
      if (row.status === "running" || row.stoppedAt === null || row.durationSeconds === null) {
        throw new Error("Completed report query returned an invalid session.");
      }
      return {
        id: row.id,
        user: { id: row.userId, name: row.userName },
        project: { id: row.projectId, name: row.projectName },
        description: row.description,
        status: row.status,
        startedAt: row.startedAt,
        stoppedAt: row.stoppedAt,
        idleSeconds: row.idleSeconds,
        durationSeconds: row.durationSeconds,
      };
    });
  }

  /** One row per member who recorded time, heaviest first. */
  public async readLeaderboardForOrganization(
    subject: AuthenticatedSubject,
    query: ReportQuery,
  ): Promise<LeaderboardRowRecord[]> {
    const totalDuration = sum(timeSessions.durationSeconds);
    const rows = await this.db
      .select({
        userId: users.id,
        userName: users.name,
        durationSeconds: totalDuration,
        sessionCount: count(timeSessions.id),
      })
      .from(timeSessions)
      .innerJoin(users, and(
        eq(users.organizationId, timeSessions.organizationId),
        eq(users.id, timeSessions.userId),
      ))
      .where(and(...this.predicates(subject, query), eq(users.organizationId, subject.organizationId)))
      .groupBy(users.id, users.name)
      // id breaks ties so equal totals do not reorder between requests.
      .orderBy(desc(totalDuration), asc(users.id));

    return rows.map((row) => ({
      user: { id: row.userId, name: row.userName },
      durationSeconds: row.durationSeconds,
      sessionCount: row.sessionCount,
    }));
  }

  private async snapshot<T>(callback: (db: Pick<DatabaseConnection["db"], "select">) => Promise<T>): Promise<T> {
    return this.db.transaction(
      async (transaction) => callback(transaction),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  public readPageForOrganization(subject: AuthenticatedSubject, query: ReportQuery, options: ReportPageOptions): Promise<ReportPageRead> {
    return this.snapshot(async (db) => ({
      summary: await this.summaryFor(db, subject, query),
      rows: await this.rowsFor(db, subject, query, options),
    }));
  }

  public readExportForOrganization(subject: AuthenticatedSubject, query: ReportQuery, maxRows: number): Promise<ReportExportRead> {
    return this.snapshot(async (db) => {
      const summary = await this.summaryFor(db, subject, query);
      const totalRows = typeof summary.totalRows === "bigint"
        ? summary.totalRows
        : typeof summary.totalRows === "string" && /^\d+$/.test(summary.totalRows)
          ? BigInt(summary.totalRows)
          : typeof summary.totalRows === "number" && Number.isSafeInteger(summary.totalRows) && summary.totalRows >= 0
            ? BigInt(summary.totalRows)
            : null;
      if (totalRows === null) throw new RangeError("Invalid report row count.");
      if (totalRows > BigInt(maxRows)) return { summary };
      return { summary, rows: await this.rowsFor(db, subject, query, { limit: maxRows + 1, offset: 0 }) };
    });
  }
}
