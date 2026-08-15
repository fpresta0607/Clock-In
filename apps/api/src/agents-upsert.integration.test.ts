import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@clock-in/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "./auth.js";
import { DrizzleAgentRepository } from "./drizzle-repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// The roster identity key is (organization, source, project) with project
// nullable. Only NULLS NOT DISTINCT (PG >= 15) makes two null-project
// sightings one agent; a schema-test cannot exercise that, so this runs the
// real upsert against a real PostgreSQL server.
integration("agents nulls-not-distinct identity upsert", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const organizationId = randomUUID();
  const ownerUserId = randomUUID();
  const projectId = randomUUID();
  const subject: AuthenticatedSubject = { organizationId, userId: ownerUserId, role: "member" };
  let repository: DrizzleAgentRepository;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "agents_upsert");
    database = disposable.database;
    await runMigrations(database);
    await database.client`
      insert into organizations (id, name, invite_code)
      values (${organizationId}, 'Roster Test', ${randomUUID().slice(0, 11)})
    `;
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${ownerUserId}, ${organizationId}, 'roster@clock-in.test', 'Roster User', 'member')
    `;
    await database.client`
      insert into projects (id, organization_id, name)
      values (${projectId}, ${organizationId}, 'Field work')
    `;
    repository = new DrizzleAgentRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("answers a replayed null-project key with the same identity", async () => {
    const now = new Date();
    const first = await repository.upsertForKey({
      organizationId,
      ownerUserId,
      source: "claude_code",
      projectId: null,
      name: "Claude Code",
      now,
    });
    const replay = await repository.upsertForKey({
      organizationId,
      ownerUserId,
      source: "claude_code",
      projectId: null,
      name: "Claude Code",
      now,
    });

    expect(replay.id).toBe(first.id);
    const record = await repository.findById(subject, first.id);
    expect(record?.name).toBe("Claude Code @ unassigned");
    expect(record?.status).toBe("anonymous");
  });

  it("mints a separate identity per project and composes its name from the project", async () => {
    const now = new Date();
    const unassigned = await repository.upsertForKey({
      organizationId,
      ownerUserId,
      source: "claude_code",
      projectId: null,
      name: "Claude Code",
      now,
    });
    const scoped = await repository.upsertForKey({
      organizationId,
      ownerUserId,
      source: "claude_code",
      projectId,
      name: "Claude Code",
      now,
    });

    expect(scoped.id).not.toBe(unassigned.id);
    const record = await repository.findById(subject, scoped.id);
    expect(record?.name).toBe("Claude Code @ Field work");
    expect(record?.project).toEqual({ id: projectId, name: "Field work" });
  });
});
