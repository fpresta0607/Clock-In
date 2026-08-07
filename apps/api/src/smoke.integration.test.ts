import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations, type DatabaseConnection } from "@clock-in/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import {
  DrizzleAccountStore,
  DrizzleProjectRepository,
  DrizzleReportRepository,
  DrizzleSessionRepository,
} from "./drizzle-repositories.js";
import { parseEnv } from "./env.js";
import { createTestAuth } from "./test-tokens.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const integrationDescription = databaseUrl
  ? "manual timer smoke path"
  : "manual timer smoke path (skipped: TEST_DATABASE_URL is not set)";

const config = parseEnv({
  DATABASE_URL: databaseUrl ?? "postgres://unused:unused@localhost:5432/unused",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
  NODE_ENV: "test",
});

integration(integrationDescription, () => {
  const schemaName = `clock_in_smoke_${randomUUID().replaceAll("-", "")}`;
  const database = databaseUrl ? createDatabase(databaseUrl, { max: 1 }) : (undefined as unknown as DatabaseConnection);
  const authUserId = randomUUID();
  let app: ReturnType<typeof createApp>;
  let authorized: Record<string, string>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    await database.client.unsafe(`create schema "${schemaName}"`);
    await database.client.unsafe(`set search_path to "${schemaName}"`);
    await runMigrations(database, { migrationsSchema: schemaName });

    const auth = await createTestAuth(config, new Date());
    authorized = {
      authorization: await auth.bearer(authUserId, { email: "smoke@clock-in.test", name: "Smoke User" }),
      "content-type": "application/json",
    };
    app = createApp({
      config,
      keys: auth.keys,
      accounts: new DrizzleAccountStore(database.db),
      projectRepository: new DrizzleProjectRepository(database.db),
      sessionRepository: new DrizzleSessionRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
    });
  }, 60_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    try {
      await database.client.unsafe(`drop schema if exists "${schemaName}" cascade`);
    } finally {
      await database.client.end({ timeout: 5 });
    }
  });

  it("provisions an account on first sign-in, tracks a session, and exports it in a report", async () => {
    const me = await app.request("/me", { headers: authorized });
    expect(me.status).toBe(200);
    const { user } = await me.json();
    expect(user).toMatchObject({ id: authUserId, email: "smoke@clock-in.test", name: "Smoke User" });
    expect(user.organizationId).toMatch(/^[0-9a-f-]{36}$/i);

    // A second request must reuse the provisioned account rather than create another.
    const repeat = await app.request("/me", { headers: authorized });
    expect((await repeat.json()).user.organizationId).toBe(user.organizationId);

    const projects = await app.request("/projects", { headers: authorized });
    expect(projects.status).toBe(200);
    const listed = (await projects.json()).projects;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "General", isArchived: false });
    const projectId = listed[0].id;

    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const start = await app.request("/sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ clientId: randomUUID(), projectId, description: "Smoke work", startedAt }),
    });
    expect(start.status).toBe(200);
    const { session } = await start.json();
    expect(session.status).toBe("running");

    const current = await app.request("/sessions/current", { headers: authorized });
    expect((await current.json()).session.id).toBe(session.id);

    const stop = await app.request(`/sessions/${session.id}/stop`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ stoppedAt: new Date().toISOString(), idleSeconds: 10 }),
    });
    expect(stop.status).toBe(200);
    const stopped = (await stop.json()).session;
    expect(stopped.status).toBe("stopped");
    expect(stopped.durationSeconds).toBeGreaterThan(0);

    const report = await app.request("/reports", { headers: authorized });
    expect(report.status).toBe(200);
    const body = await report.json();
    expect(body.rows).toHaveLength(1);
    expect(body.totalDurationSeconds).toBe(stopped.durationSeconds);

    const csv = await app.request("/reports/export.csv", { headers: authorized });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text).toContain("General");
    expect(text).toContain("Smoke work");
  }, 60_000);

  it("keeps another account's data out of this account's projects and reports", async () => {
    const other = await createTestAuth(config, new Date());
    const otherApp = createApp({
      config,
      keys: other.keys,
      accounts: new DrizzleAccountStore(database.db),
      projectRepository: new DrizzleProjectRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
    });
    const headers = {
      authorization: await other.bearer(randomUUID(), { email: "other@clock-in.test", name: "Other User" }),
    };

    const projects = await otherApp.request("/projects", { headers });
    expect((await projects.json()).projects.map((project: { name: string }) => project.name)).toEqual(["General"]);

    const report = await otherApp.request("/reports", { headers });
    expect((await report.json()).rows).toEqual([]);
  }, 60_000);
});
