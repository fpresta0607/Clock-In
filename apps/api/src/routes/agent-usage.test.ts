import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { parseEnv } from "../env.js";
import type {
  AgentRecord,
  AgentRepository,
  AgentSessionRecord,
  AgentSessionRepository,
  AgentShiftRecord,
  AgentUsageRecord,
  AgentUsageRepository,
  PathMappingRepository,
  SessionRepository,
  UpsertAgentForKey,
  UpsertAgentUsageBucket,
} from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  otherOrganization: "1e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  agent: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  session: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
  NODE_ENV: "test",
});
const users = {
  [ids.user]: { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization, role: "member" as const },
  [ids.otherUser]: { id: ids.otherUser, email: "blair@example.com", name: "Blair", organizationId: ids.otherOrganization, role: "member" as const },
};

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeader = await auth.bearer(ids.user);
});

function sessionRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: ids.session,
    organizationId: ids.organization,
    userId: ids.user,
    source: "claude_code",
    model: null,
    externalSessionId: "ext-1",
    projectId: null,
    cwd: "C:/dev/clock-in",
    ruleId: null,
    agentId: ids.agent,
    status: "ended",
    startedAt: new Date("2026-08-06T10:00:00.000Z"),
    endedAt: new Date("2026-08-06T11:00:00.000Z"),
    lastEventAt: new Date("2026-08-06T11:00:00.000Z"),
    linkedSessionId: null,
    ...overrides,
  };
}

class MemoryAgentSessions implements AgentSessionRepository {
  public constructor(private readonly sessions: AgentSessionRecord[] = []) {}

  public async findByExternalKey(current: { organizationId: string }, source: string, externalSessionId: string): Promise<AgentSessionRecord | null> {
    return this.sessions.find((row) => row.organizationId === current.organizationId
      && row.source === source && row.externalSessionId === externalSessionId) ?? null;
  }

  public async upsertStarted(): Promise<AgentSessionRecord> { throw new Error("not used"); }
  public async closeRunning(): Promise<AgentSessionRecord | null> { throw new Error("not used"); }
  public async insertEnded(): Promise<void> { throw new Error("not used"); }
  public async advanceLastEvent(): Promise<boolean> { throw new Error("not used"); }
  public async reapStale(): Promise<number> { throw new Error("not used"); }
  public async stampAgent(): Promise<void> { throw new Error("not used"); }
}

const inertAgents: AgentRepository = {
  async upsertForKey(): Promise<{ id: string }> { throw new Error("not used"); },
  async listForOrganization(): Promise<AgentRecord[]> { throw new Error("not used"); },
  async findById(): Promise<AgentRecord | null> { throw new Error("not used"); },
  async update(): Promise<AgentRecord | null> { throw new Error("not used"); },
  async merge(): Promise<void> { throw new Error("not used"); },
  async listSessionsForAgent(): Promise<AgentShiftRecord[]> { throw new Error("not used"); },
};

class MemoryAgentUsage implements AgentUsageRepository {
  public readonly records: AgentUsageRecord[] = [];

  public async findByClientId(current: { organizationId: string; userId: string }, clientId: string): Promise<AgentUsageRecord | null> {
    return this.records.find((row) => row.organizationId === current.organizationId
      && row.userId === current.userId && row.clientId === clientId) ?? null;
  }

  public async upsertBucket(input: UpsertAgentUsageBucket): Promise<void> {
    const existing = this.records.find((row) => row.organizationId === input.organizationId
      && row.agentSessionId === input.agentSessionId
      && row.bucketStartAt.getTime() === input.bucketStartAt.getTime()
      && row.model === input.model
      && row.sidechain === input.sidechain);
    if (existing !== undefined) {
      existing.inputTokens = Math.max(existing.inputTokens, input.inputTokens);
      existing.outputTokens = Math.max(existing.outputTokens, input.outputTokens);
      existing.cacheCreationInputTokens = Math.max(existing.cacheCreationInputTokens, input.cacheCreationInputTokens);
      existing.cacheReadInputTokens = Math.max(existing.cacheReadInputTokens, input.cacheReadInputTokens);
      return;
    }
    this.records.push({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      agentId: input.agentId,
      agentSessionId: input.agentSessionId,
      clientId: input.clientId,
      bucketStartAt: input.bucketStartAt,
      model: input.model,
      sidechain: input.sidechain,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
    });
  }
}

