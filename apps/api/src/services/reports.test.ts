import { describe, expect, it } from "vitest";
import type { ReportFilters } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentIntervalRecord,
  AgentRecord,
  AgentRepository,
  AgentShiftRecord,
  AppTotalRecord,
  LeaderboardRowRecord,
  PresenceIntervalRecord,
  ProjectTotalRecord,
  ReportPageOptions,
  ReportQuery,
  ReportRepository,
  ReportRowRecord,
  SessionIntervalRecord,
  ShiftCommitCountsRecord,
  ShiftCommitRepository,
  SiteTotalRecord,
} from "../repositories.js";
import { createReportService } from "./reports.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  session: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherAgent: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user, role: "member" };

function row(overrides: Partial<ReportRowRecord> = {}): ReportRowRecord {
  return {
    id: ids.session,
    user: { id: ids.user, name: "Alex" },
    project: { id: ids.project, name: "Timer" },
    description: "Focused work",
    status: "stopped",
    startedAt: new Date("2026-08-06T14:00:00.000Z"),
    stoppedAt: new Date("2026-08-06T15:00:00.000Z"),
    idleSeconds: 60,
    durationSeconds: 3_540,
    attribution: "agent",
    ...overrides,
  };
}

/** Records every reap so tests can prove read paths close stale agent sessions first. */
class Reaper {
  public readonly subjects: AuthenticatedSubject[] = [];
  public async reapStale(subject: AuthenticatedSubject) {
    this.subjects.push(subject);
    return 0;
  }
}

const silentReaper = { reapStale: async () => 0 };

class Reports implements ReportRepository {
  public lastPage: { query: Parameters<ReportRepository["readPageForOrganization"]>[1]; options: ReportPageOptions } | null = null;
  public lastLeaderboardQuery: ReportQuery | null = null;
  public lastProjectTotalsQuery: ReportQuery | null = null;
  public lastAppTotalsQuery: ReportQuery | null = null;
  public lastSiteTotalsQuery: ReportQuery | null = null;
  public exportReads = 0;
  public leaderboardRows: LeaderboardRowRecord[] = [];
  public projectTotals: ProjectTotalRecord[] = [];
  public appTotals: AppTotalRecord[] = [];
  public siteTotals: SiteTotalRecord[] = [];
  public presenceIntervals: PresenceIntervalRecord[] = [];
  public sessionIntervals: SessionIntervalRecord[] = [];
  public agentIntervals: AgentIntervalRecord[] = [];
  public constructor(private readonly rows: ReportRowRecord[] = [], private readonly accessible = new Set([ids.project, ids.user])) {}
  public async readLeaderboardForOrganization(_subject: AuthenticatedSubject, query: ReportQuery) {
    this.lastLeaderboardQuery = query;
    return this.leaderboardRows;
  }
  public roster: { id: string; name: string }[] = [];
  public async readMembersForOrganization() {
    return this.roster;
  }
  public async readProjectTotalsForMember(_subject: AuthenticatedSubject, query: ReportQuery) {
    this.lastProjectTotalsQuery = query;
    return this.projectTotals;
  }
  public async readAppTotalsForMember(_subject: AuthenticatedSubject, query: ReportQuery) {
    this.lastAppTotalsQuery = query;
    return this.appTotals;
  }
  public async readSiteTotalsForMember(_subject: AuthenticatedSubject, query: ReportQuery) {
    this.lastSiteTotalsQuery = query;
    return this.siteTotals;
  }
  public async readPresenceIntervals(_subject: AuthenticatedSubject, query: ReportQuery) {
    return this.presenceIntervals.filter((row) => query.userId === undefined || row.user.id === query.userId);
  }
  public async readSessionIntervals(_subject: AuthenticatedSubject, query: ReportQuery) {
    return this.sessionIntervals.filter((row) => query.userId === undefined || row.user.id === query.userId);
  }
  public async readAgentIntervals(_subject: AuthenticatedSubject, query: ReportQuery) {
    return this.agentIntervals.filter((row) =>
      (query.userId === undefined || row.user.id === query.userId)
      && (query.projectId === undefined || row.projectId === query.projectId)
      && (query.unassignedOnly !== true || row.projectId === null)
    );
  }
  public async findProjectForOrganization(_subject: AuthenticatedSubject, projectId: string) {
    return this.accessible.has(projectId) ? { id: projectId, name: "Timer" } : null;
  }
  public async findUserForOrganization(_subject: AuthenticatedSubject, userId: string) {
    return this.accessible.has(userId) ? { id: userId, name: "Alex" } : null;
  }
  private summary() {
    return { totalRows: this.rows.length, totalDurationSeconds: this.rows.reduce((total, record) => total + record.durationSeconds, 0) };
  }
  public async readPageForOrganization(_subject: AuthenticatedSubject, query: Parameters<ReportRepository["readPageForOrganization"]>[1], options: ReportPageOptions) {
    this.lastPage = { query, options };
    return { summary: this.summary(), rows: this.rows.slice(options.offset, options.offset + options.limit) };
  }
  public async readExportForOrganization(_subject: AuthenticatedSubject, _query: Parameters<ReportRepository["readExportForOrganization"]>[1], _maxRows: number) {
    this.exportReads += 1;
    return { summary: this.summary(), rows: this.rows };
  }
}

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: ids.session,
    organizationId: ids.organization,
    name: "Claude Code @ Timer",
    source: "claude_code",
    status: "anonymous",
    owner: { id: ids.user, name: "Alex" },
    project: { id: ids.project, name: "Timer" },
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** The pay-run report's roster; empty by default so existing report/leaderboard/meStats tests are unaffected. */
class Agents implements AgentRepository {
  public constructor(public records: AgentRecord[] = []) {}
  public async upsertForKey(): Promise<{ id: string }> {
    throw new Error("not used");
  }
  public async listForOrganization(subject: AuthenticatedSubject): Promise<AgentRecord[]> {
    return this.records.filter((record) => record.organizationId === subject.organizationId);
  }
  public async findById(): Promise<AgentRecord | null> {
    throw new Error("not used");
  }
  public async update(): Promise<AgentRecord | null> {
    throw new Error("not used");
  }
  public async merge(): Promise<void> {
    throw new Error("not used");
  }
  public async listSessionsForAgent(): Promise<AgentShiftRecord[]> {
    throw new Error("not used");
  }
}

