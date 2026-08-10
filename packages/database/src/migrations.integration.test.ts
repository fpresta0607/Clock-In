import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type DatabaseConnection } from "./client.js";
import { createDisposableTestDatabase, type DisposableTestDatabase } from "./disposable-test-database.js";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;
const integrationDescription = databaseUrl
  ? "initial PostgreSQL migration"
  : "initial PostgreSQL migration (skipped: TEST_DATABASE_URL is not set)";
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

async function migrationsThrough(index: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clock-in-migrations-"));
  const metadata = JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = metadata.entries.filter((entry) => entry.idx <= index);
  await mkdir(join(directory, "meta"));
  await writeFile(join(directory, "meta", "_journal.json"), JSON.stringify({ ...metadata, entries }));
  await Promise.all(entries.map(async (entry) => {
    await writeFile(
      join(directory, `${entry.tag}.sql`),
      await readFile(join(migrationsFolder, `${entry.tag}.sql`)),
    );
  }));
  return directory;
}

integration(integrationDescription, () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  let preBackfillMigrations: string | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "migrations");
    database = disposable.database;
    preBackfillMigrations = await migrationsThrough(12);
    await runMigrations(database, { migrationsFolder: preBackfillMigrations });
  });

  afterAll(async () => {
    if (disposable === undefined) return;
    let directoryError: unknown;
    let cleanupError: unknown;
    try {
      if (preBackfillMigrations !== undefined) await rm(preBackfillMigrations, { recursive: true, force: true });
    } catch (error) {
      directoryError = error;
    } finally {
      try {
        await disposable.cleanup();
      } catch (error) {
        cleanupError = error;
      }
    }
    if (directoryError !== undefined) throw directoryError;
    if (cleanupError !== undefined) throw cleanupError;
  });

  it("backfills legacy defaults and memberships without assigning an arbitrary administrator", async () => {
    if (!database) return;
    const legacyOrganizationId = randomUUID();
    const legacyFirstUserId = randomUUID();
    const legacySecondUserId = randomUUID();
    const existingOrganizationId = randomUUID();
    const existingUserId = randomUUID();
    const existingProjectId = randomUUID();

    await database.client`
      insert into organizations (id, name, invite_code)
      values
        (${legacyOrganizationId}, 'Legacy workspace', ${randomUUID().replaceAll("-", "")}),
        (${existingOrganizationId}, 'Existing default workspace', ${randomUUID().replaceAll("-", "")})
    `;
    await database.client`
      insert into users (id, organization_id, email, name)
      values
        (${legacyFirstUserId}, ${legacyOrganizationId}, 'legacy-first@example.test', 'Legacy First'),
        (${legacySecondUserId}, ${legacyOrganizationId}, 'legacy-second@example.test', 'Legacy Second'),
        (${existingUserId}, ${existingOrganizationId}, 'existing@example.test', 'Existing User')
    `;
    await database.client`
      insert into projects (id, organization_id, name, is_default)
      values (${existingProjectId}, ${existingOrganizationId}, 'Existing Default', true)
    `;

    await runMigrations(database);

    const legacyDefaults = await database.client`
      select id, name from projects
      where organization_id = ${legacyOrganizationId} and is_default and not archived
    `;
    expect(legacyDefaults).toEqual([expect.objectContaining({ name: "General Work" })]);
    const legacyRoles = await database.client`
      select role from users where organization_id = ${legacyOrganizationId} order by role
    `;
    expect(legacyRoles.map((user) => user.role)).toEqual(["member", "member"]);
    const legacyMemberships = await database.client`
      select user_id from project_memberships
      where organization_id = ${legacyOrganizationId} and project_id = ${legacyDefaults[0]!.id}
    `;
    expect(legacyMemberships).toHaveLength(2);
    const legacyClaims = await database.client`
      select user_id from organization_admin_claims where organization_id = ${legacyOrganizationId}
    `;
    expect(legacyClaims).toEqual([]);
    const existingDefaults = await database.client`
      select id, name from projects
      where organization_id = ${existingOrganizationId} and is_default and not archived
    `;
    expect(existingDefaults).toEqual([{ id: existingProjectId, name: "Existing Default" }]);
    const existingMemberships = await database.client`
      select user_id from project_memberships
      where organization_id = ${existingOrganizationId} and project_id = ${existingProjectId}
    `;
    expect(existingMemberships).toEqual([{ user_id: existingUserId }]);

    await runMigrations(database);
    const rerunDefaults = await database.client`
      select id from projects
      where organization_id = ${legacyOrganizationId} and is_default and not archived
    `;
    expect(rerunDefaults).toHaveLength(1);
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
