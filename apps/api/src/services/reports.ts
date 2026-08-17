import {
  clipInterval,
  intersectIntervals,
  isAttributed,
  measureTime,
  summedSeconds,
  unionSeconds,
  type AgentSplit,
  type AgentsReportFilters,
  type AgentsReportResponse,
  type Concurrency,
  type HourlyBucket,
  type Interval,
  type LeaderboardFilters,
  type LeaderboardResponse,
  type MeStatsAgent,
  type MeStatsFilters,
  type MeStatsResponse,
  type ReportFilters,
  type ReportResponse,
  type ReportRow,
  type TokenTotals,
} from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type {
  AgentIntervalRecord,
  AgentRecord,
  AgentRepository,
  AgentUsageBucketTotalRecord,
  AgentUsageRepository,
  AgentUsageTotalsRecord,
  AppTotalRecord,
  LeaderboardRowRecord,
  PresenceIntervalRecord,
  ProjectTotalRecord,
  ReportQuery,
  ReportRepository,
  ReportRowRecord,
  ReportSummaryRecord,
  SessionIntervalRecord,
  ShiftCommitCountsRecord,
  ShiftCommitRepository,
  ShiftRepoRootRecord,
  SiteTotalRecord,
} from "../repositories.js";
import { repoLabel } from "./attribution.js";
import type { AgentSessionReaper } from "./agent-sessions.js";

