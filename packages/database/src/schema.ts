import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const sessionStatus = pgEnum("session_status", ["running", "stopped", "needs_review"]);
export const activitySegmentKind = pgEnum("activity_segment_kind", ["active", "idle", "locked", "suspended"]);
export const agentSessionStatus = pgEnum("agent_session_status", ["running", "ended"]);
// How a session learned its project. Rows written by the retired manual timer
// keep the default, "manual", which is also what the column backfills to.
export const sessionAttribution = pgEnum("session_attribution", ["manual", "selected", "agent", "default"]);

const auditColumns = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
};

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    // A standing code that lets a new account join this organization instead of
    // getting its own. Rotating it is an update, which is how a leaked code is revoked.
    inviteCode: text("invite_code").notNull(),
    ...auditColumns,
  },
  (table) => [unique("organizations_invite_code_unique").on(table.inviteCode)],
);

// id mirrors neon_auth."user".id. No foreign key: neon_auth is Neon-managed and
// may be recreated, so the link is enforced by verified JWT claims instead.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").$type<"admin" | "member">().default("member").notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("users_organization_id_id_unique").on(table.organizationId, table.id),
    unique("users_organization_id_email_unique").on(table.organizationId, table.email),
    check("users_role_valid", sql`${table.role} in ('admin', 'member')`),
    index("users_organization_id_idx").on(table.organizationId),
  ],
);

// Immutable record of the one administrator bootstrap for a workspace. A
// personal-workspace creator is recorded at provisioning; an ownerless legacy
// workspace can record one explicit first-admin claim instead. Keeping the
// organization id unique makes the claim a tenant-scoped compare-and-set.
export const organizationAdminClaims = pgTable(
  "organization_admin_claims",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    // The user id has a global primary key. A direct reference keeps this
    // immutable audit record valid when an account moves organizations; the
    // claim operation itself verifies the member belongs to organizationId.
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"creator" | "legacy_first_admin">().notNull(),
    claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("organization_admin_claims_organization_id_unique").on(table.organizationId),
    check("organization_admin_claims_kind_valid", sql`${table.kind} in ('creator', 'legacy_first_admin')`),
    index("organization_admin_claims_user_id_idx").on(table.userId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    archived: boolean("archived").default(false).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("projects_organization_id_id_unique").on(table.organizationId, table.id),
    check("projects_default_active", sql`not (${table.isDefault} and ${table.archived})`),
    index("projects_organization_id_archived_idx").on(table.organizationId, table.archived),
    uniqueIndex("projects_one_default_per_organization").on(table.organizationId).where(sql`${table.isDefault}`),
  ],
);

export const projectMemberships = pgTable(
  "project_memberships",
  {
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("project_memberships_organization_user_project_unique").on(
      table.organizationId,
      table.userId,
      table.projectId,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "project_memberships_organization_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
      name: "project_memberships_organization_user_fk",
    }).onDelete("cascade"),
    index("project_memberships_user_id_idx").on(table.userId),
    index("project_memberships_project_id_idx").on(table.projectId),
  ],
);

// The one dashboard view state both surfaces share: the project scope and
// range last picked, one row per member, last write wins. Scope is text, not a
// project FK: 'all' and 'unassigned' are values too, and a deleted project's
// stale scope harmlessly falls back to 'all' at read time.
export const userViewPreferences = pgTable(
  "user_view_preferences",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    scope: text("scope").default("all").notNull(),
    range: text("range").default("30d").notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("user_view_preferences_organization_user_unique").on(table.organizationId, table.userId),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
      name: "user_view_preferences_organization_user_fk",
    }).onDelete("cascade"),
    check("user_view_preferences_scope_valid", sql`char_length(${table.scope}) between 1 and 40`),
    check(
      "user_view_preferences_range_valid",
      sql`${table.range} in ('today', '7d', '30d', '90d', 'all')`,
    ),
  ],
);

export const userProjectSelections = pgTable(
  "user_project_selections",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("user_project_selections_organization_user_unique").on(table.organizationId, table.userId),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
      name: "user_project_selections_organization_user_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.userId, table.projectId],
      foreignColumns: [
        projectMemberships.organizationId,
        projectMemberships.userId,
        projectMemberships.projectId,
      ],
      name: "user_project_selections_membership_fk",
    }).onDelete("cascade"),
    index("user_project_selections_project_id_idx").on(table.projectId),
  ],
);

export const timeSessions = pgTable(
  "time_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    clientId: uuid("client_id").notNull(),
    deviceId: uuid("device_id"),
    description: text("description"),
    status: sessionStatus("status").default("running").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    stoppedAt: timestamp("stopped_at", { mode: "date", withTimezone: true }),
    idleSeconds: integer("idle_seconds").default(0).notNull(),
    durationSeconds: integer("duration_seconds"),
    attribution: sessionAttribution("attribution").default("manual").notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("time_sessions_organization_user_client_unique").on(table.organizationId, table.userId, table.clientId),
    foreignKey({
      columns: [table.organizationId, table.userId, table.projectId],
      foreignColumns: [
        projectMemberships.organizationId,
        projectMemberships.userId,
        projectMemberships.projectId,
      ],
      name: "time_sessions_membership_fk",
    }).onDelete("restrict"),
    check("time_sessions_idle_seconds_nonnegative", sql`${table.idleSeconds} >= 0`),
    check("time_sessions_duration_seconds_nonnegative", sql`${table.durationSeconds} is null or ${table.durationSeconds} >= 0`),
    check(
      "time_sessions_description_length_valid",
      sql`${table.description} is null or char_length(${table.description}) <= 1000`,
    ),
    check(
      "time_sessions_status_fields_valid",
      sql`(
        (${table.status} = 'running' and ${table.stoppedAt} is null and ${table.durationSeconds} is null)
        or
        (${table.status} in ('stopped', 'needs_review') and ${table.stoppedAt} is not null and ${table.durationSeconds} is not null)
      )`,
    ),
    uniqueIndex("time_sessions_one_running_user_unique")
      .on(table.userId)
      .where(sql`${table.status} = 'running'`),
    index("time_sessions_organization_project_started_at_idx").on(table.organizationId, table.projectId, table.startedAt),
    index("time_sessions_organization_user_started_at_idx").on(table.organizationId, table.userId, table.startedAt),
    index("time_sessions_organization_report_started_id_idx")
      .on(table.organizationId, desc(table.startedAt), table.id)
      .where(sql`${table.status} in ('stopped', 'needs_review')`),
  ],
);