const agents = new Agents();

type CommitSeed = {
  userId: string;
  agentId: string;
  projectId: string | null;
  verification: "pending" | "merged" | "reverted" | "orphaned";
  authoredAt: Date;
};

class ShiftCommits implements ShiftCommitRepository {
  public lastCountsQuery: ReportQuery | null = null;
  public constructor(public commits: CommitSeed[] = []) {}
  public async findByClientId(): ReturnType<ShiftCommitRepository["findByClientId"]> {
    throw new Error("not used");
  }
  public async insert(): ReturnType<ShiftCommitRepository["insert"]> {
    throw new Error("not used");
  }
  public async advanceVerification(): ReturnType<ShiftCommitRepository["advanceVerification"]> {
    throw new Error("not used");
  }
  public async countsByAgent(_subject: AuthenticatedSubject, query: ReportQuery): Promise<ShiftCommitCountsRecord[]> {
    this.lastCountsQuery = query;
    const byAgent = new Map<string, ShiftCommitCountsRecord>();
    for (const commit of this.commits) {
      if (query.userId !== undefined && commit.userId !== query.userId) continue;
      if (query.projectId !== undefined && commit.projectId !== query.projectId) continue;
      if (query.unassignedOnly === true && commit.projectId !== null) continue;
      if (query.from !== undefined && commit.authoredAt < query.from) continue;
      if (query.toExclusive !== undefined && commit.authoredAt >= query.toExclusive) continue;
      const record = byAgent.get(commit.agentId) ?? {
        agentId: commit.agentId,
        recorded: 0,
        pending: 0,
        merged: 0,
        reverted: 0,
        orphaned: 0,
      };
      record.recorded += 1;
      if (commit.verification === "pending") record.pending += 1;
      else if (commit.verification === "merged") record.merged += 1;
      else if (commit.verification === "reverted") record.reverted += 1;
      else record.orphaned += 1;
      byAgent.set(commit.agentId, record);
    }
    return [...byAgent.values()];
  }
  public async listForAgent(): ReturnType<ShiftCommitRepository["listForAgent"]> {
    throw new Error("not used");
  }
}

const noMeasurement = {
  activeSeconds: 0,
  agentSeconds: 0,
  concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
  byAgent: [] as never[],
};

