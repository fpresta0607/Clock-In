import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { parseEnv } from "../env.js";
import type {
  AgentSessionRecord,
  AgentSessionRepository,
  InsertEndedAgentSession,
  PathMappingRecord,
  PathMappingRepository,
  ProjectRepository,
  SessionRecord,
  SessionRepository,
  UpsertStartedAgentSession,
} from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  otherOrganization: "1e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  timer: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
  NODE_ENV: "test",
});
const users = {
  [ids.user]: { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization },
  [ids.otherUser]: { id: ids.otherUser, email: "blair@example.com", name: "Blair", organizationId: ids.otherOrganization },
};

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeader: string;
let otherBearerHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeader = await auth.bearer(ids.user);
  otherBearerHeader = await auth.bearer(ids.otherUser);
});

class MemoryAgentSessions implements AgentSessionRepository {
  public readonly records: AgentSessionRecord[] = [];

  private find(org: string, user: string, source: string, externalSessionId: string): AgentSessionRecord | undefined {
    return this.records.find((record) => record.organizationId === org
      && record.userId === user
      && record.source === source
      && record.externalSessionId === externalSessionId);
  }

  public async findByExternalKey(subject: { organizationId: string; userId: string }, source: AgentSessionRecord["source"], externalSessionId: string) {
    return this.find(subject.organizationId, subject.userId, source, externalSessionId) ?? null;
  }

  public async upsertStarted(input: UpsertStartedAgentSession) {
    const existing = this.find(input.organizationId, input.userId, input.source, input.externalSessionId);
    if (existing !== undefined) {
      if (existing.status === "running" && input.occurredAt > existing.lastEventAt) {
        existing.lastEventAt = input.occurredAt;
      }
      return existing;
    }
    const record: AgentSessionRecord = {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      source: input.source,
      model: input.model,
      externalSessionId: input.externalSessionId,
      projectId: input.projectId,
      cwd: input.cwd,
      status: "running",
      startedAt: input.occurredAt,
      endedAt: null,
      lastEventAt: input.occurredAt,
      linkedSessionId: input.linkedSessionId,
    };
    this.records.push(record);
    return record;
  }

  public async closeRunning(subject: { organizationId: string; userId: string }, source: AgentSessionRecord["source"], externalSessionId: string, endedAt: Date, _now: Date) {
    const existing = this.find(subject.organizationId, subject.userId, source, externalSessionId);
    if (existing === undefined || existing.status === "ended") return null;
    existing.status = "ended";
    const terminalAt = endedAt > existing.lastEventAt ? endedAt : existing.lastEventAt;
    existing.endedAt = terminalAt;
    existing.lastEventAt = terminalAt;
    return existing;
  }

  public async insertEnded(input: InsertEndedAgentSession) {
    if (this.find(input.organizationId, input.userId, input.source, input.externalSessionId) !== undefined) return;
    this.records.push({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      source: input.source,
      model: input.model,
      externalSessionId: input.externalSessionId,
      projectId: input.projectId,
      cwd: input.cwd,
      status: "ended",
      startedAt: input.occurredAt,
      endedAt: input.occurredAt,
      lastEventAt: input.occurredAt,
      linkedSessionId: null,
    });
  }

  public async advanceLastEvent(subject: { organizationId: string; userId: string }, source: AgentSessionRecord["source"], externalSessionId: string, occurredAt: Date, _now: Date) {
    const existing = this.find(subject.organizationId, subject.userId, source, externalSessionId);
    if (existing === undefined || existing.status === "ended") return false;
    if (occurredAt > existing.lastEventAt) existing.lastEventAt = occurredAt;
    return true;
  }

  public async reapStale(subject: { organizationId: string; userId: string }, cutoff: Date, _now: Date) {
    let reaped = 0;
    for (const record of this.records) {
      if (record.organizationId !== subject.organizationId || record.userId !== subject.userId) continue;
      if (record.status === "running" && record.lastEventAt < cutoff) {
        record.status = "ended";
        record.endedAt = record.lastEventAt;
        reaped += 1;
      }
    }
    return reaped;
  }
}

class MemoryPathMappings implements PathMappingRepository {
  public constructor(public readonly records: PathMappingRecord[]) {}
  public async listForSubject(subject: { organizationId: string; userId: string }) {
    return this.records.filter((record) => record.organizationId === subject.organizationId && record.userId === subject.userId);
  }
  public async findById() { return null; }
  public async findByPathPrefix() { return null; }
  public async create(): Promise<PathMappingRecord> { throw new Error("not used"); }
  public async update() { return null; }
  public async remove() { return false; }
}

