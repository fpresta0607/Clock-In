import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type {
  AgentRecord,
  AgentRepository,
  AgentShiftRecord,
  AgentUpdatePatch,
  AgentUsageBucketTotalRecord,
  AgentUsageModelTotalsRecord,
  AgentUsageRepository,
  PresenceIntervalRecord,
  ReportQuery,
  ReportRepository,
  ShiftCommitRecord,
  ShiftCommitRepository,
  UpsertAgentForKey,
} from "../repositories.js";
import { createAgentService } from "./agents.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  agent: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherAgent: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
};

const member: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user, role: "member" };
const admin: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user, role: "admin" };
const now = new Date("2026-08-06T14:00:00.000Z");

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: ids.agent,
    organizationId: ids.organization,
    name: "Claude Code @ Field work",
    source: "claude_code",
    status: "anonymous",
    owner: { id: ids.user, name: "Alex" },
    project: { id: ids.project, name: "Field work" },
    repoRoot: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

class MemoryAgents implements AgentRepository {
  public readonly merges: { winnerId: string; loserId: string }[] = [];
  public readonly patches: AgentUpdatePatch[] = [];
  public readonly shiftQueries: ReportQuery[] = [];
  public shifts: AgentShiftRecord[] = [];

  public constructor(public records: AgentRecord[] = []) {}

  public async upsertForKey(_input: UpsertAgentForKey): Promise<{ id: string }> {
    throw new Error("not used");
  }

  public async listForOrganization(subject: AuthenticatedSubject): Promise<AgentRecord[]> {
    return this.records.filter((record) => record.organizationId === subject.organizationId);
  }

  public async findById(subject: AuthenticatedSubject, agentId: string): Promise<AgentRecord | null> {
    return this.records.find((record) => record.organizationId === subject.organizationId && record.id === agentId) ?? null;
  }

  public async update(subject: AuthenticatedSubject, agentId: string, patch: AgentUpdatePatch): Promise<AgentRecord | null> {
    const existing = await this.findById(subject, agentId);
    if (existing === null) return null;
    this.patches.push(patch);
    const updated: AgentRecord = {
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.ownerUserId === undefined ? {} : { owner: { ...existing.owner, id: patch.ownerUserId } }),
    };
    this.records = this.records.map((record) => (record.id === agentId ? updated : record));
    return updated;
  }

  public async merge(_subject: AuthenticatedSubject, winnerId: string, loserId: string): Promise<void> {
    this.merges.push({ winnerId, loserId });
  }

  public async listSessionsForAgent(_subject: AuthenticatedSubject, _agentId: string, query: ReportQuery): Promise<AgentShiftRecord[]> {
    this.shiftQueries.push(query);
    return this.shifts.filter((shift) => {
      const end = (shift.endedAt ?? shift.lastEventAt).getTime();
      if (query.from !== undefined && end <= query.from.getTime()) return false;
      if (query.toExclusive !== undefined && shift.startedAt.getTime() >= query.toExclusive.getTime()) return false;
      return true;
    });
  }
}

function shift(overrides: Partial<AgentShiftRecord> = {}): AgentShiftRecord {
  return {
    id: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
    model: "claude-fable-5",
    cwd: null,
    status: "ended",
    startedAt: new Date("2026-08-06T10:00:00.000Z"),
    endedAt: new Date("2026-08-06T11:00:00.000Z"),
    lastEventAt: new Date("2026-08-06T11:00:00.000Z"),
    ...overrides,
  };
}

