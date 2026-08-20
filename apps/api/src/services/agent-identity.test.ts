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
import { identityRepoRoot } from "./attribution.js";

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
/** What a gate run checks out: a directory named after the run, not a codebase. */
const gateWorktree = "C:/Users/alex/.no-mistakes/repos/3245fe18a7c8.git/worktrees/01M06FSGP392MH6VJNRX8T364A";

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const record: AgentRecord = {
    id: ids.bucket,
    organizationId: ids.organization,
    name: "Claude Code @ unassigned",
    source: "claude_code",
    status: "anonymous",
    owner: { id: ids.user, name: "Alex" },
    project: null,
    repoRoot: null,
    repoKey: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
  // A fixture that names a root carries the key that root implies, the way
  // upsertForKey composes one - so `repoKey` is never null on a row that knows
  // its repository, which is exactly what "is this the bucket?" reads.
  return record.repoKey === null && record.repoRoot !== null
    ? { ...record, repoKey: `path:${record.repoRoot}` }
    : record;
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
 * that mints on demand, and a bucket that keeps its row while a shift is still
 * in it - exactly the behaviour the real repository gets from postgres.
 */
class MemoryAgents implements AgentRepository {
  public readonly restamped: { agentSessionId: string; agentId: string }[] = [];
  public readonly retired: string[] = [];
  public readonly upserts: UpsertAgentForKey[] = [];

  public constructor(public rows: AgentRecord[] = [], private readonly sessions: AgentSessionRecord[] = []) {}

  public async upsertForKey(input: UpsertAgentForKey): Promise<{ id: string }> {
    this.upserts.push(input);
    // The real door normalizes a root that names no codebase away before it
    // keys on one, so this does too: otherwise a per-run worktree mints an
    // identity here that postgres would never have created.
    const repoRoot = identityRepoRoot(input.repoRoot);
    const existing = this.rows.find((row) => row.status !== "retired"
      && row.owner.id === input.ownerUserId
      && row.source === input.source
      && row.repoRoot === repoRoot);
    if (existing !== undefined) return { id: existing.id };
    const minted = agentRecord({ id: crypto.randomUUID(), repoRoot, name: input.name });
    this.rows.push(minted);
    return { id: minted.id };
  }

  public async findById(_current: AuthenticatedSubject, agentId: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.id === agentId) ?? null;
  }

  public async restampSession(_organizationId: string, agentSessionId: string, agentId: string): Promise<void> {
    this.restamped.push({ agentSessionId, agentId });
  }

  public async retireIfSessionless(_organizationId: string, agentId: string): Promise<boolean> {
    this.retired.push(agentId);
    // The real update carries a NOT EXISTS on agent_sessions and an
    // 'anonymous' status predicate, so a bucket that still holds a shift keeps
    // its row and one a member named is never retired at all.
    if (this.sessions.some((row) => row.agentId === agentId)) return false;
    const row = this.rows.find((entry) => entry.id === agentId);
    if (row === undefined || row.status !== "anonymous") return false;
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
  // The bucket pools every shift whose directory named no codebase, gate runs
  // included, so promoting the row would attribute all that unrelated time to
  // whichever codebase committed first. Only the claiming shift moves.
  it("re-homes the shift onto the codebase its commit names, leaving the bucket unkeyed", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const row = session();

    const graduated = await graduate(agents, row, clockIn).result;

    expect(graduated).not.toBe(ids.bucket);
    expect(agents.rows[0]!.repoRoot).toBeNull();
    expect(agents.restamped).toEqual([{ agentSessionId: ids.session, agentId: graduated }]);
    expect(row.agentId).toBe(graduated);
    // Emptied by that move, so the bucket is retired; its history is empty by
    // construction, and the operator's next un-probed shift mints a fresh one.
    expect(agents.rows[0]!.status).toBe("retired");
  });

  // Naming an agent registers it in the same write, so a registered bucket is
  // one a member named. Emptying it must not take that name off the roster.
  it("keeps a bucket a member named when its last shift graduates away", async () => {
    const agents = new MemoryAgents([agentRecord({ status: "registered", name: "Alex's helper" })]);
    const row = session();

    const graduated = await graduate(agents, row, clockIn).result;

    expect(graduated).not.toBe(ids.bucket);
    expect(row.agentId).toBe(graduated);
    expect(agents.rows[0]).toMatchObject({ id: ids.bucket, name: "Alex's helper", status: "registered" });
  });

  it("moves only the shift whose commit named a codebase, leaving the bucket's others where they are", async () => {
    const first = session({ id: "s1", externalSessionId: "ext-1" });
    const second = session({ id: "s2", externalSessionId: "ext-2" });
    const agents = new MemoryAgents([agentRecord()], [first, second]);

    const graduated = await graduate(agents, first, clockIn).result;

    expect(first.agentId).toBe(graduated);
    // The gate runs and un-probed shifts pooled here never touched clock-in.
    expect(second.agentId).toBe(ids.bucket);
    expect(agents.rows[0]!.repoRoot).toBeNull();
    expect(agents.rows[0]!.status).toBe("anonymous");
  });

  it("re-homes the shift when another agent already holds the codebase, and retires the emptied bucket", async () => {
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

  it("re-homes only its own shift when the agent already graduated elsewhere", async () => {
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

  it("graduates each of an operator's pooled shifts onto its own codebase, one commit at a time", async () => {
    // The old-installer path: every shift starts repo-less in one bucket.
    const first = session({ id: "s1", externalSessionId: "ext-1" });
    const second = session({ id: "s2", externalSessionId: "ext-2" });
    const agents = new MemoryAgents([agentRecord()], [first, second]);

    const firstHome = await graduate(agents, first, clockIn).result;
    const secondHome = await graduate(agents, second, piggies).result;

    expect(firstHome).not.toBe(ids.bucket);
    expect(secondHome).not.toBe(ids.bucket);
    expect(firstHome).not.toBe(secondHome);
    expect(agents.restamped).toEqual([
      { agentSessionId: "s1", agentId: firstHome },
      { agentSessionId: "s2", agentId: secondHome },
    ]);
  });

  // Evidence naming a per-run worktree must never cost a shift its identity:
  // the caller rejects a commit whose shift has none, and its uploader treats
  // that rejection as permanent, so the evidence would be dropped for good.
  it("parks an unstamped shift in the unassigned bucket when the evidence names only a run", async () => {
    const agents = new MemoryAgents();
    const row = session({ agentId: null });

    const { agentSessions, result } = graduate(agents, row, gateWorktree);
    const minted = await result;

    expect(minted).not.toBeNull();
    // The bucket, not a row named after the run - and the shift is stamped
    // with it, so its commit records against a real identity.
    expect(agents.rows[0]!.repoRoot).toBeNull();
    expect(agentSessions.stamped).toEqual([{ sessionId: ids.session, agentId: minted }]);
    expect(row.agentId).toBe(minted);
  });

  it("leaves a stamped shift where it is rather than re-homing it onto a run directory", async () => {
    const agents = new MemoryAgents([agentRecord()]);
    const row = session();

    await expect(graduate(agents, row, gateWorktree).result).resolves.toBe(ids.bucket);

    // The bucket never takes the run's directory as its codebase, and no
    // second identity is minted for it either.
    expect(agents.rows).toHaveLength(1);
    expect(agents.rows[0]!.repoRoot).toBeNull();
    expect(agents.upserts).toEqual([]);
    expect(agents.restamped).toEqual([]);
  });

  // A commit names a directory and nothing else, so this lane can only ever
  // mint a path key - which is precisely the identity the remote replaced.
  // Re-homing onto it would split one repository back across its worktrees,
  // one commit at a time, and the roster would refill with the rows the repair
  // script had just folded together.
  it("keeps a shift on its remote-keyed agent when a commit names another worktree", async () => {
    const agents = new MemoryAgents([agentRecord({
      id: ids.incumbent,
      repoRoot: clockIn,
      repoKey: "github.com/acme/clock-in",
      name: "Claude Code @ clock-in",
    })]);
    const row = session({ agentId: ids.incumbent });

    await expect(graduate(agents, row, "C:/w/clock-in-fix-login").result).resolves.toBe(ids.incumbent);

    expect(agents.upserts).toEqual([]);
    expect(agents.restamped).toEqual([]);
    expect(agents.rows).toHaveLength(1);
    expect(row.agentId).toBe(ids.incumbent);
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
