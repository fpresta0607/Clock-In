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

/**
 * A copy of the chain with its newest migration left out, so the seeded rows
 * below are already in place when that migration runs. Derived from the
 * journal rather than a pinned index: the point is always "the newest
 * migration, against a populated database", whatever the newest one is.
 */
async function migrationsBeforeTheNewest(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clock-in-migrations-"));
  const metadata = JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = metadata.entries.slice(0, -1);
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

/**
 * A copy of the chain stopping after `tag`, so a migration can be run against
 * a database that already holds rows the previous one wrote. Pinned by tag
 * rather than by position because the test below is about one specific
 * migration's backfill, not about whichever migration happens to be newest.
 */
async function migrationsThrough(tag: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clock-in-migrations-through-"));
  const metadata = JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const cutoff = metadata.entries.findIndex((entry) => entry.tag === tag);
  if (cutoff < 0) throw new Error(`no migration tagged ${tag}`);
  const entries = metadata.entries.slice(0, cutoff + 1);
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
  let earlierMigrations: string | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "migrations");
    database = disposable.database;
    earlierMigrations = await migrationsBeforeTheNewest();
    await runMigrations(database, { migrationsFolder: earlierMigrations });
  });

  afterAll(async () => {
    if (disposable === undefined) return;
    let directoryError: unknown;
    let cleanupError: unknown;
    try {
      if (earlierMigrations !== undefined) await rm(earlierMigrations, { recursive: true, force: true });
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

  it("replays onto a populated workspace without inventing defaults, administrators, or timer devices", async () => {
    if (!database) return;
    const legacyOrganizationId = randomUUID();
    const legacyFirstUserId = randomUUID();
    const legacySecondUserId = randomUUID();
    const existingOrganizationId = randomUUID();
    const existingUserId = randomUUID();
    const existingProjectId = randomUUID();
    const legacyTimedProjectId = randomUUID();
    const legacySessionId = randomUUID();
    const legacyDeviceId = randomUUID();
    const legacyStartedAt = new Date("2026-08-01T10:00:00.000Z");
    const legacyStoppedAt = new Date("2026-08-01T12:00:00.000Z");

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
      values
        (${existingProjectId}, ${existingOrganizationId}, 'Existing Default', true),
        (${legacyTimedProjectId}, ${legacyOrganizationId}, 'Legacy timer project', false)
    `;
    await database.client`
      insert into project_memberships (organization_id, project_id, user_id)
      values (${legacyOrganizationId}, ${legacyTimedProjectId}, ${legacyFirstUserId})
    `;
    await database.client`
      insert into time_sessions (
        id, organization_id, user_id, project_id, client_id, status,
        started_at, stopped_at, idle_seconds, duration_seconds
      ) values (
        ${legacySessionId}, ${legacyOrganizationId}, ${legacyFirstUserId}, ${legacyTimedProjectId}, ${randomUUID()}, 'stopped',
        ${legacyStartedAt.toISOString()}, ${legacyStoppedAt.toISOString()}, 3600, 3600
      )
    `;
    await database.client`
      insert into activity_segments (
        organization_id, user_id, client_id, device_id, kind,
        started_at, ended_at, received_at
      ) values (
        ${legacyOrganizationId}, ${legacyFirstUserId}, ${randomUUID()}, ${legacyDeviceId}, 'idle',
        ${legacyStartedAt.toISOString()}, ${new Date("2026-08-01T11:00:00.000Z").toISOString()}, ${new Date("2026-08-01T11:01:00.000Z").toISOString()}
      )
    `;

    await runMigrations(database);

    // A migration no longer repairs a legacy workspace with a starter
    // project: the desktop app creates one at sign-in when the account has
    // none, so the chain leaves the workspace exactly as it found it.
    const legacyDefaults = await database.client`
      select id, name from projects
      where organization_id = ${legacyOrganizationId} and is_default and not archived
    `;
    expect(legacyDefaults).toEqual([]);
    const legacyRoles = await database.client`
      select role from users where organization_id = ${legacyOrganizationId} order by role
    `;
    expect(legacyRoles.map((user) => user.role)).toEqual(["member", "member"]);
    const legacyMemberships = await database.client`
      select project_id, user_id from project_memberships
      where organization_id = ${legacyOrganizationId}
    `;
    expect(legacyMemberships).toEqual([{ project_id: legacyTimedProjectId, user_id: legacyFirstUserId }]);
    const legacyClaims = await database.client`
      select user_id from organization_admin_claims where organization_id = ${legacyOrganizationId}
    `;
    expect(legacyClaims).toEqual([]);
    const existingDefaults = await database.client`
      select id, name from projects
      where organization_id = ${existingOrganizationId} and is_default and not archived
    `;
    expect(existingDefaults).toEqual([{ id: existingProjectId, name: "Existing Default" }]);
    // Memberships are not backfilled either: the project keeps whatever
    // access it already had, which here is none.
    const existingMemberships = await database.client`
      select user_id from project_memberships
      where organization_id = ${existingOrganizationId} and project_id = ${existingProjectId}
    `;
    expect(existingMemberships).toEqual([]);
    const legacySession = await database.client`
      select device_id from time_sessions where id = ${legacySessionId}
    `;
    expect(legacySession).toEqual([{ device_id: null }]);

    // A second run is a no-op rather than a second helping of anything.
    await runMigrations(database);
    const rerunProjects = await database.client`
      select id from projects where organization_id = ${legacyOrganizationId}
    `;
    expect(rerunProjects).toEqual([{ id: legacyTimedProjectId }]);
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

    // agent_sessions.source is text with a shape check; 'browser' is a valid source.
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, cwd, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-1', '', now(), now())
    `).rejects.toThrow();
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, cwd, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-1', 'rule:placeholder', now(), now())
    `).resolves.toBeDefined();
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', '', now(), now())
    `).rejects.toThrow();
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', ${"x".repeat(201)}, now(), now())
    `).rejects.toThrow();

    // Browser spans carry no cwd; the matched url-rule id is stored instead.
    const [span] = await database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, rule_id, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-2', ${randomUUID()}, now(), now())
      returning cwd, rule_id
    `;
    expect(span?.cwd).toBeNull();
    expect(span?.rule_id).toMatch(/^[0-9a-f-]{36}$/i);
    // An ended span carries the instant it ended; the status check makes the
    // half-set row unrepresentable rather than merely discouraged.
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, status, started_at, ended_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-3', 'ended', now() - interval '10 minutes', now() - interval '5 minutes', now() - interval '5 minutes')
    `).resolves.toBeDefined();
    await expect(database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, status, started_at, last_event_at)
      values (${organizationId}, ${userId}, 'browser', 'span-4', 'ended', now(), now())
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
    await expect(database.client`
      insert into project_path_mappings (organization_id, user_id, kind, path_prefix, project_id)
      values (${organizationId}, ${userId}, 'url_rule', '', ${projectId})
    `).rejects.toThrow();
    await expect(database.client`
      insert into project_path_mappings (organization_id, user_id, kind, path_prefix, project_id)
      values (${organizationId}, ${userId}, 'url_rule', ${"x".repeat(501)}, ${projectId})
    `).rejects.toThrow();
  });
});


/**
 * `0016_agent_identity_by_remote` moves the roster's identity key from
 * `repo_root` onto `repo_key` and hand-adds a backfill between the new column
 * and the unique indexes built on it. Two things have to hold, and neither is
 * visible on an empty database:
 *
 * - the indexes must build, which they only do if the backfill cannot fold two
 *   live rows onto one key - hence `'path:' || repo_root` verbatim rather than
 *   any normalization;
 * - the key it writes must be exactly the one `identityRepoKey` composes for a
 *   repository with no known remote, or the first shift after the deploy mints
 *   a duplicate of every agent that already existed.
 */
integration(
  databaseUrl
    ? "0016 carries existing agents onto the repository key"
    : "0016 carries existing agents onto the repository key (skipped: TEST_DATABASE_URL is not set)",
  () => {
    let disposable: DisposableTestDatabase | undefined;
    let database = undefined as unknown as DatabaseConnection;
    let throughFifteen: string | undefined;
    const organizationId = randomUUID();
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const clockIn = "C:/dev/clock-in";
    const worktree = "C:/Users/fpres/.treehouse/precisiondocs-fdd5f2/2/precisiondocs";

    beforeAll(async () => {
      if (!databaseUrl) return;
      disposable = await createDisposableTestDatabase(databaseUrl, "migrations_0016");
      database = disposable.database;
      throughFifteen = await migrationsThrough("0015_agent_identity_v2");
      await runMigrations(database, { migrationsFolder: throughFifteen });
      await database.client`
        insert into organizations (id, name, invite_code)
        values (${organizationId}, 'Identity backfill', ${randomUUID().replaceAll("-", "").slice(0, 11)})
      `;
      await database.client`
        insert into users (id, organization_id, email, name)
        values (${ownerId}, ${organizationId}, 'owner@example.test', 'Owner'),
               (${otherOwnerId}, ${organizationId}, 'other@example.test', 'Other')
      `;
      // The roster as it stands before the repair: one row per path, two
      // operators' buckets, and a retired row whose key is released.
      await database.client`
        insert into agents (organization_id, owner_user_id, source, repo_root, name, status)
        values
          (${organizationId}, ${ownerId}, 'claude_code', ${clockIn}, 'Claude Code @ clock-in', 'anonymous'),
          (${organizationId}, ${ownerId}, 'claude_code', ${worktree}, 'Claude Code @ precisiondocs', 'anonymous'),
          (${organizationId}, ${ownerId}, 'claude_code', null, 'Claude Code @ unassigned', 'anonymous'),
          (${organizationId}, ${otherOwnerId}, 'claude_code', ${clockIn}, 'Claude Code @ clock-in', 'anonymous'),
          (${organizationId}, ${otherOwnerId}, 'claude_code', null, 'Claude Code @ unassigned', 'anonymous'),
          (${organizationId}, ${ownerId}, 'codex', ${clockIn}, 'Codex @ clock-in', 'retired')
      `;
    }, 60_000);

    afterAll(async () => {
      if (throughFifteen !== undefined) await rm(throughFifteen, { recursive: true, force: true });
      if (disposable !== undefined) await disposable.cleanup();
    });

    it("keys every existing row on the path it already had, and stays idempotent", async () => {
      if (!database) return;
      await runMigrations(database);

      const rows = await database.client`
        select repo_root, repo_key, status from agents
        where organization_id = ${organizationId}
        order by owner_user_id, source, repo_root nulls first
      `;
      for (const row of rows) {
        // The one invariant the deploy rests on: `identityRepoKey(root, null)`
        // composes exactly this, so a replayed shift finds its own row.
        expect(row.repo_key).toBe(row.repo_root === null ? null : `path:${row.repo_root}`);
      }
      // The buckets stayed null and so stayed one row per operator, which is
      // what the unassigned half of the key means.
      expect(rows.filter((row) => row.repo_key === null)).toHaveLength(2);
      // A retired row is carried across too - it is audit trail, not a key
      // holder, and both indexes exclude it either way.
      expect(rows.filter((row) => row.status === "retired")).toHaveLength(1);

      await runMigrations(database);
      const replayed = await database.client`
        select count(*)::int as count from agents where organization_id = ${organizationId}
      `;
      expect(replayed).toEqual([{ count: 6 }]);
    });
  },
);
