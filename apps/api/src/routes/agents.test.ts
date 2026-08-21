import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { parseEnv } from "../env.js";
import type {
  AgentRecord,
  AgentRepository,
  AgentSessionRepository,
  AgentShiftRecord,
  AgentUpdatePatch,
  PathMappingRepository,
  ReportQuery,
  SessionRepository,
  ShiftCommitRecord,
  ShiftCommitRepository,
  UpsertAgentForKey,
} from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  otherOrganization: "1e59dfd6-3d1f-4795-9420-3ab65f0df843",
  admin: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  member: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  agent: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  loser: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
  shift: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
  commit: "e2c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://siqshift:password@localhost:5432/siqshift",
  AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
  NODE_ENV: "test",
});
const users = {
  [ids.admin]: { id: ids.admin, email: "alex@example.com", name: "Alex", organizationId: ids.organization, role: "admin" as const },
  [ids.member]: { id: ids.member, email: "blair@example.com", name: "Blair", organizationId: ids.organization, role: "member" as const },
};

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let adminHeader: string;
let memberHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  adminHeader = await auth.bearer(ids.admin);
  memberHeader = await auth.bearer(ids.member);
});

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: ids.agent,
    organizationId: ids.organization,
    name: "Claude Code @ Field work",
    source: "claude_code",
    status: "anonymous",
    owner: { id: ids.admin, name: "Alex" },
    project: { id: ids.project, name: "Field work" },
    repoRoot: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** In-memory roster: merge re-points nothing here but retires the loser, which the route asserts. */
class MemoryAgents implements AgentRepository {
  public readonly merges: { winnerId: string; loserId: string }[] = [];
  public shifts: AgentShiftRecord[] = [];

  public constructor(public records: AgentRecord[] = []) {}

  public async upsertForKey(_input: UpsertAgentForKey): Promise<{ id: string }> {
    throw new Error("not used");
  }

  public async listForOrganization(subject: { organizationId: string }): Promise<AgentRecord[]> {
    return this.records.filter((record) => record.organizationId === subject.organizationId);
  }

  public async findById(subject: { organizationId: string }, agentId: string): Promise<AgentRecord | null> {
    return this.records.find((record) => record.organizationId === subject.organizationId && record.id === agentId) ?? null;
  }

  public async update(subject: { organizationId: string }, agentId: string, patch: AgentUpdatePatch): Promise<AgentRecord | null> {
    const existing = await this.findById(subject, agentId);
    if (existing === null) return null;
    const updated: AgentRecord = {
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.ownerUserId === undefined ? {} : { owner: { ...existing.owner, id: patch.ownerUserId } }),
    };
    this.records = this.records.map((record) => (record.id === agentId ? updated : record));
    return updated;
  }

  public async merge(_subject: { organizationId: string }, winnerId: string, loserId: string): Promise<void> {
    this.merges.push({ winnerId, loserId });
    this.records = this.records.map((record) => (record.id === loserId ? { ...record, status: "retired" } : record));
  }

  public async listSessionsForAgent(_subject: { organizationId: string }, _agentId: string, query: ReportQuery): Promise<AgentShiftRecord[]> {
    return this.shifts.filter((shift) => {
      const end = (shift.endedAt ?? shift.lastEventAt).getTime();
      if (query.from !== undefined && end <= query.from.getTime()) return false;
      if (query.toExclusive !== undefined && shift.startedAt.getTime() >= query.toExclusive.getTime()) return false;
      return true;
    });
  }
}

function shiftCommitRecord(overrides: Partial<ShiftCommitRecord> = {}): ShiftCommitRecord {
  return {
    id: ids.commit,
    organizationId: ids.organization,
    userId: ids.member,
    agentId: ids.agent,
    agentSessionId: ids.shift,
    clientId: "f3c7e513-b094-4d4c-ae55-21790ae019a4",
    repoRoot: "C:/dev/siqshift",
    branch: "main",
    sha: "a".repeat(40),
    subject: "did work",
    authoredAt: new Date("2026-08-06T10:30:00.000Z"),
    verification: "pending",
    verifiedAt: null,
    ...overrides,
  };
}

/** Only the paystub's read side is exercised by these routes. */
class MemoryShiftCommits implements ShiftCommitRepository {
  public constructor(private readonly records: ShiftCommitRecord[] = []) {}

  public async findByClientId(): Promise<ShiftCommitRecord | null> {
    return null;
  }

