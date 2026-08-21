import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentRecord,
  AgentRepository,
  AgentSessionRecord,
  AgentSessionRepository,
  AgentShiftRecord,
  AgentUsageRecord,
  AgentUsageRepository,
  UpsertAgentForKey,
  UpsertAgentUsageBucket,
} from "../repositories.js";
import { unknownSessionReason } from "./shift-commits.js";
import { createAgentUsageService, type AgentUsageServiceDependencies } from "./agent-usage.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  agent: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherAgent: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  session: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user, role: "member" };
const now = new Date("2026-08-06T14:00:00.000Z");

function sessionRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: ids.session,
    organizationId: ids.organization,
    userId: ids.user,
    source: "claude_code",
    model: null,
    externalSessionId: "ext-1",
    projectId: null,
    cwd: "C:/dev/siqshift",
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
  public readonly stamps: { sessionId: string; agentId: string }[] = [];
  public constructor(private readonly sessions: AgentSessionRecord[] = []) {}

  public async findByExternalKey(current: AuthenticatedSubject, source: string, externalSessionId: string): Promise<AgentSessionRecord | null> {
    return this.sessions.find((row) => row.organizationId === current.organizationId
      && row.source === source && row.externalSessionId === externalSessionId) ?? null;
  }

  public async upsertStarted(): Promise<AgentSessionRecord> { throw new Error("not used"); }
  public async closeRunning(): Promise<AgentSessionRecord | null> { throw new Error("not used"); }
  public async insertEnded(): Promise<void> { throw new Error("not used"); }
  public async advanceLastEvent(): Promise<boolean> { throw new Error("not used"); }
  public async reapStale(): Promise<number> { throw new Error("not used"); }

  public async stampAgent(current: AuthenticatedSubject, sessionId: string, agentId: string): Promise<void> {
    this.stamps.push({ sessionId, agentId });
    const target = this.sessions.find((row) => row.organizationId === current.organizationId && row.id === sessionId);
    if (target !== undefined && target.agentId === null) target.agentId = agentId;
  }
}

class MemoryAgents implements AgentRepository {
  public readonly upserts: UpsertAgentForKey[] = [];

  public async upsertForKey(input: UpsertAgentForKey): Promise<{ id: string }> {
    this.upserts.push(input);
    return { id: ids.otherAgent };
  }

  public async listForOrganization(): Promise<AgentRecord[]> { throw new Error("not used"); }
  public async findById(): Promise<AgentRecord | null> { throw new Error("not used"); }
  public async update(): Promise<AgentRecord | null> { throw new Error("not used"); }
  public async merge(): Promise<void> { throw new Error("not used"); }
  public async listSessionsForAgent(): Promise<AgentShiftRecord[]> { throw new Error("not used"); }
}

class MemoryAgentUsage implements AgentUsageRepository {
  public readonly records: AgentUsageRecord[] = [];

  public async findByClientId(current: AuthenticatedSubject, clientId: string): Promise<AgentUsageRecord | null> {
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
      // Counters are cumulative totals: a restate can only raise them.
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

function usageUpload(overrides: Record<string, unknown> = {}) {
  return {
    clientId: crypto.randomUUID(),
    source: "claude_code",
    externalSessionId: "ext-1",
    bucketStartAt: "2026-08-06T10:00:00.000Z",
    sidechain: false,
    inputTokens: 1_000,
    outputTokens: 250,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 5_000,
    ...overrides,
  };
}

function createService(overrides: Partial<AgentUsageServiceDependencies> = {}) {
  const agentUsage = overrides.agentUsage ?? new MemoryAgentUsage();
  const agentSessions = overrides.agentSessions ?? new MemoryAgentSessions([sessionRecord()]);
  const service = createAgentUsageService({
    agentUsage,
    agentSessions,
    clock: () => now,
    ...overrides,
  });
  return { service, agentUsage: agentUsage as MemoryAgentUsage, agentSessions: agentSessions as MemoryAgentSessions };
}

describe("agent-usage service", () => {
  it("records a bucket for a known shift", async () => {
    const { service, agentUsage } = createService();

    const result = await service.ingest(subject, [usageUpload({ model: "claude-opus-4-8" })]);

    expect(result).toEqual({ accepted: 1, rejected: [] });
    expect(agentUsage.records).toHaveLength(1);
    expect(agentUsage.records[0]).toMatchObject({
      agentId: ids.agent,
      agentSessionId: ids.session,
      model: "claude-opus-4-8",
      inputTokens: 1_000,
    });
  });

  it("rejects an entry whose shift has not landed yet, retryable as unknown_session", async () => {
    const { service } = createService({ agentSessions: new MemoryAgentSessions([]) });
    const entry = usageUpload();

    const result = await service.ingest(subject, [entry]);

    expect(result).toEqual({ accepted: 0, rejected: [{ clientId: entry.clientId, reason: unknownSessionReason }] });
  });

  it("replays accepted: the same clientId uploaded twice is stored once", async () => {
    const { service, agentUsage } = createService();
    const entry = usageUpload();

    await service.ingest(subject, [entry]);
    const replay = await service.ingest(subject, [entry]);

    expect(replay).toEqual({ accepted: 1, rejected: [] });
    expect(agentUsage.records).toHaveLength(1);
  });

  it("restates a bucket monotonically: a lower re-sent total never decreases the stored counter", async () => {
    const { service, agentUsage } = createService();

    await service.ingest(subject, [usageUpload({ inputTokens: 2_000, outputTokens: 500 })]);
    // A new clientId over the same bucket key restates the bucket totals.
    const restate = await service.ingest(subject, [usageUpload({ inputTokens: 1_500, outputTokens: 900 })]);

    expect(restate).toEqual({ accepted: 1, rejected: [] });
    expect(agentUsage.records).toHaveLength(1);
    expect(agentUsage.records[0]).toMatchObject({ inputTokens: 2_000, outputTokens: 900 });
  });

  it("keeps a null-model bucket and a named-model bucket distinct", async () => {
    const { service, agentUsage } = createService();

    await service.ingest(subject, [usageUpload({ inputTokens: 100 })]);
    await service.ingest(subject, [usageUpload({ model: "claude-opus-4-8", inputTokens: 200 })]);

    expect(agentUsage.records).toHaveLength(2);
    expect(agentUsage.records.map((row) => row.model).sort()).toEqual([null, "claude-opus-4-8"].sort());
  });

  it("keeps a main-file bucket and a sidechain bucket distinct", async () => {
    const { service, agentUsage } = createService();

    await service.ingest(subject, [usageUpload({ inputTokens: 100 })]);
    await service.ingest(subject, [usageUpload({ sidechain: true, inputTokens: 200 })]);

    expect(agentUsage.records).toHaveLength(2);
  });

  it("stamps a null-agentId session so pre-feature shifts still take usage rows", async () => {
    const sessions = new MemoryAgentSessions([sessionRecord({ agentId: null })]);
    const agents = new MemoryAgents();
    const { service, agentUsage } = createService({ agentSessions: sessions, agents });

    await service.ingest(subject, [usageUpload()]);

    expect(agents.upserts).toHaveLength(1);
    expect(sessions.stamps).toEqual([{ sessionId: ids.session, agentId: ids.otherAgent }]);
    expect(agentUsage.records[0]).toMatchObject({ agentId: ids.otherAgent });
  });
});
