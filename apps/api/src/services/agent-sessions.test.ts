import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentSessionRecord,
  AgentSessionRepository,
  InsertEndedAgentSession,
  PathMappingRecord,
  PathMappingRepository,
  SessionRecord,
  SessionRepository,
  UpsertStartedAgentSession,
} from "../repositories.js";
import { createAgentSessionService, type AgentSessionEventInput } from "./agent-sessions.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  timer: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user };
const now = new Date("2026-08-06T14:00:00.000Z");

class MemoryAgentSessions implements AgentSessionRepository {
  public readonly records: AgentSessionRecord[] = [];

  private find(current: AuthenticatedSubject, source: string, externalSessionId: string): AgentSessionRecord | undefined {
    return this.records.find((record) => record.organizationId === current.organizationId
      && record.userId === current.userId
      && record.source === source
      && record.externalSessionId === externalSessionId);
  }

  public async findByExternalKey(current: AuthenticatedSubject, source: AgentSessionRecord["source"], externalSessionId: string): Promise<AgentSessionRecord | null> {
    return this.find(current, source, externalSessionId) ?? null;
  }

  /** Mirrors the upsert: insert running; on replay refresh lastEventAt only, never reopen. */
  public async upsertStarted(input: UpsertStartedAgentSession): Promise<AgentSessionRecord> {
    const existing = this.find({ organizationId: input.organizationId, userId: input.userId }, input.source, input.externalSessionId);
    if (existing !== undefined) {
      if (input.occurredAt > existing.lastEventAt) existing.lastEventAt = input.occurredAt;
      return existing;
    }
    const record: AgentSessionRecord = {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      source: input.source,
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

  public async closeRunning(current: AuthenticatedSubject, source: AgentSessionRecord["source"], externalSessionId: string, endedAt: Date): Promise<AgentSessionRecord | null> {
    const existing = this.find(current, source, externalSessionId);
    if (existing === undefined || existing.status !== "running") return null;
    existing.status = "ended";
    existing.endedAt = endedAt;
    if (endedAt > existing.lastEventAt) existing.lastEventAt = endedAt;
    return existing;
  }

  /** Mirrors the tolerated end-before-start insert (ON CONFLICT DO NOTHING). */
  public async insertEnded(input: InsertEndedAgentSession): Promise<void> {
    const existing = this.find({ organizationId: input.organizationId, userId: input.userId }, input.source, input.externalSessionId);
    if (existing !== undefined) return;
    this.records.push({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      source: input.source,
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

  public async advanceLastEvent(current: AuthenticatedSubject, source: AgentSessionRecord["source"], externalSessionId: string, occurredAt: Date): Promise<boolean> {
    const existing = this.find(current, source, externalSessionId);
    if (existing === undefined || existing.status !== "running") return false;
    if (occurredAt > existing.lastEventAt) existing.lastEventAt = occurredAt;
    return true;
  }

  /** Mirrors staleness reaping: running rows older than the cutoff end at lastEventAt. */
  public async reapStale(current: AuthenticatedSubject, cutoff: Date): Promise<number> {
    let reaped = 0;
    for (const record of this.records) {
      if (record.organizationId !== current.organizationId || record.userId !== current.userId) continue;
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
  public constructor(public readonly records: PathMappingRecord[] = []) {}

  public async listForSubject(current: AuthenticatedSubject): Promise<PathMappingRecord[]> {
    return this.records.filter((record) => record.organizationId === current.organizationId && record.userId === current.userId);
  }
  public async findById(): Promise<PathMappingRecord | null> { throw new Error("not used"); }
  public async findByPathPrefix(): Promise<PathMappingRecord | null> { throw new Error("not used"); }
  public async create(): Promise<PathMappingRecord> { throw new Error("not used"); }
  public async update(): Promise<PathMappingRecord | null> { throw new Error("not used"); }
  public async remove(): Promise<boolean> { throw new Error("not used"); }
}

class MemoryTimers implements Pick<SessionRepository, "findRunning"> {
  public running: SessionRecord | null = null;
  public async findRunning(): Promise<SessionRecord | null> { return this.running; }
}

function runningTimer(projectId: string): SessionRecord {
  return {
    id: ids.timer,
    organizationId: ids.organization,
    userId: ids.user,
    clientId: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
    projectId,
    description: null,
    status: "running",
    startedAt: new Date("2026-08-06T13:00:00.000Z"),
    stoppedAt: null,
    idleSeconds: 0,
    durationSeconds: null,
  };
}

function event(overrides: Partial<AgentSessionEventInput> = {}): AgentSessionEventInput {
  return {
    source: "claude_code",
    externalSessionId: "session-1",
    event: "started",
    occurredAt: new Date("2026-08-06T13:30:00.000Z"),
    cwd: "C:/dev/clock-in",
    ...overrides,
  };
}

function createService(options: {
  mappings?: PathMappingRecord[];
  runningTimer?: SessionRecord | null;
  staleThresholdMs?: number;
} = {}) {
  const agentSessions = new MemoryAgentSessions();
  const timers = new MemoryTimers();
  timers.running = options.runningTimer ?? null;
  const service = createAgentSessionService({
    agentSessions,
    pathMappings: new MemoryPathMappings(options.mappings ?? []),
    sessions: timers as SessionRepository,
    clock: () => now,
    ...(options.staleThresholdMs === undefined ? {} : { staleThresholdMs: options.staleThresholdMs }),
  });
  return { agentSessions, service };
}

const mapped = { id: "f1c7e513-b094-4d4c-ae55-21790ae019a4", organizationId: ids.organization, userId: ids.user, pathPrefix: "C:/dev/clock-in", repoUrl: null, projectId: ids.project };

describe("agent-session service", () => {
  it("starts a running row attributed by cwd and linked to a matching running timer", async () => {
    const { agentSessions, service } = createService({ mappings: [mapped], runningTimer: runningTimer(ids.project) });

    const result = await service.ingest(subject, [event()]);

    expect(result).toEqual({ results: [{ externalSessionId: "session-1", accepted: true }] });
    expect(agentSessions.records[0]).toMatchObject({
      status: "running",
      projectId: ids.project,
      linkedSessionId: ids.timer,
      startedAt: new Date("2026-08-06T13:30:00.000Z"),
      lastEventAt: new Date("2026-08-06T13:30:00.000Z"),
      endedAt: null,
    });
  });

  it("leaves projectId null for unmapped cwds and does not link a timer on another project", async () => {
    const unmapped = createService({ runningTimer: runningTimer(ids.project) });
    await unmapped.service.ingest(subject, [event()]);
    expect(unmapped.agentSessions.records[0]).toMatchObject({ projectId: null, linkedSessionId: null });

    const otherProject = createService({ mappings: [mapped], runningTimer: runningTimer(ids.otherProject) });
    await otherProject.service.ingest(subject, [event()]);
    expect(otherProject.agentSessions.records[0]).toMatchObject({ projectId: ids.project, linkedSessionId: null });
  });

  it("treats a repeated start as a lastEventAt refresh", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event()]);
    const result = await service.ingest(subject, [event({ occurredAt: new Date("2026-08-06T13:45:00.000Z") })]);

    expect(result.results).toEqual([{ externalSessionId: "session-1", accepted: true }]);
    expect(agentSessions.records).toHaveLength(1);
    expect(agentSessions.records[0]).toMatchObject({ status: "running", lastEventAt: new Date("2026-08-06T13:45:00.000Z") });
  });

  it("closes a running session at the end event's occurredAt", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event()]);
    await service.ingest(subject, [event({ event: "ended", occurredAt: new Date("2026-08-06T13:50:00.000Z") })]);

    expect(agentSessions.records[0]).toMatchObject({
      status: "ended",
      endedAt: new Date("2026-08-06T13:50:00.000Z"),
      lastEventAt: new Date("2026-08-06T13:50:00.000Z"),
    });
  });

  it("tolerates end-before-start by storing the row directly as ended, attributed from cwd", async () => {
    const { agentSessions, service } = createService({ mappings: [mapped] });

    const result = await service.ingest(subject, [event({ event: "ended" })]);

    expect(result.results).toEqual([{ externalSessionId: "session-1", accepted: true }]);
    expect(agentSessions.records[0]).toMatchObject({
      status: "ended",
      projectId: ids.project,
      startedAt: new Date("2026-08-06T13:30:00.000Z"),
      endedAt: new Date("2026-08-06T13:30:00.000Z"),
    });
  });

  it("accepts an end for an already-ended session without reopening it", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event(), event({ event: "ended", occurredAt: new Date("2026-08-06T13:50:00.000Z") })]);
    const result = await service.ingest(subject, [event({ event: "ended", occurredAt: new Date("2026-08-06T13:55:00.000Z") })]);

    expect(result.results).toEqual([{ externalSessionId: "session-1", accepted: true }]);
    expect(agentSessions.records).toHaveLength(1);
    expect(agentSessions.records[0]).toMatchObject({ status: "ended", endedAt: new Date("2026-08-06T13:50:00.000Z") });
  });

  it("advances lastEventAt on heartbeat and accepts unknown sessions as no-ops", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event()]);
    await service.ingest(subject, [
      event({ event: "heartbeat", occurredAt: new Date("2026-08-06T13:40:00.000Z") }),
      event({ event: "heartbeat", externalSessionId: "ghost", occurredAt: new Date("2026-08-06T13:41:00.000Z") }),
    ]);

    expect(agentSessions.records).toHaveLength(1);
    expect(agentSessions.records[0]).toMatchObject({ lastEventAt: new Date("2026-08-06T13:40:00.000Z") });
  });

  it("reaps running sessions stale beyond six hours at their lastEventAt before a batch", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event({ occurredAt: new Date("2026-08-06T07:00:00.000Z") })]);

    const result = await service.ingest(subject, [event({ externalSessionId: "fresh" })]);

    expect(result.results).toEqual([{ externalSessionId: "fresh", accepted: true }]);
    expect(agentSessions.records[0]).toMatchObject({
      externalSessionId: "session-1",
      status: "ended",
      endedAt: new Date("2026-08-06T07:00:00.000Z"),
    });
    expect(agentSessions.records[1]).toMatchObject({ externalSessionId: "fresh", status: "running" });
  });

  it("exposes reaping for read paths", async () => {
    const { agentSessions, service } = createService();
    await service.ingest(subject, [event({ occurredAt: new Date("2026-08-06T07:30:00.000Z") })]);

    await expect(service.reapStale(subject)).resolves.toBe(1);
    await expect(service.reapStale(subject)).resolves.toBe(0);
    expect(agentSessions.records[0]).toMatchObject({ status: "ended", endedAt: new Date("2026-08-06T07:30:00.000Z") });
  });

  it("rejects invalid or far-future events individually without failing the batch", async () => {
    const { agentSessions, service } = createService();

    const result = await service.ingest(subject, [
      event({ occurredAt: new Date("2026-08-06T14:00:30.001Z") }),
      event({ externalSessionId: "bad-date", occurredAt: new Date("not-a-date") }),
      event({ externalSessionId: "fine" }),
    ]);

    expect(result.results).toEqual([
      { externalSessionId: "session-1", accepted: false, reason: "occurredAt is too far in the future" },
      { externalSessionId: "bad-date", accepted: false, reason: "occurredAt is invalid" },
      { externalSessionId: "fine", accepted: true },
    ]);
    expect(agentSessions.records.map((record) => record.externalSessionId)).toEqual(["fine"]);
  });

  it("scopes sessions to the subject's organization and user", async () => {
    const { agentSessions, service } = createService();
    const other: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.otherUser };
    await service.ingest(subject, [event()]);
    await service.ingest(other, [event()]);

    expect(agentSessions.records).toHaveLength(2);
    await service.ingest(other, [event({ event: "ended" })]);
    expect(agentSessions.records[0]).toMatchObject({ userId: ids.user, status: "running" });
    expect(agentSessions.records[1]).toMatchObject({ userId: ids.otherUser, status: "ended" });
  });
});
