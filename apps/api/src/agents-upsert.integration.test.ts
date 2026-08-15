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

  // Retiring has to mean retired. While the identity key covered every row,
  // the next shift conflicted onto the retired agent and put it straight back
  // on the pay run - which also undid every merge on the following shift.
  it("mints a fresh identity once a retired one has released the key", async () => {
    const now = new Date();
    const key = { organizationId, ownerUserId, projectId, name: "Codex", now } as const;
    const first = await repository.upsertForKey({ ...key, source: "codex" });
    await database.client`update agents set status = 'retired' where id = ${first.id}`;

    const replacement = await repository.upsertForKey({ ...key, source: "codex" });

    expect(replacement.id).not.toBe(first.id);
    expect((await repository.findById(subject, first.id))?.status).toBe("retired");
    expect((await repository.findById(subject, replacement.id))?.status).toBe("anonymous");
  });

  it("mints a fresh unassigned identity once the retired one has released the key", async () => {
    const now = new Date();
    const key = { organizationId, ownerUserId, projectId: null, name: "Cursor", now } as const;
    const first = await repository.upsertForKey({ ...key, source: "cursor" });
    await database.client`update agents set status = 'retired' where id = ${first.id}`;

    const replacement = await repository.upsertForKey({ ...key, source: "cursor" });

    expect(replacement.id).not.toBe(first.id);
    // And the replacement is still one identity, not one row per sighting.
    await expect(repository.upsertForKey({ ...key, source: "cursor" })).resolves.toEqual({ id: replacement.id });
  });

  // Releasing the key means something else can take it, so bringing the
  // retired row back is a conflict the caller can act on rather than a 500.
  it("refuses to un-retire an identity another agent now holds", async () => {
    const now = new Date();
    const key = { organizationId, ownerUserId, projectId, name: "Copilot", now } as const;
    const retired = await repository.upsertForKey({ ...key, source: "copilot" });
    await database.client`update agents set status = 'retired' where id = ${retired.id}`;
    await repository.upsertForKey({ ...key, source: "copilot" });

    await expect(repository.update(subject, retired.id, { status: "registered", updatedAt: now }))
      .rejects.toMatchObject({ code: "conflict" });
    expect((await repository.findById(subject, retired.id))?.status).toBe("retired");
  });
});