class MemoryTimers implements Pick<SessionRepository, "findRunning"> {
  public constructor(private readonly running: SessionRecord | null) {}
  public async findRunning() { return this.running; }
}

class Projects implements ProjectRepository {
  public async listForMember() { return []; }
  public async findForMember() { return null; }
  public async createForMember(): Promise<never> { throw new Error("not implemented"); }
}

function runningTimer() {
  return {
    id: ids.timer,
    organizationId: ids.organization,
    userId: ids.user,
    clientId: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
    projectId: ids.project,
    description: null,
    status: "running",
    startedAt: new Date("2026-08-06T13:00:00.000Z"),
    stoppedAt: null,
    idleSeconds: 0,
    durationSeconds: null,
  } satisfies SessionRecord;
}

function createTestApp(agentSessions = new MemoryAgentSessions(), options: { withMapping?: boolean; withTimer?: boolean; withUrlRule?: boolean } = {}) {
  const mappings: PathMappingRecord[] = [];
  if (options.withMapping === true) {
    mappings.push({ id: "e1c7e513-b094-4d4c-ae55-21790ae019a4", organizationId: ids.organization, userId: ids.user, pathPrefix: "C:/dev/clock-in", repoUrl: null, projectId: ids.project });
  }
  if (options.withUrlRule === true) {
    mappings.push({ id: "01c7e513-b094-4d4c-ae55-21790ae019a4", organizationId: ids.organization, userId: ids.user, pathPrefix: "github.com/acme/*", repoUrl: null, projectId: ids.project });
  }
  return createApp({
    config,
    keys,
    accounts: { resolve: async (identity) => users[identity.authUserId as keyof typeof users] },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    projectRepository: new Projects(),
    sessionRepository: new MemoryTimers(options.withTimer === true ? runningTimer() : null) as SessionRepository,
    agentSessionRepository: agentSessions,
    pathMappingRepository: new MemoryPathMappings(mappings),
  });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    source: "kimi_code",
    externalSessionId: "session-1",
    event: "started",
    occurredAt: "2026-08-06T13:30:00.000Z",
    cwd: "C:/dev/clock-in",
    ...overrides,
  };
}