// Coarse OS-activity evidence uploaded by the desktop monitor. Idempotent on the
// client-generated id, exactly like time_sessions.client_id.
export const activitySegments = pgTable(
  "activity_segments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    clientId: uuid("client_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    kind: activitySegmentKind("kind").notNull(),
    processName: text("process_name"),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { mode: "date", withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("activity_segments_organization_user_client_unique").on(table.organizationId, table.userId, table.clientId),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
      name: "activity_segments_organization_user_fk",
    }).onDelete("cascade"),
    check("activity_segments_time_order_valid", sql`${table.endedAt} > ${table.startedAt}`),
    check(
      "activity_segments_process_name_length_valid",
      sql`${table.processName} is null or char_length(${table.processName}) <= 200`,
    ),
    index("activity_segments_organization_user_started_at_idx").on(table.organizationId, table.userId, table.startedAt),
  ],
);

// Agent CLI sessions reported by clock-in-hook. Upserted on
// (organization, user, source, external session id); end-before-start is tolerated.
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    // Text rather than an enum, and checked only for shape: the runtime roster
    // in packages/shared/src/agent-runtimes.json decides what Clock-In can say
    // about a runtime, never whether it may be recorded. A runtime nobody has
    // declared yet lands here under its own id instead of being rejected or
    // collapsed into 'other', so supporting a new CLI needs no migration.
    source: text("source").notNull(),
    externalSessionId: text("external_session_id").notNull(),
    // What the runtime was driving, when its hook says so. Recorded beside the
    // runtime and never derived from it: pi on deepseek-v4-pro is still pi.
    model: text("model"),
    // Nullable until the attribution service resolves cwd to a project. The composite
    // FK uses MATCH SIMPLE, so a null projectId skips the tenant check entirely.
    projectId: uuid("project_id"),
    // Null for browser spans, which carry no working directory; the matched
    // url-rule mapping id below attributes them instead.
    cwd: text("cwd"),
    ruleId: uuid("rule_id"),
    status: agentSessionStatus("status").default("running").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { mode: "date", withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { mode: "date", withTimezone: true }).notNull(),
    linkedSessionId: uuid("linked_session_id").references(() => timeSessions.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("agent_sessions_organization_user_source_external_unique").on(
      table.organizationId,
      table.userId,
      table.source,
      table.externalSessionId,
    ),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
      name: "agent_sessions_organization_user_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "agent_sessions_organization_project_fk",
    }).onDelete("restrict"),
    check(
      "agent_sessions_status_fields_valid",
      sql`(
        (${table.status} = 'running' and ${table.endedAt} is null)
        or
        (${table.status} = 'ended' and ${table.endedAt} is not null)
      )`,
    ),
    check(
      "agent_sessions_external_session_id_length_valid",
      sql`char_length(${table.externalSessionId}) between 1 and 200`,
    ),
    check("agent_sessions_cwd_length_valid", sql`${table.cwd} is null or char_length(${table.cwd}) between 1 and 1000`),
    check("agent_sessions_source_valid", sql`${table.source} ~ '^[a-z][a-z0-9_]*$' and char_length(${table.source}) <= 40`),
    check("agent_sessions_model_length_valid", sql`${table.model} is null or char_length(${table.model}) between 1 and 200`),
    index("agent_sessions_organization_user_started_at_idx").on(table.organizationId, table.userId, table.startedAt),
  ],
);

// Per-user mapping from a filesystem path prefix (kind = 'path_prefix', with an optional
// git remote) or a URL rule pattern (kind = 'url_rule') to a project; the attribution
// service resolves agent-session cwds and browser-span rule ids against these. The
// (organization, user, path_prefix) uniqueness spans both kinds.
export const projectPathMappings = pgTable(
  "project_path_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").default("path_prefix").notNull(),
    pathPrefix: text("path_prefix").notNull(),
    repoUrl: text("repo_url"),
    projectId: uuid("project_id").notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("project_path_mappings_organization_user_prefix_unique").on(
      table.organizationId,
      table.userId,
      table.pathPrefix,
    ),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
      name: "project_path_mappings_organization_user_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "project_path_mappings_organization_project_fk",
    }).onDelete("cascade"),
    check(
      "project_path_mappings_path_prefix_length_valid",
      sql`char_length(${table.pathPrefix}) between 1 and 500`,
    ),
    check(
      "project_path_mappings_kind_valid",
      sql`${table.kind} in ('path_prefix', 'url_rule')`,
    ),
  ],
);
