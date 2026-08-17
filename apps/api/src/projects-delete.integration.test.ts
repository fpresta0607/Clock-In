import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@clock-in/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "./auth.js";
import { DrizzleAgentRepository, DrizzleProjectRepository } from "./drizzle-repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// agents_organization_project_fk is ON DELETE restrict, so a project that has
// ever hosted an agent can only be deleted once every identity has left it.
// Only a real PostgreSQL enforces that, and only a real PostgreSQL can prove
// the re-point does not trip the identity key on the way out.
integration("deleting a project that hosts roster agents", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const organizationId = randomUUID();
  const ownerUserId = randomUUID();
  const subject: AuthenticatedSubject = { organizationId, userId: ownerUserId, role: "admin" };
  let projects: DrizzleProjectRepository;
  let agents: DrizzleAgentRepository;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "projects_delete");
    database = disposable.database;
    await runMigrations(database);
    await database.client`
      insert into organizations (id, name, invite_code)
      values (${organizationId}, 'Project Delete Test', ${randomUUID().slice(0, 11)})
    `;
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${ownerUserId}, ${organizationId}, 'delete@clock-in.test', 'Delete User', 'admin')
    `;
    projects = new DrizzleProjectRepository(database.db);
    agents = new DrizzleAgentRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  async function project(name: string): Promise<string> {
    const id = randomUUID();
    await database.client`
      insert into projects (id, organization_id, name) values (${id}, ${organizationId}, ${name})
    `;
    await database.client`
      insert into project_memberships (organization_id, project_id, user_id)
      values (${organizationId}, ${id}, ${ownerUserId})
    `;
    return id;
  }

  async function statusOf(agentId: string): Promise<{ projectId: string | null; status: string }> {
    const record = await agents.findById(subject, agentId);
    if (record === null) throw new Error("The agent was deleted rather than moved.");
    return { projectId: record.project?.id ?? null, status: record.status };
  }

  it("reports the identities the delete would move, alongside the sessions", async () => {
    const doomed = await project("Counted");
    await agents.upsertForKey({
      organizationId,
      ownerUserId,
      source: "claude_code",
      repoRoot: null,
      projectId: doomed,
      name: "Claude Code",
      now: new Date(),
    });

    await expect(projects.usageForOrganization(subject, doomed)).resolves.toEqual({
      sessionCount: 0,
      durationSeconds: 0,
      agentSessionCount: 0,
      agentCount: 1,
    });
  });

  it("moves the identity to the replacement project instead of failing on the foreign key", async () => {
    const doomed = await project("Moved from");
    const replacement = await project("Moved to");
    const moving = await agents.upsertForKey({
      organizationId,
      ownerUserId,
      source: "claude_code",
      repoRoot: null,
      projectId: doomed,
      name: "Claude Code",
      now: new Date(),
    });

    await projects.deleteForOrganization(subject, doomed, replacement);

    await expect(statusOf(moving.id)).resolves.toEqual({ projectId: replacement, status: "anonymous" });
    const remaining = await database.client`select id from projects where id = ${doomed}`;
    expect(remaining).toEqual([]);
  });

  it("unassigns the identity when the sessions go with the project", async () => {
    const doomed = await project("Deleted outright");
    const orphaning = await agents.upsertForKey({
      organizationId,
      ownerUserId,
      source: "codex",
      repoRoot: null,
      projectId: doomed,
      name: "Codex",
      now: new Date(),
    });

    await projects.deleteForOrganization(subject, doomed, null);

    await expect(statusOf(orphaning.id)).resolves.toEqual({ projectId: null, status: "anonymous" });
  });

  // Before v2 the project was part of the identity key, so moving two agents
  // onto one destination collided and the loser had to be retired to release
  // its key. The project is a plain attribute now, so both simply move and
  // both stay live - the codebase each works is what keeps them distinct.
  it("moves every identity to the destination project, keeping both live", async () => {
    const doomed = await project("Colliding from");
    const replacement = await project("Colliding to");
    const key = { organizationId, ownerUserId, source: "cursor" as const, name: "Cursor", now: new Date() };
    const incumbent = await agents.upsertForKey({ ...key, repoRoot: "C:/dev/clock-in", projectId: replacement });
    const moved = await agents.upsertForKey({ ...key, repoRoot: "C:/dev/pocket-piggies", projectId: doomed });
    expect(moved.id).not.toBe(incumbent.id);

    await projects.deleteForOrganization(subject, doomed, replacement);

    await expect(statusOf(moved.id)).resolves.toEqual({ projectId: replacement, status: "anonymous" });
    await expect(statusOf(incumbent.id)).resolves.toEqual({ projectId: replacement, status: "anonymous" });
    // Each identity is still the one its own repo's next shift lands on.
    await expect(agents.upsertForKey({ ...key, repoRoot: "C:/dev/pocket-piggies", projectId: replacement }))
      .resolves.toEqual({ id: moved.id });
  });
});