function createService(
  agents: MemoryAgents,
  members: ReadonlyMap<string, string> = new Map([[ids.user, "Alex"]]),
  usage?: MemoryUsage,
  presence: PresenceIntervalRecord[] = [],
  shiftCommits?: MemoryShiftCommits,
) {
  const reapStale = vi.fn().mockResolvedValue(0);
  const presenceQueries: ReportQuery[] = [];
  const reports = {
    async findUserForOrganization(_subject: AuthenticatedSubject, userId: string) {
      const name = members.get(userId);
      return name === undefined ? null : { id: userId, name };
    },
    async readPresenceIntervals(_subject: AuthenticatedSubject, query: ReportQuery) {
      presenceQueries.push(query);
      return presence.filter((row) =>
        (query.from === undefined || row.endedAt > query.from)
        && (query.toExclusive === undefined || row.startedAt < query.toExclusive));
    },
  } as ReportRepository;
  const service = createAgentService({
    agents,
    reaper: { reapStale },
    reports,
    clock: () => now,
    ...(usage === undefined ? {} : { agentUsage: usage }),
    ...(shiftCommits === undefined ? {} : { shiftCommits }),
  });
  return { service, reapStale, presenceQueries };
}

/** The paystub's usage sums, grouped per model and per hour exactly like the SQL. */
class MemoryUsage implements AgentUsageRepository {
  public readonly modelQueries: ReportQuery[] = [];
  public rows: AgentUsageModelTotalsRecord[] = [];
  public buckets: AgentUsageBucketTotalRecord[] = [];
  public async findByClientId(): ReturnType<AgentUsageRepository["findByClientId"]> {
    throw new Error("not used");
  }
  public async upsertBucket(): ReturnType<AgentUsageRepository["upsertBucket"]> {
    throw new Error("not used");
  }
  public async sumByBucket(): ReturnType<AgentUsageRepository["sumByBucket"]> {
    throw new Error("not used");
  }
  public async sumByBucketForAgent(): Promise<AgentUsageBucketTotalRecord[]> {
    return this.buckets;
  }
  public async sumByAgent(): ReturnType<AgentUsageRepository["sumByAgent"]> {
    throw new Error("not used");
  }
  public async sumByAgentAndModel(_subject: AuthenticatedSubject, _agentId: string, query: ReportQuery): Promise<AgentUsageModelTotalsRecord[]> {
    this.modelQueries.push(query);
    return this.rows;
  }
}

function commitRecord(overrides: Partial<ShiftCommitRecord> = {}): ShiftCommitRecord {
  return {
    id: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
    organizationId: ids.organization,
    userId: ids.user,
    agentId: ids.agent,
    agentSessionId: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
    clientId: "f2c7e513-b094-4d4c-ae55-21790ae019a4",
    repoRoot: "C:\\dev\\clock-in",
    branch: "main",
    sha: "0".repeat(40),
    subject: "feat: ship it",
    authoredAt: new Date("2026-08-06T10:30:00.000Z"),
    verification: "pending",
    verifiedAt: null,
    ...overrides,
  };
}

/** Only the paystub read is exercised; the write paths belong to their own suite. */
class MemoryShiftCommits implements ShiftCommitRepository {
  public constructor(public rows: ShiftCommitRecord[] = []) {}
  public async findByClientId(): ReturnType<ShiftCommitRepository["findByClientId"]> {
    throw new Error("not used");
  }
  public async insert(): ReturnType<ShiftCommitRepository["insert"]> {
    throw new Error("not used");
  }
  public async advanceVerification(): Promise<boolean> {
    throw new Error("not used");
  }
  public async countsByAgent(): ReturnType<ShiftCommitRepository["countsByAgent"]> {
    throw new Error("not used");
  }
  public async repoRootsByAgent(): ReturnType<ShiftCommitRepository["repoRootsByAgent"]> {
    throw new Error("not used");
  }
  public async listForAgent(): Promise<ShiftCommitRecord[]> {
    return this.rows;
  }
}