describe("report service", () => {
  it("scopes report queries to the authenticated organization and normalizes inclusive UTC calendar bounds", async () => {
    const reports = new Reports([row({ id: ids.otherProject, durationSeconds: 60, startedAt: new Date("2026-08-06T16:00:00.000Z") }), row()]);
    const service = createReportService({ reports, reaper: silentReaper, agents });

    await expect(service.list(subject, { from: "2026-08-01", to: "2026-08-06", projectId: ids.project, userId: ids.user, page: 1, pageSize: 50 })).resolves.toMatchObject({
      filters: { from: "2026-08-01", to: "2026-08-06", projectId: ids.project, userId: ids.user, page: 1, pageSize: 50 },
      totalDurationSeconds: 3_600,
      rows: [{ id: ids.otherProject }, { id: ids.session }],
    });
    expect(reports.lastPage).toEqual({
      query: {
        from: new Date("2026-08-01T00:00:00.000Z"),
        toExclusive: new Date("2026-08-07T00:00:00.000Z"),
        projectId: ids.project,
        userId: ids.user,
      },
      options: { limit: 50, offset: 0 },
    });
  });

  it("returns an empty report with a zero total", async () => {
    await expect(createReportService({ reports: new Reports(), reaper: silentReaper, agents }).list(subject, { page: 1, pageSize: 50 })).resolves.toEqual({ filters: { page: 1, pageSize: 50 }, totalDurationSeconds: 0, pagination: { page: 1, pageSize: 50, totalRows: 0, totalPages: 0 }, rows: [] });
  });

  it("passes device-local instant bounds as an exact clipped report range", async () => {
    const reports = new Reports([row()]);
    const service = createReportService({ reports, reaper: silentReaper, agents });

    const result = await service.list(subject, {
      fromAt: "2026-03-08T06:00:00.000Z",
      toExclusiveAt: "2026-03-09T05:00:00.000Z",
      page: 1,
      pageSize: 50,
    });

    expect(result.filters).toMatchObject({
      fromAt: "2026-03-08T06:00:00.000Z",
      toExclusiveAt: "2026-03-09T05:00:00.000Z",
    });
    expect(reports.lastPage?.query).toEqual({
      from: new Date("2026-03-08T06:00:00.000Z"),
      toExclusive: new Date("2026-03-09T05:00:00.000Z"),
    });
  });

  it("rejects reversed or excessive date ranges", async () => {
    const service = createReportService({ reports: new Reports(), reaper: silentReaper, agents });
    await expect(service.list(subject, { from: "2026-08-07", to: "2026-08-06", page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "validation_error" });
    await expect(service.list(subject, { from: "2025-01-01", to: "2026-01-02", page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("defends the repository from pathological page offsets", async () => {
    const service = createReportService({ reports: new Reports(), reaper: silentReaper, agents });
    await expect(service.list(subject, { page: 10_001, pageSize: 1 } as ReportFilters)).rejects.toMatchObject({ code: "validation_error" });
  });

  it("returns stable not_found for project and user filters outside the subject organization", async () => {
    const service = createReportService({ reports: new Reports([], new Set()), reaper: silentReaper, agents });
    await expect(service.list(subject, { projectId: ids.otherProject, page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "not_found", message: "Project not found." });
    await expect(service.list(subject, { userId: ids.otherUser, page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "not_found", message: "User not found." });
  });

  it("rejects unsafe report duration totals", async () => {
    const service = createReportService({ reports: new Reports([row({ durationSeconds: Number.MAX_SAFE_INTEGER }), row({ id: ids.otherProject, durationSeconds: 1 })]), reaper: silentReaper, agents });
    await expect(service.list(subject, { page: 1, pageSize: 50 })).rejects.toThrow(RangeError);
  });

  it("uses the exact filtered summary while returning only the requested deterministic page", async () => {
    const reports = new Reports([
      row({ id: "b1c7e513-b094-4d4c-ae55-21790ae019a4", startedAt: new Date("2026-08-06T14:00:00.000Z") }),
      row({ id: "a1c7e513-b094-4d4c-ae55-21790ae019a4", startedAt: new Date("2026-08-06T14:00:00.000Z"), durationSeconds: 60 }),
    ]);
    const result = await createReportService({ reports, reaper: silentReaper, agents }).list(subject, { page: 2, pageSize: 1 });

    expect(result).toMatchObject({
      totalDurationSeconds: 3_600,
      pagination: { page: 2, pageSize: 1, totalRows: 2, totalPages: 2 },
      rows: [{ id: "a1c7e513-b094-4d4c-ae55-21790ae019a4" }],
    });
  });

  it("uses one snapshot read for export and rejects an oversized export before row materialization", async () => {
    const oversized = new Reports();
    oversized.readExportForOrganization = async () => {
      oversized.exportReads += 1;
      return { summary: { totalRows: 10_001, totalDurationSeconds: 0 }, rows: [] };
    };
    const oversizedService = createReportService({ reports: oversized, reaper: silentReaper, agents });
    await expect(oversizedService.export(subject, { page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "validation_error" });
    expect(oversized.exportReads).toBe(1);

    const exported = new Reports([row()]);
    const exportService = createReportService({ reports: exported, reaper: silentReaper, agents });
    const result = await exportService.export(subject, { page: 1, pageSize: 50 });
    expect(result.rows).toHaveLength(1);
    expect(exported.exportReads).toBe(1);
  });

  it("closes stale agent sessions before every report aggregation", async () => {
    const reaper = new Reaper();
    const service = createReportService({ reports: new Reports(), reaper, agents });

    await service.list(subject, { page: 1, pageSize: 50 });
    await service.export(subject, { page: 1, pageSize: 50 });
    await service.leaderboard(subject, {});
    await service.meStats(subject, {});

    expect(reaper.subjects).toEqual([subject, subject, subject, subject]);
  });

  it("splits each row into attributed and unattributed by how it learned its project", async () => {
    const reports = new Reports([
      row({ attribution: "agent" }),
      row({ id: ids.otherProject, attribution: "default" }),
      row({ id: ids.session, attribution: "manual" }),
    ]);
    const result = await createReportService({ reports, reaper: silentReaper, agents }).list(subject, { page: 1, pageSize: 50 });

    expect(result.rows.map((record) => [record.attributedSeconds, record.unattributedSeconds])).toEqual([
      [3_540, 0],
      [0, 3_540],
      [3_540, 0],
    ]);
  });

  it("never lets a row's two halves disagree with its duration", async () => {
    const reports = new Reports([row({ durationSeconds: 3_540, attribution: "default" })]);
    const result = await createReportService({ reports, reaper: silentReaper, agents }).list(subject, { page: 1, pageSize: 50 });

    const [only] = result.rows;
    expect((only?.attributedSeconds ?? 0) + (only?.unattributedSeconds ?? 0)).toBe(only?.durationSeconds);
  });
});

describe("leaderboard", () => {
  const entry = (id: string, name: string, durationSeconds: number | string | null, sessionCount: number, attributedSeconds: number | string | null = 0): LeaderboardRowRecord => ({
    user: { id, name },
    durationSeconds,
    sessionCount,
    attributedSeconds,
  });

  it("ranks members by recorded time and totals the organization", async () => {
    const reports = new Reports();
    reports.leaderboardRows = [
      entry(ids.user, "Alex", 7_200, 3, 5_400),
      entry(ids.otherUser, "Sam", 3_600, 1, "3600"),
    ];
    const service = createReportService({ reports, reaper: silentReaper, agents });

    const result = await service.leaderboard(subject, {});

    expect(result.entries).toEqual([
      { rank: 1, user: { id: ids.user, name: "Alex" }, durationSeconds: 7_200, sessionCount: 3, attributedSeconds: 5_400, unattributedSeconds: 1_800, ...noMeasurement },
      { rank: 2, user: { id: ids.otherUser, name: "Sam" }, durationSeconds: 3_600, sessionCount: 1, attributedSeconds: 3_600, unattributedSeconds: 0, ...noMeasurement },
    ]);
    expect(result.totalDurationSeconds).toBe(10_800);
    expect(result.medianSessionSeconds).toBeNull();
  });

  it("ranks by active wall-clock time and keeps agent parallelism out of the hours", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    reports.leaderboardRows = [
      entry(ids.user, "Alex", 3_600, 1, 3_600),
      entry(ids.otherUser, "Sam", 7_200, 2, 7_200),
    ];
    // Alex: present two hours straight, three agents in parallel for the first.
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(11) },
      { user: { id: ids.otherUser, name: "Sam" }, startedAt: hour(9), endedAt: hour(10) },
    ];
    reports.sessionIntervals = [
      { user: { id: ids.user, name: "Alex" }, projectId: ids.project, attribution: "agent", startedAt: hour(9), stoppedAt: hour(11) },
      { user: { id: ids.otherUser, name: "Sam" }, projectId: ids.project, attribution: "selected", startedAt: hour(9), stoppedAt: hour(10) },
    ];
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, projectId: ids.project, startedAt: hour(9), endedAt: hour(10) },
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, projectId: ids.project, startedAt: hour(9), endedAt: hour(10) },
      { user: { id: ids.user, name: "Alex" }, source: "codex", model: null, projectId: ids.project, startedAt: hour(9), endedAt: hour(10) },
    ];
    const service = createReportService({ reports, reaper: silentReaper, agents });

    const result = await service.leaderboard(subject, {});

    // Alex worked 2h of wall clock; 3h of agent runtime never inflates it.
    const [alex, sam] = result.entries;
    expect(alex?.user.name).toBe("Alex");
    expect(alex?.rank).toBe(1);
    expect(alex?.activeSeconds).toBe(7_200);
    expect(alex?.agentSeconds).toBe(10_800);
    expect(alex?.concurrency).toEqual({ t0Seconds: 3_600, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 3_600, awaySeconds: 0 });
    // The by-agent split sums to agent time, never to active time.
    expect(alex?.byAgent).toEqual([
      { source: "claude_code", model: null, durationSeconds: 7_200, sessionCount: 2, maxConcurrent: 2, medianSeconds: 3_600 },
      { source: "codex", model: null, durationSeconds: 3_600, sessionCount: 1, maxConcurrent: 1, medianSeconds: 3_600 },
    ]);
    expect(sam?.rank).toBe(2);
    expect(sam?.activeSeconds).toBe(3_600);
    expect(result.medianSessionSeconds).toBe(5_400);
  });

  it("shares a rank between members with identical totals", async () => {
    const reports = new Reports();
    reports.leaderboardRows = [
      entry(ids.user, "Alex", 3_600, 2),
      entry(ids.otherUser, "Sam", 3_600, 1),
      entry(ids.project, "Jo", 60, 1),
    ];
    const service = createReportService({ reports, reaper: silentReaper, agents });

    const result = await service.leaderboard(subject, {});

    expect(result.entries.map((row) => row.rank)).toEqual([1, 1, 3]);
  });

  it("lists every member on a scoped board, at zero when the scope has none of their time", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    // Alex worked in the scoped project; Sam only had the machine on.
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(10) },
      { user: { id: ids.otherUser, name: "Sam" }, startedAt: hour(9), endedAt: hour(11) },
    ];
    reports.sessionIntervals = [
      { user: { id: ids.user, name: "Alex" }, projectId: ids.project, attribution: "selected", startedAt: hour(9), stoppedAt: hour(10) },
    ];
    const service = createReportService({ reports, reaper: silentReaper, agents });

    const result = await service.leaderboard(subject, { scope: ids.project });

    // A teammate outside the scope reads as a zero row, never as missing.
    expect(result.entries.map((entry) => [entry.user.name, entry.activeSeconds])).toEqual([
      ["Alex", 3_600],
      ["Sam", 0],
    ]);
    expect(reports.lastLeaderboardQuery?.projectId).toBe(ids.project);
  });

  it("lists a roster member with no recorded time at all as a zero row", async () => {
    const reports = new Reports();
    reports.roster = [
      { id: ids.user, name: "Alex" },
      { id: ids.otherUser, name: "Sam" },
    ];
    const service = createReportService({ reports, reaper: silentReaper, agents });

    const result = await service.leaderboard(subject, {});

    expect(result.entries.map((entry) => [entry.user.name, entry.activeSeconds, entry.agentSeconds])).toEqual([
      ["Alex", 0, 0],
      ["Sam", 0, 0],
    ]);
  });

  it("maps the unassigned scope onto default-attributed sessions", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, reaper: silentReaper, agents });

    await service.leaderboard(subject, { scope: "unassigned" });

    expect(reports.lastLeaderboardQuery?.unassignedOnly).toBe(true);
    expect(reports.lastLeaderboardQuery?.projectId).toBeUndefined();
  });

  it("refuses a scope naming a project outside the workspace", async () => {
    const service = createReportService({ reports: new Reports([], new Set()), reaper: silentReaper, agents });

    await expect(service.leaderboard(subject, { scope: ids.otherProject }))
      .rejects.toMatchObject({ code: "not_found", message: "Project not found." });
  });

  it("carries the dashboard scope into the session list and the export", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, reaper: silentReaper, agents });

    await service.list(subject, { scope: ids.project, page: 1, pageSize: 50 });
    expect(reports.lastPage?.query.projectId).toBe(ids.project);

    await service.export(subject, { scope: "unassigned", page: 1, pageSize: 50 });
    // The export reads through the same scoped query the board does.
    expect(reports.exportReads).toBe(1);
  });

  it("reads postgres sum strings and a null total without losing precision", async () => {
    const reports = new Reports();
    reports.leaderboardRows = [entry(ids.user, "Alex", "9007199254740990", 2), entry(ids.otherUser, "Sam", null, 0, null)];
    const service = createReportService({ reports, reaper: silentReaper, agents });

    const result = await service.leaderboard(subject, {});

    expect(result.entries[0]?.durationSeconds).toBe(9_007_199_254_740_990);
    expect(result.entries[1]?.durationSeconds).toBe(0);
    expect(result.entries[1]?.attributedSeconds).toBe(0);
    expect(result.entries[1]?.unattributedSeconds).toBe(0);
  });

  it("applies the same inclusive calendar bounds the reports use", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, reaper: silentReaper, agents });

    await service.leaderboard(subject, { from: "2026-08-01", to: "2026-08-06" });

    expect(reports.lastLeaderboardQuery?.from).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(reports.lastLeaderboardQuery?.toExclusive).toEqual(new Date("2026-08-07T00:00:00.000Z"));
  });

  it("uses device-local instant bounds for clipped leaderboard totals", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, reaper: silentReaper, agents });

    await service.leaderboard(subject, {
      fromAt: "2026-03-08T06:00:00.000Z",
      toExclusiveAt: "2026-03-09T05:00:00.000Z",
    });

    expect(reports.lastLeaderboardQuery).toEqual({
      from: new Date("2026-03-08T06:00:00.000Z"),
      toExclusive: new Date("2026-03-09T05:00:00.000Z"),
    });
  });

  it("rejects a range wider than a year and returns an empty board for no activity", async () => {
    const reports = new Reports();
    const service = createReportService({ reports, reaper: silentReaper, agents });

    await expect(service.leaderboard(subject, { from: "2024-01-01", to: "2026-01-01" })).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(service.leaderboard(subject, {})).resolves.toEqual({
      filters: {},
      totalDurationSeconds: 0,
      medianSessionSeconds: null,
      entries: [],
    });
  });
});

