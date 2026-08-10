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
  const database = databaseUrl ? createDatabase(databaseUrl, { max: 1 }) : undefined;

  beforeAll(async () => {
    if (!database || !databaseUrl) return;
    // Migrations hard-reference the public schema (phase-2 enum types and
    // foreign keys), so the disposable boundary is the database itself, not
    // a schema. Refuse anything that is not obviously a scratch database.
    const dbName = new URL(databaseUrl).pathname.replace("/", "");
    if (!dbName.startsWith("clock_in_")) {
      throw new Error(
        `TEST_DATABASE_URL must point at a disposable database whose name starts with "clock_in_", got "${dbName}".`,
      );
    }
    await runMigrations(database);
    await runMigrations(database);
  });

  afterAll(async () => {
    if (!database) return;
    try {
      // Reset the scratch database so reruns start empty.
      await database.client.unsafe(`drop schema public cascade`);
      await database.client.unsafe(`create schema public`);
      await database.client.unsafe(`drop schema if exists drizzle cascade`);
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
      insert into organizations (id, name, invite_code) values (${organizationId}, 'Integration Org', ${randomUUID().replaceAll("-", "")})
    `;
    await database.client`
      insert into users (id, organization_id, email, name)
      values (${userId}, ${organizationId}, 'integration@example.test', 'Integration User')
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

  it("supports browser agent sources and url-rule mapping kinds", async () => {
    if (!database) return;
    const organizationId = randomUUID();
    const userId = randomUUID();
    const projectId = randomUUID();

    await database.client`
      insert into organizations (id, name, invite_code) values (${organizationId}, 'Browser Org', ${randomUUID().replaceAll("-", "")})
    `;
    await database.client`
      insert into users (id, organization_id, email, name)
      values (${userId}, ${organizationId}, 'browser@example.test', 'Browser User')
    `;
    await database.client`
      insert into projects (id, organization_id, name) values (${projectId}, ${organizationId}, 'Browser Project')
    `;

    // The agent_source enum accepts browser spans.
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, cwd, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-1', '', now(), now())
    `).rejects.toThrow();
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, cwd, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-1', 'rule:placeholder', now(), now())
    `).resolves.toBeDefined();

    // Browser spans carry no cwd; the matched url-rule id is stored instead.
    const [span] = await database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, rule_id, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-2', ${randomUUID()}, now(), now())
      returning cwd, rule_id
    `;
    expect(span?.cwd).toBeNull();
    expect(span?.rule_id).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, status, started_at, ended_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-3', 'stale', now() - interval '10 minutes', now() - interval '5 minutes', now() - interval '5 minutes')
    `).resolves.toBeDefined();
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, status, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-4', 'stale', now(), now())
    `).rejects.toThrow();

    // kind defaults to a path prefix, and the (org, user, prefix) uniqueness spans both kinds.
    const [defaulted] = await database.client`
      insert into project_path_mappings (organization_id, user_id, path_prefix, project_id)
      values (${organizationId}, ${userId}, 'github.com/acme/*', ${projectId})
      returning kind
    `;
    expect(defaulted?.kind).toBe("path_prefix");
    await expect(database.client`
      insert into project_path_mappings (organization_id, user_id, kind, path_prefix, project_id)
      values (${organizationId}, ${userId}, 'url_rule', 'github.com/acme/*', ${projectId})
    `).rejects.toThrow();
    await expect(database.client`
      insert into project_path_mappings (organization_id, user_id, kind, path_prefix, project_id)
      values (${organizationId}, ${userId}, 'url_rule', '*.figma.com/files/*', ${projectId})
      returning kind
    `).resolves.toBeDefined();

    // The kind column rejects anything outside the two known kinds.
    await expect(database.client`
      insert into project_path_mappings (organization_id, user_id, kind, path_prefix, project_id)
      values (${organizationId}, ${userId}, 'glob', 'example.com', ${projectId})
    `).rejects.toThrow();
  });
});
