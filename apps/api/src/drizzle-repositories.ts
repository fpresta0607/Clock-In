import { randomBytes } from "node:crypto";

import { generateInviteCode, type AgentSource } from "@clock-in/shared";
import { and, asc, count, desc, eq, gt, gte, isNotNull, lt, ne, or, sql, sum } from "drizzle-orm";
import {
  activitySegments,
  agentSessions,
  organizationAdminClaims,
  organizations,
  projectMemberships,
  projectPathMappings,
  projects,
  timeSessions,
  userProjectSelections,
  users,
  userViewPreferences,
  type DatabaseConnection,
} from "@clock-in/database";

import type {
  AccountStore,
  AuthenticatedSubject,
  AuthenticatedUser,
  AuthIdentity,
  FirstAdminClaimResult,
  OrganizationRecord,
} from "./auth.js";
import { AppError } from "./errors.js";
import {
  PathMappingRepositoryError,
  SessionRepositoryError,
  type ActivitySegmentInsert,
  type ActivitySegmentRepository,
  type AgentIntervalRecord,
  type AgentSessionRecord,
  type AgentSessionRepository,
  type AppTotalRecord,
  type PresenceIntervalRecord,
  type ProjectUsageRecord,
  type SessionIntervalRecord,
  type ViewPreferencesRecord,
  type ViewPreferencesRepository,
  type CreatePathMapping,
  type CreateRunningSession,
  type InsertEndedAgentSession,
  type LeaderboardRowRecord,
  type ObservedSessionInsert,
  type PathMappingRecord,
  type PathMappingRepository,
  type ProjectRecord,
  type ProjectRepository,
  type ProjectTotalRecord,
  type SiteTotalRecord,
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
    attribution: row.attribution,
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
      .select({ id: projects.id, organizationId: projects.organizationId, name: projects.name, archived: projects.archived, isDefault: projects.isDefault, createdAt: projects.createdAt })
      .from(projects)
      .innerJoin(projectMemberships, and(
        eq(projectMemberships.organizationId, projects.organizationId),
        eq(projectMemberships.projectId, projects.id),
      ))
      .where(and(
        eq(projects.organizationId, subject.organizationId),
        eq(projectMemberships.userId, subject.userId),
        eq(projectMemberships.organizationId, subject.organizationId),
      ))
      .orderBy(asc(projects.name), asc(projects.id));
  }

  public async findForMember(subject: AuthenticatedSubject, projectId: string): Promise<ProjectRecord | null> {
    const rows = await this.db
      .select({ id: projects.id, organizationId: projects.organizationId, name: projects.name, archived: projects.archived, isDefault: projects.isDefault, createdAt: projects.createdAt })
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
        .returning({ id: projects.id, organizationId: projects.organizationId, name: projects.name, archived: projects.archived, isDefault: projects.isDefault, createdAt: projects.createdAt });
      if (project === undefined) throw new Error("Failed to create the project.");
      await tx
        .insert(projectMemberships)
        .values({ organizationId: subject.organizationId, projectId: project.id, userId: subject.userId });
      return project;
    });
  }

  public async updateForMember(
    subject: AuthenticatedSubject,
    projectId: string,
    patch: { name?: string; archived?: boolean },
  ): Promise<ProjectRecord | null> {
    const existing = await this.findForMember(subject, projectId);
    if (existing === null) return null;
    const rows = await this.db
      .update(projects)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.archived === undefined ? {} : { archived: patch.archived }),
      })
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, subject.organizationId)))
      .returning({ id: projects.id, organizationId: projects.organizationId, name: projects.name, archived: projects.archived, isDefault: projects.isDefault, createdAt: projects.createdAt });
    return rows[0] ?? null;
  }

  public async usageForOrganization(subject: AuthenticatedSubject, projectId: string): Promise<ProjectUsageRecord> {
    const [sessions] = await this.db
      .select({ sessionCount: count(timeSessions.id), durationSeconds: sum(timeSessions.durationSeconds) })
      .from(timeSessions)
      .where(and(eq(timeSessions.organizationId, subject.organizationId), eq(timeSessions.projectId, projectId)));
    const [agents] = await this.db
      .select({ agentSessionCount: count(agentSessions.id) })
      .from(agentSessions)
      .where(and(eq(agentSessions.organizationId, subject.organizationId), eq(agentSessions.projectId, projectId)));
    const durationSeconds = sessions?.durationSeconds;
    return {
      sessionCount: Number(sessions?.sessionCount ?? 0),
      durationSeconds: durationSeconds === null || durationSeconds === undefined ? 0 : Number(durationSeconds),
      agentSessionCount: Number(agents?.agentSessionCount ?? 0),
    };
  }

  public async deleteForOrganization(subject: AuthenticatedSubject, projectId: string, reassignTo: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (reassignTo !== null) {
        // Sessions carry a composite FK through project_memberships, so every
        // user being moved needs a membership in the target project first.
        await tx.execute(sql`
          insert into project_memberships (organization_id, project_id, user_id)
          select distinct ${subject.organizationId}::uuid, ${reassignTo}::uuid, user_id
          from time_sessions
          where organization_id = ${subject.organizationId} and project_id = ${projectId}
          on conflict do nothing
        `);
        await tx
          .update(timeSessions)
          .set({ projectId: reassignTo })
          .where(and(eq(timeSessions.organizationId, subject.organizationId), eq(timeSessions.projectId, projectId)));
        await tx
          .update(agentSessions)
          .set({ projectId: reassignTo })
          .where(and(eq(agentSessions.organizationId, subject.organizationId), eq(agentSessions.projectId, projectId)));
      } else {
        await tx
          .delete(timeSessions)
          .where(and(eq(timeSessions.organizationId, subject.organizationId), eq(timeSessions.projectId, projectId)));
        await tx
          .delete(agentSessions)
          .where(and(eq(agentSessions.organizationId, subject.organizationId), eq(agentSessions.projectId, projectId)));
      }
      await tx
        .delete(projectPathMappings)
        .where(and(eq(projectPathMappings.organizationId, subject.organizationId), eq(projectPathMappings.projectId, projectId)));
      await tx
        .delete(userProjectSelections)
        .where(and(eq(userProjectSelections.organizationId, subject.organizationId), eq(userProjectSelections.projectId, projectId)));
      await tx
        .delete(projectMemberships)
        .where(and(eq(projectMemberships.organizationId, subject.organizationId), eq(projectMemberships.projectId, projectId)));
      await tx
        .delete(projects)
        .where(and(eq(projects.organizationId, subject.organizationId), eq(projects.id, projectId)));
    });
  }
}

