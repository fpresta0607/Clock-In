import { randomBytes } from "node:crypto";

import { generateInviteCode, type AgentSource } from "@clock-in/shared";
import { and, asc, count, desc, eq, gt, gte, isNotNull, lt, ne, or, sql, sum } from "drizzle-orm";
import {
  activitySegments,
  agentSessions,
  organizations,
  projectMemberships,
  projectPathMappings,
  projects,
  timeSessions,
  userProjectSelections,
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
  PathMappingRepositoryError,
  SessionRepositoryError,
  type ActivitySegmentInsert,
  type ActivitySegmentRepository,
  type AgentSessionRecord,
  type AgentSessionRepository,
  type AgentSessionStaleCutoffs,
  type AppTotalRecord,
  type CreatePathMapping,
  type CreateRunningSession,
  type InsertEndedAgentSession,
  type LeaderboardRowRecord,
  type PathMappingRecord,
  type PathMappingRepository,
  type ProjectRecord,
  type ProjectRepository,
  type ProjectTotalRecord,
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
  type SiteTotalRecord,
  type StopRunningSession,
  type UpdatePathMapping,
  type UpsertStartedAgentSession,
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

  private async ensureDefaultForMember(subject: AuthenticatedSubject): Promise<ProjectRecord> {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(projects)
        .values({ organizationId: subject.organizationId, name: "General Work", isDefault: true })
        .onConflictDoNothing();
      const rows = await tx
        .select({
          id: projects.id,
          organizationId: projects.organizationId,
          name: projects.name,
          archived: projects.archived,
          isDefault: projects.isDefault,
        })
        .from(projects)
        .where(and(
          eq(projects.organizationId, subject.organizationId),
          eq(projects.isDefault, true),
          eq(projects.archived, false),
        ))
        .limit(1);
      const project = rows[0];
      if (project === undefined) throw new Error("The organization has no usable default project.");
      const members = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organizationId, subject.organizationId));
      if (members.length > 0) {
        await tx
          .insert(projectMemberships)
          .values(members.map((member) => ({
            organizationId: subject.organizationId,
            projectId: project.id,
            userId: member.id,
          })))
          .onConflictDoNothing();
      }
      return project;
    });
  }

  public async listForMember(subject: AuthenticatedSubject): Promise<ProjectRecord[]> {
    await this.ensureDefaultForMember(subject);
    return this.db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        name: projects.name,
        archived: projects.archived,
        isDefault: projects.isDefault,
      })
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
    await this.ensureDefaultForMember(subject);
    const rows = await this.db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        name: projects.name,
        archived: projects.archived,
        isDefault: projects.isDefault,
      })
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

  public async createForMember(subject: AuthenticatedSubject, name: string): Promise<ProjectRecord> {
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .insert(projects)
        .values({ organizationId: subject.organizationId, name })
        .returning({
          id: projects.id,
          organizationId: projects.organizationId,
          name: projects.name,
          archived: projects.archived,
          isDefault: projects.isDefault,
        });
      if (project === undefined) throw new Error("Failed to create the project.");
      await tx
        .insert(projectMemberships)
        .values({ organizationId: subject.organizationId, projectId: project.id, userId: subject.userId });
      return project;
    });
  }

  public async preferredForMember(subject: AuthenticatedSubject): Promise<ProjectRecord | null> {
    const fallback = await this.ensureDefaultForMember(subject);
    const selected = await this.db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        name: projects.name,
        archived: projects.archived,
        isDefault: projects.isDefault,
      })
      .from(userProjectSelections)
      .innerJoin(projects, and(
        eq(projects.organizationId, userProjectSelections.organizationId),
        eq(projects.id, userProjectSelections.projectId),
      ))
      .where(and(
        eq(userProjectSelections.organizationId, subject.organizationId),
        eq(userProjectSelections.userId, subject.userId),
        eq(projects.archived, false),
      ))
      .limit(1);
    return selected[0] ?? fallback;
  }

  public async rememberSelection(subject: AuthenticatedSubject, projectId: string): Promise<void> {
    const project = await this.findForMember(subject, projectId);
    if (project === null || project.archived) return;
    await this.db
      .insert(userProjectSelections)
      .values({ organizationId: subject.organizationId, userId: subject.userId, projectId: project.id })
      .onConflictDoUpdate({
        target: [userProjectSelections.organizationId, userProjectSelections.userId],
        set: { projectId: project.id, updatedAt: new Date() },
      });
  }

  public async updateForAdmin(
    subject: AuthenticatedSubject,
    projectId: string,
    input: { name?: string; archived?: boolean; replacementProjectId?: string },
  ): Promise<ProjectRecord | null> {
    if (subject.role !== "admin") {
      throw new AppError("forbidden", "Only workspace admins can change projects.");
    }
    return this.db.transaction(async (tx) => {
      const targetRows = await tx
        .select({
          id: projects.id,
          organizationId: projects.organizationId,
          name: projects.name,
          archived: projects.archived,
          isDefault: projects.isDefault,
        })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, subject.organizationId)))
        .limit(1);
      const target = targetRows[0];
      if (target === undefined) return null;

      const replacingDefault = target.isDefault && (input.archived === true || input.replacementProjectId !== undefined);
      if (input.replacementProjectId !== undefined && !replacingDefault) {
        throw new AppError("validation_error", "Only the default project can be replaced.");
      }
      if (target.isDefault && input.archived === true && input.replacementProjectId === undefined) {
        throw new AppError("validation_error", "Choose a replacement before archiving the default project.");
      }

      if (replacingDefault) {
        const replacementRows = await tx
          .select({ id: projects.id, archived: projects.archived })
          .from(projects)
          .innerJoin(projectMemberships, and(
            eq(projectMemberships.organizationId, projects.organizationId),
            eq(projectMemberships.projectId, projects.id),
          ))
          .where(and(
            eq(projects.id, input.replacementProjectId!),
            eq(projects.organizationId, subject.organizationId),
            eq(projects.archived, false),
            eq(projectMemberships.userId, subject.userId),
          ))
          .limit(1);
        const replacement = replacementRows[0];
        if (replacement === undefined || replacement.id === target.id) {
          throw new AppError("validation_error", "Choose another active project as the replacement.");
        }
        await tx
          .update(projects)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(projects.id, target.id));
        await tx
          .update(projects)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(projects.id, replacement.id));
        const members = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.organizationId, subject.organizationId));
        if (members.length > 0) {
          await tx
            .insert(projectMemberships)
            .values(members.map((member) => ({
              organizationId: subject.organizationId,
              projectId: replacement.id,
              userId: member.id,
            })))
            .onConflictDoNothing();
        }
      }

      const rows = await tx
        .update(projects)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.archived === undefined ? {} : { archived: input.archived }),
          updatedAt: new Date(),
        })
        .where(and(eq(projects.id, target.id), eq(projects.organizationId, subject.organizationId)))
        .returning({
          id: projects.id,
          organizationId: projects.organizationId,
          name: projects.name,
          archived: projects.archived,
          isDefault: projects.isDefault,
        });
      return rows[0] ?? null;
    });
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

  public async resolve(identity: AuthIdentity, inviteCode?: string, workspaceName?: string): Promise<AuthenticatedUser> {
    const existing = await this.find(identity.authUserId);
    if (existing !== null) {
      return existing.email === identity.email && existing.name === identity.name
        ? existing
        : this.syncProfile(identity);
    }
    try {
      return inviteCode === undefined
        ? await this.provision(identity, workspaceName)
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
        .select({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId, role: users.role })
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
        .set({ organizationId: target.id, role: "member", updatedAt: new Date() })
        .where(eq(users.id, subject.userId))
        .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId, role: users.role });
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
          role: "member",
        })
        .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId, role: users.role });
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
      .select({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId, role: users.role })
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
      .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId, role: users.role });
    const row = rows[0];
    if (row === undefined) throw new Error("The signed-in account disappeared during profile sync.");
    return row;
  }

  private async provision(identity: AuthIdentity, workspaceName?: string): Promise<AuthenticatedUser> {
    return this.db.transaction(async (tx) => {
      const [organization] = await tx
        .insert(organizations)
        .values({
          name: workspaceName ?? `${identity.name}'s workspace`,
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
          role: "admin",
        })
        .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId, role: users.role });
      if (user === undefined) throw new Error("Failed to create a user for a new account.");

      const [project] = await tx
        .insert(projects)
        .values({ organizationId: organization.id, name: "General Work", isDefault: true })
        .returning({ id: projects.id });
      if (project === undefined) throw new Error("Failed to create a starter project for a new account.");

      await tx
        .insert(projectMemberships)
        .values({ organizationId: organization.id, projectId: project.id, userId: user.id });

      return user;
    });
  }
}