describe("agent service", () => {
  it("lists the organization's roster", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const { service } = createService(agents);
    await expect(service.list(member)).resolves.toHaveLength(1);
  });

  it("patches after re-validating the merged record", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const { service } = createService(agents);

    const updated = await service.patch(member, ids.agent, { name: "Reviewer", status: "registered" });
    expect(updated).toMatchObject({ name: "Reviewer", status: "registered" });
    expect(agents.patches[0]).toMatchObject({ name: "Reviewer", status: "registered", updatedAt: now });

    await expect(service.patch(member, ids.agent, { name: "x".repeat(201) }))
      .rejects.toMatchObject({ code: "validation_error" });
    await expect(service.patch(member, ids.otherAgent, { name: "Ghost" }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("registers an anonymous agent in the same write as its first rename", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const { service } = createService(agents);

    const renamed = await service.patch(member, ids.agent, { name: "Reviewer" });
    expect(renamed).toMatchObject({ name: "Reviewer", status: "registered" });
    expect(agents.patches[0]).toMatchObject({ name: "Reviewer", status: "registered", updatedAt: now });

    // Renaming an already-registered agent sends no status at all.
    await service.patch(member, ids.agent, { name: "Reviewer II" });
    expect(agents.patches[1]).toMatchObject({ name: "Reviewer II" });
    expect(agents.patches[1]).not.toHaveProperty("status");

    // An explicit status always wins over the ceremony.
    const retiring = new MemoryAgents([agentRecord()]);
    const { service: retiringService } = createService(retiring);
    await retiringService.patch(member, ids.agent, { name: "Reviewer", status: "retired" });
    expect(retiring.patches[0]).toMatchObject({ name: "Reviewer", status: "retired" });

    // An owner change alone is no naming ceremony.
    const handing = new MemoryAgents([agentRecord()]);
    const { service: handingService } = createService(handing);
    await handingService.patch(member, ids.agent, { ownerUserId: ids.user });
    expect(handing.patches[0]).not.toHaveProperty("status");
  });

  it("rejects an owner change to a nonexistent user", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const { service } = createService(agents);

    await expect(service.patch(member, ids.agent, { ownerUserId: "99999999-9999-4999-8999-999999999999" }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(agents.patches).toHaveLength(0);
  });

  it("rejects an owner change to a user outside the organization", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const { service } = createService(agents, new Map([[ids.user, "Alex"]]));

    await expect(service.patch(member, ids.agent, { ownerUserId: "88888888-8888-4888-8888-888888888888" }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(agents.patches).toHaveLength(0);
  });

  it("reassigns an owner who is a member of the organization", async () => {
    const otherUser = "f1c7e513-b094-4d4c-ae55-21790ae019a4";
    const agents = new MemoryAgents([agentRecord()]);
    const { service } = createService(agents, new Map([[ids.user, "Alex"], [otherUser, "Blair"]]));

    const updated = await service.patch(member, ids.agent, { ownerUserId: otherUser });
    expect(updated.owner.id).toBe(otherUser);
    expect(agents.patches[0]).toMatchObject({ ownerUserId: otherUser });
  });

  it("gates merging on the admin role before anything else", async () => {
    const agents = new MemoryAgents([agentRecord(), agentRecord({ id: ids.otherAgent })]);
    const { service } = createService(agents);

    await expect(service.merge(member, ids.agent, ids.otherAgent)).rejects.toMatchObject({ code: "forbidden" });
    expect(agents.merges).toHaveLength(0);

    await expect(service.merge(admin, ids.agent, ids.agent)).rejects.toMatchObject({ code: "validation_error" });
    await expect(service.merge(admin, ids.agent, "00000000-0000-4000-8000-000000000099"))
      .rejects.toMatchObject({ code: "not_found" });

    await service.merge(admin, ids.agent, ids.otherAgent);
    expect(agents.merges).toEqual([{ winnerId: ids.agent, loserId: ids.otherAgent }]);
  });

  it("builds a paystub: reaps first, clips shifts to the range, rounds once per shift", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    agents.shifts = [
      // Fully inside the range: one hour.
      shift(),
      // Straddles the range start at 09:00: only the half inside counts.
      shift({
        id: "d2c7e513-b094-4d4c-ae55-21790ae019a4",
        startedAt: new Date("2026-08-06T08:30:00.000Z"),
        endedAt: new Date("2026-08-06T09:30:00.000Z"),
        lastEventAt: new Date("2026-08-06T09:30:00.000Z"),
      }),
      // Still running: its effective end is its last event, never "open".
      shift({
        id: "d3c7e513-b094-4d4c-ae55-21790ae019a4",
        model: null,
        status: "running",
        startedAt: new Date("2026-08-06T12:00:00.000Z"),
        endedAt: null,
        lastEventAt: new Date("2026-08-06T12:30:00.000Z"),
      }),
    ];
    const { service, reapStale } = createService(agents);

    const paystub = await service.paystub(member, ids.agent, {
      fromAt: "2026-08-06T09:00:00.000Z",
      toExclusiveAt: "2026-08-06T14:00:00.000Z",
    });

    expect(reapStale).toHaveBeenCalledWith(member);
    expect(paystub.agent).toMatchObject({ id: ids.agent, createdAt: "2026-08-01T00:00:00.000Z" });
    expect(paystub.totals).toMatchObject({
      agentSeconds: 3_600 + 1_800 + 1_800,
      shiftCount: 3,
      commitsRecorded: 0,
      heldRate: null,
      // No usage repository is wired: zeros under tokensReported false.
      tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      tokensReported: false,
    });
    const running = paystub.shifts.find((row) => row.id === "d3c7e513-b094-4d4c-ae55-21790ae019a4");
    expect(running).toMatchObject({ endedAt: null, durationSeconds: 1_800 });

    // The model mix folds per-shift seconds under each named model, unnamed
    // shifts under null, in first-seen order. With no usage data each model's
    // token split stays null - absence stays absence. The session facts come
    // from the clipped shifts, so the two Fable shifts never overlap (max 1)
    // and their median is the midpoint of 1h and the clipped half hour.
    expect(paystub.models).toEqual([
      { model: "claude-fable-5", agentSeconds: 3_600 + 1_800, shiftCount: 2, maxConcurrent: 1, medianSeconds: 2_700, tokens: null },
      { model: null, agentSeconds: 1_800, shiftCount: 1, maxConcurrent: 1, medianSeconds: 1_800, tokens: null },
    ]);

    // Six weekly buckets, oldest first, ending at the range's end.
    expect(paystub.trend).toHaveLength(6);
    expect(paystub.trend[5]!.periodStartAt).toBe("2026-07-30T14:00:00.000Z");
    expect(paystub.trend[5]).toMatchObject({ agentSeconds: 3_600 + 3_600 + 1_800, shiftCount: 3, heldRate: null });
    expect(paystub.trend[0]).toMatchObject({ agentSeconds: 0, shiftCount: 0 });
  });

  it("splits the paystub's token totals per model, the null-model bucket included", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    agents.shifts = [
      shift(),
      shift({
        id: "d3c7e513-b094-4d4c-ae55-21790ae019a4",
        model: null,
        status: "ended",
        startedAt: new Date("2026-08-06T12:00:00.000Z"),
        endedAt: new Date("2026-08-06T12:30:00.000Z"),
        lastEventAt: new Date("2026-08-06T12:30:00.000Z"),
      }),
    ];
    const usage = new MemoryUsage();
    usage.rows = [
      // Postgres sums surface as strings; the service converts them.
      { model: "claude-fable-5", inputTokens: "12000", outputTokens: "800", cacheCreationInputTokens: "400", cacheReadInputTokens: "60000", rowCount: 3 },
      { model: null, inputTokens: 500, outputTokens: 25, cacheCreationInputTokens: 0, cacheReadInputTokens: 2_000, rowCount: 1 },
    ];
    const { service } = createService(agents, undefined, usage);

    const paystub = await service.paystub(member, ids.agent, {
      fromAt: "2026-08-06T09:00:00.000Z",
      toExclusiveAt: "2026-08-06T14:00:00.000Z",
    });

    // The range total is the sum over the per-model rows.
    expect(paystub.totals.tokens).toEqual({
      inputTokens: 12_500,
      outputTokens: 825,
      cacheCreationInputTokens: 400,
      cacheReadInputTokens: 62_000,
    });
    expect(paystub.totals.tokensReported).toBe(true);
    expect(paystub.models).toEqual([
      { model: "claude-fable-5", agentSeconds: 3_600, shiftCount: 1, maxConcurrent: 1, medianSeconds: 3_600, tokens: { inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 } },
      { model: null, agentSeconds: 1_800, shiftCount: 1, maxConcurrent: 1, medianSeconds: 1_800, tokens: { inputTokens: 500, outputTokens: 25, cacheCreationInputTokens: 0, cacheReadInputTokens: 2_000 } },
    ]);
  });

  it("keeps a model's token split null when that model reported nothing", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    agents.shifts = [
      shift(),
      shift({
        id: "d3c7e513-b094-4d4c-ae55-21790ae019a4",
        model: "gpt-5",
        status: "ended",
        startedAt: new Date("2026-08-06T12:00:00.000Z"),
        endedAt: new Date("2026-08-06T12:30:00.000Z"),
        lastEventAt: new Date("2026-08-06T12:30:00.000Z"),
      }),
    ];
    const usage = new MemoryUsage();
    // Only claude-fable-5 reported; gpt-5's split stays null while the totals
    // still count what was reported.
    usage.rows = [
      { model: "claude-fable-5", inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, rowCount: 1 },
    ];
    const { service } = createService(agents, undefined, usage);

    const paystub = await service.paystub(member, ids.agent, {});

    expect(paystub.totals.tokensReported).toBe(true);
    expect(paystub.models).toEqual([
      { model: "claude-fable-5", agentSeconds: 3_600, shiftCount: 1, maxConcurrent: 1, medianSeconds: 3_600, tokens: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
      { model: "gpt-5", agentSeconds: 1_800, shiftCount: 1, maxConcurrent: 1, medianSeconds: 1_800, tokens: null },
    ]);
  });

  it("labels each shift's codebase, preferring the commit's repo root over the working directory", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    agents.shifts = [
      // A commit names the repository itself; the cwd sits inside it.
      shift({ cwd: "C:\\dev\\clock-in\\apps\\web" }),
      // No commit, so the working directory is the only label there is.
      shift({
        id: "d3c7e513-b094-4d4c-ae55-21790ae019a4",
        cwd: "/home/alex/src/pocket-piggies/",
        startedAt: new Date("2026-08-06T12:00:00.000Z"),
        endedAt: new Date("2026-08-06T12:30:00.000Z"),
        lastEventAt: new Date("2026-08-06T12:30:00.000Z"),
      }),
      // Nothing recorded either: null, never a guess.
      shift({
        id: "d4c7e513-b094-4d4c-ae55-21790ae019a4",
        startedAt: new Date("2026-08-06T13:00:00.000Z"),
        endedAt: new Date("2026-08-06T13:15:00.000Z"),
        lastEventAt: new Date("2026-08-06T13:15:00.000Z"),
      }),
    ];
    const commits = new MemoryShiftCommits([
      commitRecord({ agentSessionId: "d1c7e513-b094-4d4c-ae55-21790ae019a4", repoRoot: "C:\\dev\\clock-in" }),
    ]);
    const { service } = createService(agents, undefined, undefined, [], commits);

    const paystub = await service.paystub(member, ids.agent, {
      fromAt: "2026-08-06T09:00:00.000Z",
      toExclusiveAt: "2026-08-06T14:00:00.000Z",
    });

    expect(paystub.shifts.map((row) => row.repo)).toEqual(["clock-in", "pocket-piggies", null]);
    // Heaviest first, so the codebase an agent spent its hours in leads.
    expect(paystub.codebases).toEqual([
      { repo: "clock-in", agentSeconds: 3_600, shiftCount: 1 },
      { repo: "pocket-piggies", agentSeconds: 1_800, shiftCount: 1 },
      { repo: null, agentSeconds: 900, shiftCount: 1 },
    ]);
  });

  it("splits the agent's runtime against its owner's presence, and plots the pair hourly", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    agents.shifts = [
      // 10:00-11:00, of which the owner was present for the first half hour.
      shift(),
      // 12:00-12:30, entirely while the owner was away.
      shift({
        id: "d3c7e513-b094-4d4c-ae55-21790ae019a4",
        startedAt: new Date("2026-08-06T12:00:00.000Z"),
        endedAt: new Date("2026-08-06T12:30:00.000Z"),
        lastEventAt: new Date("2026-08-06T12:30:00.000Z"),
      }),
    ];
    const presence: PresenceIntervalRecord[] = [
      { user: { id: ids.user, name: "Alex" }, startedAt: new Date("2026-08-06T10:00:00.000Z"), endedAt: new Date("2026-08-06T10:30:00.000Z") },
    ];
    const { service, presenceQueries } = createService(agents, undefined, undefined, presence);

    const paystub = await service.paystub(member, ids.agent, {
      fromAt: "2026-08-06T09:00:00.000Z",
      toExclusiveAt: "2026-08-06T14:00:00.000Z",
    });

    // Presence is read for the agent's owner, never for the caller.
    expect(presenceQueries[0]).toMatchObject({ userId: ids.user });
    expect(paystub.totals).toMatchObject({
      agentSeconds: 3_600 + 1_800,
      ownerActiveSeconds: 1_800,
      awaySeconds: 1_800 + 1_800,
    });

    // One bucket per hour of the range, the owner's active time beside the
    // agent's runtime, and no token line where nothing reported.
    expect(paystub.hourly).toHaveLength(5);
    expect(paystub.hourly[1]).toMatchObject({
      hourStart: "2026-08-06T10:00:00.000Z",
      activeSeconds: 1_800,
      agentSeconds: 3_600,
      inputTokens: null,
    });
    expect(paystub.hourly[3]).toMatchObject({ hourStart: "2026-08-06T12:00:00.000Z", activeSeconds: 0, agentSeconds: 1_800 });
  });

  it("leaves the hourly series empty for the unbounded range", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    agents.shifts = [shift()];
    const { service } = createService(agents);

    await expect(service.paystub(member, ids.agent, {})).resolves.toMatchObject({ hourly: [] });
  });

  it("answers an unknown paystub agent with not_found", async () => {
    const { service } = createService(new MemoryAgents());
    await expect(service.paystub(member, ids.agent, {})).rejects.toBeInstanceOf(AppError);
  });

  it("refuses an owner change from a member who owns nothing here", async () => {
    const agents = new MemoryAgents([agentRecord({ owner: { id: ids.otherUser, name: "Blair" } })]);
    const { service } = createService(agents, new Map([[ids.user, "Alex"], [ids.otherUser, "Blair"]]));

    await expect(service.patch(member, ids.agent, { ownerUserId: ids.user })).rejects.toBeInstanceOf(AppError);
    expect(agents.patches).toHaveLength(0);
    // An admin, and the owner themselves, still may.
    await expect(service.patch(admin, ids.agent, { ownerUserId: ids.user })).resolves.toMatchObject({
      owner: { id: ids.user },
    });
  });

  // The roster row counts shifts with `clipInterval`, which drops a
  // zero-length one; the paystub totals and its trend have to agree, or the
  // same agent and range reconcile to two different numbers.
  it("counts a zero-length shift the way the roster report does: not at all", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const instant = new Date("2026-08-06T12:00:00.000Z");
    agents.shifts = [
      shift(),
      shift({
        id: "d4c7e513-b094-4d4c-ae55-21790ae019a4",
        startedAt: instant,
        endedAt: instant,
        lastEventAt: instant,
      }),
    ];
    const { service } = createService(agents);

    const paystub = await service.paystub(member, ids.agent, {
      fromAt: "2026-08-06T09:00:00.000Z",
      toExclusiveAt: "2026-08-06T14:00:00.000Z",
    });

    expect(paystub.totals.shiftCount).toBe(1);
    expect(paystub.trend[5]).toMatchObject({ shiftCount: 1 });
    // The shift is still listed - it happened, it just has no duration.
    expect(paystub.shifts).toHaveLength(2);
  });
});