  public async insert(): Promise<"inserted" | "duplicate"> {
    throw new Error("not used");
  }

  public async advanceVerification(): Promise<boolean> {
    throw new Error("not used");
  }

  public async countsByAgent(): Promise<never[]> {
    return [];
  }

  public async repoRootsByAgent(): Promise<never[]> {
    return [];
  }

  public async listForAgent(_subject: { organizationId: string }, agentId: string): Promise<ShiftCommitRecord[]> {
    return this.records.filter((record) => record.agentId === agentId);
  }
}

/** Only reapStale is exercised by these routes. */
const reaperOnlySessions = {
  reapStale: async () => 0,
} as unknown as AgentSessionRepository;

/** The agent-session block mounts too, so it gets inert mapping/session fakes. */
const emptyPathMappings = {
  listForSubject: async () => [],
  findById: async () => null,
  findByPathPrefix: async () => null,
  create: async () => { throw new Error("not used"); },
  update: async () => null,
  remove: async () => false,
} as PathMappingRepository;

const idleSessions = { findRunning: async () => null } as unknown as SessionRepository;

const orgMembers = {
  [ids.admin]: { id: ids.admin, name: "Alex" },
  [ids.member]: { id: ids.member, name: "Blair" },
};

const membershipReports = {
  findUserForOrganization: async (_subject: { organizationId: string }, userId: string) =>
    orgMembers[userId as keyof typeof orgMembers] ?? null,
  // The paystub measures the agent's runtime against its owner's presence; no
  // segments here, so every shift reads as time the owner was away.
  readPresenceIntervals: async () => [],
} as unknown as import("../repositories.js").ReportRepository;

const emptyProjects = {
  listForMember: async () => [],
  findForMember: async () => null,
  createForMember: async (): Promise<never> => { throw new Error("not used"); },
} as unknown as import("../repositories.js").ProjectRepository;

function createTestApp(agents = new MemoryAgents([agentRecord()]), shiftCommits?: ShiftCommitRepository) {
  const app = createApp({
    config,
    keys,
    accounts: { resolve: async (identity) => users[identity.authUserId as keyof typeof users] },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    agentSessionRepository: reaperOnlySessions,
    agentRepository: agents,
    ...(shiftCommits === undefined ? {} : { shiftCommitRepository: shiftCommits }),
    reportRepository: membershipReports,
    pathMappingRepository: emptyPathMappings,
    sessionRepository: idleSessions,
    projectRepository: emptyProjects,
  });
  return { app, agents };
}