/**
 * Corroborated seconds for one time session: the overlap of [startedAt, stoppedAt]
 * with the member's fresh "active" activity segments plus the agent sessions linked
 * to the session, floored and capped at durationSeconds. Browser spans are excluded:
 * they attribute active time to a project but never corroborate it. Evidence received
 * more than seven days after it occurred is stored but never corroborates. Overlapping
 * evidence intervals are summed rather than unioned; the durationSeconds cap absorbs
 * the double-count, so corroborated time can never exceed the session it backs.
 */
interface ExactStatsRange {
  from: Date;
  toExclusive: Date;
}

function exactStatsRange(query: ReportQuery): ExactStatsRange | null {
  if (!query.clipToRange || query.from === undefined || query.toExclusive === undefined) return null;
  return { from: query.from, toExclusive: query.toExclusive };
}

function sessionDurationSecondsSql(range: ExactStatsRange | null) {
  if (range === null) return timeSessions.durationSeconds;
  return sql<string | null>`least(${timeSessions.durationSeconds}, floor(greatest(0, extract(epoch from (
    least(${timeSessions.stoppedAt}, ${range.toExclusive.toISOString()})
    - greatest(${timeSessions.startedAt}, ${range.from.toISOString()})
  )))))::bigint`;
}

function corroboratedSecondsSql(range: ExactStatsRange | null = null) {
  const sessionStart = range === null
    ? sql`${timeSessions.startedAt}`
    : sql`greatest(${timeSessions.startedAt}, ${range.from.toISOString()})`;
  const sessionEnd = range === null
    ? sql`${timeSessions.stoppedAt}`
    : sql`least(${timeSessions.stoppedAt}, ${range.toExclusive.toISOString()})`;
  const sessionDuration = sessionDurationSecondsSql(range);
  return sql<string | null>`least(
    ${sessionDuration},
    floor(
      coalesce((
        select sum(greatest(0, extract(epoch from
          least(${activitySegments.endedAt}, ${sessionEnd})
          - greatest(${activitySegments.startedAt}, ${sessionStart}))))
        from ${activitySegments}
        where ${activitySegments.organizationId} = ${timeSessions.organizationId}
          and ${activitySegments.userId} = ${timeSessions.userId}
          and ${activitySegments.kind} = 'active'
          and ${activitySegments.startedAt} < ${sessionEnd}
          and ${activitySegments.endedAt} > ${sessionStart}
          and ${activitySegments.receivedAt} <= ${activitySegments.endedAt} + interval '7 days'
      ), 0) + coalesce((
        select sum(greatest(0, extract(epoch from
          least(coalesce(${agentSessions.endedAt}, ${agentSessions.lastEventAt}), ${sessionEnd})
          - greatest(${agentSessions.startedAt}, ${sessionStart}))))
        from ${agentSessions}
        where ${agentSessions.linkedSessionId} = ${timeSessions.id}
          and ${agentSessions.source} <> 'browser'
          and ${agentSessions.receivedAt} <= coalesce(${agentSessions.endedAt}, ${agentSessions.lastEventAt}) + interval '7 days'
      ), 0)
    )
  )::bigint`;
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
    const exactRange = exactStatsRange(query);
    if (exactRange !== null) {
      conditions.push(lt(timeSessions.startedAt, exactRange.toExclusive));
      conditions.push(gt(timeSessions.stoppedAt, exactRange.from));
    } else {
      if (query.from !== undefined) conditions.push(gte(timeSessions.startedAt, query.from));
      if (query.toExclusive !== undefined) conditions.push(lt(timeSessions.startedAt, query.toExclusive));
    }
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
        corroboratedSeconds: corroboratedSecondsSql(),
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
        corroboratedSeconds: row.corroboratedSeconds,
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
        corroboratedSeconds: sum(corroboratedSecondsSql()),
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
      corroboratedSeconds: row.corroboratedSeconds,
    }));
  }

  /** One row per project the member recorded time in, heaviest first. */
  public async readProjectTotalsForMember(
    subject: AuthenticatedSubject,
    query: ReportQuery,
  ): Promise<ProjectTotalRecord[]> {
    const exactRange = exactStatsRange(query);
    const sessionDuration = sessionDurationSecondsSql(exactRange);
    const totalDuration = sum(sessionDuration);
    const rows = await this.db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        durationSeconds: totalDuration,
        corroboratedSeconds: sum(corroboratedSecondsSql(exactRange)),
        sessionCount: count(timeSessions.id),
      })
      .from(timeSessions)
      .innerJoin(projects, and(
        eq(projects.organizationId, timeSessions.organizationId),
        eq(projects.id, timeSessions.projectId),
      ))
      .where(and(
        ...this.predicates(subject, query),
        eq(timeSessions.userId, subject.userId),
        eq(projects.organizationId, subject.organizationId),
      ))
      .groupBy(projects.id, projects.name)
      // id breaks ties so equal totals do not reorder between requests.
      .orderBy(desc(totalDuration), asc(projects.id));

    return rows.map((row) => ({
      project: { id: row.projectId, name: row.projectName },
      durationSeconds: row.durationSeconds,
      corroboratedSeconds: row.corroboratedSeconds,
      sessionCount: row.sessionCount,
    }));
  }

  /**
   * One row per foreground process the member was active in, heaviest first.
   * The same freshness window as corroboration applies, and segments are
   * clamped to the requested range so only in-range time counts.
   */
  public async readAppTotalsForMember(
    subject: AuthenticatedSubject,
    query: ReportQuery,
  ): Promise<AppTotalRecord[]> {
    // Raw sql`` interpolation bypasses drizzle's Date mapping, and postgres-js
    // cannot serialize a bare Date — bind the bounds as ISO strings instead.
    const rangeStart = query.from === undefined ? sql`${activitySegments.startedAt}` : sql`${query.from.toISOString()}`;
    const rangeEnd = query.toExclusive === undefined ? sql`${activitySegments.endedAt}` : sql`${query.toExclusive.toISOString()}`;
    // The subtraction inside extract() is parenthesized on purpose: with bound
    // parameters inside nested calls Postgres mis-parses the unwrapped form and
    // rejects the query at the table FROM.
    const duration = sql<string | null>`floor(sum(greatest(0, extract(epoch from (
      least(${activitySegments.endedAt}, ${rangeEnd})
      - greatest(${activitySegments.startedAt}, ${rangeStart})
    )))))`;
    const rows = await this.db
      .select({
        processName: activitySegments.processName,
        durationSeconds: duration,
      })
      .from(activitySegments)
      .where(and(
        eq(activitySegments.organizationId, subject.organizationId),
        eq(activitySegments.userId, subject.userId),
        eq(activitySegments.kind, "active"),
        isNotNull(activitySegments.processName),
        ...(query.from === undefined ? [] : [gt(activitySegments.endedAt, query.from)]),
        ...(query.toExclusive === undefined ? [] : [lt(activitySegments.startedAt, query.toExclusive)]),
        sql`${activitySegments.receivedAt} <= ${activitySegments.endedAt} + interval '7 days'`,
      ))
      .groupBy(activitySegments.processName)
      .having(gt(duration, 0))
      // processName breaks ties so equal totals do not reorder between requests.
      .orderBy(desc(duration), asc(activitySegments.processName));

    return rows.map((row) => {
      if (row.processName === null) throw new Error("App totals query returned a null process name.");
      return { processName: row.processName, durationSeconds: row.durationSeconds };
    });
  }

  /**
   * One row per url rule the member's browser spans matched, heaviest first.
   * Span time counts only where it overlaps the member's fresh "active"
   * segments, both clamped to the requested range — a focused tab on an idle
   * machine attributes nothing. Both sides keep corroboration's seven-day
   * freshness window, and a deleted rule's spans drop out with its mapping row.
   * Concurrent spans on the same rule and concurrent active segments across
   * devices each merge into interval sets before their overlap is summed, so
   * neither side can count one focused wall-clock second twice.
   */
  public async readSiteTotalsForMember(
    subject: AuthenticatedSubject,
    query: ReportQuery,
  ): Promise<SiteTotalRecord[]> {
    // Raw sql`` interpolation bypasses drizzle's Date mapping, and postgres-js
    // cannot serialize a bare Date — bind the bounds as ISO strings instead.
    const windowStart = query.from === undefined
      ? sql`greatest(seg.started_at, s.started_at)`
      : sql`greatest(seg.started_at, s.started_at, ${query.from.toISOString()})`;
    const windowEnd = query.toExclusive === undefined
      ? sql`least(seg.ended_at, s.ended_at)`
      : sql`least(seg.ended_at, s.ended_at, ${query.toExclusive.toISOString()})`;
    // Overlapping and touching intervals collapse into islands via the running
    // max of previous ends. Spans partition by rule; active segments union
    // across devices because site totals represent focused wall-clock time.
    const rows = await this.db.execute(sql`
      with spans as (
        select rule_id, started_at, coalesce(ended_at, last_event_at) as ended_at
        from agent_sessions
        where organization_id = ${subject.organizationId}
          and user_id = ${subject.userId}
          and source = 'browser'
          and rule_id is not null
          and received_at <= coalesce(ended_at, last_event_at) + interval '7 days'
          ${query.from === undefined ? sql`` : sql`and coalesce(ended_at, last_event_at) > ${query.from.toISOString()}`}
          ${query.toExclusive === undefined ? sql`` : sql`and started_at < ${query.toExclusive.toISOString()}`}
      ),
      islands as (
        select rule_id, started_at, ended_at,
          sum(case when prev_end is null or started_at > prev_end then 1 else 0 end)
            over (partition by rule_id order by started_at, ended_at) as island
        from (
          select rule_id, started_at, ended_at,
            max(ended_at) over (
              partition by rule_id order by started_at, ended_at
              rows between unbounded preceding and 1 preceding
            ) as prev_end
          from spans
        ) ordered_spans
      ),
      merged_spans as (
        select rule_id, min(started_at) as started_at, max(ended_at) as ended_at
        from islands
        group by rule_id, island
      ),
      active_segments as (
        select started_at, ended_at
        from activity_segments
        where organization_id = ${subject.organizationId}
          and user_id = ${subject.userId}
          and kind = 'active'
          and received_at <= ended_at + interval '7 days'
          ${query.from === undefined ? sql`` : sql`and ended_at > ${query.from.toISOString()}`}
          ${query.toExclusive === undefined ? sql`` : sql`and started_at < ${query.toExclusive.toISOString()}`}
      ),
      active_islands as (
        select started_at, ended_at,
          sum(case when prev_end is null or started_at > prev_end then 1 else 0 end)
            over (order by started_at, ended_at) as island
        from (
          select started_at, ended_at,
            max(ended_at) over (
              order by started_at, ended_at
              rows between unbounded preceding and 1 preceding
            ) as prev_end
          from active_segments
        ) ordered_segments
      ),
      merged_active_segments as (
        select min(started_at) as started_at, max(ended_at) as ended_at
        from active_islands
        group by island
      ),
      site_totals as (
        select m.id as "mappingId", m.path_prefix as "pattern", m.project_id as "projectId",
          floor(sum(greatest(0, extract(epoch from (${windowEnd} - ${windowStart})))))::bigint as "durationSeconds"
        from merged_spans s
        join project_path_mappings m
          on m.organization_id = ${subject.organizationId} and m.user_id = ${subject.userId}
          and m.id = s.rule_id and m.kind = 'url_rule'
        join merged_active_segments seg
          on seg.started_at < s.ended_at and seg.ended_at > s.started_at
        where true
          ${query.from === undefined ? sql`` : sql`and s.ended_at > ${query.from.toISOString()}`}
          ${query.toExclusive === undefined ? sql`` : sql`and s.started_at < ${query.toExclusive.toISOString()}`}
        group by m.id, m.path_prefix, m.project_id
      )
      select "mappingId", "pattern", "projectId", "durationSeconds"
      from site_totals
      where "durationSeconds" > 0
      order by "durationSeconds" desc, "mappingId" asc
    `);

    return (rows as unknown as { mappingId: string; pattern: string; projectId: string | null; durationSeconds: string | null }[]).map((row) => ({
      mapping: { id: row.mappingId, pattern: row.pattern, projectId: row.projectId },
      durationSeconds: row.durationSeconds,
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

export class DrizzleActivitySegmentRepository implements ActivitySegmentRepository {
  public constructor(private readonly db: DatabaseConnection["db"]) {}

  /** Replay-safe: the (organization, user, client) unique key makes re-uploads no-ops. */
  public async insertBatch(segments: ActivitySegmentInsert[]): Promise<void> {
    if (segments.length === 0) return;
    await this.db
      .insert(activitySegments)
      .values(segments)
      .onConflictDoNothing({
        target: [activitySegments.organizationId, activitySegments.userId, activitySegments.clientId],
      });
  }
}

function asAgentSessionRecord(row: typeof agentSessions.$inferSelect): AgentSessionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    source: row.source,
    externalSessionId: row.externalSessionId,
    projectId: row.projectId,
    cwd: row.cwd,
    ruleId: row.ruleId,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    lastEventAt: row.lastEventAt,
    linkedSessionId: row.linkedSessionId,
  };
}

const agentSessionKey = [
  agentSessions.organizationId,
  agentSessions.userId,
  agentSessions.source,
  agentSessions.externalSessionId,
];

export class DrizzleAgentSessionRepository implements AgentSessionRepository {
  public constructor(private readonly db: DatabaseConnection["db"]) {}

  public async findByExternalKey(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string): Promise<AgentSessionRecord | null> {
    const rows = await this.db.select().from(agentSessions).where(and(
      eq(agentSessions.organizationId, subject.organizationId),
      eq(agentSessions.userId, subject.userId),
      eq(agentSessions.source, source),
      eq(agentSessions.externalSessionId, externalSessionId),
    )).limit(1);
    return rows[0] === undefined ? null : asAgentSessionRecord(rows[0]);
  }

  public async upsertStarted(input: UpsertStartedAgentSession): Promise<AgentSessionRecord> {
    const rows = await this.db
      .insert(agentSessions)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        source: input.source,
        externalSessionId: input.externalSessionId,
        cwd: input.cwd,
        ruleId: input.ruleId,
        projectId: input.projectId,
        linkedSessionId: input.linkedSessionId,
        status: "running",
        startedAt: input.occurredAt,
        endedAt: null,
        lastEventAt: input.occurredAt,
        receivedAt: input.receivedAt,
      })
      .onConflictDoUpdate({
        target: agentSessionKey,
        // A replayed start refreshes lastEventAt only; an ended row stays ended.
        // Drizzle does not run onConflictDoUpdate set values through the column
        // serializer, so bind an ISO string - a raw Date crashes postgres-js.
        set: {
          status: sql`case
            when ${agentSessions.source} = 'browser'
              and ${agentSessions.status} = 'stale'
              and ${agentSessions.lastEventAt} < ${input.occurredAt.toISOString()}
            then 'running'::agent_session_status
            else ${agentSessions.status}
          end`,
          endedAt: sql`case
            when ${agentSessions.source} = 'browser'
              and ${agentSessions.status} = 'stale'
              and ${agentSessions.lastEventAt} < ${input.occurredAt.toISOString()}
            then null
            else ${agentSessions.endedAt}
          end`,
          lastEventAt: sql`greatest(${agentSessions.lastEventAt}, ${input.occurredAt.toISOString()})`,
          updatedAt: sql`${input.receivedAt.toISOString()}`,
        },
      })
      .returning();
    return asAgentSessionRecord(rows[0]!);
  }

  public async closeRunning(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string, endedAt: Date, now: Date): Promise<AgentSessionRecord | null> {
    const rows = await this.db
      .update(agentSessions)
      .set({
        status: "ended",
        endedAt: sql`greatest(${agentSessions.lastEventAt}, ${endedAt.toISOString()})`,
        lastEventAt: sql`greatest(${agentSessions.lastEventAt}, ${endedAt.toISOString()})`,
        updatedAt: now,
      })
      .where(and(
        eq(agentSessions.organizationId, subject.organizationId),
        eq(agentSessions.userId, subject.userId),
        eq(agentSessions.source, source),
        eq(agentSessions.externalSessionId, externalSessionId),
        or(
          eq(agentSessions.status, "running"),
          and(
            eq(agentSessions.source, "browser"),
            eq(agentSessions.status, "stale"),
            sql`${agentSessions.lastEventAt} <= ${endedAt.toISOString()}`,
          ),
        ),
      ))
      .returning();
    return rows[0] === undefined ? null : asAgentSessionRecord(rows[0]);
  }

  public async insertEnded(input: InsertEndedAgentSession): Promise<void> {
    await this.db
      .insert(agentSessions)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        source: input.source,
        externalSessionId: input.externalSessionId,
        cwd: input.cwd,
        ruleId: input.ruleId,
        projectId: input.projectId,
        status: "ended",
        startedAt: input.occurredAt,
        endedAt: input.occurredAt,
        lastEventAt: input.occurredAt,
        receivedAt: input.receivedAt,
      })
      .onConflictDoNothing({ target: agentSessionKey });
  }

  public async advanceLastEvent(subject: AuthenticatedSubject, source: AgentSource, externalSessionId: string, occurredAt: Date, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(agentSessions)
      .set({
        status: sql`case
          when ${agentSessions.source} = 'browser'
            and ${agentSessions.status} = 'stale'
            and ${agentSessions.lastEventAt} < ${occurredAt.toISOString()}
          then 'running'::agent_session_status
          else ${agentSessions.status}
        end`,
        endedAt: sql`case
          when ${agentSessions.source} = 'browser'
            and ${agentSessions.status} = 'stale'
            and ${agentSessions.lastEventAt} < ${occurredAt.toISOString()}
          then null
          else ${agentSessions.endedAt}
        end`,
        lastEventAt: sql`greatest(${agentSessions.lastEventAt}, ${occurredAt.toISOString()})`,
        updatedAt: now,
      })
      .where(and(
        eq(agentSessions.organizationId, subject.organizationId),
        eq(agentSessions.userId, subject.userId),
        eq(agentSessions.source, source),
        eq(agentSessions.externalSessionId, externalSessionId),
        or(
          eq(agentSessions.status, "running"),
          and(
            eq(agentSessions.source, "browser"),
            eq(agentSessions.status, "stale"),
            sql`${agentSessions.lastEventAt} < ${occurredAt.toISOString()}`,
          ),
        ),
      ))
      .returning({ id: agentSessions.id });
    return rows.length > 0;
  }

  public async reapStale(
    subject: AuthenticatedSubject,
    cutoffs: AgentSessionStaleCutoffs,
    now: Date,
  ): Promise<number> {
    const rows = await this.db
      .update(agentSessions)
      .set({ status: "stale", endedAt: sql`${agentSessions.lastEventAt}`, updatedAt: now })
      .where(and(
        eq(agentSessions.organizationId, subject.organizationId),
        eq(agentSessions.userId, subject.userId),
        eq(agentSessions.status, "running"),
        or(
          and(eq(agentSessions.source, "browser"), lt(agentSessions.lastEventAt, cutoffs.browser)),
          and(ne(agentSessions.source, "browser"), lt(agentSessions.lastEventAt, cutoffs.default)),
        ),
      ))
      .returning({ id: agentSessions.id });
    return rows.length;
  }
}

