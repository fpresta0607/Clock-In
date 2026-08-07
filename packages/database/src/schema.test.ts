import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  organizations,
  projectMemberships,
  projects,
  timeSessions,
  users,
} from "./schema.js";

describe("database schema", () => {
  it("defines organization-scoped users and projects with audit timestamps", () => {
    expect(organizations.id.primary).toBe(true);
    expect(organizations.createdAt.notNull).toBe(true);
    expect(organizations.updatedAt.notNull).toBe(true);
    expect(organizations.createdAt.withTimezone).toBe(true);
    expect(organizations.updatedAt.withTimezone).toBe(true);
    expect(users.organizationId.notNull).toBe(true);
    expect(users.email.notNull).toBe(true);
    expect(users.passwordHash.notNull).toBe(true);
    expect(projects.organizationId.notNull).toBe(true);
    expect(projects.archived.notNull).toBe(true);
    expect(getTableConfig(users).uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "users_organization_id_email_unique",
    );
  });

  it("defines project memberships scoped to an organization", () => {
    expect(projectMemberships.organizationId.notNull).toBe(true);
    expect(projectMemberships.projectId.notNull).toBe(true);
    expect(projectMemberships.userId.notNull).toBe(true);
    expect(getTableConfig(projectMemberships).foreignKeys).toHaveLength(2);
  });

  it("defines constrained, idempotent time sessions", () => {
    expect(timeSessions.organizationId.notNull).toBe(true);
    expect(timeSessions.userId.notNull).toBe(true);
    expect(timeSessions.projectId.notNull).toBe(true);
    expect(timeSessions.clientId.notNull).toBe(true);
    expect(timeSessions.status.enumValues).toEqual(["running", "stopped", "needs_review"]);
    expect(timeSessions.startedAt.notNull).toBe(true);
    expect(timeSessions.idleSeconds.notNull).toBe(true);
    expect(timeSessions.createdAt.notNull).toBe(true);
    expect(timeSessions.updatedAt.notNull).toBe(true);
    expect(timeSessions.startedAt.withTimezone).toBe(true);
    expect(timeSessions.stoppedAt.withTimezone).toBe(true);

    const config = getTableConfig(timeSessions);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.checks.map((constraint) => constraint.name)).toEqual([
      "time_sessions_idle_seconds_nonnegative",
      "time_sessions_duration_seconds_nonnegative",
      "time_sessions_status_fields_valid",
    ]);
    const runningSessionIndex = config.indexes.find(
      (index) => index.config.name === "time_sessions_one_running_user_unique",
    );
    expect(runningSessionIndex?.config.unique).toBe(true);
    expect(runningSessionIndex?.config.where).toBeDefined();
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "time_sessions_organization_user_client_unique",
    );
  });
});
