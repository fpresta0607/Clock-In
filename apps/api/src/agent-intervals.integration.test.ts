import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@clock-in/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import {
  DrizzleAccountStore,
  DrizzleActivitySegmentRepository,
  DrizzleAgentSessionRepository,
  DrizzlePathMappingRepository,
  DrizzleProjectRepository,
  DrizzleReportRepository,
  DrizzleSessionRepository,
} from "./drizzle-repositories.js";
import { parseEnv } from "./env.js";
import { createTestAuth } from "./test-tokens.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// Regression for the production leaderboard 500: readAgentIntervals bound the
// `from` range bound as a bare Date on the right of a raw sql`` fragment, which
// strips drizzle's Date mapping and makes postgres-js refuse the query. The fix
// serializes the bound as an ISO string, like every other report range bound.
// This runs the real leaderboard endpoint against a real PostgreSQL server so
// the driver-level serialization is actually exercised.
integration("leaderboard agent-interval range binding", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const authUserId = randomUUID();
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "agent_interval_regression");
    database = disposable.database;
    const config = parseEnv({
      DATABASE_URL: disposable.databaseUrl,
      AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
      NODE_ENV: "test",
    });
    await runMigrations(database);

    const auth = await createTestAuth(config, new Date());
    headers = {
      authorization: await auth.bearer(authUserId, { email: "regression@clock-in.test", name: "Regression User" }),
      "content-type": "application/json",
    };
    app = createApp({
      config,
      keys: auth.keys,
      accounts: new DrizzleAccountStore(database.db),
      projectRepository: new DrizzleProjectRepository(database.db),
      sessionRepository: new DrizzleSessionRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
      pathMappingRepository: new DrizzlePathMappingRepository(database.db),
      activitySegmentRepository: new DrizzleActivitySegmentRepository(database.db),
    });
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("returns the leaderboard with a from bound instead of 500ing", async () => {
    const me = await app.request("/me", { headers });
    expect(me.status).toBe(200);
    const { user } = await me.json();

    const endedAt = new Date(Date.now() - 30_000);
    const startedAt = new Date(endedAt.getTime() - 3_600_000);
    await database.client`
      insert into agent_sessions (
        id, organization_id, user_id, source, external_session_id, model,
        project_id, cwd, rule_id, status, started_at, ended_at, last_event_at,
        linked_session_id, received_at
      ) values (
        ${randomUUID()}, ${user.organizationId}, ${user.id}, 'claude_code', ${randomUUID()}, null,
        null, null, null, 'ended', ${startedAt.toISOString()}, ${endedAt.toISOString()}, ${endedAt.toISOString()},
        null, ${endedAt.toISOString()}
      )
    `;

    const fromAt = new Date(Date.now() - 7_200_000).toISOString();
    const toExclusiveAt = new Date(Date.now() + 3_600_000).toISOString();
    const response = await app.request(
      `/reports/leaderboard?fromAt=${encodeURIComponent(fromAt)}&toExclusiveAt=${encodeURIComponent(toExclusiveAt)}`,
      { headers },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toContainEqual(expect.objectContaining({
      user: { id: user.id, name: user.name },
      agentSeconds: 3_600,
    }));
  }, 60_000);
});