function asPathMappingRecord(row: typeof projectPathMappings.$inferSelect): PathMappingRecord {
  // The kind_valid CHECK keeps this closed world honest; an unknown value means
  // the database and the code disagree, which must surface rather than coerce.
  if (row.kind !== "path_prefix" && row.kind !== "url_rule") {
    throw new Error(`Path mapping ${row.id} has an unrecognized kind: ${row.kind}`);
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    kind: row.kind,
    pathPrefix: row.pathPrefix,
    repoUrl: row.repoUrl,
    projectId: row.projectId,
  };
}

export class DrizzlePathMappingRepository implements PathMappingRepository {
  public constructor(private readonly db: DatabaseConnection["db"]) {}

  public async listForSubject(subject: AuthenticatedSubject): Promise<PathMappingRecord[]> {
    const rows = await this.db
      .select()
      .from(projectPathMappings)
      .where(and(
        eq(projectPathMappings.organizationId, subject.organizationId),
        eq(projectPathMappings.userId, subject.userId),
      ))
      .orderBy(asc(projectPathMappings.pathPrefix), asc(projectPathMappings.id));
    return rows.map(asPathMappingRecord);
  }

  public async findById(subject: AuthenticatedSubject, mappingId: string): Promise<PathMappingRecord | null> {
    const rows = await this.db.select().from(projectPathMappings).where(and(
      eq(projectPathMappings.id, mappingId),
      eq(projectPathMappings.organizationId, subject.organizationId),
      eq(projectPathMappings.userId, subject.userId),
    )).limit(1);
    return rows[0] === undefined ? null : asPathMappingRecord(rows[0]);
  }

