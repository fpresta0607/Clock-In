import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;
const integrationDescription = databaseUrl
  ? "initial PostgreSQL migration"
  : "initial PostgreSQL migration (skipped: TEST_DATABASE_URL is not set)";

integration(integrationDescription, () => {
  const schemaName = `clock_in_test_${randomUUID().replaceAll("-", "")}`;
  const database = databaseUrl ? createDatabase(databaseUrl, { max: 1 }) : undefined;

  beforeAll(async () => {
    if (!database) return;
    await database.client.unsafe(`create schema \"${schemaName}\"`);
    await database.client.unsafe(`set search_path to \"${schemaName}\"`);
    await runMigrations(database, { migrationsSchema: schemaName });
    await runMigrations(database, { migrationsSchema: schemaName });
  });

  afterAll(async () => {
    if (!database) return;
    try {
      await database.client.unsafe(`drop schema if exists \"${schemaName}\" cascade`);
    } finally {
      await database.client.end({ timeout: 5 });
    }
  });

  it("enforces tenant foreign keys and a single running session per user", async () => {
    if (!database) return;
    const organizationId = randomUUID();
    const userId = randomUUID();
    const projectId = randomUUID();
    const unassignedProjectId = randomUUID();
    const secondProjectId = randomUUID();
    const sessionId = randomUUID();

    await database.client`
      insert into organizations (id, name) values (${organizationId}, 'Integration Org')
    `;
    await database.client`
      insert into users (id, organization_id, email, name, password_hash)
      values (${userId}, ${organizationId}, 'integration@example.test', 'Integration User', 'not-a-password')
    `;
    await database.client`
      insert into projects (id, organization_id, name) values (${projectId}, ${organizationId}, 'Project One')
    `;
    await database.client`
      insert into project_memberships (organization_id, project_id, user_id)
      values (${organizationId}, ${projectId}, ${userId})
    `;
    await database.client`
      insert into projects (id, organization_id, name) values (${unassignedProjectId}, ${organizationId}, 'Unassigned')
    `;
    await expect(database.client`
      insert into projects (id, organization_id, name) values (${secondProjectId}, ${randomUUID()}, 'Wrong Tenant')
    `).rejects.toThrow();
    await database.client`
      insert into time_sessions (id, organization_id, user_id, project_id, client_id, status, started_at)
      values (${sessionId}, ${organizationId}, ${userId}, ${projectId}, ${randomUUID()}, 'running', now())
    `;
    await expect(database.client`
      insert into time_sessions (id, organization_id, user_id, project_id, client_id, status, started_at, stopped_at, duration_seconds)
      values (${randomUUID()}, ${organizationId}, ${userId}, ${unassignedProjectId}, ${randomUUID()}, 'stopped', now(), now(), 1)
    `).rejects.toThrow();
    await expect(database.client`
      insert into time_sessions (id, organization_id, user_id, project_id, client_id, status, started_at)
      values (${randomUUID()}, ${organizationId}, ${userId}, ${projectId}, ${randomUUID()}, 'running', now())
    `).rejects.toThrow();
    await expect(database.client`
      update time_sessions
      set status = 'stopped', stopped_at = now(), duration_seconds = 1
      where id = ${sessionId}
    `).resolves.toBeDefined();
    await expect(database.client`
      insert into time_sessions (id, organization_id, user_id, project_id, client_id, status, started_at, stopped_at, duration_seconds)
      values (${randomUUID()}, ${organizationId}, ${userId}, ${projectId}, ${randomUUID()}, 'stopped', now(), now(), 1)
    `).resolves.toBeDefined();
  });
});
