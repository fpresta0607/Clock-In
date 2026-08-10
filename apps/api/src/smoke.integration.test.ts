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
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("provisions an account on first sign-in, tracks a session, and exports it in a report", async () => {
    const me = await app.request("/me", { headers: authorized });
    expect(me.status).toBe(200);
    const { user } = await me.json();
    expect(user).toMatchObject({ id: authUserId, email: "smoke@clock-in.test", name: "Smoke User" });
    expect(user.organizationId).toMatch(/^[0-9a-f-]{36}$/i);

    const creatorClaims = await database.client`
      select user_id, kind from organization_admin_claims where organization_id = ${user.organizationId}
    `;
    expect(creatorClaims).toEqual([{ user_id: authUserId, kind: "creator" }]);
    const creatorClaim = await app.request("/organization/claim-admin", { method: "POST", headers: authorized });
    expect(creatorClaim.status).toBe(409);

    // A second request must reuse the provisioned account rather than create another.
    const repeat = await app.request("/me", { headers: authorized });
    expect((await repeat.json()).user.organizationId).toBe(user.organizationId);

    const projects = await app.request("/projects", { headers: authorized });
    expect(projects.status).toBe(200);
    const listed = (await projects.json()).projects;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "General Work", isArchived: false, isDefault: true });
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
    expect(relisted.map((project: { name: string }) => project.name)).toEqual(["General Work", "Smoke Side Project"]);

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

  it("repairs a legacy workspace once, keeps selections private, and replaces its default safely", async () => {
    const organizationId = randomUUID();
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    const otherOrganizationId = randomUUID();
    const otherUserId = randomUUID();
    const otherInviteCode = "ACDEF-GHJKM";
    await database.client`
      insert into organizations (id, name, invite_code)
      values
        (${organizationId}, 'Legacy workspace', ${randomUUID().replaceAll("-", "")}),
        (${otherOrganizationId}, 'Other workspace', ${otherInviteCode})
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

    const firstResponses = await Promise.all([
      legacyApp.request("/projects", { headers: firstHeaders }),
      legacyApp.request("/projects", { headers: firstHeaders }),
    ]);
    const firstLists = await Promise.all(firstResponses.map((response) => response.json()));
    const defaultIds = firstLists.map((list) => list.selectedProjectId);
    expect(new Set(defaultIds).size).toBe(1);
    expect(firstLists.every((list) => list.projects.length === 1 && list.projects[0].name === "General Work" && list.projects[0].isDefault)).toBe(true);

    const defaultProjectId = defaultIds[0] as string;
    const defaultMemberships = await database.client`
      select user_id from project_memberships
      where organization_id = ${organizationId} and project_id = ${defaultProjectId}
    `;
    expect(defaultMemberships.map((membership) => membership.user_id).sort()).toEqual(
      [firstUserId, secondUserId].sort(),
    );
    const legacyRoles = await database.client`
      select id, role from users where organization_id = ${organizationId} order by id
    `;
    expect(legacyRoles).toEqual([
      { id: firstUserId, role: "member" },
      { id: secondUserId, role: "member" },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    await expect(legacyAccounts.claimFirstAdmin({ organizationId, userId: otherUserId })).resolves.toEqual({ kind: "not_member" });
    const secondList = await secondApp.request("/projects", { headers: secondHeaders });
    const secondProjectsBeforeReplacement = await secondList.json();
    expect(secondProjectsBeforeReplacement.selectedProjectId).toBe(defaultProjectId);

    const lockedRename = await legacyApp.request(`/projects/${defaultProjectId}`, {
      method: "PATCH",
      headers: firstHeaders,
      body: JSON.stringify({ name: "Shared Work" }),
    });
    expect(lockedRename.status).toBe(403);
    await expect(lockedRename.json()).resolves.toMatchObject({
      error: { code: "forbidden", message: expect.stringContaining("claim the first admin role") },
    });

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
    // claim. The winner can administer the default project immediately; the
    // losing member remains unable to do so.
    const administratorApp = firstClaimWon ? legacyApp : secondApp;
    const administratorHeaders = firstClaimWon ? firstHeaders : secondHeaders;
    const memberApp = firstClaimWon ? secondApp : legacyApp;
    const memberHeaders = firstClaimWon ? secondHeaders : firstHeaders;
    const administratorId = firstClaimWon ? firstUserId : secondUserId;

    const blockedMove = await administratorApp.request("/organization/join", {
      method: "POST",
      headers: administratorHeaders,
      body: JSON.stringify({ inviteCode: otherInviteCode }),
    });
    expect(blockedMove.status).toBe(409);
    await expect(blockedMove.json()).resolves.toMatchObject({
      error: { code: "conflict", message: expect.stringContaining("first administrator") },
    });
    const administratorAfterBlockedMove = await database.client`
      select organization_id, role from users where id = ${administratorId}
    `;
    expect(administratorAfterBlockedMove).toEqual([{ organization_id: organizationId, role: "admin" }]);

    const soloOrganizationId = randomUUID();
    const soloUserId = randomUUID();
    const joiningUserId = randomUUID();
    const soloInviteCode = "JKLMN-PQRST";
    await database.client`
      insert into organizations (id, name, invite_code)
      values (${soloOrganizationId}, 'Solo legacy workspace', ${soloInviteCode})
    `;
    await database.client`
      insert into users (id, organization_id, email, name)
      values (${soloUserId}, ${soloOrganizationId}, 'solo-legacy@clock-in.test', 'Solo Legacy')
    `;
    await expect(legacyAccounts.claimFirstAdmin({ organizationId: soloOrganizationId, userId: soloUserId }))
      .resolves.toMatchObject({ kind: "claimed" });

    if (disposable === undefined) throw new Error("The disposable smoke database is required for this test.");
    const mover = createDatabase(disposable.databaseUrl, { max: 1 });
    const joiner = createDatabase(disposable.databaseUrl, { max: 1 });
    try {
      const moverAuth = await createTestAuth(config, new Date());
      const joinerAuth = await createTestAuth(config, new Date());
      const moverApp = createApp({ config, keys: moverAuth.keys, accounts: new DrizzleAccountStore(mover.db) });
      const joinerApp = createApp({ config, keys: joinerAuth.keys, accounts: new DrizzleAccountStore(joiner.db) });
      const moverHeaders = {
        authorization: await moverAuth.bearer(soloUserId, { email: "solo-legacy@clock-in.test", name: "Solo Legacy" }),
        "content-type": "application/json",
      };
      const joinerHeaders = {
        authorization: await joinerAuth.bearer(joiningUserId, { email: "joining@clock-in.test", name: "Joining Member" }),
        "content-type": "application/json",
      };
      const [move, join] = await Promise.all([
        moverApp.request("/organization/join", {
          method: "POST",
          headers: moverHeaders,
          body: JSON.stringify({ inviteCode: otherInviteCode }),
        }),
        joinerApp.request("/accounts", {
          method: "POST",
          headers: joinerHeaders,
          body: JSON.stringify({ inviteCode: soloInviteCode }),
        }),
      ]);

      expect([[200, 404], [200, 409]]).toContainEqual([move.status, join.status].sort());
      const remaining = await database.client`
        select id, role from users where organization_id = ${soloOrganizationId} order by id
      `;
      if (move.status === 200) {
        expect(join.status).toBe(404);
        expect(remaining).toEqual([]);
      } else {
        expect(move.status).toBe(409);
        expect(join.status).toBe(200);
        expect(remaining).toEqual([
          { id: joiningUserId, role: "member" },
          { id: soloUserId, role: "admin" },
        ].sort((left, right) => left.id.localeCompare(right.id)));
      }
    } finally {
      await Promise.all([
        mover.client.end({ timeout: 5 }),
        joiner.client.end({ timeout: 5 }),
      ]);
    }

    const defaultStart = await administratorApp.request("/sessions", {
      method: "POST",
      headers: administratorHeaders,
      body: JSON.stringify({ clientId: randomUUID(), deviceId: randomUUID(), description: "Legacy default" }),
    });
    expect(defaultStart.status).toBe(200);
    expect((await defaultStart.json()).session.projectId).toBe(defaultProjectId);

    const renamed = await administratorApp.request(`/projects/${defaultProjectId}`, {
      method: "PATCH",
      headers: administratorHeaders,
      body: JSON.stringify({ name: "Shared Work" }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: defaultProjectId, name: "Shared Work", isDefault: true });

    const memberRename = await memberApp.request(`/projects/${defaultProjectId}`, {
      method: "PATCH",
      headers: memberHeaders,
      body: JSON.stringify({ name: "Member cannot rename" }),
    });
    expect(memberRename.status).toBe(403);

    const privateCreate = await administratorApp.request("/projects", {
      method: "POST",
      headers: administratorHeaders,
      body: JSON.stringify({ name: "Restricted work" }),
    });
    const privateProject = await privateCreate.json();
    const memberBeforeReplacement = await memberApp.request("/projects", { headers: memberHeaders });
    expect((await memberBeforeReplacement.json()).projects.map((project: { id: string }) => project.id)).not.toContain(privateProject.id);
    const restrictedCreate = await memberApp.request("/projects", {
      method: "POST",
      headers: memberHeaders,
      body: JSON.stringify({ name: "Teammate-only work" }),
    });
    const restrictedProject = await restrictedCreate.json();

    const inaccessibleReplacement = await administratorApp.request(`/projects/${defaultProjectId}`, {
      method: "PATCH",
      headers: administratorHeaders,
      body: JSON.stringify({ isArchived: true, replacementProjectId: restrictedProject.id }),
    });
    expect(inaccessibleReplacement.status).toBe(400);
    const replacement = await administratorApp.request(`/projects/${defaultProjectId}`, {
      method: "PATCH",
      headers: administratorHeaders,
      body: JSON.stringify({ isArchived: true, replacementProjectId: privateProject.id }),
    });
    expect(replacement.status).toBe(200);
    expect((await replacement.json())).toMatchObject({ id: defaultProjectId, isArchived: true, isDefault: false });

    const memberAfterReplacement = await memberApp.request("/projects", { headers: memberHeaders });
    const memberProjects = await memberAfterReplacement.json();
    expect(memberProjects.selectedProjectId).toBe(privateProject.id);
    expect(memberProjects.projects).toContainEqual(expect.objectContaining({ id: privateProject.id, isDefault: true }));
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
    expect((await projects.json()).projects.map((project: { name: string }) => project.name)).toEqual(["General Work"]);

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
    expect(sharedProject.name).toBe("General Work");

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
    expect((await projects.json()).projects.map((project: { name: string }) => project.name)).toEqual(["General Work", "Smoke Side Project"]);

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

  it("attributes browser spans, links running timer evidence, and keeps corroboration to wall-clock time", async () => {
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

    const timerDeviceId = randomUUID();
    const started = await app.request("/sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ clientId: randomUUID(), projectId, deviceId: timerDeviceId, description: "Browser-backed work", startedAt: at(0) }),
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
            deviceId: timerDeviceId,
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

    const agentMapping = await app.request("/path-mappings", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ kind: "path_prefix", pathPrefix: "C:/smoke-overlap", projectId }),
    });
    expect(agentMapping.status).toBe(200);
    const agentEvidence = await app.request("/agent-sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        events: [
          { source: "codex", externalSessionId: "smoke-agent-overlap", event: "started", occurredAt: at(90_000), cwd: "C:/smoke-overlap" },
          { source: "codex", externalSessionId: "smoke-agent-overlap", event: "ended", occurredAt: at(330_000), cwd: "C:/smoke-overlap" },
        ],
      }),
    });
    expect(agentEvidence.status).toBe(200);

    const stop = await app.request(`/sessions/${timerId}/stop`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ stoppedAt: at(600_000), idleSeconds: 0 }),
    });
    expect(stop.status).toBe(200);

    const stats = await app.request(
      `/me/stats?fromAt=${encodeURIComponent(at(0))}&toExclusiveAt=${encodeURIComponent(at(600_000))}`,
      { headers: authorized },
    );
    expect(stats.status).toBe(200);
    const body = await stats.json();

    // The span counts under its rule, clipped to the active segment: minutes 1-4.
    expect(body.sites).toEqual([
      { mapping: { id: ruleId, pattern: "github.com/acme/*", projectId }, durationSeconds: 180 },
    ]);

    const rangedStats = await app.request(
      `/me/stats?fromAt=${encodeURIComponent(at(90_000))}&toExclusiveAt=${encodeURIComponent(at(150_000))}`,
      { headers: authorized },
    );
    expect(rangedStats.status).toBe(200);
    expect((await rangedStats.json()).sites).toEqual([
      { mapping: { id: ruleId, pattern: "github.com/acme/*", projectId }, durationSeconds: 60 },
    ]);

    const project = body.projects.find((entry: { project: { id: string } }) => entry.project.id === projectId);
    expect(project).toMatchObject({ durationSeconds: 600, attributedSeconds: 330, sessionCount: 1 });

    const idleTimerDeviceId = randomUUID();
    const idleTimer = await app.request("/sessions", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ clientId: randomUUID(), projectId, deviceId: idleTimerDeviceId, description: "Idle-boundary work", startedAt: at(0) }),
    });
    expect(idleTimer.status).toBe(200);
    const idleTimerId = (await idleTimer.json()).session.id;
    const idleEvidence = await app.request("/activity/segments", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        segments: [{
          clientId: randomUUID(),
          deviceId: idleTimerDeviceId,
          kind: "idle",
          startedAt: at(0),
          endedAt: at(300_000),
        }, {
          clientId: randomUUID(),
          deviceId: randomUUID(),
          kind: "idle",
          startedAt: at(300_000),
          endedAt: at(600_000),
        }],
      }),
    });
    expect(idleEvidence.status).toBe(200);
    const idleStop = await app.request(`/sessions/${idleTimerId}/stop`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ stoppedAt: at(600_000), idleSeconds: 300 }),
    });
    expect(idleStop.status).toBe(200);
    const idleRange = await app.request(
      `/reports?fromAt=${encodeURIComponent(at(0))}&toExclusiveAt=${encodeURIComponent(at(300_000))}`,
      { headers: authorized },
    );
    expect(idleRange.status).toBe(200);
    expect((await idleRange.json()).rows).toContainEqual(expect.objectContaining({
      id: idleTimerId,
      durationSeconds: 0,
    }));

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

  it("clips completed totals at a local DST calendar boundary in SQL", async () => {
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

    const response = await app.request(
      "/me/stats?fromAt=2026-03-08T06%3A00%3A00.000Z&toExclusiveAt=2026-03-09T05%3A00%3A00.000Z",
      { headers: authorized },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.projects).toContainEqual({
      project: { id: projectId, name: "DST Boundary Project" },
      durationSeconds: 1_800,
      attributedSeconds: 1_800,
      sessionCount: 1,
    });

    const reports = await app.request(
      "/reports?fromAt=2026-03-08T06%3A00%3A00.000Z&toExclusiveAt=2026-03-09T05%3A00%3A00.000Z",
      { headers: authorized },
    );
    expect(reports.status).toBe(200);
    const reportBody = await reports.json();
    expect(reportBody.totalDurationSeconds).toBe(1_800);
    expect(reportBody.rows).toContainEqual(expect.objectContaining({
      project: { id: projectId, name: "DST Boundary Project" },
      durationSeconds: 1_800,
      attributedSeconds: 1_800,
    }));

    const leaderboard = await app.request(
      "/reports/leaderboard?fromAt=2026-03-08T06%3A00%3A00.000Z&toExclusiveAt=2026-03-09T05%3A00%3A00.000Z",
      { headers: authorized },
    );
    expect(leaderboard.status).toBe(200);
    const leaderboardBody = await leaderboard.json();
    expect(leaderboardBody.totalDurationSeconds).toBe(1_800);
    expect(leaderboardBody.entries).toContainEqual(expect.objectContaining({
      user: { id: user.id, name: user.name },
      durationSeconds: 1_800,
      attributedSeconds: 1_800,
      sessionCount: 1,
    }));
  }, 60_000);

  it("rejects clipped legacy idle time with unrelated overlapping device evidence", async () => {
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

    const stored = await database.client`
      select device_id from time_sessions where id = ${sessionId}
    `;
    expect(stored).toEqual([{ device_id: null }]);

    const response = await app.request(
      `/reports?projectId=${projectId}&fromAt=2026-08-02T10%3A00%3A00.000Z&toExclusiveAt=2026-08-02T11%3A00%3A00.000Z&page=1&pageSize=50`,
      { headers: authorized },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "validation_error",
        message: "This range includes time without enough activity evidence to clip exactly.",
      },
    });
  }, 60_000);

  it("rejects a clipped device session when its idle intervals are missing", async () => {
    const created = await app.request("/projects", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ name: "Unreconciled Idle Range Project" }),
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

    const response = await app.request(
      `/reports?projectId=${projectId}&fromAt=${encodeURIComponent(startedAt.toISOString())}&toExclusiveAt=${encodeURIComponent(new Date(startedAt.getTime() + 30_000).toISOString())}&page=1&pageSize=50`,
      { headers: authorized },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "validation_error",
        message: "This range includes time without enough activity evidence to clip exactly.",
      },
    });
  }, 60_000);
});
