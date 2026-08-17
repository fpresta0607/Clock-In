import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentRecord,
  AgentRepository,
  AgentSessionRecord,
  AgentSessionRepository,
  AgentShiftRecord,
  AgentUpdatePatch,
  InsertShiftCommit,
  ReportQuery,
  ShiftCommitCountsRecord,
  ShiftCommitRecord,
  ShiftCommitRepository,
  ShiftCommitVerificationState,
  ShiftRepoRootRecord,
  UpsertAgentForKey,
} from "../repositories.js";
import { unknownSessionReason, createShiftCommitService, type ShiftCommitServiceDependencies } from "./shift-commits.js";

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

class MemoryShiftCommits implements ShiftCommitRepository {
  public readonly records: ShiftCommitRecord[] = [];
  public readonly advances: { commitId: string; verification: string }[] = [];
  /** Stands in for a row the database itself refuses: a check or a foreign key. */
  public rejectSha: string | undefined;

  public async findByClientId(current: AuthenticatedSubject, clientId: string): Promise<ShiftCommitRecord | null> {
    return this.records.find((row) => row.organizationId === current.organizationId
      && row.userId === current.userId && row.clientId === clientId) ?? null;
  }

  public async insert(input: InsertShiftCommit): Promise<"inserted" | "duplicate"> {
    if (this.rejectSha !== undefined && input.sha === this.rejectSha) {
      throw Object.assign(new Error("check constraint violated"), { code: "23514" });
    }
    const clientDuplicate = this.records.some((row) => row.organizationId === input.organizationId
      && row.userId === input.userId && row.clientId === input.clientId);
    const agentShaDuplicate = this.records.some((row) => row.organizationId === input.organizationId
      && row.agentId === input.agentId && row.repoRoot === input.repoRoot && row.sha === input.sha);
    if (clientDuplicate || agentShaDuplicate) return "duplicate";
    this.records.push({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      agentId: input.agentId,
      agentSessionId: input.agentSessionId,
      clientId: input.clientId,
      repoRoot: input.repoRoot,
      branch: input.branch,
      sha: input.sha,
      subject: input.subject,
      authoredAt: input.authoredAt,
      verification: input.verification,
      verifiedAt: input.verifiedAt,
    });
    return "inserted";
  }

  public async advanceVerification(
    current: AuthenticatedSubject,
    commitId: string,
    verification: Exclude<ShiftCommitVerificationState, "pending">,
    verifiedAt: Date,
  ): Promise<boolean> {
    const record = this.records.find((row) => row.organizationId === current.organizationId && row.id === commitId);
    if (record === undefined || record.verification !== "pending") return false;
    this.advances.push({ commitId, verification });
    record.verification = verification;
    record.verifiedAt = verifiedAt;
    return true;
  }

  public async countsByAgent(): Promise<ShiftCommitCountsRecord[]> { throw new Error("not used"); }
  public async repoRootsByAgent(): Promise<ShiftRepoRootRecord[]> { throw new Error("not used"); }
  public async listForAgent(): Promise<ShiftCommitRecord[]> { throw new Error("not used"); }
}

function commitUpload(overrides: Record<string, unknown> = {}) {
  return {
    clientId: crypto.randomUUID(),
    source: "claude_code",
    externalSessionId: "ext-1",
    repoRoot: "C:/dev/clock-in",
    branch: "feat/roster",
    sha: "a".repeat(40),
    subject: "feat(api): shift commits",
    authoredAt: "2026-08-06T10:30:00.000Z",
    verification: "pending" as const,
    ...overrides,
  };
}

function createService(overrides: Partial<ShiftCommitServiceDependencies> = {}) {
  const shiftCommits = overrides.shiftCommits ?? new MemoryShiftCommits();
  const agentSessions = overrides.agentSessions ?? new MemoryAgentSessions([sessionRecord()]);
  const service = createShiftCommitService({
    shiftCommits,
    agentSessions,
    clock: () => now,
    ...overrides,
  });
  return { service, shiftCommits: shiftCommits as MemoryShiftCommits, agentSessions: agentSessions as MemoryAgentSessions };
}