/** Upsert-per-member view state; the unique (organization, user) key makes last write win. */
export class DrizzleViewPreferencesRepository implements ViewPreferencesRepository {
  public constructor(private readonly db: DatabaseConnection["db"]) {}

  public async readForMember(subject: AuthenticatedSubject): Promise<ViewPreferencesRecord | null> {
    const rows = await this.db
      .select({ scope: userViewPreferences.scope, range: userViewPreferences.range })
      .from(userViewPreferences)
      .where(and(
        eq(userViewPreferences.organizationId, subject.organizationId),
        eq(userViewPreferences.userId, subject.userId),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  public async writeForMember(subject: AuthenticatedSubject, patch: { scope?: string | undefined; range?: string | undefined }): Promise<ViewPreferencesRecord> {
    const rows = await this.db
      .insert(userViewPreferences)
      .values({
        organizationId: subject.organizationId,
        userId: subject.userId,
        ...(patch.scope === undefined ? {} : { scope: patch.scope }),
        ...(patch.range === undefined ? {} : { range: patch.range }),
      })
      .onConflictDoUpdate({
        target: [userViewPreferences.organizationId, userViewPreferences.userId],
        set: {
          ...(patch.scope === undefined ? {} : { scope: patch.scope }),
          ...(patch.range === undefined ? {} : { range: patch.range }),
          updatedAt: sql`now()`,
        },
      })
      .returning({ scope: userViewPreferences.scope, range: userViewPreferences.range });
    const row = rows[0];
    if (row === undefined) throw new Error("Failed to save view preferences.");
    return row;
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
        .values({ ...input, status: "running", stoppedAt: null, idleSeconds: 0, durationSeconds: null, attribution: "manual" })
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

  public async insertObservedBatch(sessions: ObservedSessionInsert[]): Promise<void> {
    if (sessions.length === 0) return;
    await this.db
      .insert(timeSessions)
      .values(sessions.map((session) => ({ ...session, description: null })))
      .onConflictDoNothing({
        target: [timeSessions.organizationId, timeSessions.userId, timeSessions.clientId],
      });
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
      // A departing final administrator would strand the remaining members with
      // nobody able to manage the workspace, so refuse the move.
      if (current.role === "admin") {
        // Serializes concurrent departures from one workspace: without the
        // lock, two admins each read the other as "still here" and both
        // leave, stranding the workspace with no self-service recovery.
        await tx.execute(sql`
          select ${organizations.id}
          from ${organizations}
          where ${organizations.id} = ${previousOrganizationId}
          for update
        `);
        const [remainingMember] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(
            eq(users.organizationId, previousOrganizationId),
            ne(users.id, subject.userId),
          ))
          .limit(1);
        const [remainingAdministrator] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(
            eq(users.organizationId, previousOrganizationId),
            ne(users.id, subject.userId),
            eq(users.role, "admin"),
          ))
          .limit(1);
        if (remainingMember !== undefined && remainingAdministrator === undefined) {
          throw new AppError(
            "conflict",
            "The final administrator cannot leave a workspace while it still has members.",
          );
        }
      }
      await tx.delete(projectMemberships).where(eq(projectMemberships.userId, subject.userId));
      // Role never travels: an administrator of the workspace being left is a
      // plain member of the one being joined, whose admin claim is already
      // spoken for. Carrying it over would hand out admin in any workspace an
      // invite code reaches.
      const [moved] = await tx
        .update(users)
        .set({ organizationId: target.id, role: "member", updatedAt: new Date() })
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

  public async claimFirstAdmin(subject: AuthenticatedSubject): Promise<FirstAdminClaimResult> {
    return this.db.transaction(async (tx) => {
      const lockedUser = await tx.execute(sql`
        select ${users.id}
        from ${users}
        where ${users.id} = ${subject.userId}
        for update
      `);
      if (lockedUser.length === 0) return { kind: "not_member" };
      const [member] = await tx
        .select({ role: users.role })
        .from(users)
        .where(and(eq(users.id, subject.userId), eq(users.organizationId, subject.organizationId)))
        .limit(1);
      if (member === undefined) return { kind: "not_member" };
      if (member.role === "admin") return { kind: "already_claimed" };

      const lockedOrganization = await tx.execute(sql`
        select ${organizations.id}
        from ${organizations}
        where ${organizations.id} = ${subject.organizationId}
        for update
      `);
      if (lockedOrganization.length === 0) return { kind: "not_member" };

      const [claim] = await tx
        .insert(organizationAdminClaims)
        .values({
          organizationId: subject.organizationId,
          userId: subject.userId,
          kind: "legacy_first_admin",
        })
        .onConflictDoNothing()
        .returning({ organizationId: organizationAdminClaims.organizationId });
      if (claim === undefined) return { kind: "already_claimed" };

      const [user] = await tx
        .update(users)
        .set({ role: "admin", updatedAt: new Date() })
        .where(and(
          eq(users.id, subject.userId),
          eq(users.organizationId, subject.organizationId),
          eq(users.role, "member"),
        ))
        .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId, role: users.role });
      if (user === undefined) throw new Error("The first-admin claimant was no longer an active member.");
      return { kind: "claimed", user };
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
        .returning({ id: users.id, email: users.email, name: users.name, organizationId: users.organizationId });
      if (user === undefined) throw new Error("Failed to create a user for a new account.");

      await tx
        .insert(organizationAdminClaims)
        .values({ organizationId: organization.id, userId: user.id, kind: "creator" });

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

/**
 * Attributed seconds for one time session: its whole duration when something
 * named the project (a legacy manual start, an explicit selection, or an agent
 * session's working directory), and zero when it fell back to the user's
 * default project. Attribution is a property of the session, not an overlap, so
 * attributed time can never exceed the session it describes.
 */
function attributedSecondsSql() {
  return sql<string | null>`case
    when ${timeSessions.attribution} = 'default' then 0
    else coalesce(${timeSessions.durationSeconds}, 0)
  end`;
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
    if (query.unassignedOnly === true) conditions.push(eq(timeSessions.attribution, "default"));
    return conditions;
  }

  /**
   * Active-kind OS segments overlapping the range: the person at the machine.
   * Range overlap rather than containment, so a segment crossing a boundary is
   * returned whole and the service clips it. The same freshness window as the
   * app breakdown applies. Presence has no project, so no project predicate.
   */
  public async readPresenceIntervals(subject: AuthenticatedSubject, query: ReportQuery): Promise<PresenceIntervalRecord[]> {
    const rows = await this.db
      .select({ userId: users.id, userName: users.name, startedAt: activitySegments.startedAt, endedAt: activitySegments.endedAt })
      .from(activitySegments)
      .innerJoin(users, and(
        eq(users.organizationId, activitySegments.organizationId),
        eq(users.id, activitySegments.userId),
      ))
      .where(and(
        eq(activitySegments.organizationId, subject.organizationId),
        eq(activitySegments.kind, "active"),
        ...(query.userId === undefined ? [] : [eq(activitySegments.userId, query.userId)]),
        ...(query.from === undefined ? [] : [gt(activitySegments.endedAt, query.from)]),
        ...(query.toExclusive === undefined ? [] : [lt(activitySegments.startedAt, query.toExclusive)]),
        sql`${activitySegments.receivedAt} <= ${activitySegments.endedAt} + interval '7 days'`,
      ));
    return rows.map((row) => ({
      user: { id: row.userId, name: row.userName },
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    }));
  }

  /** Completed sessions overlapping the range, with the scope predicates applied. */
  public async readSessionIntervals(subject: AuthenticatedSubject, query: ReportQuery): Promise<SessionIntervalRecord[]> {
    // The shared predicates bound startedAt inside the range; interval reads
    // want overlap instead, so the range conditions are stated directly.
    const rows = await this.db
      .select({
        userId: users.id,
        userName: users.name,
        projectId: timeSessions.projectId,
        attribution: timeSessions.attribution,
        startedAt: timeSessions.startedAt,
        stoppedAt: timeSessions.stoppedAt,
      })
      .from(timeSessions)
      .innerJoin(users, and(
        eq(users.organizationId, timeSessions.organizationId),
        eq(users.id, timeSessions.userId),
      ))
      .where(and(
        eq(timeSessions.organizationId, subject.organizationId),
        or(eq(timeSessions.status, "stopped"), eq(timeSessions.status, "needs_review")),
        isNotNull(timeSessions.stoppedAt),
        ...(query.userId === undefined ? [] : [eq(timeSessions.userId, query.userId)]),
        ...(query.projectId === undefined ? [] : [eq(timeSessions.projectId, query.projectId)]),
        ...(query.unassignedOnly === true ? [eq(timeSessions.attribution, "default")] : []),
        ...(query.from === undefined ? [] : [gt(timeSessions.stoppedAt, query.from)]),
        ...(query.toExclusive === undefined ? [] : [lt(timeSessions.startedAt, query.toExclusive)]),
      ));
    return rows.flatMap((row) => (row.stoppedAt === null ? [] : [{
      user: { id: row.userId, name: row.userName },
      projectId: row.projectId,
      attribution: row.attribution,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt,
    }]));
  }

  /**
   * Agent-session runtimes overlapping the range. A running session's interval
   * ends at its last event — the evidence in hand, not a promise about now.
   * The Unassigned scope reads agent sessions whose project nothing resolved.
   */
  public async readAgentIntervals(subject: AuthenticatedSubject, query: ReportQuery): Promise<AgentIntervalRecord[]> {
    const intervalEnd = sql<Date>`coalesce(${agentSessions.endedAt}, ${agentSessions.lastEventAt})`;
    const rows = await this.db
      .select({
        userId: users.id,
        userName: users.name,
        source: agentSessions.source,
        model: agentSessions.model,
        projectId: agentSessions.projectId,
        startedAt: agentSessions.startedAt,
        endedAt: intervalEnd,
      })
      .from(agentSessions)
      .innerJoin(users, and(
        eq(users.organizationId, agentSessions.organizationId),
        eq(users.id, agentSessions.userId),
      ))
      .where(and(
        eq(agentSessions.organizationId, subject.organizationId),
        ...(query.userId === undefined ? [] : [eq(agentSessions.userId, query.userId)]),
        ...(query.projectId === undefined ? [] : [eq(agentSessions.projectId, query.projectId)]),
        ...(query.unassignedOnly === true ? [sql`${agentSessions.projectId} is null`] : []),
        // A raw fragment on the left strips drizzle's Date mapping from the
        // right-hand parameter, and postgres-js refuses a bare Date - so the
        // bound is passed as an ISO string, exactly like the report ranges.
        ...(query.from === undefined
          ? []
          : [sql`coalesce(${agentSessions.endedAt}, ${agentSessions.lastEventAt}) > ${query.from.toISOString()}`]),
        ...(query.toExclusive === undefined ? [] : [lt(agentSessions.startedAt, query.toExclusive)]),
      ));
    return rows.map((row) => ({
      user: { id: row.userId, name: row.userName },
      source: row.source,
      model: row.model,
      projectId: row.projectId,
      startedAt: row.startedAt,
      endedAt: row.endedAt instanceof Date ? row.endedAt : new Date(row.endedAt as unknown as string),
    }));
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
        attribution: timeSessions.attribution,
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
        attribution: row.attribution,
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
        attributedSeconds: sum(attributedSecondsSql()),
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
      attributedSeconds: row.attributedSeconds,
    }));
  }

  /** One row per project the member recorded time in, heaviest first. */
  public async readProjectTotalsForMember(
    subject: AuthenticatedSubject,
    query: ReportQuery,
  ): Promise<ProjectTotalRecord[]> {
    const totalDuration = sum(timeSessions.durationSeconds);
    const rows = await this.db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        durationSeconds: totalDuration,
        attributedSeconds: sum(attributedSecondsSql()),
        sessionCount: count(timeSessions.id),
      })
      .from(timeSessions)
      .innerJoin(projects, and(
        eq(projects.organizationId, timeSessions.organizationId),
        eq(projects.id, timeSessions.projectId),
      ))
      .where(and(
        ...this.predicates(subject, query),
        // Falls back to the caller when the query named nobody, so a missing
        // filter reads as "my own" rather than as the whole workspace.
        eq(timeSessions.userId, query.userId ?? subject.userId),
        eq(projects.organizationId, subject.organizationId),
      ))
      .groupBy(projects.id, projects.name)
      // id breaks ties so equal totals do not reorder between requests.
      .orderBy(desc(totalDuration), asc(projects.id));

