import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "./auth.js";
import { DrizzleAgentRepository, DrizzleShiftCommitRepository } from "./drizzle-repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// The merge re-point is raw SQL with a NOT EXISTS guard against the
// (org, agent_id, repo_root, sha) unique, so only a real PostgreSQL can prove
// it neither errors on a collision nor leaves the loser's commits stranded.
// Token rows move under the same transaction: under v2 a moved or renamed
// directory makes merge the ordinary repair, and usage stranded on a retired
// row would silently leave a codebase's effort unattributed.
integration("agent merge re-points shift_commits and agent_usage", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const organizationId = randomUUID();
  const ownerUserId = randomUUID();
  const winnerId = randomUUID();
  const loserId = randomUUID();
  const winnerSessionId = randomUUID();
  const loserSessionId = randomUUID();
  const subject: AuthenticatedSubject = { organizationId, userId: ownerUserId, role: "admin" };
  let agents: DrizzleAgentRepository;
  let shiftCommits: DrizzleShiftCommitRepository;
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const authoredAt = new Date("2026-08-06T14:30:00.000Z");

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "agents_merge");
    database = disposable.database;
    await runMigrations(database);
    await database.client`
      insert into organizations (id, name, invite_code)
      values (${organizationId}, 'Roster Merge Test', ${randomUUID().slice(0, 11)})
    `;
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${ownerUserId}, ${organizationId}, 'merge@siqshift.test', 'Merge User', 'admin')
    `;
    await database.client`
      insert into agents (id, organization_id, owner_user_id, project_id, source, name, status)
      values
        (${winnerId}, ${organizationId}, ${ownerUserId}, null, 'claude_code', 'Claude Code @ unassigned', 'anonymous'),
        (${loserId}, ${organizationId}, ${ownerUserId}, null, 'codex', 'Codex @ unassigned', 'anonymous')
    `;
    const startedAt = "2026-08-06T14:00:00.000Z";
    const endedAt = "2026-08-06T15:00:00.000Z";
    await database.client`
      insert into agent_sessions (id, organization_id, user_id, source, external_session_id, model, project_id, cwd, rule_id, agent_id, status, started_at, ended_at, last_event_at)
      values
        (${winnerSessionId}, ${organizationId}, ${ownerUserId}, 'claude_code', 'winner-ext', null, null, '/repo', null, ${winnerId}, 'ended', ${startedAt}, ${endedAt}, ${endedAt}),
        (${loserSessionId}, ${organizationId}, ${ownerUserId}, 'codex', 'loser-ext', null, null, '/repo', null, ${loserId}, 'ended', ${startedAt}, ${endedAt}, ${endedAt})
    `;
    await database.client`
      insert into shift_commits (id, organization_id, user_id, agent_id, agent_session_id, client_id, repo_root, branch, sha, subject, authored_at, verification, verified_at)
      values
        (${randomUUID()}, ${organizationId}, ${ownerUserId}, ${winnerId}, ${winnerSessionId}, ${randomUUID()}, '/repo', 'main', ${shaA}, 'winner commit', ${authoredAt.toISOString()}, 'pending', null),
        (${randomUUID()}, ${organizationId}, ${ownerUserId}, ${loserId}, ${loserSessionId}, ${randomUUID()}, '/repo', 'main', ${shaB}, 'loser unique commit', ${authoredAt.toISOString()}, 'pending', null),
        (${randomUUID()}, ${organizationId}, ${ownerUserId}, ${loserId}, ${loserSessionId}, ${randomUUID()}, '/repo', 'main', ${shaA}, 'loser colliding commit', ${authoredAt.toISOString()}, 'pending', null)
    `;
    await database.client`
      insert into agent_usage (id, organization_id, user_id, agent_id, agent_session_id, client_id, bucket_start_at, model, sidechain, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
      values (${randomUUID()}, ${organizationId}, ${ownerUserId}, ${loserId}, ${loserSessionId}, ${randomUUID()}, ${startedAt}, 'claude-opus-5', false, 12000, 800, 400, 60000)
    `;
    agents = new DrizzleAgentRepository(database.db);
    shiftCommits = new DrizzleShiftCommitRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("moves the loser's commits to the winner except a colliding commit, and retires the loser", async () => {
    await agents.merge(subject, winnerId, loserId);

    const winnerCommits = await shiftCommits.listForAgent(subject, winnerId, {});
    const loserCommits = await shiftCommits.listForAgent(subject, loserId, {});

    expect(new Set(winnerCommits.map((commit) => commit.sha))).toEqual(new Set([shaA, shaB]));
    expect(new Set(loserCommits.map((commit) => commit.sha))).toEqual(new Set([shaA]));

    const loser = await agents.findById(subject, loserId);
    expect(loser?.status).toBe("retired");
  });

  // The gap v2 closes: the merge moved shifts and commits but never
  // agent_usage, so a merged agent's tokens stayed on the retired row and its
  // effort vanished from every report keyed on the winner.
  it("moves the loser's token rows to the winner too", async () => {
    const stranded = await database.client`
      select agent_id from agent_usage where organization_id = ${organizationId}
    `;

    expect(stranded.map((row) => row.agent_id)).toEqual([winnerId]);
  });

  // The merge above is what makes this case exist: retiring the loser has to
  // release its identity key, or the very next codex shift conflicts back
  // onto the retired row and the merge is undone before anyone sees it.
  it("gives the next shift on the loser's key a fresh identity, not the retired one", async () => {
    const minted = await agents.upsertForKey({
      organizationId,
      ownerUserId,
      source: "codex",
      repoRoot: null,
      projectId: null,
      name: "Codex",
      now: new Date(),
    });

    expect(minted.id).not.toBe(loserId);
    expect((await agents.findById(subject, minted.id))?.status).toBe("anonymous");
    expect((await agents.findById(subject, loserId))?.status).toBe("retired");
  });
});