describe("shift-commit service", () => {
  it("replays accepted: same commit uploaded twice is accepted once", async () => {
    const { service, shiftCommits } = createService();
    const commit = commitUpload();

    await service.ingest(subject, [commit]);
    const replay = await service.ingest(subject, [commit]);

    expect(replay).toEqual({ accepted: 1, rejected: [] });
    expect(shiftCommits.records).toHaveLength(1);
  });

  it("rejects a commit whose shift has not landed yet, retryable as unknown_session", async () => {
    const { service } = createService({ agentSessions: new MemoryAgentSessions([]) });
    const commit = commitUpload();

    const result = await service.ingest(subject, [commit]);

    expect(result).toEqual({ accepted: 0, rejected: [{ clientId: commit.clientId, reason: unknownSessionReason }] });
  });

  it("records the same agent's same sha once, even across two client uploads", async () => {
    const { service, shiftCommits } = createService();
    const sha = "b".repeat(40);

    const first = await service.ingest(subject, [commitUpload({ sha })]);
    const second = await service.ingest(subject, [commitUpload({ sha })]);

    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(1);
    expect(shiftCommits.records.filter((row) => row.sha === sha)).toHaveLength(1);
  });

  it("records the same sha twice when two different agents recorded it", async () => {
    const sessions = new MemoryAgentSessions([
      sessionRecord({ id: "d1c7e513-b094-4d4c-ae55-21790ae019a4", externalSessionId: "ext-1", agentId: ids.agent }),
      sessionRecord({ id: "d2c7e513-b094-4d4c-ae55-21790ae019a4", externalSessionId: "ext-2", agentId: ids.otherAgent }),
    ]);
    const { service, shiftCommits } = createService({ agentSessions: sessions });
    const sha = "c".repeat(40);

    await service.ingest(subject, [commitUpload({ sha, externalSessionId: "ext-1" })]);
    await service.ingest(subject, [commitUpload({ sha, externalSessionId: "ext-2" })]);

    expect(shiftCommits.records.filter((row) => row.sha === sha)).toHaveLength(2);
  });

  it("advances pending to a decided verification, but a decided row never moves again", async () => {
    const { service, shiftCommits } = createService();
    const commit = commitUpload();
    await service.ingest(subject, [commit]);

    await service.ingest(subject, [commitUpload({
      ...commit,
      verification: "merged",
      verifiedAt: "2026-08-06T13:00:00.000Z",
    })]);
    expect(shiftCommits.records[0]).toMatchObject({ verification: "merged" });

    // A later replay carrying "reverted" for an already-merged row is a no-op.
    await service.ingest(subject, [commitUpload({
      ...commit,
      verification: "reverted",
      verifiedAt: "2026-08-06T13:30:00.000Z",
    })]);
    expect(shiftCommits.records[0]).toMatchObject({ verification: "merged" });
  });

  it("stamps a null-agentId session so pre-feature shifts still take commits", async () => {
    const sessions = new MemoryAgentSessions([sessionRecord({ agentId: null })]);
    const agents = new MemoryAgents();
    const { service, shiftCommits } = createService({ agentSessions: sessions, agents });

    await service.ingest(subject, [commitUpload()]);

    expect(agents.upserts).toHaveLength(1);
    expect(sessions.stamps).toEqual([{ sessionId: ids.session, agentId: ids.otherAgent }]);
    expect(shiftCommits.records[0]).toMatchObject({ agentId: ids.otherAgent });
  });

  // A gate run commits from a worktree named after the run. That names no
  // codebase, but the shift still has to come out of graduation with an
  // identity: the rejection below is permanent to the uploader, so returning
  // none here would drop the commit for good instead of parking it.
  it("keeps the commit of an unstamped shift whose only evidence names a run", async () => {
    const sessions = new MemoryAgentSessions([sessionRecord({ agentId: null })]);
    const agents = new MemoryAgents();
    const { service, shiftCommits } = createService({ agentSessions: sessions, agents });
    const repoRoot = "C:/Users/alex/.no-mistakes/repos/3245fe18a7c8.git/worktrees/01M06FSGP392MH6VJNRX8T364A";

    const result = await service.ingest(subject, [commitUpload({ repoRoot })]);

    expect(result).toEqual({ accepted: 1, rejected: [] });
    expect(sessions.stamps).toEqual([{ sessionId: ids.session, agentId: ids.otherAgent }]);
    expect(shiftCommits.records[0]).toMatchObject({ agentId: ids.otherAgent, repoRoot });
  });

  it("rejects a commit whose verifiedAt presence disagrees with its verification", async () => {
    const { service } = createService();

    const withoutVerifiedAt = await service.ingest(subject, [commitUpload({ verification: "merged" })]);
    expect(withoutVerifiedAt.rejected).toHaveLength(1);

    const withVerifiedAt = await service.ingest(subject, [commitUpload({ verifiedAt: "2026-08-06T13:00:00.000Z" })]);
    expect(withVerifiedAt.rejected).toHaveLength(1);
  });

  // A payroll timestamp with no sanity bound could be stamped in any year the
  // client liked; a verification happens after its commit and by now.
  it("rejects a verifiedAt outside the commit's own lifetime", async () => {
    const { service, shiftCommits } = createService();

    const inTheFuture = await service.ingest(subject, [commitUpload({
      verification: "merged",
      verifiedAt: "2099-01-01T00:00:00.000Z",
    })]);
    expect(inTheFuture.rejected).toEqual([{ clientId: expect.any(String), reason: "verifiedAt is out of bounds" }]);

    const beforeTheCommit = await service.ingest(subject, [commitUpload({
      verification: "merged",
      verifiedAt: "2019-01-01T00:00:00.000Z",
    })]);
    expect(beforeTheCommit.rejected).toHaveLength(1);
    expect(shiftCommits.records).toHaveLength(0);

    // Clock skew between two machines is not a forgery: a few hours either
    // way still records.
    const skewed = await service.ingest(subject, [commitUpload({
      verification: "merged",
      verifiedAt: "2026-08-06T09:00:00.000Z",
    })]);
    expect(skewed).toEqual({ accepted: 1, rejected: [] });
  });

  // README: "per-row refusals never fail a batch". A 500 here would wedge the
  // client, which replays the identical batch every five minutes forever.
  it("rejects one row the database refuses without failing the rest of the batch", async () => {
    const shiftCommits = new MemoryShiftCommits();
    const poison = commitUpload({ sha: "b".repeat(40) });
    shiftCommits.rejectSha = "b".repeat(40);
    const { service } = createService({ shiftCommits });

    const outcome = await service.ingest(subject, [commitUpload(), poison, commitUpload({ sha: "c".repeat(40) })]);

    expect(outcome.accepted).toBe(2);
    expect(outcome.rejected).toEqual([{ clientId: poison.clientId, reason: "the commit could not be recorded" }]);
    expect(shiftCommits.records.map((record) => record.sha)).toEqual(["a".repeat(40), "c".repeat(40)]);
  });
});
