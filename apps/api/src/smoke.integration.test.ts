import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations, type DatabaseConnection } from "@clock-in/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import {
  DrizzleAccountStore,
  DrizzleAgentSessionRepository,
  DrizzleProjectRepository,
  DrizzleReportRepository,
  DrizzleSessionRepository,
} from "./drizzle-repositories.js";
import { parseEnv } from "./env.js";
import { createTestAuth } from "./test-tokens.js";

// An empty TEST_DATABASE_URL in a .env means "not configured", not "connect to ''".
const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
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
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
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

    // Ranged stats bind the date bounds through raw sql`` interpolation; this
    // is the only coverage that runs that serialization against a real server.
    const today = new Date().toISOString().slice(0, 10);
    const stats = await app.request(`/me/stats?from=${today}&to=${today}`, { headers: authorized });
    expect(stats.status).toBe(200);
    const statsBody = await stats.json();
    expect(statsBody.totalDurationSeconds).toBe(stopped.durationSeconds);
    expect(statsBody.apps).toEqual([]);
  }, 60_000);

  it("keeps another account's data out of this account's projects and reports", async () => {
    const other = await createTestAuth(config, new Date());
    const otherApp = createApp({
      config,
      keys: other.keys,
      accounts: new DrizzleAccountStore(database.db),
      projectRepository: new DrizzleProjectRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
    });
    const headers = {
      authorization: await other.bearer(randomUUID(), { email: "other@clock-in.test", name: "Other User" }),
    };

    const projects = await otherApp.request("/projects", { headers });
    expect((await projects.json()).projects.map((project: { name: string }) => project.name)).toEqual(["General"]);

    const report = await otherApp.request("/reports", { headers });
    expect((await report.json()).rows).toEqual([]);
  }, 60_000);

  it("joins a teammate through the invite code and ranks them on one leaderboard", async () => {
    const organizationResponse = await app.request("/organization", { headers: authorized });
    expect(organizationResponse.status).toBe(200);
    const { organization } = await organizationResponse.json();
    expect(organization.inviteCode).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);

    const teammate = await createTestAuth(config, new Date());
    const teammateId = randomUUID();
    const teammateApp = createApp({
      config,
      keys: teammate.keys,
      accounts: new DrizzleAccountStore(database.db),
      projectRepository: new DrizzleProjectRepository(database.db),
      sessionRepository: new DrizzleSessionRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
    });
    const teammateAuth = {
      authorization: await teammate.bearer(teammateId, { email: "teammate@clock-in.test", name: "Teammate" }),
      "content-type": "application/json",
    };

    // Typed the way a person would: lower case, no dash.
    const joined = await teammateApp.request("/accounts", {
      method: "POST",
      headers: teammateAuth,
      body: JSON.stringify({ inviteCode: organization.inviteCode.replace("-", "").toLowerCase() }),
    });
    expect(joined.status).toBe(200);
    const joinedUser = (await joined.json()).user;
    expect(joinedUser.organizationId).toBe(organization.id);

    // Joining grants access to the organization's existing projects.
    const teammateProjects = await teammateApp.request("/projects", { headers: teammateAuth });
    const sharedProject = (await teammateProjects.json()).projects[0];
    expect(sharedProject.name).toBe("General");

    const teammateStart = new Date(Date.now() - 1_800_000).toISOString();
    const started = await teammateApp.request("/sessions", {
      method: "POST",
      headers: teammateAuth,
      body: JSON.stringify({ clientId: randomUUID(), projectId: sharedProject.id, description: "Teammate work", startedAt: teammateStart }),
    });
    expect(started.status).toBe(200);
    await teammateApp.request(`/sessions/${(await started.json()).session.id}/stop`, {
      method: "POST",
      headers: teammateAuth,
      body: JSON.stringify({ stoppedAt: new Date().toISOString(), idleSeconds: 0 }),
    });

    const leaderboard = await app.request("/reports/leaderboard", { headers: authorized });
    expect(leaderboard.status).toBe(200);
    const board = await leaderboard.json();

    expect(board.entries).toHaveLength(2);
    // The teammate recorded ~30 minutes against the first account's ~50 seconds,
    // so ranking follows recorded time rather than the order accounts were created.
    expect(board.entries[0]).toMatchObject({ rank: 1, user: { name: "Teammate" } });
    expect(board.entries[1]).toMatchObject({ rank: 2, user: { name: "Smoke User" } });
    expect(board.entries[0].durationSeconds).toBeGreaterThan(board.entries[1].durationSeconds);
    expect(board.entries[0].sessionCount).toBe(1);
    expect(board.totalDurationSeconds).toBe(
      board.entries[0].durationSeconds + board.entries[1].durationSeconds,
    );

    // Both members see the same board, because they are in the same organization.
    const teammateBoard = await teammateApp.request("/reports/leaderboard", { headers: teammateAuth });
    expect((await teammateBoard.json()).entries.map((row: { user: { name: string } }) => row.user.name))
      .toEqual(["Teammate", "Smoke User"]);
  }, 90_000);

  it("refuses an invite code that matches no organization", async () => {
    const stranger = await createTestAuth(config, new Date());
    const strangerApp = createApp({
      config,
      keys: stranger.keys,
      accounts: new DrizzleAccountStore(database.db),
    });

    const response = await strangerApp.request("/accounts", {
      method: "POST",
      headers: {
        authorization: await stranger.bearer(randomUUID(), { email: "stranger@clock-in.test", name: "Stranger" }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ inviteCode: "ACDEF-GHJKM" }),
    });

    expect(response.status).toBe(404);
  }, 60_000);

  it("moves a late signup into the workspace and cleans up the one it left", async () => {
    const { organization } = await (await app.request("/organization", { headers: authorized })).json();

    // Signs up with no code at all, landing in a personal workspace.
    const latecomer = await createTestAuth(config, new Date());
    const latecomerId = randomUUID();
    const latecomerApp = createApp({
      config,
      keys: latecomer.keys,
      accounts: new DrizzleAccountStore(database.db),
      projectRepository: new DrizzleProjectRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
    });
    const headers = {
      authorization: await latecomer.bearer(latecomerId, { email: "late@clock-in.test", name: "Late Comer" }),
      "content-type": "application/json",
    };

    const before = (await (await latecomerApp.request("/me", { headers })).json()).user;
    expect(before.organizationId).not.toBe(organization.id);
    const strandedOrganizationId = before.organizationId;

    const joined = await latecomerApp.request("/organization/join", {
      method: "POST",
      headers,
      body: JSON.stringify({ inviteCode: organization.inviteCode.replace("-", "").toLowerCase() }),
    });
    expect(joined.status).toBe(200);
    expect((await joined.json()).user.organizationId).toBe(organization.id);

    // The move carries project access with it.
    const projects = await latecomerApp.request("/projects", { headers });
    expect((await projects.json()).projects.map((project: { name: string }) => project.name)).toEqual(["General"]);

    // The abandoned personal workspace is gone rather than left behind.
    const abandoned = await database.client<{ total: number }[]>`
      select count(*)::int as total from organizations where id = ${strandedOrganizationId}
    `;
    expect(abandoned[0]?.total).toBe(0);

    // Joining again is a no-op rather than an error.
    const again = await latecomerApp.request("/organization/join", {
      method: "POST",
      headers,
      body: JSON.stringify({ inviteCode: organization.inviteCode }),
    });
    expect(again.status).toBe(200);
  }, 90_000);

  it("refuses to move an account that already recorded time", async () => {
    const { organization } = await (await app.request("/organization", { headers: authorized })).json();

    const tracked = await createTestAuth(config, new Date());
    const trackedApp = createApp({
      config,
      keys: tracked.keys,
      accounts: new DrizzleAccountStore(database.db),
      projectRepository: new DrizzleProjectRepository(database.db),
      sessionRepository: new DrizzleSessionRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
    });
    const headers = {
      authorization: await tracked.bearer(randomUUID(), { email: "tracked@clock-in.test", name: "Tracked User" }),
      "content-type": "application/json",
    };

    const own = (await (await trackedApp.request("/projects", { headers })).json()).projects[0];
    const started = await trackedApp.request("/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ clientId: randomUUID(), projectId: own.id, startedAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    await trackedApp.request(`/sessions/${(await started.json()).session.id}/stop`, {
      method: "POST",
      headers,
      body: JSON.stringify({ stoppedAt: new Date().toISOString(), idleSeconds: 0 }),
    });

    const refused = await trackedApp.request("/organization/join", {
      method: "POST",
      headers,
      body: JSON.stringify({ inviteCode: organization.inviteCode }),
    });

    expect(refused.status).toBe(409);
    // The refusal must leave the account exactly where it was.
    expect((await (await trackedApp.request("/me", { headers })).json()).user.organizationId).not.toBe(organization.id);
  }, 90_000);
});