const emptyPathMappings: PathMappingRepository = {
  async listForSubject() { return []; },
  async findById() { return null; },
  async findByPathPrefix() { return null; },
  async create(): Promise<never> { throw new Error("not used"); },
  async update() { return null; },
  async remove() { return false; },
};

const idleSessions = { findRunning: async () => null } as unknown as SessionRepository;

const emptyReports = {
  findUserForOrganization: async () => null,
} as unknown as import("../repositories.js").ReportRepository;

const emptyProjects = {
  listForMember: async () => [],
  findForMember: async () => null,
  createForMember: async (): Promise<never> => { throw new Error("not used"); },
} as unknown as import("../repositories.js").ProjectRepository;

function createTestApp(agentUsage = new MemoryAgentUsage(), sessions = new MemoryAgentSessions([sessionRecord()])) {
  return createApp({
    config,
    keys,
    accounts: { resolve: async (identity) => users[identity.authUserId as keyof typeof users] },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    agentSessionRepository: sessions,
    agentRepository: inertAgents,
    reportRepository: emptyReports,
    agentUsageRepository: agentUsage,
    pathMappingRepository: emptyPathMappings,
    sessionRepository: idleSessions,
    projectRepository: emptyProjects,
  });
}

function usageUpload(overrides: Record<string, unknown> = {}) {
  return {
    clientId: crypto.randomUUID(),
    source: "claude_code",
    externalSessionId: "ext-1",
    bucketStartAt: "2026-08-06T10:00:00.000Z",
    model: "claude-opus-4-8",
    sidechain: false,
    inputTokens: 1_000,
    outputTokens: 250,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 5_000,
    ...overrides,
  };
}

describe("agent-usage routes", () => {
  it("requires a bearer token", async () => {
    const response = await createTestApp().request("http://api.test/agent-usage", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("rejects malformed and schema-invalid bodies", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const malformed = await app.request("http://api.test/agent-usage", { method: "POST", headers, body: "{bad" });
    expect(malformed.status).toBe(400);

    const empty = await app.request("http://api.test/agent-usage", { method: "POST", headers, body: JSON.stringify({ usage: [] }) });
    expect(empty.status).toBe(400);

    const negative = await app.request("http://api.test/agent-usage", {
      method: "POST", headers, body: JSON.stringify({ usage: [usageUpload({ inputTokens: -1 })] }),
    });
    expect(negative.status).toBe(400);

    const extra = await app.request("http://api.test/agent-usage", {
      method: "POST", headers, body: JSON.stringify({ usage: [usageUpload({ transcriptPath: "C:/secret.jsonl" })] }),
    });
    expect(extra.status).toBe(400);
  });

  it("accepts usage, reports unknown_session as retryable, and replays idempotently", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const agentUsage = new MemoryAgentUsage();
    const app = createTestApp(agentUsage);
    const good = usageUpload();
    const unknown = usageUpload({ externalSessionId: "ghost" });

    const uploaded = await app.request("http://api.test/agent-usage", {
      method: "POST", headers, body: JSON.stringify({ usage: [good, unknown] }),
    });
    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toEqual({
      accepted: 1,
      rejected: [{ clientId: unknown.clientId, reason: "unknown_session" }],
    });
    expect(agentUsage.records).toHaveLength(1);

    const replay = await app.request("http://api.test/agent-usage", {
      method: "POST", headers, body: JSON.stringify({ usage: [good] }),
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ accepted: 1, rejected: [] });
    expect(agentUsage.records).toHaveLength(1);
  });

  it("restates a bucket monotonically across uploads", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const agentUsage = new MemoryAgentUsage();
    const app = createTestApp(agentUsage);
    await app.request("http://api.test/agent-usage", {
      method: "POST", headers, body: JSON.stringify({ usage: [usageUpload({ inputTokens: 2_000 })] }),
    });

    await app.request("http://api.test/agent-usage", {
      method: "POST", headers, body: JSON.stringify({ usage: [usageUpload({ inputTokens: 1_500 })] }),
    });

    expect(agentUsage.records).toHaveLength(1);
    expect(agentUsage.records[0]).toMatchObject({ inputTokens: 2_000 });
  });
});
