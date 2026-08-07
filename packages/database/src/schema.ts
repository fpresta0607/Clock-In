import { sql } from "drizzle-orm";
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

const auditColumns = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
};

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  ...auditColumns,
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("users_organization_id_id_unique").on(table.organizationId, table.id),
    unique("users_organization_id_email_unique").on(table.organizationId, table.email),
    index("users_organization_id_idx").on(table.organizationId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    archived: boolean("archived").default(false).notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("projects_organization_id_id_unique").on(table.organizationId, table.id),
    index("projects_organization_id_archived_idx").on(table.organizationId, table.archived),
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

export const timeSessions = pgTable(
  "time_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    clientId: uuid("client_id").notNull(),
    status: sessionStatus("status").default("running").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    stoppedAt: timestamp("stopped_at", { mode: "date", withTimezone: true }),
    idleSeconds: integer("idle_seconds").default(0).notNull(),
    durationSeconds: integer("duration_seconds"),
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
  ],
);
