import type { ReportFilters, ReportResponse, ReportRow } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type { ReportQuery, ReportRepository, ReportRowRecord, ReportSummaryRecord } from "../repositories.js";

export interface ReportService {
  list(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportResponse>;
  export(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportExport>;
}

export interface ReportExport {
  totalDurationSeconds: number;
  rows: ReportRow[];
}

export interface ReportServiceDependencies {
  reports: ReportRepository;
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

function normalizedQuery(filters: ReportFilters): ReportQuery {
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

function asReportRow(record: ReportRowRecord): ReportRow {
  return {
    id: record.id,
    user: record.user,
    project: record.project,
    description: record.description,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    stoppedAt: record.stoppedAt.toISOString(),
    idleSeconds: record.idleSeconds,
    durationSeconds: record.durationSeconds,
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

export function createReportService(dependencies: ReportServiceDependencies): ReportService {
  return {
    async list(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportResponse> {
      validatePagination(filters);
      const query = normalizedQuery(filters);
      await authorizeFilters(dependencies.reports, subject, query);
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
  };
}
