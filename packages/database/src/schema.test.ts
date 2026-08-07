import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  activitySegments,
  agentSessions,
  organizations,
  projectMemberships,
  projectPathMappings,
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
    expect(users.id.primary).toBe(true);
    expect(users.email.notNull).toBe(true);
    expect(projects.organizationId.notNull).toBe(true);
    expect(projects.id.primary).toBe(true);
    expect(projects.archived.notNull).toBe(true);
    for (const table of [users, projects]) {
      expect(table.createdAt.notNull).toBe(true);
      expect(table.updatedAt.notNull).toBe(true);
      expect(table.createdAt.withTimezone).toBe(true);
      expect(table.updatedAt.withTimezone).toBe(true);
    }
    expect(getTableConfig(users).uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "users_organization_id_email_unique",
    );
  });

  it("defines project memberships scoped to an organization", () => {
    expect(projectMemberships.organizationId.notNull).toBe(true);
    expect(projectMemberships.projectId.notNull).toBe(true);
    expect(projectMemberships.userId.notNull).toBe(true);
    expect(projectMemberships.createdAt.notNull).toBe(true);
    expect(projectMemberships.updatedAt.notNull).toBe(true);
    expect(projectMemberships.createdAt.withTimezone).toBe(true);
    expect(projectMemberships.updatedAt.withTimezone).toBe(true);
    const config = getTableConfig(projectMemberships);
    expect(config.foreignKeys).toHaveLength(2);
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "project_memberships_organization_user_project_unique",
    );
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining(["project_memberships_user_id_idx", "project_memberships_project_id_idx"]),
    );
  });

  it("defines constrained, idempotent time sessions", () => {
    expect(timeSessions.organizationId.notNull).toBe(true);
    expect(timeSessions.id.primary).toBe(true);
    expect(timeSessions.userId.notNull).toBe(true);
    expect(timeSessions.projectId.notNull).toBe(true);
    expect(timeSessions.clientId.notNull).toBe(true);
    expect(timeSessions.description.notNull).toBe(false);
    expect(timeSessions.description.columnType).toBe("PgText");
    expect(timeSessions.status.enumValues).toEqual(["running", "stopped", "needs_review"]);
    expect(timeSessions.startedAt.notNull).toBe(true);
    expect(timeSessions.idleSeconds.notNull).toBe(true);
    expect(timeSessions.idleSeconds.columnType).toBe("PgInteger");
    expect(timeSessions.durationSeconds.columnType).toBe("PgInteger");
    expect(timeSessions.createdAt.notNull).toBe(true);
    expect(timeSessions.updatedAt.notNull).toBe(true);
    expect(timeSessions.createdAt.withTimezone).toBe(true);
    expect(timeSessions.updatedAt.withTimezone).toBe(true);
    expect(timeSessions.startedAt.withTimezone).toBe(true);
    expect(timeSessions.stoppedAt.withTimezone).toBe(true);

    const config = getTableConfig(timeSessions);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "time_sessions_idle_seconds_nonnegative",
        "time_sessions_duration_seconds_nonnegative",
        "time_sessions_description_length_valid",
        "time_sessions_status_fields_valid",
      ]),
    );
    const descriptionLengthCheck = config.checks.find(
      (constraint) => constraint.name === "time_sessions_description_length_valid",
    );
    expect(new PgDialect().sqlToQuery(descriptionLengthCheck!.value).sql).toContain(
      'char_length("time_sessions"."description") <= 1000',
    );
    const runningSessionIndex = config.indexes.find(
      (index) => index.config.name === "time_sessions_one_running_user_unique",
    );
    expect(runningSessionIndex?.config.unique).toBe(true);
    expect(runningSessionIndex?.config.where).toBeDefined();
    const reportIndex = config.indexes.find(
      (index) => index.config.name === "time_sessions_organization_report_started_id_idx",
    );
    expect(reportIndex?.config.unique).toBe(false);
    expect(reportIndex?.config.where).toBeDefined();
    expect(new PgDialect().sqlToQuery(reportIndex!.config.where!).sql).toContain("'stopped'");
    expect(reportIndex?.config.columns[0]?.indexConfig.order).toBe("asc");
    expect(new PgDialect().sqlToQuery(reportIndex!.config.columns[1] as SQL).sql).toContain('"started_at" desc');
    expect(reportIndex?.config.columns[2]?.indexConfig.order).toBe("asc");
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "time_sessions_organization_user_client_unique",
    );
    for (const indexName of [
      "time_sessions_organization_project_started_at_idx",
      "time_sessions_organization_user_started_at_idx",
    ]) {
      const reportingIndex = config.indexes.find((index) => index.config.name === indexName);
      expect(reportingIndex?.config.unique).toBe(false);
      expect(reportingIndex?.config.where).toBeUndefined();
    }
  });

  it("defines idempotent, time-ordered activity segments scoped to a user device", () => {
    expect(activitySegments.id.primary).toBe(true);
    expect(activitySegments.organizationId.notNull).toBe(true);
    expect(activitySegments.userId.notNull).toBe(true);
    expect(activitySegments.clientId.notNull).toBe(true);
    expect(activitySegments.deviceId.notNull).toBe(true);
    expect(activitySegments.kind.notNull).toBe(true);
    expect(activitySegments.kind.enumValues).toEqual(["active", "idle", "locked", "suspended"]);
    expect(activitySegments.processName.notNull).toBe(false);
    expect(activitySegments.processName.columnType).toBe("PgText");
    expect(activitySegments.startedAt.notNull).toBe(true);
    expect(activitySegments.endedAt.notNull).toBe(true);
    expect(activitySegments.startedAt.withTimezone).toBe(true);
    expect(activitySegments.endedAt.withTimezone).toBe(true);
    expect(activitySegments.receivedAt.notNull).toBe(true);
    expect(activitySegments.receivedAt.withTimezone).toBe(true);
    expect(activitySegments.createdAt.notNull).toBe(true);
    expect(activitySegments.updatedAt.notNull).toBe(true);

    const config = getTableConfig(activitySegments);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "activity_segments_organization_user_client_unique",
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "activity_segments_time_order_valid",
        "activity_segments_process_name_length_valid",
      ]),
    );
    const timeOrderCheck = config.checks.find((constraint) => constraint.name === "activity_segments_time_order_valid");
    expect(new PgDialect().sqlToQuery(timeOrderCheck!.value).sql).toContain('"ended_at" > "activity_segments"."started_at"');
    const processNameCheck = config.checks.find(
      (constraint) => constraint.name === "activity_segments_process_name_length_valid",
    );
    expect(new PgDialect().sqlToQuery(processNameCheck!.value).sql).toContain(
      'char_length("activity_segments"."process_name") <= 200',
    );
    const userTimelineIndex = config.indexes.find(
      (index) => index.config.name === "activity_segments_organization_user_started_at_idx",
    );
    expect(userTimelineIndex?.config.unique).toBe(false);
    expect(userTimelineIndex?.config.where).toBeUndefined();
  });

  it("defines upsertable agent sessions with status-consistent timestamps", () => {
    expect(agentSessions.id.primary).toBe(true);
    expect(agentSessions.organizationId.notNull).toBe(true);
    expect(agentSessions.userId.notNull).toBe(true);
    expect(agentSessions.source.notNull).toBe(true);
    expect(agentSessions.source.enumValues).toEqual(["claude_code", "codex", "kimi_code", "other"]);
    expect(agentSessions.externalSessionId.notNull).toBe(true);
    expect(agentSessions.externalSessionId.columnType).toBe("PgText");
    expect(agentSessions.projectId.notNull).toBe(false);
    expect(agentSessions.cwd.notNull).toBe(true);
    expect(agentSessions.status.notNull).toBe(true);
    expect(agentSessions.status.enumValues).toEqual(["running", "ended"]);
    expect(agentSessions.startedAt.notNull).toBe(true);
    expect(agentSessions.endedAt.notNull).toBe(false);
    expect(agentSessions.lastEventAt.notNull).toBe(true);
    expect(agentSessions.lastEventAt.withTimezone).toBe(true);
    expect(agentSessions.linkedSessionId.notNull).toBe(false);
    expect(agentSessions.receivedAt.notNull).toBe(true);
    expect(agentSessions.createdAt.notNull).toBe(true);
    expect(agentSessions.updatedAt.notNull).toBe(true);

    const config = getTableConfig(agentSessions);
    expect(config.foreignKeys).toHaveLength(3);
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "agent_sessions_organization_user_source_external_unique",
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "agent_sessions_status_fields_valid",
        "agent_sessions_external_session_id_length_valid",
        "agent_sessions_cwd_length_valid",
      ]),
    );
    const statusCheck = config.checks.find((constraint) => constraint.name === "agent_sessions_status_fields_valid");
    expect(new PgDialect().sqlToQuery(statusCheck!.value).sql).toContain("'running'");
    const externalIdCheck = config.checks.find(
      (constraint) => constraint.name === "agent_sessions_external_session_id_length_valid",
    );
    expect(new PgDialect().sqlToQuery(externalIdCheck!.value).sql).toContain(
      'char_length("agent_sessions"."external_session_id") between 1 and 200',
    );
    const cwdCheck = config.checks.find((constraint) => constraint.name === "agent_sessions_cwd_length_valid");
    expect(new PgDialect().sqlToQuery(cwdCheck!.value).sql).toContain(
      'char_length("agent_sessions"."cwd") between 1 and 1000',
    );
    const userTimelineIndex = config.indexes.find(
      (index) => index.config.name === "agent_sessions_organization_user_started_at_idx",
    );
    expect(userTimelineIndex?.config.unique).toBe(false);
    expect(userTimelineIndex?.config.where).toBeUndefined();
  });

  it("defines per-user project path mappings with unique prefixes", () => {
    expect(projectPathMappings.id.primary).toBe(true);
    expect(projectPathMappings.organizationId.notNull).toBe(true);
    expect(projectPathMappings.userId.notNull).toBe(true);
    expect(projectPathMappings.pathPrefix.notNull).toBe(true);
    expect(projectPathMappings.pathPrefix.columnType).toBe("PgText");
    expect(projectPathMappings.repoUrl.notNull).toBe(false);
    expect(projectPathMappings.projectId.notNull).toBe(true);
    expect(projectPathMappings.createdAt.notNull).toBe(true);
    expect(projectPathMappings.updatedAt.notNull).toBe(true);

    const config = getTableConfig(projectPathMappings);
    expect(config.foreignKeys).toHaveLength(2);
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "project_path_mappings_organization_user_prefix_unique",
    );
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "project_path_mappings_path_prefix_length_valid",
    );
    const prefixCheck = config.checks.find(
      (constraint) => constraint.name === "project_path_mappings_path_prefix_length_valid",
    );
    expect(new PgDialect().sqlToQuery(prefixCheck!.value).sql).toContain(
      'char_length("project_path_mappings"."path_prefix") between 1 and 500',
    );
  });
});