export interface ReportService {
  list(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportResponse>;
  export(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportExport>;
  leaderboard(subject: AuthenticatedSubject, filters: LeaderboardFilters): Promise<LeaderboardResponse>;
  meStats(subject: AuthenticatedSubject, filters: MeStatsFilters): Promise<MeStatsResponse>;
  agentsReport(subject: AuthenticatedSubject, filters: AgentsReportFilters): Promise<AgentsReportResponse>;
}

export interface ReportExport {
  totalDurationSeconds: number;
  rows: ReportRow[];
}

export interface ReportServiceDependencies {
  reports: ReportRepository;
  /** Stale running agent sessions close at lastEventAt before report aggregation. */
  reaper: AgentSessionReaper;
  /** The roster behind the pay-run report and /me/stats's own-agent rows. */
  agents: AgentRepository;
  /** Without it, every agent row's commit counts stay at zero and heldRate null. */
  shiftCommits?: ShiftCommitRepository;
  /** Without it, token totals stay at zero under tokensReported false, and hourly token fields stay null. */
  agentUsage?: AgentUsageRepository;
}

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
export const reportExportRowCap = 10_000;

function validatePagination(filters: ReportFilters): void {
  if (!Number.isSafeInteger(filters.page) || !Number.isSafeInteger(filters.pageSize)
    || filters.page < 1 || filters.page > 10_000 || filters.pageSize < 1 || filters.pageSize > 200) {
    throw new AppError("validation_error", "Invalid report pagination.");
  }
}

function utcStart(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

type ReportRangeFilters = Pick<ReportFilters, "from" | "to" | "fromAt" | "toExclusiveAt">;

/** Shared range normalization; the agents paystub and pay-run reuse the exact reporting rules. */
export function normalizedQuery(filters: ReportRangeFilters & Partial<Pick<ReportFilters, "projectId" | "userId">>): ReportQuery {
  const hasInstantBoundary = filters.fromAt !== undefined || filters.toExclusiveAt !== undefined;
  if (hasInstantBoundary) {
    if (filters.from !== undefined || filters.to !== undefined || filters.fromAt === undefined || filters.toExclusiveAt === undefined) {
      throw new AppError("validation_error", "Report instant bounds must be supplied together without calendar dates.");
    }
    const from = new Date(filters.fromAt);
    const toExclusive = new Date(filters.toExclusiveAt);
    const durationMs = toExclusive.getTime() - from.getTime();
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 367 * millisecondsPerDay) {
      throw new AppError("validation_error", "The report time range must be between zero and 367 days.");
    }
    return {
      from,
      toExclusive,
      ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
      ...(filters.userId === undefined ? {} : { userId: filters.userId }),
    };
  }
  const from = filters.from === undefined ? undefined : utcStart(filters.from);
  const inclusiveTo = filters.to === undefined ? undefined : utcStart(filters.to);
  if (from !== undefined && inclusiveTo !== undefined) {
    const rangeDays = (inclusiveTo.getTime() - from.getTime()) / millisecondsPerDay;
    if (rangeDays < 0 || rangeDays > 365) {
      throw new AppError("validation_error", "The report date range must be between zero and 366 days.");
    }
  }
  return {
    ...(from === undefined ? {} : { from }),
    ...(inclusiveTo === undefined ? {} : { toExclusive: new Date(inclusiveTo.getTime() + millisecondsPerDay) }),
    ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
    ...(filters.userId === undefined ? {} : { userId: filters.userId }),
  };
}

function normalizedMeStatsQuery(filters: MeStatsFilters): ReportQuery {
  return { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
}

/** Maps the dashboard scope onto query predicates. 'all' and absent are the same thing. */
function scopeQuery(scope: LeaderboardFilters["scope"]): Pick<ReportQuery, "projectId" | "unassignedOnly"> {
  if (scope === undefined || scope === "all") return {};
  if (scope === "unassigned") return { unassignedOnly: true };
  return { projectId: scope };
}

/** Everything the time model needs about one member, gathered across the three interval reads. */
type MemberIntervals = {
  user: { id: string; name: string };
  presence: Interval[];
  sessions: Interval[];
  agents: { source: string; model: string | null; interval: Interval }[];
};

const asInterval = (start: Date, end: Date): Interval => ({ start: start.getTime(), end: end.getTime() });

function collectMembers(
  presence: PresenceIntervalRecord[],
  sessions: SessionIntervalRecord[],
  agents: AgentIntervalRecord[],
): Map<string, MemberIntervals> {
  const members = new Map<string, MemberIntervals>();
  const memberFor = (user: { id: string; name: string }): MemberIntervals => {
    const existing = members.get(user.id);
    if (existing !== undefined) return existing;
    const created: MemberIntervals = { user, presence: [], sessions: [], agents: [] };
    members.set(user.id, created);
    return created;
  };
  for (const row of presence) memberFor(row.user).presence.push(asInterval(row.startedAt, row.endedAt));
  for (const row of sessions) memberFor(row.user).sessions.push(asInterval(row.startedAt, row.stoppedAt));
  for (const row of agents) {
    memberFor(row.user).agents.push({ source: row.source, model: row.model, interval: asInterval(row.startedAt, row.endedAt) });
  }
  return members;
}

type MemberMeasurement = {
  activeSeconds: number;
  agentSeconds: number;
  concurrency: Concurrency;
  byAgent: AgentSplit[];
};

/** The range as epoch-millisecond bounds, matching what `measureTime` clips by. */
function queryRange(query: ReportQuery): Partial<Interval> {
  return {
    ...(query.from === undefined ? {} : { start: query.from.getTime() }),
    ...(query.toExclusive === undefined ? {} : { end: query.toExclusive.getTime() }),
  };
}

/**
 * The person's working intervals under the current scope. Presence carries no
 * project, so a project or unassigned scope narrows it to the slices where that
 * scope's sessions were open; the all-projects scope is presence itself.
 */
function workingIntervals(member: MemberIntervals, query: ReportQuery): Interval[] {
  const scoped = query.projectId !== undefined || query.unassignedOnly === true;
  return scoped ? intersectIntervals(member.presence, member.sessions) : member.presence;
}

/** Intervals clipped to the range, zero-length ones dropped. */
function clippedIntervals(intervals: readonly Interval[], range: Partial<Interval>): Interval[] {
  return intervals
    .map((interval) => clipInterval(interval, range))
    .filter((interval): interval is Interval => interval !== null);
}

/** Peak number of the given intervals overlapping at once, via a sweep line. */
export function maxConcurrentCount(intervals: readonly Interval[]): number {
  const starts = intervals.map((interval) => interval.start).sort((a, b) => a - b);
  const ends = intervals.map((interval) => interval.end).sort((a, b) => a - b);
  let startIndex = 0;
  let endIndex = 0;
  let running = 0;
  let peak = 0;
  while (startIndex < starts.length) {
    if (starts[startIndex]! < ends[endIndex]!) {
      running += 1;
      peak = Math.max(peak, running);
      startIndex += 1;
    } else {
      running -= 1;
      endIndex += 1;
    }
  }
  return peak;
}

/** Median in-range session length in seconds; 0 with no sessions. */
export function medianDurationSeconds(intervals: readonly Interval[]): number {
  const lengths = intervals
    .map((interval) => interval.end - interval.start)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  if (lengths.length === 0) return 0;
  const middle = Math.floor(lengths.length / 2);
  const medianMs = lengths.length % 2 === 1 ? lengths[middle]! : (lengths[middle - 1]! + lengths[middle]!) / 2;
  return Math.round(medianMs / 1_000);
}

/**
 * One hour of the caller's local calendar at a time. Bounded ranges tile from
 * their start instant - which the dashboards send as the viewer's local
 * midnight - so bucket `k` is local hour `k`. The unbounded "all time" range
 * returns no buckets; its full history lives in the CSV export instead.
 *
 * Usage buckets join the tile their start falls inside, and tokens are a
 * plain sum over them. An hour nothing reported tokens for keeps nulls, never
 * an invented zero.
 */
export function hourlySeries(
  working: readonly Interval[],
  agents: readonly Interval[],
  usage: readonly AgentUsageBucketTotalRecord[],
  range: Partial<Interval>,
): HourlyBucket[] {
  if (range.start === undefined || range.end === undefined) return [];
  const evidence = [...working, ...agents];
  if (evidence.length === 0) return [];
  const start = range.start;
  const end = range.end;
  if (start >= end) return [];
  const buckets: HourlyBucket[] = [];
  for (let cursor = start; cursor < end; cursor += 60 * 60 * 1_000) {
    const hour = { start: cursor, end: Math.min(cursor + 60 * 60 * 1_000, end) };
    const tokens = usageTokensInHour(usage, hour);
    buckets.push({
      hourStart: new Date(cursor).toISOString(),
      activeSeconds: unionSeconds(working, hour),
      agentSeconds: summedSeconds(agents, hour),
      inputTokens: tokens?.inputTokens ?? null,
      outputTokens: tokens?.outputTokens ?? null,
      cacheCreationInputTokens: tokens?.cacheCreationInputTokens ?? null,
      cacheReadInputTokens: tokens?.cacheReadInputTokens ?? null,
    });
  }
  return buckets;
}

/** The token counters summed over the usage buckets whose start falls inside the hour; null when none do. */
function usageTokensInHour(usage: readonly AgentUsageBucketTotalRecord[], hour: Interval): TokenTotals | null {
  let totals: TokenTotals | null = null;
  for (const bucket of usage) {
    const bucketStart = bucket.bucketStartAt.getTime();
    if (bucketStart < hour.start || bucketStart >= hour.end) continue;
    totals ??= { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    totals.inputTokens += safeInteger(bucket.inputTokens, "hourly input tokens");
    totals.outputTokens += safeInteger(bucket.outputTokens, "hourly output tokens");
    totals.cacheCreationInputTokens += safeInteger(bucket.cacheCreationInputTokens, "hourly cache creation tokens");
    totals.cacheReadInputTokens += safeInteger(bucket.cacheReadInputTokens, "hourly cache read tokens");
  }
  return totals;
}

const ZERO_TOKENS: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/**
 * One agent's token totals for a report row: the counters summed over the
 * range, and tokensReported counting rows - never whether the sum is nonzero.
 */
function agentTokenTotals(record: AgentUsageTotalsRecord | undefined): { tokens: TokenTotals; tokensReported: boolean } {
  if (record === undefined) return { tokens: ZERO_TOKENS, tokensReported: false };
  return {
    tokens: {
      inputTokens: safeInteger(record.inputTokens, "agent input tokens"),
      outputTokens: safeInteger(record.outputTokens, "agent output tokens"),
      cacheCreationInputTokens: safeInteger(record.cacheCreationInputTokens, "agent cache creation tokens"),
      cacheReadInputTokens: safeInteger(record.cacheReadInputTokens, "agent cache read tokens"),
    },
    tokensReported: safeInteger(record.rowCount, "agent usage row count") > 0,
  };
}

/** Total tokens burned: the sum of the four counters, for the tokens ranking. */
function totalTokens(tokens: TokenTotals): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationInputTokens + tokens.cacheReadInputTokens;
}

/**
 * The tokens ranking key: reporters rank by their total tokens, and agents
 * that reported none sit below every reporter - even one whose rows sum to
 * zero, because a reported zero and no report are different facts.
 */
function rankTokens(row: { tokens: TokenTotals; tokensReported: boolean }): number {
  return row.tokensReported ? totalTokens(row.tokens) + 1 : 0;
}

/**
 * One member's numbers under the current scope. Presence carries no project,
 * so a project or unassigned scope narrows it to the slices where that scope's
 * sessions were open; the all-projects scope is presence itself.
 */
function measureMember(member: MemberIntervals, query: ReportQuery): MemberMeasurement {
  const working = workingIntervals(member, query);
  const range = queryRange(query);
  const measurement = measureTime(working, member.agents.map((agent) => agent.interval), range);
  // Grouped before summing, so each split rounds once. Rounding every
  // interval on its own drifts the splits away from the agentSeconds total
  // they are contracted to reconstruct.
  const grouped = new Map<string, { source: string; model: string | null; intervals: Interval[] }>();
  for (const agent of member.agents) {
    const key = `${agent.source}|${agent.model ?? ""}`;
    const existing = grouped.get(key) ?? { source: agent.source, model: agent.model, intervals: [] };
    existing.intervals.push(agent.interval);
    grouped.set(key, existing);
  }
  const splits = new Map<string, AgentSplit>();
  for (const [key, group] of grouped) {
    const clipped = clippedIntervals(group.intervals, range);
    splits.set(key, {
      source: group.source,
      model: group.model,
      durationSeconds: Math.round(clipped.reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1_000),
      sessionCount: clipped.length,
      maxConcurrent: maxConcurrentCount(clipped),
      medianSeconds: medianDurationSeconds(clipped),
    });
  }
  return {
    activeSeconds: measurement.activeSeconds,
    agentSeconds: measurement.agentSeconds,
    concurrency: measurement.concurrency,
    byAgent: [...splits.values()]
      .filter((split) => split.durationSeconds > 0)
      .sort((a, b) => b.durationSeconds - a.durationSeconds || a.source.localeCompare(b.source)),
  };
}

/** Median of the sessions' in-range seconds; null with no sessions. */
function medianSessionSeconds(sessions: SessionIntervalRecord[], query: ReportQuery): number | null {
  const range = { ...(query.from === undefined ? {} : { start: query.from.getTime() }), ...(query.toExclusive === undefined ? {} : { end: query.toExclusive.getTime() }) };
  const lengths = sessions
    .map((session) => summedSeconds([asInterval(session.startedAt, session.stoppedAt)], range))
    .filter((seconds) => seconds > 0)
    .sort((a, b) => a - b);
  if (lengths.length === 0) return null;
  const middle = Math.floor(lengths.length / 2);
  return lengths.length % 2 === 1 ? lengths[middle]! : Math.round((lengths[middle - 1]! + lengths[middle]!) / 2);
}

const EMPTY_MEASUREMENT: MemberMeasurement = {
  activeSeconds: 0,
  agentSeconds: 0,
  concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
  byAgent: [],
};

function asReportRow(record: ReportRowRecord): ReportRow {
  const durationSeconds = record.durationSeconds;
  return {
    id: record.id,
    user: record.user,
    project: record.project,
    description: record.description,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    stoppedAt: record.stoppedAt.toISOString(),
    idleSeconds: record.idleSeconds,
    durationSeconds,
    attribution: record.attribution,
    // A session is attributed whole or not at all: its project came from a
    // naming signal, or it fell back to the default project.
    attributedSeconds: isAttributed(record.attribution) ? durationSeconds : 0,
    unattributedSeconds: isAttributed(record.attribution) ? 0 : durationSeconds,
  };
}

/** The legacy per-member row, before the time model measures it. */
function asLeaderboardEntry(record: LeaderboardRowRecord): {
  rank: number;
  user: { id: string; name: string };
  durationSeconds: number;
  sessionCount: number;
  attributedSeconds: number;
  unattributedSeconds: number;
} {
  const durationSeconds = safeInteger(record.durationSeconds, "leaderboard duration");
  const attributedSeconds = Math.min(
    durationSeconds,
    safeInteger(record.attributedSeconds, "leaderboard attributed seconds"),
  );
  // Rank is assigned once, after the board sorts by active time.
  return {
    rank: 0,
    user: record.user,
    durationSeconds,
    sessionCount: safeInteger(record.sessionCount, "leaderboard session count"),
    attributedSeconds,
    unattributedSeconds: Math.max(0, durationSeconds - attributedSeconds),
  };
}

/** Reads a postgres sum/count - number, string, or bigint - as a safe nonnegative integer; null reads as 0. */
export function safeInteger(value: number | string | bigint | null, field: string): number {
  if (value === null) return 0;
  const bigint = typeof value === "bigint"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? BigInt(value)
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? BigInt(value)
        : null;
  if (bigint === null || bigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Report ${field} exceeds the safe integer range.`);
  }
  return Number(bigint);
}

function summaryValues(summary: ReportSummaryRecord): { totalRows: number; totalDurationSeconds: number } {
  return {
    totalRows: safeInteger(summary.totalRows, "row count"),
    totalDurationSeconds: safeInteger(summary.totalDurationSeconds, "duration total"),
  };
}

async function authorizeFilters(repository: ReportRepository, subject: AuthenticatedSubject, query: ReportQuery): Promise<void> {
  if (query.projectId !== undefined && await repository.findProjectForOrganization(subject, query.projectId) === null) {
    throw new AppError("not_found", "Project not found.");
  }
  if (query.userId !== undefined && await repository.findUserForOrganization(subject, query.userId) === null) {
    throw new AppError("not_found", "User not found.");
  }
}

function asProjectTotal(record: ProjectTotalRecord): MeStatsResponse["projects"][number] {
  const durationSeconds = safeInteger(record.durationSeconds, "project duration");
  const attributedSeconds = Math.min(
    durationSeconds,
    safeInteger(record.attributedSeconds, "project attributed seconds"),
  );
  return {
    project: record.project,
    durationSeconds,
    attributedSeconds,
    unattributedSeconds: Math.max(0, durationSeconds - attributedSeconds),
    sessionCount: safeInteger(record.sessionCount, "project session count"),
  };
}

function asAppTotal(record: AppTotalRecord): MeStatsResponse["apps"][number] {
  return {
    processName: record.processName,
    durationSeconds: safeInteger(record.durationSeconds, "app duration"),
  };
}

function asSiteTotal(record: SiteTotalRecord): MeStatsResponse["sites"][number] {
  return {
    mapping: record.mapping,
    durationSeconds: safeInteger(record.durationSeconds, "site duration"),
  };
}

function asAgentReportView(record: AgentRecord): AgentsReportResponse["rows"][number]["agent"] {
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    status: record.status,
    owner: record.owner,
    project: record.project,
    createdAt: record.createdAt.toISOString(),
  };
}

function asMeStatsAgentView(record: AgentRecord): MeStatsAgent["agent"] {
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    status: record.status,
    project: record.project,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Hours and shift count from an agent's intervals overlapping the range (reports rounding rule: group, then round once). */
function agentHours(intervals: readonly Interval[], range: Partial<Interval>): { agentSeconds: number; shiftCount: number } {
  const clipped = clippedIntervals(intervals, range);
  return {
    agentSeconds: Math.round(clipped.reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1_000),
    shiftCount: clipped.length,
  };
}

/** merged / (merged + reverted + orphaned) - the decided commits; null while nothing has been decided. */
function agentCommitCounts(counts: ShiftCommitCountsRecord | undefined): {
  commitsRecorded: number;
  commitsPending: number;
  commitsMerged: number;
  commitsReverted: number;
  commitsOrphaned: number;
  heldRate: number | null;
} {
  const recorded = counts === undefined ? 0 : safeInteger(counts.recorded, "agent commit recorded count");
  const pending = counts === undefined ? 0 : safeInteger(counts.pending, "agent commit pending count");
  const merged = counts === undefined ? 0 : safeInteger(counts.merged, "agent commit merged count");
  const reverted = counts === undefined ? 0 : safeInteger(counts.reverted, "agent commit reverted count");
  const orphaned = counts === undefined ? 0 : safeInteger(counts.orphaned, "agent commit orphaned count");
  const decided = merged + reverted + orphaned;
  return {
    commitsRecorded: recorded,
    commitsPending: pending,
    commitsMerged: merged,
    commitsReverted: reverted,
    commitsOrphaned: orphaned,
    heldRate: decided === 0 ? null : merged / decided,
  };
}

/**
 * One roster agent's intervals plus the distinct models its shifts named and
 * the distinct codebases they worked, both capped like the contract's rows.
 */
interface AgentIntervals {
  intervals: Interval[];
  models: string[];
  repos: string[];
}

const agentLabelCap = 20;

/** Appends a label once, up to the contract's cap. */
function collectLabel(labels: string[], label: string | null): void {
  if (label === null || labels.includes(label) || labels.length >= agentLabelCap) return;
  labels.push(label);
}

/**
 * Roster agents' intervals grouped by agentId; legacy sessions with no roster
 * identity carry no row to group into. A shift's codebase follows the
 * paystub's shiftRepoLabel rule: its commit's repo root when it recorded one,
 * its working directory otherwise.
 */
function intervalsByAgentId(
  intervals: readonly AgentIntervalRecord[],
  repoRoots: readonly ShiftRepoRootRecord[],
): Map<string, AgentIntervals> {
  const rootBySession = new Map(repoRoots.map((row) => [row.agentSessionId, row.repoRoot]));
  const grouped = new Map<string, AgentIntervals>();
  for (const row of intervals) {
    if (row.agentId === null) continue;
    const existing = grouped.get(row.agentId) ?? { intervals: [], models: [], repos: [] };
    existing.intervals.push(asInterval(row.startedAt, row.endedAt));
    collectLabel(existing.models, row.model);
    const root = rootBySession.get(row.sessionId) ?? row.cwd;
    collectLabel(existing.repos, root === null ? null : repoLabel(root));
    grouped.set(row.agentId, existing);
  }
  return grouped;
}

export function createReportService(dependencies: ReportServiceDependencies): ReportService {
  return {
    async list(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportResponse> {
      validatePagination(filters);
      const query: ReportQuery = { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
      await authorizeFilters(dependencies.reports, subject, query);
      await dependencies.reaper.reapStale(subject);
      const offset = (filters.page - 1) * filters.pageSize;
      if (!Number.isSafeInteger(offset)) throw new AppError("validation_error", "Invalid report pagination.");
      const page = await dependencies.reports.readPageForOrganization(subject, query, { limit: filters.pageSize, offset });
      const summary = summaryValues(page.summary);
      return {
        filters,
        totalDurationSeconds: summary.totalDurationSeconds,
        pagination: {
          page: filters.page,
          pageSize: filters.pageSize,
          totalRows: summary.totalRows,
          totalPages: Math.ceil(summary.totalRows / filters.pageSize),
        },
        rows: page.rows.map(asReportRow),
      };
    },

    async export(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportExport> {
      validatePagination(filters);
      const query: ReportQuery = { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
      await authorizeFilters(dependencies.reports, subject, query);
      await dependencies.reaper.reapStale(subject);
      const exportRead = await dependencies.reports.readExportForOrganization(subject, query, reportExportRowCap);
      const summary = summaryValues(exportRead.summary);
      if (summary.totalRows > reportExportRowCap) {
        throw new AppError("validation_error", "Report export is limited to 10,000 rows. Narrow the filters and try again.");
      }
      const rows = exportRead.rows ?? [];
      if (rows.length > reportExportRowCap) throw new RangeError("Report export row count exceeded its limit.");
      return {
        totalDurationSeconds: summary.totalDurationSeconds,
        rows: rows.map(asReportRow),
      };
    },

    async leaderboard(subject: AuthenticatedSubject, filters: LeaderboardFilters): Promise<LeaderboardResponse> {
      const query: ReportQuery = { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
      await authorizeFilters(dependencies.reports, subject, query);
      await dependencies.reaper.reapStale(subject);
      const [rows, roster, presence, sessionIntervals, agentIntervals] = await Promise.all([
        dependencies.reports.readLeaderboardForOrganization(subject, query),
        dependencies.reports.readMembersForOrganization(subject),
        dependencies.reports.readPresenceIntervals(subject, query),
        dependencies.reports.readSessionIntervals(subject, query),
        dependencies.reports.readAgentIntervals(subject, query),
      ]);
      const members = collectMembers(presence, sessionIntervals, agentIntervals);
      const legacy = rows.map(asLeaderboardEntry);
      const legacyById = new Map(legacy.map((entry) => [entry.user.id, entry]));
      // Every member of the workspace is on the board, zeros included: a
      // teammate with no recorded time today reads as "0s", never as missing.
      for (const user of roster) {
        if (legacyById.has(user.id)) continue;
        const empty = { rank: 0, user, durationSeconds: 0, sessionCount: 0, attributedSeconds: 0, unattributedSeconds: 0 };
        legacy.push(empty);
        legacyById.set(user.id, empty);
      }
      // Interval evidence can name someone the roster no longer does (a
      // member deleted mid-range); their measured work still counts.
      for (const member of members.values()) {
        if (legacyById.has(member.user.id)) continue;
        const empty = { rank: 0, user: member.user, durationSeconds: 0, sessionCount: 0, attributedSeconds: 0, unattributedSeconds: 0 };
        legacy.push(empty);
        legacyById.set(member.user.id, empty);
      }
      const measured = legacy.map((entry) => {
        const member = members.get(entry.user.id);
        const measurement = member === undefined ? EMPTY_MEASUREMENT : measureMember(member, query);
        return { ...entry, ...measurement };
      });
      // The board ranks by active time - the human-hours number - with the
      // legacy duration as a stable tiebreak. A rank is shared only when the
      // whole ranking key ties, so equal work reads as equal and nothing else does.
      measured.sort((a, b) => b.activeSeconds - a.activeSeconds
        || b.durationSeconds - a.durationSeconds
        || a.user.id.localeCompare(b.user.id));
      const tied = (a: typeof measured[number], b: typeof measured[number]): boolean =>
        a.activeSeconds === b.activeSeconds && a.durationSeconds === b.durationSeconds;
      const entries = measured.map((entry, index) => ({ ...entry, rank: index + 1 }));
      for (let i = 1; i < entries.length; i++) {
        if (tied(measured[i]!, measured[i - 1]!)) entries[i]!.rank = entries[i - 1]!.rank;
      }
      return {
        filters,
        totalDurationSeconds: entries.reduce((total, entry) => total + entry.durationSeconds, 0),
        medianSessionSeconds: medianSessionSeconds(sessionIntervals, query),
        entries,
      };
    },

    async meStats(subject: AuthenticatedSubject, filters: MeStatsFilters): Promise<MeStatsResponse> {
      // A named teammate, or the caller. The same membership check the org
      // report runs: an id outside this workspace is a stable not_found.
      const query: ReportQuery = { ...normalizedMeStatsQuery(filters), userId: filters.userId ?? subject.userId };
      await authorizeFilters(dependencies.reports, subject, {
        ...(filters.userId === undefined ? {} : { userId: filters.userId }),
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      });
      await dependencies.reaper.reapStale(subject);
      const [projects, apps, sites, presence, sessionIntervals, agentIntervals, usageBuckets, usageByAgent] = await Promise.all([
        dependencies.reports.readProjectTotalsForMember(subject, query).then((rows) => rows.map(asProjectTotal)),
        dependencies.reports.readAppTotalsForMember(subject, query).then((rows) => rows.map(asAppTotal)),
        dependencies.reports.readSiteTotalsForMember(subject, query).then((rows) => rows.map(asSiteTotal)),
        dependencies.reports.readPresenceIntervals(subject, query),
        dependencies.reports.readSessionIntervals(subject, query),
        dependencies.reports.readAgentIntervals(subject, query),
        dependencies.agentUsage === undefined ? Promise.resolve([]) : dependencies.agentUsage.sumByBucket(subject, query),
        dependencies.agentUsage === undefined ? Promise.resolve([]) : dependencies.agentUsage.sumByAgent(subject, query),
      ]);
      const member = collectMembers(presence, sessionIntervals, agentIntervals).get(query.userId ?? subject.userId);
      const measurement = member === undefined ? EMPTY_MEASUREMENT : measureMember(member, query);
      const hourly = member === undefined
        ? []
        : hourlySeries(workingIntervals(member, query), member.agents.map((agent) => agent.interval), usageBuckets, queryRange(query));

      const range = queryRange(query);
      const [commitCounts, repoRoots] = dependencies.shiftCommits === undefined
        ? [[], []]
        : await Promise.all([
          dependencies.shiftCommits.countsByAgent(subject, query),
          dependencies.shiftCommits.repoRootsByAgent(subject, query),
        ]);
      const grouped = intervalsByAgentId(agentIntervals, repoRoots);
      const roster = await dependencies.agents.listForOrganization(subject);
      const rosterById = new Map(roster.map((agent) => [agent.id, agent]));
      const countsById = new Map(commitCounts.map((row) => [row.agentId, row]));
      const usageById = new Map(usageByAgent.map((row) => [row.agentId, row]));
      // Own agent rows are exactly the roster identities this member's shifts
      // ran under in range - the same boundary the interval read already scoped to.
      const agents: MeStatsAgent[] = [...grouped.keys()]
        .map((agentId) => rosterById.get(agentId))
        .filter((agent): agent is AgentRecord => agent !== undefined)
        .map((agent) => ({
          agent: asMeStatsAgentView(agent),
          ...agentHours(grouped.get(agent.id)?.intervals ?? [], range),
          ...agentCommitCounts(countsById.get(agent.id)),
          models: grouped.get(agent.id)?.models ?? [],
          repos: grouped.get(agent.id)?.repos ?? [],
          ...agentTokenTotals(usageById.get(agent.id)),
        }));

      return {
        filters,
        totalDurationSeconds: projects.reduce((total, project) => total + project.durationSeconds, 0),
        attributedSeconds: projects.reduce((total, project) => total + project.attributedSeconds, 0),
        unattributedSeconds: projects.reduce((total, project) => total + project.unattributedSeconds, 0),
        ...measurement,
        hourly,
        projects,
        apps,
        sites,
        agents,
      };
    },

    async agentsReport(subject: AuthenticatedSubject, filters: AgentsReportFilters): Promise<AgentsReportResponse> {
      const query: ReportQuery = { ...normalizedQuery(filters), ...scopeQuery(filters.scope) };
      await authorizeFilters(dependencies.reports, subject, query);
      await dependencies.reaper.reapStale(subject);
      const [roster, agentIntervals, commitCounts, repoRoots, usageByAgent] = await Promise.all([
        dependencies.agents.listForOrganization(subject),
        dependencies.reports.readAgentIntervals(subject, query),
        dependencies.shiftCommits === undefined ? Promise.resolve([]) : dependencies.shiftCommits.countsByAgent(subject, query),
        dependencies.shiftCommits === undefined ? Promise.resolve([]) : dependencies.shiftCommits.repoRootsByAgent(subject, query),
        dependencies.agentUsage === undefined ? Promise.resolve([]) : dependencies.agentUsage.sumByAgent(subject, query),
      ]);
      const range = queryRange(query);
      const grouped = intervalsByAgentId(agentIntervals, repoRoots);
      const countsById = new Map(commitCounts.map((row) => [row.agentId, row]));
      const usageById = new Map(usageByAgent.map((row) => [row.agentId, row]));
      // Every roster agent gets a row, activity or not: the roster - not the
      // interval data - decides which agents exist.
      const rows = roster.map((agent) => ({
        agent: asAgentReportView(agent),
        ...agentHours(grouped.get(agent.id)?.intervals ?? [], range),
        ...agentCommitCounts(countsById.get(agent.id)),
        models: grouped.get(agent.id)?.models ?? [],
        repos: grouped.get(agent.id)?.repos ?? [],
        ...agentTokenTotals(usageById.get(agent.id)),
      }));
      // A sort ranks heaviest first; ties and non-reporters keep roster order
      // (the sort is stable). Tokens rank agents that reported none last.
      if (filters.sort === "hours") {
        rows.sort((a, b) => b.agentSeconds - a.agentSeconds);
      } else if (filters.sort === "tokens") {
        rows.sort((a, b) => rankTokens(b) - rankTokens(a));
      }
      return {
        filters,
        headcount: {
          total: roster.length,
          // Active is everyone still on the clock: anonymous and registered alike.
          active: roster.filter((agent) => agent.status !== "retired").length,
          retired: roster.filter((agent) => agent.status === "retired").length,
        },
        rows,
      };
    },
  };
}
