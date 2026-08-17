import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentRecord,
  AgentRepository,
  AgentSessionRecord,
  AgentSessionRepository,
  UpsertAgentForKey,
} from "../repositories.js";
import { graduateAgentForSession } from "./agent-identity.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  session: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
  bucket: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  incumbent: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user, role: "member" };
const now = new Date("2026-08-16T14:00:00.000Z");
const clockIn = "C:/dev/clock-in";
const piggies = "C:/dev/pocket-piggies";

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: ids.bucket,
    organizationId: ids.organization,
    name: "Claude Code @ unassigned",
    source: "claude_code",
    status: "anonymous",
    owner: { id: ids.user, name: "Alex" },
    project: null,
    repoRoot: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function session(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: ids.session,
    organizationId: ids.organization,
    userId: ids.user,
    source: "claude_code",
    model: null,
    externalSessionId: "ext-1",
    projectId: null,
    cwd: clockIn,
    ruleId: null,
    agentId: ids.bucket,
    status: "ended",
    startedAt: new Date("2026-08-16T10:00:00.000Z"),
    endedAt: new Date("2026-08-16T11:00:00.000Z"),
    lastEventAt: new Date("2026-08-16T11:00:00.000Z"),
    linkedSessionId: null,
    ...overrides,
  };
}

/**
 * The roster as the graduation rules see it: rows by id, a repo-keyed index
 * that mints on demand, and a claim that refuses when the codebase is taken -
 * exactly the partial-unique behaviour the real repository gets from postgres.
 */
class MemoryAgents implements AgentRepository {
  public readonly restamped: { agentSessionId: string; agentId: string }[] = [];
  public readonly retired: string[] = [];
  public readonly upserts: UpsertAgentForKey[] = [];

  public constructor(public rows: AgentRecord[] = []) {}

  public async upsertForKey(input: UpsertAgentForKey): Promise<{ id: string }> {
    this.upserts.push(input);
    const existing = this.rows.find((row) => row.status !== "retired"
      && row.owner.id === input.ownerUserId
      && row.source === input.source
      && row.repoRoot === input.repoRoot);
    if (existing !== undefined) return { id: existing.id };
    const minted = agentRecord({ id: crypto.randomUUID(), repoRoot: input.repoRoot, name: input.name });
    this.rows.push(minted);
    return { id: minted.id };
  }

  public async findById(_current: AuthenticatedSubject, agentId: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.id === agentId) ?? null;
  }

  public async claimRepoRoot(_organizationId: string, agentId: string, repoRoot: string): Promise<boolean> {
    const row = this.rows.find((entry) => entry.id === agentId);
    if (row === undefined || row.repoRoot !== null) return false;
    const taken = this.rows.some((entry) => entry.status !== "retired"
      && entry.owner.id === row.owner.id && entry.source === row.source && entry.repoRoot === repoRoot);
    if (taken) return false;
    row.repoRoot = repoRoot;
    return true;
  }

  public async restampSession(_organizationId: string, agentSessionId: string, agentId: string): Promise<void> {
    this.restamped.push({ agentSessionId, agentId });
  }

  public async retireIfSessionless(_organizationId: string, agentId: string): Promise<boolean> {
    this.retired.push(agentId);
    const row = this.rows.find((entry) => entry.id === agentId);
    if (row === undefined) return false;
    row.status = "retired";
    return true;
  }

  public async listForOrganization(): Promise<AgentRecord[]> { throw new Error("not used"); }
  public async update(): Promise<AgentRecord | null> { throw new Error("not used"); }
  public async merge(): Promise<void> { throw new Error("not used"); }
  public async listSessionsForAgent(): Promise<never> { throw new Error("not used"); }
}

class MemorySessions implements Pick<AgentSessionRepository, "stampAgent"> {
  public readonly stamped: { sessionId: string; agentId: string }[] = [];
  public async stampAgent(_current: AuthenticatedSubject, sessionId: string, agentId: string): Promise<void> {
    this.stamped.push({ sessionId, agentId });
  }
}

function graduate(agents: MemoryAgents, row: AgentSessionRecord, repoRoot: string) {
  const agentSessions = new MemorySessions();
  return {
    agentSessions,
    result: graduateAgentForSession(
      { agents, agentSessions: agentSessions as unknown as AgentSessionRepository },
      subject,
      row,
      "claude_code",
      repoRoot,
      now,
    ),
  };
}