describe("agent-session routes", () => {
  it("requires a bearer token", async () => {
    const response = await createTestApp().request("http://api.test/agent-sessions", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("rejects malformed and schema-invalid bodies", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const malformed = await app.request("http://api.test/agent-sessions", { method: "POST", headers, body: "{bad" });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });

    const badEvent = await app.request("http://api.test/agent-sessions", { method: "POST", headers, body: JSON.stringify({ events: [event({ event: "paused" })] }) });
    expect(badEvent.status).toBe(400);

    const empty = await app.request("http://api.test/agent-sessions", { method: "POST", headers, body: JSON.stringify({ events: [] }) });
    expect(empty.status).toBe(400);
  });

  it("records concurrent sessions from different runtimes without confusing them", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const agentSessions = new MemoryAgentSessions();
    const app = createTestApp(agentSessions, { withMapping: true });

    // Several runtimes run at once on one machine, which is the normal case,
    // not the exotic one. Two open sessions in the same folder must stay two
    // rows: the (source, externalSessionId) key is what tells them apart.
    const response = await app.request("http://api.test/agent-sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [
          event({ source: "claude_code", externalSessionId: "claude-1" }),
          event({ source: "pi", externalSessionId: "pi-1", model: "deepseek-v4-pro" }),
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(agentSessions.records.map((record) => [record.source, record.model, record.projectId])).toEqual([
      ["claude_code", null, ids.project],
      ["pi", "deepseek-v4-pro", ids.project],
    ]);

    // Ending one leaves the other running.
    await app.request("http://api.test/agent-sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [event({ source: "pi", externalSessionId: "pi-1", event: "ended", occurredAt: "2026-08-06T13:55:00.000Z" })] }),
    });
    expect(agentSessions.records.map((record) => [record.source, record.status])).toEqual([
      ["claude_code", "running"],
      ["pi", "ended"],
    ]);
  });

  it("records a runtime the roster has never heard of under its own name", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const agentSessions = new MemoryAgentSessions();
    const app = createTestApp(agentSessions, { withMapping: true });

    const response = await app.request("http://api.test/agent-sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [event({ source: "agent_9", externalSessionId: "new-1" })] }),
    });
    expect(response.status).toBe(200);
    expect(agentSessions.records[0]).toMatchObject({ source: "agent_9", projectId: ids.project });
  });

  it("keeps the model beside the runtime and never derives one from the other", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const agentSessions = new MemoryAgentSessions();
    const app = createTestApp(agentSessions, { withMapping: true });

    await app.request("http://api.test/agent-sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [
          // The same model driven by two runtimes stays two runtimes...
          event({ source: "pi", externalSessionId: "pi-1", model: "deepseek-v4-pro" }),
          event({ source: "opencode", externalSessionId: "oc-1", model: "deepseek-v4-pro" }),
          // ...and a runtime that names no model records none rather than a guess.
          event({ source: "claude_code", externalSessionId: "claude-1" }),
        ],
      }),
    });
    expect(agentSessions.records.map((record) => [record.source, record.model])).toEqual([
      ["pi", "deepseek-v4-pro"],
      ["opencode", "deepseek-v4-pro"],
      ["claude_code", null],
    ]);
  });

  it("attributes and links a started session, then closes it on end", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const agentSessions = new MemoryAgentSessions();
    const app = createTestApp(agentSessions, { withMapping: true, withTimer: true });

    const started = await app.request("http://api.test/agent-sessions", { method: "POST", headers, body: JSON.stringify({ events: [event()] }) });
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toEqual({ results: [{ externalSessionId: "session-1", accepted: true }] });
    expect(agentSessions.records[0]).toMatchObject({ status: "running", projectId: ids.project, linkedSessionId: ids.timer });

    const ended = await app.request("http://api.test/agent-sessions", {
      method: "POST", headers, body: JSON.stringify({ events: [event({ event: "ended", occurredAt: "2026-08-06T13:55:00.000Z" })] }),
    });
    expect(ended.status).toBe(200);
    expect(agentSessions.records[0]).toMatchObject({ status: "ended", endedAt: new Date("2026-08-06T13:55:00.000Z") });
  });

  it("tolerates end-before-start and replays a start idempotently", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const agentSessions = new MemoryAgentSessions();
    const app = createTestApp(agentSessions);

    const endFirst = await app.request("http://api.test/agent-sessions", { method: "POST", headers, body: JSON.stringify({ events: [event({ event: "ended" })] }) });
    expect(endFirst.status).toBe(200);
    await expect(endFirst.json()).resolves.toEqual({ results: [{ externalSessionId: "session-1", accepted: true }] });
    expect(agentSessions.records[0]).toMatchObject({ status: "ended", projectId: null });

    const replay = await app.request("http://api.test/agent-sessions", { method: "POST", headers, body: JSON.stringify({ events: [event(), event()] }) });
    expect(replay.status).toBe(200);
    expect(agentSessions.records).toHaveLength(1);
  });

  it("rejects far-future events per row without failing the batch", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const response = await app.request("http://api.test/agent-sessions", {
      method: "POST", headers,
      body: JSON.stringify({ events: [event({ occurredAt: "2026-08-06T14:00:30.001Z" }), event({ externalSessionId: "fine" })] }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [
        { externalSessionId: "session-1", accepted: false, reason: "occurredAt is too far in the future" },
        { externalSessionId: "fine", accepted: true },
      ],
    });
  });

  it("keeps another organization's sessions invisible and untouched", async () => {
    const headers = { authorization: otherBearerHeader, "content-type": "application/json" };
    const agentSessions = new MemoryAgentSessions();
    const app = createTestApp(agentSessions);

    await app.request("http://api.test/agent-sessions", {
      method: "POST", headers: { ...headers, authorization: bearerHeader }, body: JSON.stringify({ events: [event()] }),
    });
    // The other org's end for the same external session id is a new, separate row.
    const other = await app.request("http://api.test/agent-sessions", {
      method: "POST", headers, body: JSON.stringify({ events: [event({ event: "ended" })] }),
    });

    expect(other.status).toBe(200);
    expect(agentSessions.records).toHaveLength(2);
    expect(agentSessions.records[0]).toMatchObject({ organizationId: ids.organization, status: "running" });
    expect(agentSessions.records[1]).toMatchObject({ organizationId: ids.otherOrganization, status: "ended" });
  });

  it("reaps sessions stale beyond six hours when a batch arrives", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const agentSessions = new MemoryAgentSessions();
    const app = createTestApp(agentSessions);

    await app.request("http://api.test/agent-sessions", {
      method: "POST", headers, body: JSON.stringify({ events: [event({ occurredAt: "2026-08-06T07:00:00.000Z" })] }),
    });
    await app.request("http://api.test/agent-sessions", {
      method: "POST", headers, body: JSON.stringify({ events: [event({ externalSessionId: "fresh" })] }),
    });

    expect(agentSessions.records[0]).toMatchObject({ status: "ended", endedAt: new Date("2026-08-06T07:00:00.000Z") });
    expect(agentSessions.records[1]).toMatchObject({ externalSessionId: "fresh", status: "running" });
  });


});
