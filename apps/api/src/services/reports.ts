import {
  isAttributed,
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
  AppTotalRecord,
  LeaderboardRowRecord,
  ProjectTotalRecord,
  ReportQuery,
  ReportRepository,
  ReportRowRecord,
  ReportSummaryRecord,
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
  /** Stale running agent sessions close at lastEventAt before any corroboration read. */
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
      clipToRange: true,
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
    ...(from === undefined && inclusiveTo === undefined ? {} : { clipToRange: true }),
    ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
    ...(filters.userId === undefined ? {} : { userId: filters.userId }),
  };
}

function normalizedMeStatsQuery(filters: MeStatsFilters): ReportQuery {
  return normalizedQuery(filters);
}

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

/**
 * Ranks by position in the already-sorted rows, but shares a rank between equal
 * totals so a tie does not read as one member ahead of another.
 */
function asLeaderboardEntry(record: LeaderboardRowRecord, index: number, all: LeaderboardRowRecord[]): {
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
  const previous = index === 0 ? undefined : all[index - 1];
  const isTiedWithPrevious = previous !== undefined
    && safeInteger(previous.durationSeconds, "leaderboard duration") === durationSeconds;
  return {
    rank: isTiedWithPrevious ? sharedRank(record, index, all) : index + 1,
    user: record.user,
    durationSeconds,
    sessionCount: safeInteger(record.sessionCount, "leaderboard session count"),
    attributedSeconds,
    unattributedSeconds: Math.max(0, durationSeconds - attributedSeconds),
  };
}

function sharedRank(record: LeaderboardRowRecord, index: number, all: LeaderboardRowRecord[]): number {
  const duration = safeInteger(record.durationSeconds, "leaderboard duration");
  let first = index;
  while (first > 0 && safeInteger(all[first - 1]!.durationSeconds, "leaderboard duration") === duration) {
    first -= 1;
  }
  return first + 1;
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
      const query = normalizedQuery(filters);
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
      const query = normalizedQuery(filters);
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
      const query = normalizedQuery(filters);
      await dependencies.reaper.reapStale(subject);
      const rows = await dependencies.reports.readLeaderboardForOrganization(subject, query);
      const entries = rows.map(asLeaderboardEntry);
      return {
        filters,
        totalDurationSeconds: entries.reduce((total, entry) => total + entry.durationSeconds, 0),
        entries,
      };
    },

    async meStats(subject: AuthenticatedSubject, filters: MeStatsFilters): Promise<MeStatsResponse> {
      const query: ReportQuery = { ...normalizedMeStatsQuery(filters), userId: subject.userId };
      await dependencies.reaper.reapStale(subject);
      const projects = (await dependencies.reports.readProjectTotalsForMember(subject, query)).map(asProjectTotal);
      const apps = (await dependencies.reports.readAppTotalsForMember(subject, query)).map(asAppTotal);
      const sites = (await dependencies.reports.readSiteTotalsForMember(subject, query)).map(asSiteTotal);
      return {
        filters,
        totalDurationSeconds: projects.reduce((total, project) => total + project.durationSeconds, 0),
        attributedSeconds: projects.reduce((total, project) => total + project.attributedSeconds, 0),
        unattributedSeconds: projects.reduce((total, project) => total + project.unattributedSeconds, 0),
        projects,
        apps,
        sites,
      };
    },
  };
}
