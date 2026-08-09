import { randomUUID } from "node:crypto";

import { createDatabase, runMigrations, type DatabaseConnection } from "@clock-in/database";
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
  const database = databaseUrl ? createDatabase(databaseUrl, { max: 1 }) : (undefined as unknown as DatabaseConnection);
  const authUserId = randomUUID();
  let app: ReturnType<typeof createApp>;
  let authorized: Record<string, string>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    // Migrations hard-reference the public schema (phase-2 enum types and
    // foreign keys), so the disposable boundary is the database itself, not
    // a schema. Refuse anything that is not obviously a scratch database.
    const dbName = new URL(databaseUrl).pathname.replace("/", "");
    if (!dbName.startsWith("clock_in_")) {
      throw new Error(
        `TEST_DATABASE_URL must point at a disposable database whose name starts with "clock_in_", got "${dbName}".`,
      );
    }
    await runMigrations(database);

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
      pathMappingRepository: new DrizzlePathMappingRepository(database.db),
      activitySegmentRepository: new DrizzleActivitySegmentRepository(database.db),
    });
  }, 60_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    try {
      // Reset the scratch database so reruns start empty.
      await database.client.unsafe(`drop schema public cascade`);
      await database.client.unsafe(`create schema public`);
      await database.client.unsafe(`drop schema if exists drizzle cascade`);
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

    const created = await app.request("/projects", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ name: "Smoke Side Project" }),
    });
    expect(created.status).toBe(201);
    const createdProject = await created.json();
    expect(createdProject).toMatchObject({ name: "Smoke Side Project", isArchived: false });
    const relisted = (await (await app.request("/projects", { headers: authorized })).json()).projects;
    expect(relisted.map((project: { name: string }) => project.name)).toEqual(["General", "Smoke Side Project"]);

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
      sessionRepository: new DrizzleSessionRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
      pathMappingRepository: new DrizzlePathMappingRepository(database.db),
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
      pathMappingRepository: new DrizzlePathMappingRepository(database.db),
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
      sessionRepository: new DrizzleSessionRepository(database.db),
      reportRepository: new DrizzleReportRepository(database.db),
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
      pathMappingRepository: new DrizzlePathMappingRepository(database.db),
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

    // The move carries project access with it (the side project from the first test included).
    const projects = await latecomerApp.request("/projects", { headers });
    expect((await projects.json()).projects.map((project: { name: string }) => project.name)).toEqual(["General", "Smoke Side Project"]);

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
      pathMappingRepository: new DrizzlePathMappingRepository(database.db),
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

  it("attributes a browser span through its url rule, links the running timer, and feeds sites without corroborating", async () => {
    // A fixed ten-minute window ending now keeps every overlap below exact.
    const t0 = Date.now() - 600_000;
    const at = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

    const created = await app.request("/projects", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ name: "Smoke Browser Project" }),
    });
    expect(created.status).toBe(201);
    const projectId = (await created.json()).id;

    const rule = await app.request("/path-mappings", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ kind: "url_rule", pathPrefix: "github.com/acme/*", projectId }),
    });
    expect(rule.status).toBe(200);
    const ruleId = (await rule.json()).id;

    const started = await app.request("/sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ clientId: randomUUID(), projectId, description: "Browser-backed work", startedAt: at(0) }),
    });
    expect(started.status).toBe(200);
    const timerId = (await started.json()).session.id;

    // The span opens one minute into the timer and closes at minute four.
    const spanStart = await app.request("/agent-sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        events: [{ source: "browser", externalSessionId: "smoke-span-1", event: "started", occurredAt: at(60_000), ruleId }],
      }),
    });
    expect(spanStart.status).toBe(200);
    expect((await spanStart.json()).results).toEqual([{ externalSessionId: "smoke-span-1", accepted: true }]);

    // Attribution is server-side: the stored row names the rule's project,
    // links the running timer, and carries no cwd.
    const rows = await database.client<{
      project_id: string | null;
      linked_session_id: string | null;
      cwd: string | null;
      rule_id: string | null;
      status: string;
    }[]>`select project_id::text, linked_session_id::text, cwd, rule_id::text, status from agent_sessions where source = 'browser'`;
    expect(rows).toEqual([{
      project_id: projectId,
      linked_session_id: timerId,
      cwd: null,
      rule_id: ruleId,
      status: "running",
    }]);

    const spanEnd = await app.request("/agent-sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        events: [{ source: "browser", externalSessionId: "smoke-span-1", event: "ended", occurredAt: at(240_000), ruleId }],
      }),
    });
    expect(spanEnd.status).toBe(200);

    // Two devices were active over the same five-minute wall-clock window.
    // Their overlap must be unioned before clipping the browser span.
    const activity = await app.request("/activity/segments", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        segments: [
          {
            clientId: randomUUID(),
            deviceId: randomUUID(),
            kind: "active",
            processName: "chrome.exe",
            startedAt: at(0),
            endedAt: at(210_000),
          },
          {
            clientId: randomUUID(),
            deviceId: randomUUID(),
            kind: "active",
            processName: "chrome.exe",
            startedAt: at(120_000),
            endedAt: at(300_000),
          },
        ],
      }),
    });
    expect(activity.status).toBe(200);

    const stop = await app.request(`/sessions/${timerId}/stop`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ stoppedAt: at(600_000), idleSeconds: 0 }),
    });
    expect(stop.status).toBe(200);

    const today = new Date().toISOString().slice(0, 10);
    const stats = await app.request(`/me/stats?from=${today}&to=${today}`, { headers: authorized });
    expect(stats.status).toBe(200);
    const body = await stats.json();

    // The span counts under its rule, clipped to the active segment: minutes 1-4.
    expect(body.sites).toEqual([
      { mapping: { id: ruleId, pattern: "github.com/acme/*", projectId }, durationSeconds: 180 },
    ]);

    // Corroboration is the active-segment overlap only; the linked browser span adds nothing.
    const project = body.projects.find((entry: { project: { id: string } }) => entry.project.id === projectId);
    expect(project).toMatchObject({ durationSeconds: 600, corroboratedSeconds: 300, sessionCount: 1 });

    // A span can cross a requested range while its only active overlap lies
    // before that range. The SQL repository must omit the resulting zero row.
    const zeroDay = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const zeroBoundary = Date.parse(`${zeroDay}T00:00:00.000Z`);
    const zeroAt = (offsetMs: number) => new Date(zeroBoundary + offsetMs).toISOString();
    const zeroRule = await app.request("/path-mappings", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ kind: "url_rule", pathPrefix: "example.com/*", projectId }),
    });
    const zeroRuleId = (await zeroRule.json()).id;
    const zeroSpan = await app.request("/agent-sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        events: [
          { source: "browser", externalSessionId: "smoke-span-zero", event: "started", occurredAt: zeroAt(-3_600_000), ruleId: zeroRuleId },
          { source: "browser", externalSessionId: "smoke-span-zero", event: "ended", occurredAt: zeroAt(3_600_000), ruleId: zeroRuleId },
        ],
      }),
    });
    expect(zeroSpan.status).toBe(200);
    const zeroActivity = await app.request("/activity/segments", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        segments: [{
          clientId: randomUUID(),
          deviceId: randomUUID(),
          kind: "active",
          processName: "chrome.exe",
          startedAt: zeroAt(-1_800_000),
          endedAt: zeroAt(-900_000),
        }],
      }),
    });
    expect(zeroActivity.status).toBe(200);
    const zeroStats = await app.request(`/me/stats?from=${zeroDay}&to=${zeroDay}`, { headers: authorized });
    expect(zeroStats.status).toBe(200);
    expect((await zeroStats.json()).sites).toEqual([]);
  }, 60_000);

  it("excludes a 500 ms browser intersection from SQL site totals", async () => {
    const start = new Date(Date.now() - 60_000);
    const end = new Date(start.getTime() + 500);
    const externalSessionId = randomUUID();
    const created = await app.request("/projects", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ name: "Subsecond Browser Project" }),
    });
    expect(created.status).toBe(201);
    const projectId = (await created.json()).id;

    const rule = await app.request("/path-mappings", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ kind: "url_rule", pathPrefix: "subsecond.example/*", projectId }),
    });
    expect(rule.status).toBe(200);
    const ruleId = (await rule.json()).id;

    const span = await app.request("/agent-sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        events: [
          { source: "browser", externalSessionId, event: "started", occurredAt: start.toISOString(), ruleId },
          { source: "browser", externalSessionId, event: "ended", occurredAt: end.toISOString(), ruleId },
        ],
      }),
    });
    expect(span.status).toBe(200);

    const activity = await app.request("/activity/segments", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        segments: [{
          clientId: randomUUID(),
          deviceId: randomUUID(),
          kind: "active",
          processName: "chrome.exe",
          startedAt: start.toISOString(),
          endedAt: end.toISOString(),
        }],
      }),
    });
    expect(activity.status).toBe(200);

    const day = start.toISOString().slice(0, 10);
    const stats = await app.request(`/me/stats?from=${day}&to=${day}`, { headers: authorized });
    expect(stats.status).toBe(200);
    expect((await stats.json()).sites).not.toContainEqual(expect.objectContaining({
      mapping: expect.objectContaining({ id: ruleId }),
    }));
  }, 60_000);
});