    return rows.map((row) => ({
      project: { id: row.projectId, name: row.projectName },
      durationSeconds: row.durationSeconds,
      attributedSeconds: row.attributedSeconds,
      sessionCount: row.sessionCount,
    }));
  }

  /**
   * One row per foreground process the member was active in, heaviest first.
   * The same freshness window as observed-session uploads applies, and segments are
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
    // floor(...)::bigint: extract(epoch ...) yields a scaled numeric
    // ("90.000000"), which the service's safe-integer parse rejects.
    const duration = sql<string | null>`floor(sum(greatest(0, extract(epoch from
      least(${activitySegments.endedAt}, ${rangeEnd})
      - greatest(${activitySegments.startedAt}, ${rangeStart})))))::bigint`;
    const rows = await this.db
      .select({
        processName: activitySegments.processName,
        durationSeconds: duration,
      })
      .from(activitySegments)
      .where(and(
        eq(activitySegments.organizationId, subject.organizationId),
        eq(activitySegments.userId, query.userId ?? subject.userId),
        eq(activitySegments.kind, "active"),
        isNotNull(activitySegments.processName),
        ...(query.from === undefined ? [] : [gt(activitySegments.endedAt, query.from)]),
        ...(query.toExclusive === undefined ? [] : [lt(activitySegments.startedAt, query.toExclusive)]),
        sql`${activitySegments.receivedAt} <= ${activitySegments.endedAt} + interval '7 days'`,
      ))
      .groupBy(activitySegments.processName)
      // processName breaks ties so equal totals do not reorder between requests.
      .orderBy(desc(duration), asc(activitySegments.processName));

    return rows.map((row) => {
      if (row.processName === null) throw new Error("App totals query returned a null process name.");
      return { processName: row.processName, durationSeconds: row.durationSeconds };
    });
  }

  private async snapshot<T>(callback: (db: Pick<DatabaseConnection["db"], "select">) => Promise<T>): Promise<T> {
    return this.db.transaction(
      async (transaction) => callback(transaction),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  public async readSiteTotalsForMember(_subject: AuthenticatedSubject, _query: ReportQuery): Promise<SiteTotalRecord[]> {
    return [];
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

// Raw sql`` interpolation bypasses drizzle's Date mapping and postgres-js cannot
// serialize a bare Date, so every `greatest` bound below is bound as an ISO string
// and cast, exactly as the report ranges above are.
function asAgentSessionRecord(row: typeof agentSessions.$inferSelect): AgentSessionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    source: row.source,
    model: row.model,
    externalSessionId: row.externalSessionId,
    projectId: row.projectId,
    cwd: row.cwd ?? "",
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
        model: input.model,
        externalSessionId: input.externalSessionId,
        cwd: input.cwd,
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
        // A later start that names a model fills one in — a session can be
        // resumed on a different model — but never blanks one already recorded.
        set: {
          ...(input.model === null ? {} : { model: input.model }),
          lastEventAt: sql`greatest(${agentSessions.lastEventAt}, ${input.occurredAt.toISOString()}::timestamptz)`,
          updatedAt: input.receivedAt,
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
        endedAt,
        lastEventAt: sql`greatest(${agentSessions.lastEventAt}, ${endedAt.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(and(
        eq(agentSessions.organizationId, subject.organizationId),
        eq(agentSessions.userId, subject.userId),
        eq(agentSessions.source, source),
        eq(agentSessions.externalSessionId, externalSessionId),
        eq(agentSessions.status, "running"),
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
        model: input.model,
        externalSessionId: input.externalSessionId,
        cwd: input.cwd,
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
        lastEventAt: sql`greatest(${agentSessions.lastEventAt}, ${occurredAt.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(and(
        eq(agentSessions.organizationId, subject.organizationId),
        eq(agentSessions.userId, subject.userId),
        eq(agentSessions.source, source),
        eq(agentSessions.externalSessionId, externalSessionId),
        eq(agentSessions.status, "running"),
      ))
      .returning({ id: agentSessions.id });
    return rows.length > 0;
  }

  public async reapStale(subject: AuthenticatedSubject, cutoff: Date, now: Date): Promise<number> {
    const rows = await this.db
      .update(agentSessions)
      .set({ status: "ended", endedAt: sql`${agentSessions.lastEventAt}`, updatedAt: now })
      .where(and(
        eq(agentSessions.organizationId, subject.organizationId),
        eq(agentSessions.userId, subject.userId),
        eq(agentSessions.status, "running"),
        lt(agentSessions.lastEventAt, cutoff),
      ))
      .returning({ id: agentSessions.id });
    return rows.length;
  }
}

function asPathMappingRecord(row: typeof projectPathMappings.$inferSelect): PathMappingRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
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