describe("me/stats", () => {
  it("scopes per-project totals to the caller with inclusive calendar bounds and reaps stale agents first", async () => {
    const reports = new Reports();
    reports.projectTotals = [
      { project: { id: ids.project, name: "Timer" }, durationSeconds: 7_200, attributedSeconds: 5_400, sessionCount: 2 },
      { project: { id: ids.otherProject, name: "Side" }, durationSeconds: "600", attributedSeconds: "600", sessionCount: 1 },
    ];
    reports.appTotals = [
      { processName: "Code.exe", durationSeconds: "4200" },
      { processName: "chrome.exe", durationSeconds: 1_800 },
    ];
    reports.siteTotals = [
      { mapping: { id: "01c7e513-b094-4d4c-ae55-21790ae019a4", pattern: "github.com/acme/*", projectId: ids.project }, durationSeconds: "900" },
    ];
    const reaper = new Reaper();
    const service = createReportService({ reports, reaper, agents });

    const result = await service.meStats(subject, { from: "2026-08-01", to: "2026-08-06" });

    expect(result).toEqual({
      filters: { from: "2026-08-01", to: "2026-08-06" },
      totalDurationSeconds: 7_800,
      attributedSeconds: 6_000,
      unattributedSeconds: 1_800,
      ...noMeasurement,
      hourly: [],
      projects: [
        { project: { id: ids.project, name: "Timer" }, durationSeconds: 7_200, attributedSeconds: 5_400, unattributedSeconds: 1_800, sessionCount: 2 },
        { project: { id: ids.otherProject, name: "Side" }, durationSeconds: 600, attributedSeconds: 600, unattributedSeconds: 0, sessionCount: 1 },
      ],
      apps: [
        { processName: "Code.exe", durationSeconds: 4_200 },
        { processName: "chrome.exe", durationSeconds: 1_800 },
      ],
      sites: [
        { mapping: { id: "01c7e513-b094-4d4c-ae55-21790ae019a4", pattern: "github.com/acme/*", projectId: ids.project }, durationSeconds: 900 },
      ],
      agents: [],
    });
    // Without a userId filter, the repository read is pinned to the caller.
    expect(reports.lastProjectTotalsQuery).toEqual({
      from: new Date("2026-08-01T00:00:00.000Z"),
      toExclusive: new Date("2026-08-07T00:00:00.000Z"),
      userId: ids.user,
    });
    expect(reports.lastAppTotalsQuery).toEqual(reports.lastProjectTotalsQuery);
    expect(reports.lastSiteTotalsQuery).toEqual(reports.lastProjectTotalsQuery);
    expect(reaper.subjects).toEqual([subject]);
  });

  it("returns an empty stats response when the caller recorded nothing", async () => {
    const result = await createReportService({ reports: new Reports(), reaper: silentReaper, agents }).meStats(subject, {});

    expect(result).toEqual({ filters: {}, totalDurationSeconds: 0, attributedSeconds: 0, unattributedSeconds: 0, ...noMeasurement, hourly: [], projects: [], apps: [], sites: [], agents: [] });
  });

  it("buckets active and agent time by the caller's local hours, collapsing overlap but summing parallelism", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    // Two overlapping presence intervals still count as one hour of presence
    // per wall-clock hour - the union, never the sum.
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(11) },
      { user: { id: ids.user, name: "Alex" }, startedAt: new Date(Date.UTC(2026, 7, 5, 9, 30)), endedAt: new Date(Date.UTC(2026, 7, 5, 10, 30)) },
    ];
    // Two agents running in parallel count twice inside that hour.
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, projectId: ids.project, startedAt: hour(9), endedAt: hour(10) },
      { user: { id: ids.user, name: "Alex" }, source: "codex", model: null, projectId: ids.project, startedAt: hour(9), endedAt: hour(10) },
    ];
    const service = createReportService({ reports, reaper: silentReaper, agents });

    const result = await service.meStats(subject, {
      fromAt: "2026-08-05T00:00:00.000Z",
      toExclusiveAt: "2026-08-06T00:00:00.000Z",
    });

    // The series tiles midnight-to-midnight on the caller's calendar, so the
    // empty early hours are present and the two busy hours read exactly.
    expect(result.hourly).toHaveLength(24);
    const byHour = new Map(result.hourly.map((bucket) => [new Date(bucket.hourStart).getUTCHours(), bucket]));
    expect(byHour.get(9)).toEqual({ hourStart: "2026-08-05T09:00:00.000Z", activeSeconds: 3_600, agentSeconds: 7_200 });
    expect(byHour.get(10)).toEqual({ hourStart: "2026-08-05T10:00:00.000Z", activeSeconds: 3_600, agentSeconds: 0 });
    for (let h = 0; h < 24; h++) {
      if (h === 9 || h === 10) continue;
      expect(byHour.get(h)).toEqual({ hourStart: `2026-08-05T${String(h).padStart(2, "0")}:00:00.000Z`, activeSeconds: 0, agentSeconds: 0 });
    }
  });

  it("leaves the unbounded all-time range without an hourly graph", async () => {
    const hour = (h: number): Date => new Date(Date.UTC(2026, 7, 5, h));
    const reports = new Reports();
    reports.presenceIntervals = [
      { user: { id: ids.user, name: "Alex" }, startedAt: hour(9), endedAt: hour(11) },
    ];
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, projectId: ids.project, startedAt: hour(9), endedAt: hour(10) },
    ];
    const service = createReportService({ reports, reaper: silentReaper, agents });

    const result = await service.meStats(subject, {});

    expect(result.hourly).toEqual([]);
    expect(result.activeSeconds).toBe(7_200);
  });

  it("reads a named teammate's stats instead of the caller's when asked", async () => {
    const reports = new Reports([], new Set([ids.user, ids.otherUser]));
    const service = createReportService({ reports, reaper: silentReaper, agents });

    await service.meStats(subject, { userId: ids.otherUser });

    expect(reports.lastProjectTotalsQuery).toEqual({ userId: ids.otherUser });
    expect(reports.lastAppTotalsQuery).toEqual({ userId: ids.otherUser });
  });

  it("refuses a stats userId from outside the workspace, like the org report does", async () => {
    const service = createReportService({ reports: new Reports([], new Set()), reaper: silentReaper, agents });

    await expect(service.meStats(subject, { userId: ids.otherUser }))
      .rejects.toMatchObject({ code: "not_found", message: "User not found." });
  });

  it("rejects reversed or excessive date ranges like the org reports do", async () => {
    const service = createReportService({ reports: new Reports(), reaper: silentReaper, agents });

    await expect(service.meStats(subject, { from: "2026-08-07", to: "2026-08-06" })).rejects.toMatchObject({ code: "validation_error" });
    await expect(service.meStats(subject, { from: "2025-01-01", to: "2026-01-02" })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("carries the caller's own agent rows, scoped exactly like the org-wide pay-run report", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, projectId: ids.project, agentId: ids.session, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
      // A teammate's shift under a different roster identity must never surface here.
      { user: { id: ids.otherUser, name: "Sam" }, source: "codex", model: null, projectId: ids.project, agentId: ids.otherAgent, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([agentRecord({ id: ids.session }), agentRecord({ id: ids.otherAgent, source: "codex" })]);
    const authoredAt = new Date("2026-08-06T14:30:00.000Z");
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
    ]);
    const service = createReportService({ reports, reaper: silentReaper, agents: roster, shiftCommits });

    const result = await service.meStats(subject, {});

    expect(result.agents).toEqual([{
      agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
      agentSeconds: 3_600,
      shiftCount: 1,
      commitsRecorded: 2,
      commitsPending: 0,
      commitsMerged: 2,
      commitsReverted: 0,
      commitsOrphaned: 0,
      heldRate: 1,
    }]);
  });

  it("scopes a shared agent's commit tallies to the caller in meStats while the org report shows every member", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, projectId: ids.project, agentId: ids.session, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
      { user: { id: ids.otherUser, name: "Sam" }, source: "claude_code", model: null, projectId: ids.project, agentId: ids.session, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([agentRecord({ id: ids.session })]);
    const authoredAt = new Date("2026-08-06T14:30:00.000Z");
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
      { userId: ids.otherUser, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
    ]);
    const service = createReportService({ reports, reaper: silentReaper, agents: roster, shiftCommits });

    const own = await service.meStats(subject, {});

    expect(own.agents).toEqual([{
      agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
      agentSeconds: 3_600,
      shiftCount: 1,
      commitsRecorded: 1,
      commitsPending: 0,
      commitsMerged: 1,
      commitsReverted: 0,
      commitsOrphaned: 0,
      heldRate: 1,
    }]);
    expect(shiftCommits.lastCountsQuery).toEqual({ userId: ids.user });

    const org = await service.agentsReport(subject, {});

    expect(org.rows).toEqual([{
      agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
      agentSeconds: 7_200,
      shiftCount: 2,
      commitsRecorded: 2,
      commitsPending: 0,
      commitsMerged: 2,
      commitsReverted: 0,
      commitsOrphaned: 0,
      heldRate: 1,
    }]);
  });
});