describe("late repo discovery", () => {
  it("rule 1: names the codebase of a bucket that has none, keeping its id", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const row = session();

    await expect(graduate(agents, row, clockIn).result).resolves.toBe(ids.bucket);

    // The id never moved, so the hours, shifts, tokens and commits already on
    // it graduate with it and nothing has to be re-summed.
    expect(agents.rows[0]!.repoRoot).toBe(clockIn);
    expect(agents.restamped).toEqual([]);
    expect(agents.retired).toEqual([]);
  });

  it("rule 2: re-homes the shift when another agent already holds the codebase, and retires the emptied bucket", async () => {
    const agents = new MemoryAgents([
      agentRecord(),
      agentRecord({ id: ids.incumbent, repoRoot: clockIn, name: "Claude Code @ clock-in" }),
    ]);
    const row = session();

    await expect(graduate(agents, row, clockIn).result).resolves.toBe(ids.incumbent);

    expect(agents.restamped).toEqual([{ agentSessionId: ids.session, agentId: ids.incumbent }]);
    // A bucket left with nothing is retired; its history is empty by
    // construction, so retiring loses nothing.
    expect(agents.retired).toEqual([ids.bucket]);
    expect(row.agentId).toBe(ids.incumbent);
  });

  it("rule 3: re-homes only its own shift when the agent already graduated elsewhere", async () => {
    const agents = new MemoryAgents([agentRecord({ repoRoot: piggies, name: "Claude Code @ pocket-piggies" })]);
    const row = session();

    const graduated = await graduate(agents, row, clockIn).result;

    // The already-graduated agent keeps its codebase and its other shifts;
    // this shift alone moves onto find-or-create for the one named.
    expect(graduated).not.toBe(ids.bucket);
    expect(agents.rows[0]!.repoRoot).toBe(piggies);
    expect(agents.restamped).toEqual([{ agentSessionId: ids.session, agentId: graduated }]);
    // Only a bucket can be emptied this way, so nothing is retired here.
    expect(agents.retired).toEqual([]);
  });

  it("does nothing when the evidence names the codebase the agent already carries", async () => {
    const agents = new MemoryAgents([agentRecord({ repoRoot: clockIn })]);
    const row = session();

    await expect(graduate(agents, row, clockIn).result).resolves.toBe(ids.bucket);

    expect(agents.upserts).toEqual([]);
    expect(agents.restamped).toEqual([]);
  });

  it("late-mints straight onto the codebase for a shift that never got an identity", async () => {
    const agents = new MemoryAgents();
    const row = session({ agentId: null });

    const { agentSessions, result } = graduate(agents, row, clockIn);
    const minted = await result;

    expect(agents.upserts[0]).toMatchObject({ repoRoot: clockIn, ownerUserId: ids.user });
    expect(agentSessions.stamped).toEqual([{ sessionId: ids.session, agentId: minted }]);
    expect(row.agentId).toBe(minted);
  });

  it("an operator's shared bucket graduates once, then re-homes each later repo's own shift", async () => {
    // The old-installer path: every shift starts repo-less in one bucket.
    const agents = new MemoryAgents([agentRecord()]);
    const first = session({ id: "s1", externalSessionId: "ext-1" });
    const second = session({ id: "s2", externalSessionId: "ext-2" });

    const bucketGraduated = await graduate(agents, first, clockIn).result;
    const rehomed = await graduate(agents, second, piggies).result;

    expect(bucketGraduated).toBe(ids.bucket);
    expect(rehomed).not.toBe(ids.bucket);
    expect(agents.restamped).toEqual([{ agentSessionId: "s2", agentId: rehomed }]);
  });

  it("mints nothing for a source that is not on the roster", async () => {
    const agents = new MemoryAgents();
    const agentSessions = new MemorySessions();

    await expect(graduateAgentForSession(
      { agents, agentSessions: agentSessions as unknown as AgentSessionRepository },
      subject,
      session({ source: "browser", agentId: null }),
      "browser",
      clockIn,
      now,
    )).resolves.toBeNull();
    expect(agents.upserts).toEqual([]);
  });
});
