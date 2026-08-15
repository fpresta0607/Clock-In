import { randomUUID } from "node:crypto";

import {
  createDatabase,
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
  DrizzleAgentRepository,
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

let config = parseEnv({
  DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
  NODE_ENV: "test",
});

integration(integrationDescription, () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const authUserId = randomUUID();
  let app: ReturnType<typeof createApp>;
  let authorized: Record<string, string>;
  let auth: Awaited<ReturnType<typeof createTestAuth>>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "api_smoke");
    database = disposable.database;
    config = parseEnv({
      DATABASE_URL: disposable.databaseUrl,
      AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
      NODE_ENV: "test",
    });
    await runMigrations(database);

    auth = await createTestAuth(config, new Date());
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
      agentRepository: new DrizzleAgentRepository(database.db),
      agentSessionRepository: new DrizzleAgentSessionRepository(database.db),
      pathMappingRepository: new DrizzlePathMappingRepository(database.db),
      activitySegmentRepository: new DrizzleActivitySegmentRepository(database.db),
    });
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
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
      body: JSON.stringify({ clientId: randomUUID(), projectId, deviceId: randomUUID(), description: "Smoke work", startedAt }),
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

  it("records the creator's admin claim when provisioning a workspace", async () => {
    const creatorId = randomUUID();
    const headers = {
      authorization: await auth.bearer(creatorId, { email: "claim-creator@clock-in.test", name: "Claim Creator" }),
      "content-type": "application/json",
    };
    const me = await app.request("/me", { headers });
    expect(me.status).toBe(200);
    const { user } = await me.json();

    const creatorClaims = await database.client`
      select user_id, kind from organization_admin_claims where organization_id = ${user.organizationId}
    `;
    expect(creatorClaims).toEqual([{ user_id: creatorId, kind: "creator" }]);
    const creatorClaim = await app.request("/organization/claim-admin", { method: "POST", headers });
    expect(creatorClaim.status).toBe(409);
  }, 60_000);

  // The desktop's real recording path: the monitor observes work, spools it,
  // and the uploader replays the spool as these two batch posts. This is the
  // wire flow that goes stale first when the schema and the app drift apart.
  it("records an observed session with its segments and reports it in stats", async () => {
    const observerId = randomUUID();
    const observer = {
      authorization: await auth.bearer(observerId, {
        email: "observer@clock-in.test",
        name: "Observer User",
      }),
      "content-type": "application/json",
    };
    await app.request("/me", { headers: observer });
    const projects = (await (await app.request("/projects", { headers: observer })).json()).projects;
    const projectId = projects[0].id;

    const deviceId = randomUUID();
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const stoppedAt = new Date(Date.now() - 30_000).toISOString();

    // Exactly what the desktop uploader puts on the wire, in its order:
    // segments first, then the finished session.
    const segments = await app.request("/activity/segments", {
      method: "POST",
      headers: observer,
      body: JSON.stringify({
        segments: [{
          clientId: randomUUID(),
          deviceId,
          kind: "active",
          processName: "code.exe",
          startedAt,
          endedAt: stoppedAt,
        }],
      }),
    });
    expect(segments.status).toBe(200);
    expect((await segments.json()).rejected).toEqual([]);

    const sessionClientId = randomUUID();
    const observedBatch = {
      sessions: [{
        clientId: sessionClientId,
        projectId,
        attribution: "default",
        startedAt,
        stoppedAt,
        idleSeconds: 0,
      }],
    };
    const observed = await app.request("/sessions/observed", {
      method: "POST",
      headers: observer,
      body: JSON.stringify(observedBatch),
    });
    expect(observed.status).toBe(200);
    expect((await observed.json()).rejected).toEqual([]);

    // The spool replays identical payloads after a failed ack; the replay
    // must land as the same session, not a duplicate.
    const replay = await app.request("/sessions/observed", {
      method: "POST",
      headers: observer,
      body: JSON.stringify(observedBatch),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).rejected).toEqual([]);

    const today = new Date().toISOString().slice(0, 10);
    const stats = await app.request(`/me/stats?from=${today}&to=${today}`, { headers: observer });
    if (stats.status !== 200) console.log("stats body:", await stats.clone().text());
    expect(stats.status).toBe(200);
    const statsBody = await stats.json();
    expect(statsBody.totalDurationSeconds).toBe(90);
    expect(statsBody.apps).toEqual([{ processName: "code.exe", durationSeconds: 90 }]);
  }, 60_000);

  // The whole roster hangs off this one endpoint, and it is the first thing a
  // schema the migration chain cannot rebuild takes down: the ingest reads
  // project_path_mappings with an explicit column list taken from schema.ts,
  // so a column that lives in schema.ts but in no migration turns every agent
  // event into a 500. This database was built by replaying the chain.
  it("resolves a shift against a database the migration chain built, and mints its roster identity", async () => {
    const agentUserId = randomUUID();
    const agentHeaders = {
      authorization: await auth.bearer(agentUserId, { email: "roster@clock-in.test", name: "Roster User" }),
      "content-type": "application/json",
    };
    await app.request("/me", { headers: agentHeaders });
    const projects = (await (await app.request("/projects", { headers: agentHeaders })).json()).projects;
    const projectId = projects[0].id;

    const mapping = await app.request("/path-mappings", {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({ pathPrefix: "C:/dev/roster", projectId }),
    });
    expect(mapping.status).toBe(200);
    expect(await mapping.json()).toMatchObject({ kind: "path_prefix" });

    const externalSessionId = randomUUID();
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const events = await app.request("/agent-sessions", {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({
        events: [
          { source: "claude_code", externalSessionId, event: "started", occurredAt: startedAt, cwd: "C:/dev/roster/app" },
          { source: "claude_code", externalSessionId, event: "ended", occurredAt: new Date().toISOString(), cwd: "C:/dev/roster/app" },
        ],
      }),
    });

    expect(events.status).toBe(200);
    const results = (await events.json()).results;
    expect(results.every((row: { accepted: boolean }) => row.accepted)).toBe(true);

    // The shift resolved to the mapped project and minted the identity that
    // the roster, the paystub and the pay run all read.
    const roster = await app.request("/agents", { headers: agentHeaders });
    expect(roster.status).toBe(200);
    expect((await roster.json()).agents).toEqual([expect.objectContaining({
      source: "claude_code",
      status: "anonymous",
      project: { id: projectId, name: projects[0].name },
    })]);
  }, 60_000);

  it("bootstraps a legacy workspace with one first-admin claim and keeps a member's new project private", async () => {
    const organizationId = randomUUID();
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    const otherOrganizationId = randomUUID();
    const otherUserId = randomUUID();
    await database.client`
      insert into organizations (id, name, invite_code)
      values
        (${organizationId}, 'Legacy workspace', ${randomUUID().replaceAll("-", "")}),
        (${otherOrganizationId}, 'Other workspace', ${randomUUID().replaceAll("-", "")})
    `;
    await database.client`
      insert into users (id, organization_id, email, name)
      values
        (${firstUserId}, ${organizationId}, 'legacy-first@clock-in.test', 'Legacy First'),
        (${secondUserId}, ${organizationId}, 'legacy-second@clock-in.test', 'Legacy Second'),
        (${otherUserId}, ${otherOrganizationId}, 'other@clock-in.test', 'Other User')
    `;
    const firstAuth = await createTestAuth(config, new Date());
    const secondAuth = await createTestAuth(config, new Date());
    const legacyAccounts = new DrizzleAccountStore(database.db);
    const legacyApp = createApp({
      config,
      keys: firstAuth.keys,
      accounts: legacyAccounts,
      projectRepository: new DrizzleProjectRepository(database.db),
      sessionRepository: new DrizzleSessionRepository(database.db),
    });
    const firstHeaders = {
      authorization: await firstAuth.bearer(firstUserId, { email: "legacy-first@clock-in.test", name: "Legacy First" }),
      "content-type": "application/json",
    };
    const secondApp = createApp({
      config,
      keys: secondAuth.keys,
      accounts: legacyAccounts,
      projectRepository: new DrizzleProjectRepository(database.db),
      sessionRepository: new DrizzleSessionRepository(database.db),
    });
    const secondHeaders = {
      authorization: await secondAuth.bearer(secondUserId, { email: "legacy-second@clock-in.test", name: "Legacy Second" }),
      "content-type": "application/json",
    };

    // The server no longer repairs legacy workspaces with a starter project:
    // both members see an empty list, and the desktop app is what creates a
    // default project at sign-in when the account has none.
    const firstList = await legacyApp.request("/projects", { headers: firstHeaders });
    expect(firstList.status).toBe(200);
    expect((await firstList.json()).projects).toEqual([]);
    const secondList = await secondApp.request("/projects", { headers: secondHeaders });
    expect((await secondList.json()).projects).toEqual([]);

    const legacyRoles = await database.client`
      select id, role from users where organization_id = ${organizationId} order by id
    `;
    expect(legacyRoles).toEqual([
      { id: firstUserId, role: "member" },
      { id: secondUserId, role: "member" },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    await expect(legacyAccounts.claimFirstAdmin({ organizationId, userId: otherUserId, role: "member" as const })).resolves.toEqual({ kind: "not_member" });

    if (disposable === undefined) throw new Error("The disposable smoke database is required for this test.");
    const firstClaimant = createDatabase(disposable.databaseUrl, { max: 1 });
    const secondClaimant = createDatabase(disposable.databaseUrl, { max: 1 });
    let firstClaimWon = false;
    try {
      const firstClaimApp = createApp({ config, keys: firstAuth.keys, accounts: new DrizzleAccountStore(firstClaimant.db) });
      const secondClaimApp = createApp({ config, keys: secondAuth.keys, accounts: new DrizzleAccountStore(secondClaimant.db) });
      const [firstClaim, secondClaim] = await Promise.all([
        firstClaimApp.request("/organization/claim-admin", { method: "POST", headers: firstHeaders }),
        secondClaimApp.request("/organization/claim-admin", { method: "POST", headers: secondHeaders }),
      ]);
      expect([firstClaim.status, secondClaim.status].sort()).toEqual([200, 409]);
      firstClaimWon = firstClaim.status === 200;
      const winningClaim = firstClaim.status === 200 ? firstClaim : secondClaim;
      const winningUser = (await winningClaim.json()).user.id;
      const claims = await database.client`
        select user_id, kind from organization_admin_claims where organization_id = ${organizationId}
      `;
      expect(claims).toEqual([{ user_id: winningUser, kind: "legacy_first_admin" }]);
    } finally {
      await Promise.all([
        firstClaimant.client.end({ timeout: 5 }),
        secondClaimant.client.end({ timeout: 5 }),
      ]);
    }

    // Either concurrent active member may win the tenant-scoped first-admin
    // claim. The winner is promoted to administrator; the losing member's
    // later claim still refuses, because the organization's claim is spent.
    const administratorApp = firstClaimWon ? legacyApp : secondApp;
    const administratorHeaders = firstClaimWon ? firstHeaders : secondHeaders;
    const memberApp = firstClaimWon ? secondApp : legacyApp;
    const memberHeaders = firstClaimWon ? secondHeaders : firstHeaders;
    const administratorId = firstClaimWon ? firstUserId : secondUserId;

    const promoted = await database.client`
      select organization_id, role from users where id = ${administratorId}
    `;
    expect(promoted).toEqual([{ organization_id: organizationId, role: "admin" }]);
    const reclaim = await memberApp.request("/organization/claim-admin", { method: "POST", headers: memberHeaders });
    expect(reclaim.status).toBe(409);

    // A project one member creates stays invisible to the other member.
    const privateCreate = await administratorApp.request("/projects", {
      method: "POST",
      headers: administratorHeaders,
      body: JSON.stringify({ name: "Restricted work" }),
    });
    expect(privateCreate.status).toBe(201);
    const privateProject = await privateCreate.json();
    const memberProjects = await memberApp.request("/projects", { headers: memberHeaders });
    expect((await memberProjects.json()).projects.map((project: { id: string }) => project.id)).not.toContain(privateProject.id);
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
      agentRepository: new DrizzleAgentRepository(database.db),
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
      agentRepository: new DrizzleAgentRepository(database.db),
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
      body: JSON.stringify({ clientId: randomUUID(), projectId: sharedProject.id, deviceId: randomUUID(), description: "Teammate work", startedAt: teammateStart }),
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
      agentRepository: new DrizzleAgentRepository(database.db),
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

    // Role never travels: the latecomer was the admin of their own solo
    // workspace, and must arrive in the joined one as a plain member -
    // otherwise any invite code hands out admin.
    const movedRole = await database.client<{ role: string }[]>`
      select role from users where id = ${latecomerId}
    `;
    expect(movedRole[0]?.role).toBe("member");

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

  it("keeps a creator administrator in place while another member remains", async () => {
    const { organization: target } = await (await app.request("/organization", { headers: authorized })).json();
    const creatorAuth = await createTestAuth(config, new Date());
    const creatorId = randomUUID();
    const creatorApp = createApp({
      config,
      keys: creatorAuth.keys,
      accounts: new DrizzleAccountStore(database.db),
    });
    const creatorHeaders = {
      authorization: await creatorAuth.bearer(creatorId, { email: "creator-continuity@clock-in.test", name: "Creator Continuity" }),
      "content-type": "application/json",
    };
    const creator = (await (await creatorApp.request("/me", { headers: creatorHeaders })).json()).user;
    const memberId = randomUUID();
    await database.client`
      insert into users (id, organization_id, email, name)
      values (${memberId}, ${creator.organizationId}, 'creator-continuity-member@clock-in.test', 'Creator Continuity Member')
    `;

    const blocked = await creatorApp.request("/organization/join", {
      method: "POST",
      headers: creatorHeaders,
      body: JSON.stringify({ inviteCode: target.inviteCode }),
    });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toEqual({
      error: {
        code: "conflict",
        message: "The final administrator cannot leave a workspace while it still has members.",
      },
    });

    const members = await database.client`
      select id, organization_id, role from users
      where organization_id = ${creator.organizationId}
      order by id
    `;
    expect(members).toEqual([
      { id: creatorId, organization_id: creator.organizationId, role: "admin" },
      { id: memberId, organization_id: creator.organizationId, role: "member" },
    ].sort((left, right) => left.id.localeCompare(right.id)));

    const memberAuth = await createTestAuth(config, new Date());
    const memberApp = createApp({
      config,
      keys: memberAuth.keys,
      accounts: new DrizzleAccountStore(database.db),
    });
    const claim = await memberApp.request("/organization/claim-admin", {
      method: "POST",
      headers: {
        authorization: await memberAuth.bearer(memberId, { email: "creator-continuity-member@clock-in.test", name: "Creator Continuity Member" }),
        "content-type": "application/json",
      },
    });
    expect(claim.status).toBe(409);
  }, 60_000);

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
      agentRepository: new DrizzleAgentRepository(database.db),
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
      body: JSON.stringify({ clientId: randomUUID(), projectId: own.id, deviceId: randomUUID(), startedAt: new Date(Date.now() - 60_000).toISOString() }),
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



  // Since f2cb540 a completed session is never clipped: it counts whole in the
  // range containing its start instant. Activity-segment app totals still clip
  // to the requested bounds in SQL. Both are locked here at the DST-shifted
  // local day the dashboard actually sends (2026-03-08 in America/Chicago is a
  // 23-hour day, 06:00Z to 05:00Z the next day), because those instant bounds
  // bind through raw sql`` interpolation only against a real server.
  it("buckets sessions by start instant at a local DST boundary while app totals clip in SQL", async () => {
    const me = await app.request("/me", { headers: authorized });
    expect(me.status).toBe(200);
    const { user } = await me.json();

    const created = await app.request("/projects", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ name: "DST Boundary Project" }),
    });
    expect(created.status).toBe(201);
    const projectId = (await created.json()).id;

    // Straddles the boundary: started on local March 7, stopped on local March 8.
    const startedAt = new Date("2026-03-08T05:30:00.000Z");
    const stoppedAt = new Date("2026-03-08T06:30:00.000Z");
    await database.client`
      insert into time_sessions (
        id, organization_id, user_id, project_id, client_id, status,
        started_at, stopped_at, idle_seconds, duration_seconds
      ) values (
        ${randomUUID()}, ${user.organizationId}, ${user.id}, ${projectId}, ${randomUUID()}, 'stopped',
        ${startedAt.toISOString()}, ${stoppedAt.toISOString()}, 0, 3600
      )
    `;
    await database.client`
      insert into activity_segments (
        organization_id, user_id, client_id, device_id, kind, process_name,
        started_at, ended_at, received_at
      ) values (
        ${user.organizationId}, ${user.id}, ${randomUUID()}, ${randomUUID()}, 'active', 'clock-in.exe',
        ${startedAt.toISOString()}, ${stoppedAt.toISOString()}, ${new Date("2026-03-08T06:31:00.000Z").toISOString()}
      )
    `;

    const priorDay = "fromAt=2026-03-07T06%3A00%3A00.000Z&toExclusiveAt=2026-03-08T06%3A00%3A00.000Z";
    const dstDay = "fromAt=2026-03-08T06%3A00%3A00.000Z&toExclusiveAt=2026-03-09T05%3A00%3A00.000Z";

    // The day the session started owns all 3600 seconds of it; the activity
    // segment contributes only its half hour inside each day's bounds.
    const priorStats = await app.request(`/me/stats?${priorDay}`, { headers: authorized });
    expect(priorStats.status).toBe(200);
    const priorStatsBody = await priorStats.json();
    expect(priorStatsBody.totalDurationSeconds).toBe(3_600);
    expect(priorStatsBody.projects).toEqual([{
      project: { id: projectId, name: "DST Boundary Project" },
      durationSeconds: 3_600,
      attributedSeconds: 3_600,
      unattributedSeconds: 0,
      sessionCount: 1,
    }]);
    expect(priorStatsBody.apps).toEqual([{ processName: "clock-in.exe", durationSeconds: 1_800 }]);

    const dstStats = await app.request(`/me/stats?${dstDay}`, { headers: authorized });
    expect(dstStats.status).toBe(200);
    const dstStatsBody = await dstStats.json();
    expect(dstStatsBody.totalDurationSeconds).toBe(0);
    expect(dstStatsBody.projects).toEqual([]);
    expect(dstStatsBody.apps).toEqual([{ processName: "clock-in.exe", durationSeconds: 1_800 }]);

    const priorReports = await app.request(`/reports?${priorDay}`, { headers: authorized });
    expect(priorReports.status).toBe(200);
    const priorReportBody = await priorReports.json();
    expect(priorReportBody.totalDurationSeconds).toBe(3_600);
    expect(priorReportBody.rows).toContainEqual(expect.objectContaining({
      project: { id: projectId, name: "DST Boundary Project" },
      durationSeconds: 3_600,
      attributedSeconds: 3_600,
    }));

    const dstReports = await app.request(`/reports?${dstDay}`, { headers: authorized });
    expect(dstReports.status).toBe(200);
    const dstReportBody = await dstReports.json();
    expect(dstReportBody.totalDurationSeconds).toBe(0);
    expect(dstReportBody.rows).toEqual([]);

    const priorBoard = await app.request(`/reports/leaderboard?${priorDay}`, { headers: authorized });
    expect(priorBoard.status).toBe(200);
    const priorBoardBody = await priorBoard.json();
    expect(priorBoardBody.totalDurationSeconds).toBe(3_600);
    // The board lists every workspace member zeros included, and an earlier
    // test joined a teammate into this workspace, so assert this member's row
    // rather than the whole list.
    expect(priorBoardBody.entries).toContainEqual(expect.objectContaining({
      user: { id: user.id, name: user.name },
      durationSeconds: 3_600,
      attributedSeconds: 3_600,
      sessionCount: 1,
    }));

    const dstBoard = await app.request(`/reports/leaderboard?${dstDay}`, { headers: authorized });
    expect(dstBoard.status).toBe(200);
    const dstBoardBody = await dstBoard.json();
    expect(dstBoardBody.totalDurationSeconds).toBe(0);
    expect(dstBoardBody.entries.every((entry: { durationSeconds: number }) => entry.durationSeconds === 0)).toBe(true);
  }, 60_000);

  // Since f2cb540, idle is subtracted when a session is recorded, not
  // reconciled against device evidence at read time: a legacy row reports
  // whole in the range containing its start, and overlapping idle segments
  // from an unrelated device never change its totals.
  it("reports a legacy idle session whole in its start range, untouched by overlapping idle evidence", async () => {
    const me = await app.request("/me", { headers: authorized });
    expect(me.status).toBe(200);
    const { user } = await me.json();

    const created = await app.request("/projects", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ name: "Legacy Idle Range Project" }),
    });
    expect(created.status).toBe(201);
    const projectId = (await created.json()).id;
    const sessionId = randomUUID();
    const deviceId = randomUUID();
    const startedAt = new Date("2026-08-02T10:00:00.000Z");
    const stoppedAt = new Date("2026-08-02T12:00:00.000Z");

    await database.client`
      insert into time_sessions (
        id, organization_id, user_id, project_id, client_id, status,
        started_at, stopped_at, idle_seconds, duration_seconds
      ) values (
        ${sessionId}, ${user.organizationId}, ${user.id}, ${projectId}, ${randomUUID()}, 'stopped',
        ${startedAt.toISOString()}, ${stoppedAt.toISOString()}, 3600, 3600
      )
    `;
    const activity = await app.request("/activity/segments", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        segments: [{
          clientId: randomUUID(),
          deviceId,
          kind: "idle",
          startedAt: startedAt.toISOString(),
          endedAt: new Date("2026-08-02T11:00:00.000Z").toISOString(),
        }],
      }),
    });
    expect(activity.status).toBe(200);
    expect((await activity.json()).rejected).toEqual([]);

    // Legacy manual rows never carried a device, and still do not.
    const stored = await database.client`
      select device_id from time_sessions where id = ${sessionId}
    `;
    expect(stored).toEqual([{ device_id: null }]);

    const startRange = await app.request(
      `/reports?projectId=${projectId}&fromAt=2026-08-02T10%3A00%3A00.000Z&toExclusiveAt=2026-08-02T11%3A00%3A00.000Z&page=1&pageSize=50`,
      { headers: authorized },
    );
    expect(startRange.status).toBe(200);
    const startRangeBody = await startRange.json();
    expect(startRangeBody.totalDurationSeconds).toBe(3_600);
    expect(startRangeBody.rows).toEqual([expect.objectContaining({
      id: sessionId,
      idleSeconds: 3_600,
      durationSeconds: 3_600,
      attribution: "manual",
    })]);

    // The range covering the rest of the session reports nothing, because
    // completed sessions are never split across ranges.
    const laterRange = await app.request(
      `/reports?projectId=${projectId}&fromAt=2026-08-02T11%3A00%3A00.000Z&toExclusiveAt=2026-08-02T12%3A00%3A00.000Z&page=1&pageSize=50`,
      { headers: authorized },
    );
    expect(laterRange.status).toBe(200);
    const laterRangeBody = await laterRange.json();
    expect(laterRangeBody.totalDurationSeconds).toBe(0);
    expect(laterRangeBody.rows).toEqual([]);
  }, 60_000);

  // The manual timer is retired, but README still promises an older installed
  // build can finish and upload the work it started. Lock that the deprecated
  // start/stop path records idle-subtracted totals and buckets by start.
  it("still records a deprecated manual session and reports it whole in its start range", async () => {
    const created = await app.request("/projects", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ name: "Deprecated Timer Project" }),
    });
    expect(created.status).toBe(201);
    const projectId = (await created.json()).id;
    const startedAt = new Date(Date.now() - 120_000);
    const stoppedAt = new Date(Date.now() - 60_000);
    const deviceId = randomUUID();

    const started = await app.request("/sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        clientId: randomUUID(),
        projectId,
        deviceId,
        startedAt: startedAt.toISOString(),
      }),
    });
    expect(started.status).toBe(200);
    const sessionId = (await started.json()).session.id;

    const stopped = await app.request(`/sessions/${sessionId}/stop`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ stoppedAt: stoppedAt.toISOString(), idleSeconds: 30 }),
    });
    expect(stopped.status).toBe(200);
    expect((await stopped.json()).session).toMatchObject({
      status: "stopped",
      idleSeconds: 30,
      durationSeconds: 30,
      attribution: "manual",
    });

    const startRange = await app.request(
      `/reports?projectId=${projectId}&fromAt=${encodeURIComponent(startedAt.toISOString())}&toExclusiveAt=${encodeURIComponent(new Date(startedAt.getTime() + 30_000).toISOString())}&page=1&pageSize=50`,
      { headers: authorized },
    );
    expect(startRange.status).toBe(200);
    const startRangeBody = await startRange.json();
    expect(startRangeBody.totalDurationSeconds).toBe(30);
    expect(startRangeBody.rows).toEqual([expect.objectContaining({
      id: sessionId,
      idleSeconds: 30,
      durationSeconds: 30,
      attribution: "manual",
    })]);

    const afterRange = await app.request(
      `/reports?projectId=${projectId}&fromAt=${encodeURIComponent(stoppedAt.toISOString())}&toExclusiveAt=${encodeURIComponent(new Date(stoppedAt.getTime() + 60_000).toISOString())}&page=1&pageSize=50`,
      { headers: authorized },
    );
    expect(afterRange.status).toBe(200);
    const afterRangeBody = await afterRange.json();
    expect(afterRangeBody.totalDurationSeconds).toBe(0);
    expect(afterRangeBody.rows).toEqual([]);
  }, 60_000);
});
