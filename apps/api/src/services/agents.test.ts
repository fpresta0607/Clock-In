import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type {
  AgentRecord,
  AgentRepository,
  AgentShiftRecord,
  AgentUpdatePatch,
  ReportQuery,
  ReportRepository,
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
    status: "ended",
    startedAt: new Date("2026-08-06T10:00:00.000Z"),
    endedAt: new Date("2026-08-06T11:00:00.000Z"),
    lastEventAt: new Date("2026-08-06T11:00:00.000Z"),
    ...overrides,
  };
}

function createService(agents: MemoryAgents, members: ReadonlyMap<string, string> = new Map([[ids.user, "Alex"]])) {
  const reapStale = vi.fn().mockResolvedValue(0);
  const reports = {
    async findUserForOrganization(_subject: AuthenticatedSubject, userId: string) {
      const name = members.get(userId);
      return name === undefined ? null : { id: userId, name };
    },
  } as ReportRepository;
  const service = createAgentService({ agents, reaper: { reapStale }, reports, clock: () => now });
  return { service, reapStale };
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
    });
    const running = paystub.shifts.find((row) => row.id === "d3c7e513-b094-4d4c-ae55-21790ae019a4");
    expect(running).toMatchObject({ endedAt: null, durationSeconds: 1_800 });

    // The model mix folds per-shift seconds under each named model, unnamed
    // shifts under null, in first-seen order.
    expect(paystub.models).toEqual([
      { model: "claude-fable-5", agentSeconds: 3_600 + 1_800, shiftCount: 2 },
      { model: null, agentSeconds: 1_800, shiftCount: 1 },
    ]);

    // Six weekly buckets, oldest first, ending at the range's end.
    expect(paystub.trend).toHaveLength(6);
    expect(paystub.trend[5]!.periodStartAt).toBe("2026-07-30T14:00:00.000Z");
    expect(paystub.trend[5]).toMatchObject({ agentSeconds: 3_600 + 3_600 + 1_800, shiftCount: 3, heldRate: null });
    expect(paystub.trend[0]).toMatchObject({ agentSeconds: 0, shiftCount: 0 });
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