  public async findByPathPrefix(subject: AuthenticatedSubject, pathPrefix: string): Promise<PathMappingRecord | null> {
    const rows = await this.db.select().from(projectPathMappings).where(and(
      eq(projectPathMappings.organizationId, subject.organizationId),
      eq(projectPathMappings.userId, subject.userId),
      eq(projectPathMappings.pathPrefix, pathPrefix),
    )).limit(1);
    return rows[0] === undefined ? null : asPathMappingRecord(rows[0]);
  }

  public async create(input: CreatePathMapping): Promise<PathMappingRecord> {
    try {
      const rows = await this.db.insert(projectPathMappings).values(input).returning();
      return asPathMappingRecord(rows[0]!);
    } catch (error) {
      if (uniqueConstraint(error) === "project_path_mappings_organization_user_prefix_unique") {
        throw new PathMappingRepositoryError("path_prefix");
      }
      throw error;
    }
  }

  public async update(subject: AuthenticatedSubject, mappingId: string, input: UpdatePathMapping): Promise<PathMappingRecord | null> {
    try {
      const rows = await this.db
        .update(projectPathMappings)
        .set(input)
        .where(and(
          eq(projectPathMappings.id, mappingId),
          eq(projectPathMappings.organizationId, subject.organizationId),
          eq(projectPathMappings.userId, subject.userId),
        ))
        .returning();
      return rows[0] === undefined ? null : asPathMappingRecord(rows[0]);
    } catch (error) {
      if (uniqueConstraint(error) === "project_path_mappings_organization_user_prefix_unique") {
        throw new PathMappingRepositoryError("path_prefix");
      }
      throw error;
    }
  }

  public async remove(subject: AuthenticatedSubject, mappingId: string): Promise<boolean> {
    const rows = await this.db
      .delete(projectPathMappings)
      .where(and(
        eq(projectPathMappings.id, mappingId),
        eq(projectPathMappings.organizationId, subject.organizationId),
        eq(projectPathMappings.userId, subject.userId),
      ))
      .returning({ id: projectPathMappings.id });
    return rows.length > 0;
  }
}