describe("agents report", () => {
  it("lists every roster agent with hours, shifts, and held share - zero-activity agents included", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, projectId: ids.project, agentId: ids.session, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([
      agentRecord({ id: ids.session }),
      agentRecord({ id: ids.otherAgent, name: "Codex @ Side", source: "codex", status: "registered" }),
    ]);
    const authoredAt = new Date("2026-08-06T14:30:00.000Z");
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "pending", authoredAt },
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "reverted", authoredAt },
    ]);
    const service = createReportService({ reports, reaper: silentReaper, agents: roster, shiftCommits });

    const result = await service.agentsReport(subject, {});

    expect(result.rows).toEqual([
      {
        agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
        agentSeconds: 3_600,
        shiftCount: 1,
        commitsRecorded: 3,
        commitsPending: 1,
        commitsMerged: 1,
        commitsReverted: 1,
        commitsOrphaned: 0,
        // merged / decided (merged + reverted + orphaned); "orphaned" decides too.
        heldRate: 0.5,
      },
      {
        // A registered agent with nothing in range still gets a row: zeros and a null rate, never absence.
        agent: { id: ids.otherAgent, name: "Codex @ Side", source: "codex", status: "registered", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
        agentSeconds: 0,
        shiftCount: 0,
        commitsRecorded: 0,
        commitsPending: 0,
        commitsMerged: 0,
        commitsReverted: 0,
        commitsOrphaned: 0,
        heldRate: null,
      },
    ]);
    expect(result.headcount).toEqual({ total: 2, anonymous: 1, registered: 1, retired: 0 });
  });

  it("works with no commit repository configured, reaps stale sessions first, and rejects a scope outside the workspace", async () => {
    const reaper = new Reaper();
    const roster = new Agents([agentRecord()]);
    const service = createReportService({ reports: new Reports(), reaper, agents: roster });

    const result = await service.agentsReport(subject, {});
    expect(result.rows).toEqual([{
      agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
      agentSeconds: 0,
      shiftCount: 0,
      commitsRecorded: 0,
      commitsPending: 0,
      commitsMerged: 0,
      commitsReverted: 0,
      commitsOrphaned: 0,
      heldRate: null,
    }]);
    expect(reaper.subjects).toEqual([subject]);

    const outsideScopeService = createReportService({ reports: new Reports([], new Set()), reaper: silentReaper, agents });
    await expect(outsideScopeService.agentsReport(subject, { scope: ids.otherProject }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("narrows commit tallies to the same project scope as the hours", async () => {
    const reports = new Reports();
    reports.agentIntervals = [
      { user: { id: ids.user, name: "Alex" }, source: "claude_code", model: null, projectId: ids.project, agentId: ids.session, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
      { user: { id: ids.user, name: "Alex" }, source: "codex", model: null, projectId: ids.otherProject, agentId: ids.otherAgent, startedAt: new Date("2026-08-06T14:00:00.000Z"), endedAt: new Date("2026-08-06T15:00:00.000Z") },
    ];
    const roster = new Agents([
      agentRecord({ id: ids.session }),
      agentRecord({ id: ids.otherAgent, name: "Codex @ Side", source: "codex", project: { id: ids.otherProject, name: "Side" } }),
    ]);
    const authoredAt = new Date("2026-08-06T14:30:00.000Z");
    const shiftCommits = new ShiftCommits([
      { userId: ids.user, agentId: ids.session, projectId: ids.project, verification: "merged", authoredAt },
      { userId: ids.user, agentId: ids.otherAgent, projectId: ids.otherProject, verification: "merged", authoredAt },
    ]);
    const service = createReportService({ reports, reaper: silentReaper, agents: roster, shiftCommits });

    const result = await service.agentsReport(subject, { scope: ids.project });

    expect(result.rows).toEqual([
      {
        agent: { id: ids.session, name: "Claude Code @ Timer", source: "claude_code", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.project, name: "Timer" }, createdAt: "2026-08-01T00:00:00.000Z" },
        agentSeconds: 3_600,
        shiftCount: 1,
        commitsRecorded: 1,
        commitsPending: 0,
        commitsMerged: 1,
        commitsReverted: 0,
        commitsOrphaned: 0,
        heldRate: 1,
      },
      {
        agent: { id: ids.otherAgent, name: "Codex @ Side", source: "codex", status: "anonymous", owner: { id: ids.user, name: "Alex" }, project: { id: ids.otherProject, name: "Side" }, createdAt: "2026-08-01T00:00:00.000Z" },
        agentSeconds: 0,
        shiftCount: 0,
        commitsRecorded: 0,
        commitsPending: 0,
        commitsMerged: 0,
        commitsReverted: 0,
        commitsOrphaned: 0,
        heldRate: null,
      },
    ]);
    expect(shiftCommits.lastCountsQuery).toEqual({ projectId: ids.project });
  });
});