describe("agent routes", () => {
  it("requires a bearer token", async () => {
    const { app } = createTestApp();
    const response = await app.request("http://api.test/agents");
    expect(response.status).toBe(401);
  });

  it("lists the roster in the contract shape", async () => {
    const { app } = createTestApp();
    const response = await app.request("http://api.test/agents", { headers: { authorization: adminHeader } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agents: [{
        id: ids.agent,
        name: "Claude Code @ Field work",
        source: "claude_code",
        status: "anonymous",
        owner: { id: ids.admin, name: "Alex" },
        project: { id: ids.project, name: "Field work" },
        createdAt: "2026-08-01T00:00:00.000Z",
      }],
    });
  });

  // Both projections have to parse through the same strict schema, which is
  // what optional-rather-than-nullable buys: a caller who owns neither agent
  // reads the codebase's name and simply never receives the path.
  it("sends the codebase name to every member and the path only to the owner and admins", async () => {
    const owned = agentRecord({ repoRoot: "C:/dev/siqshift" });
    const { app } = createTestApp(new MemoryAgents([owned]));

    const asOwner = await app.request("http://api.test/agents", { headers: { authorization: adminHeader } });
    expect(asOwner.status).toBe(200);
    await expect(asOwner.json()).resolves.toMatchObject({
      agents: [{ repoName: "siqshift", repoRoot: "C:/dev/siqshift" }],
    });

    const asOther = await app.request("http://api.test/agents", { headers: { authorization: memberHeader } });
    expect(asOther.status).toBe(200);
    const body = await asOther.json() as { agents: Record<string, unknown>[] };
    expect(body.agents[0]).toMatchObject({ repoName: "siqshift" });
    // Absent, not blanked - the roster still reads correctly from the name.
    expect(body.agents[0]).not.toHaveProperty("repoRoot");
  });

  it("renames an agent that carries a repo, which re-validates the whole record", async () => {
    // The trap: `patch` re-validates the merged agent against the strict
    // schema, so an identity column left out of that literal fails a rename
    // on a field the request never mentions.
    const { app } = createTestApp(new MemoryAgents([agentRecord({ repoRoot: "C:/dev/siqshift" })]));

    const response = await app.request(`http://api.test/agents/${ids.agent}`, {
      method: "PATCH",
      headers: { authorization: memberHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "Reviewer" }),
    });

    expect(response.status).toBe(200);
    // The route re-parses what the service projects, so a mismatched
    // projection would be a 500 on this read path rather than a type error.
    await expect(response.json()).resolves.toMatchObject({ name: "Reviewer", repoName: "siqshift" });
  });

  it("patches a rename, any member allowed, and an anonymous agent registers in the same write", async () => {
    const { app } = createTestApp();
    const response = await app.request(`http://api.test/agents/${ids.agent}`, {
      method: "PATCH",
      headers: { authorization: memberHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "Reviewer" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ name: "Reviewer", status: "registered" });
  });

  it("refuses malformed patches and unknown agents", async () => {
    const { app } = createTestApp();
    const headers = { authorization: memberHeader, "content-type": "application/json" };

    const emptyPatch = await app.request(`http://api.test/agents/${ids.agent}`, { method: "PATCH", headers, body: JSON.stringify({}) });
    expect(emptyPatch.status).toBe(400);

    const anonymous = await app.request(`http://api.test/agents/${ids.agent}`, { method: "PATCH", headers, body: JSON.stringify({ status: "anonymous" }) });
    expect(anonymous.status).toBe(400);

    const badId = await app.request("http://api.test/agents/not-a-uuid", { method: "PATCH", headers, body: JSON.stringify({ name: "x" }) });
    expect(badId.status).toBe(400);

    const missing = await app.request(`http://api.test/agents/${ids.loser}`, { method: "PATCH", headers, body: JSON.stringify({ name: "x" }) });
    expect(missing.status).toBe(404);
  });

  it("refuses a member's merge with 403 and leaves the roster untouched", async () => {
    const agents = new MemoryAgents([agentRecord(), agentRecord({ id: ids.loser, project: null, name: "Claude Code @ unassigned" })]);
    const { app } = createTestApp(agents);
    const response = await app.request(`http://api.test/agents/${ids.agent}/merge`, {
      method: "POST",
      headers: { authorization: memberHeader, "content-type": "application/json" },
      body: JSON.stringify({ loserId: ids.loser }),
    });
    expect(response.status).toBe(403);
    expect(agents.merges).toHaveLength(0);
  });

  it("lets an admin merge: the loser's shifts re-point and the loser retires", async () => {
    const agents = new MemoryAgents([agentRecord(), agentRecord({ id: ids.loser, project: null, name: "Claude Code @ unassigned" })]);
    const { app } = createTestApp(agents);
    const response = await app.request(`http://api.test/agents/${ids.agent}/merge`, {
      method: "POST",
      headers: { authorization: adminHeader, "content-type": "application/json" },
      body: JSON.stringify({ loserId: ids.loser }),
    });
    expect(response.status).toBe(204);
    expect(agents.merges).toEqual([{ winnerId: ids.agent, loserId: ids.loser }]);
    expect(agents.records.find((record) => record.id === ids.loser)).toMatchObject({ status: "retired" });

    const selfMerge = await app.request(`http://api.test/agents/${ids.agent}/merge`, {
      method: "POST",
      headers: { authorization: adminHeader, "content-type": "application/json" },
      body: JSON.stringify({ loserId: ids.agent }),
    });
    expect(selfMerge.status).toBe(400);
  });

  it("serves the paystub for a bounded range and validates its filters", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    agents.shifts = [{
      id: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
      model: "claude-fable-5",
      status: "ended",
      startedAt: new Date("2026-08-06T10:00:00.000Z"),
      endedAt: new Date("2026-08-06T11:00:00.000Z"),
      lastEventAt: new Date("2026-08-06T11:00:00.000Z"),
    }];
    const { app } = createTestApp(agents);

    const query = "fromAt=2026-08-06T00%3A00%3A00.000Z&toExclusiveAt=2026-08-07T00%3A00%3A00.000Z";
    const response = await app.request(`http://api.test/agents/${ids.agent}/paystub?${query}`, {
      headers: { authorization: memberHeader },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totals).toMatchObject({ agentSeconds: 3_600, shiftCount: 1, heldRate: null });
    expect(body.shifts).toHaveLength(1);
    expect(body.trend).toHaveLength(6);

    const mixed = await app.request(
      `http://api.test/agents/${ids.agent}/paystub?from=2026-08-06&fromAt=2026-08-06T00%3A00%3A00.000Z&toExclusiveAt=2026-08-07T00%3A00%3A00.000Z`,
      { headers: { authorization: memberHeader } },
    );
    expect(mixed.status).toBe(400);

    const missing = await app.request(`http://api.test/agents/${ids.loser}/paystub`, { headers: { authorization: memberHeader } });
    expect(missing.status).toBe(404);
  });

  // Renaming and retiring are open to any member, but ownership decides who
  // the pay run credits, so moving it needs the same gate a merge has.
  it("refuses a member's owner reassignment with 403 and leaves the owner alone", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const { app } = createTestApp(agents);

    const refused = await app.request(`http://api.test/agents/${ids.agent}`, {
      method: "PATCH",
      headers: { authorization: memberHeader, "content-type": "application/json" },
      body: JSON.stringify({ ownerUserId: ids.member }),
    });

    expect(refused.status).toBe(403);
    expect(agents.records[0]!.owner.id).toBe(ids.admin);
  });

  it("lets an admin, and the current owner, reassign an owner", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const { app } = createTestApp(agents);

    const byAdmin = await app.request(`http://api.test/agents/${ids.agent}`, {
      method: "PATCH",
      headers: { authorization: adminHeader, "content-type": "application/json" },
      body: JSON.stringify({ ownerUserId: ids.member }),
    });
    expect(byAdmin.status).toBe(200);
    await expect(byAdmin.json()).resolves.toMatchObject({ owner: { id: ids.member } });

    // Blair now owns it, so Blair may hand it back without being an admin.
    const byOwner = await app.request(`http://api.test/agents/${ids.agent}`, {
      method: "PATCH",
      headers: { authorization: memberHeader, "content-type": "application/json" },
      body: JSON.stringify({ ownerUserId: ids.admin }),
    });
    expect(byOwner.status).toBe(200);
    await expect(byOwner.json()).resolves.toMatchObject({ owner: { id: ids.admin } });
  });

  // A repo root is a working directory, and README promises those reach only
  // the owning user and workspace admins.
  it("sends the repo root to the owner and an admin, and withholds it from other members", async () => {
    const agents = new MemoryAgents([agentRecord({ owner: { id: ids.member, name: "Blair" } })]);
    agents.shifts = [{
      id: ids.shift,
      model: null,
      status: "ended",
      startedAt: new Date("2026-08-06T10:00:00.000Z"),
      endedAt: new Date("2026-08-06T11:00:00.000Z"),
      lastEventAt: new Date("2026-08-06T11:00:00.000Z"),
    }];
    const { app } = createTestApp(agents, new MemoryShiftCommits([shiftCommitRecord()]));
    const query = "fromAt=2026-08-06T00%3A00%3A00.000Z&toExclusiveAt=2026-08-07T00%3A00%3A00.000Z";

    const owner = await app.request(`http://api.test/agents/${ids.agent}/paystub?${query}`, {
      headers: { authorization: memberHeader },
    });
    expect(owner.status).toBe(200);
    expect((await owner.json()).shifts[0].commits[0]).toMatchObject({ repoRoot: "C:/dev/siqshift" });

    // The admin owns nothing here and still sees it: admins always do.
    const admin = await app.request(`http://api.test/agents/${ids.agent}/paystub?${query}`, {
      headers: { authorization: adminHeader },
    });
    expect(admin.status).toBe(200);
    expect((await admin.json()).shifts[0].commits[0]).toMatchObject({ repoRoot: "C:/dev/siqshift" });

    const stranger = new MemoryAgents([agentRecord({ owner: { id: ids.admin, name: "Alex" } })]);
    stranger.shifts = agents.shifts;
    const other = createTestApp(stranger, new MemoryShiftCommits([shiftCommitRecord()])).app;
    const response = await other.request(`http://api.test/agents/${ids.agent}/paystub?${query}`, {
      headers: { authorization: memberHeader },
    });
    expect(response.status).toBe(200);
    const commit = (await response.json()).shifts[0].commits[0];
    expect(commit.repoRoot).toBeUndefined();
    // Absent, not blanked: the rest of the commit still reports.
    expect(commit).toMatchObject({ sha: "a".repeat(40), subject: "did work", branch: "main" });
  });
});
