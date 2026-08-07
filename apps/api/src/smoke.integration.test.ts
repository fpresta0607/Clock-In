import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations, type DatabaseConnection } from "@clock-in/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { hashPassword } from "./auth.js";
import {
  DrizzleProjectRepository,
  DrizzleReportRepository,
  DrizzleSessionRepository,
  DrizzleUserCredentialStore,
} from "./drizzle-repositories.js";
import { parseEnv } from "./env.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const integrationDescription = databaseUrl
  ? "manual timer smoke path"
  : "manual timer smoke path (skipped: TEST_DATABASE_URL is not set)";

const password = "correct-horse-battery-staple";
const email = "smoke@clock-in.test";

integration(integrationDescription, () => {
  const schemaName = `clock_in_smoke_${randomUUID().replaceAll("-", "")}`;
  const database = databaseUrl ? createDatabase(databaseUrl, { max: 1 }) : (undefined as unknown as DatabaseConnection);
  const organizationId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    await database.client.unsafe(`create schema "${schemaName}"`);
    await database.client.unsafe(`set search_path to "${schemaName}"`);
    await runMigrations(database, { migrationsSchema: schemaName });

    await database.client`insert into organizations (id, name) values (${organizationId}, 'Smoke Org')`;
    await database.client`
      insert into users (id, organization_id, email, name, password_hash)
      values (${userId}, ${organizationId}, ${email}, 'Smoke User', ${await hashPassword(password)})
    `;
    await database.client`insert into projects (id, organization_id, name) values (${projectId}, ${organizationId}, 'Smoke Project')`;
    await database.client`
      insert into project_memberships (organization_id, project_id, user_id)
      values (${organizationId}, ${projectId}, ${userId})
    `;

    app = createApp({
      config: parseEnv({ DATABASE_URL: databaseUrl, JWT_SECRET: "a".repeat(32), NODE_ENV: "test" }),
      credentials: new DrizzleUserCredentialStore(database.db),
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

  it("logs in, tracks a session, and exports it in a report", async () => {
    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    const { accessToken, user } = await login.json();
    expect(user.id).toBe(userId);
    const authorized = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

    const projects = await app.request("/projects", { headers: authorized });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toMatchObject({ projects: [{ id: projectId, isArchived: false }] });

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
    expect(text).toContain("Smoke Project");
    expect(text).toContain("Smoke work");
  }, 60_000);
});
