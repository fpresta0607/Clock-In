import {
  intersectIntervals,
  isAttributed,
  measureTime,
  summedSeconds,
  type AgentSplit,
  type Concurrency,
  type Interval,
  type LeaderboardFilters,
  type LeaderboardResponse,
  type MeStatsFilters,
  type MeStatsResponse,
  type ReportFilters,
  type ReportResponse,
  type ReportRow,
} from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type {
  AgentIntervalRecord,
  AppTotalRecord,
  LeaderboardRowRecord,
  PresenceIntervalRecord,
  ProjectTotalRecord,
  ReportQuery,
  ReportRepository,
  ReportRowRecord,
  ReportSummaryRecord,
  SessionIntervalRecord,
  SiteTotalRecord,
} from "../repositories.js";
import type { AgentSessionReaper } from "./agent-sessions.js";

export interface ReportService {
  list(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportResponse>;
  export(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportExport>;
  leaderboard(subject: AuthenticatedSubject, filters: LeaderboardFilters): Promise<LeaderboardResponse>;
  meStats(subject: AuthenticatedSubject, filters: MeStatsFilters): Promise<MeStatsResponse>;
}

export interface ReportExport {
  totalDurationSeconds: number;
  rows: ReportRow[];
}

export interface ReportServiceDependencies {
  reports: ReportRepository;
  /** Stale running agent sessions close at lastEventAt before report aggregation. */
  reaper: AgentSessionReaper;
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

function normalizedQuery(filters: ReportRangeFilters & Partial<Pick<ReportFilters, "projectId" | "userId">>): ReportQuery {
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

/**
 * One member's numbers under the current scope. Presence carries no project,
 * so a project or unassigned scope narrows it to the slices where that scope's
 * sessions were open; the all-projects scope is presence itself.
 */
function measureMember(member: MemberIntervals, query: ReportQuery): MemberMeasurement {
  const scoped = query.projectId !== undefined || query.unassignedOnly === true;
  const working = scoped ? intersectIntervals(member.presence, member.sessions) : member.presence;
  const range = { ...(query.from === undefined ? {} : { start: query.from.getTime() }), ...(query.toExclusive === undefined ? {} : { end: query.toExclusive.getTime() }) };
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
    splits.set(key, {
      source: group.source,
      model: group.model,
      durationSeconds: summedSeconds(group.intervals, range),
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

function safeInteger(value: number | string | bigint | null, field: string): number {
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
      const [rows, presence, sessionIntervals, agentIntervals] = await Promise.all([
        dependencies.reports.readLeaderboardForOrganization(subject, query),
        dependencies.reports.readPresenceIntervals(subject, query),
        dependencies.reports.readSessionIntervals(subject, query),
        dependencies.reports.readAgentIntervals(subject, query),
      ]);
      const members = collectMembers(presence, sessionIntervals, agentIntervals);
      const legacy = rows.map(asLeaderboardEntry);
      const legacyById = new Map(legacy.map((entry) => [entry.user.id, entry]));
      // Someone with agent work but no completed session still belongs on the
      // board. Presence alone does not qualify under a project or unassigned
      // scope: presence carries no project, so every member of the workspace
      // would otherwise appear as an all-zero row under every scope.
      const scoped = query.projectId !== undefined || query.unassignedOnly === true;
      const qualifies = (member: MemberIntervals): boolean =>
        scoped ? member.sessions.length > 0 || member.agents.length > 0 : member.presence.length > 0 || member.agents.length > 0;
      const synthesized = new Set<string>();
      for (const member of members.values()) {
        if (!legacyById.has(member.user.id) && qualifies(member)) {
          const empty = { rank: 0, user: member.user, durationSeconds: 0, sessionCount: 0, attributedSeconds: 0, unattributedSeconds: 0 };
          legacy.push(empty);
          legacyById.set(member.user.id, empty);
          synthesized.add(member.user.id);
        }
      }
      const measured = legacy
        .map((entry) => {
          const member = members.get(entry.user.id);
          const measurement = member === undefined ? EMPTY_MEASUREMENT : measureMember(member, query);
          return { ...entry, ...measurement };
        })
        // A member the report itself returned always stands, even at zero.
        // A member this code invented from interval evidence has to justify
        // the row, or a scope with nothing in it fills with phantom zeroes.
        .filter((entry) => !synthesized.has(entry.user.id)
          || entry.activeSeconds > 0 || entry.agentSeconds > 0 || entry.durationSeconds > 0);
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
      const [projects, apps, sites, presence, sessionIntervals, agentIntervals] = await Promise.all([
        dependencies.reports.readProjectTotalsForMember(subject, query).then((rows) => rows.map(asProjectTotal)),
        dependencies.reports.readAppTotalsForMember(subject, query).then((rows) => rows.map(asAppTotal)),
        dependencies.reports.readSiteTotalsForMember(subject, query).then((rows) => rows.map(asSiteTotal)),
        dependencies.reports.readPresenceIntervals(subject, query),
        dependencies.reports.readSessionIntervals(subject, query),
        dependencies.reports.readAgentIntervals(subject, query),
      ]);
      const member = collectMembers(presence, sessionIntervals, agentIntervals).get(query.userId ?? subject.userId);
      const measurement = member === undefined ? EMPTY_MEASUREMENT : measureMember(member, query);
      return {
        filters,
        totalDurationSeconds: projects.reduce((total, project) => total + project.durationSeconds, 0),
        attributedSeconds: projects.reduce((total, project) => total + project.attributedSeconds, 0),
        unattributedSeconds: projects.reduce((total, project) => total + project.unattributedSeconds, 0),
        ...measurement,
        projects,
        apps,
        sites,
      };
    },
  };
}
