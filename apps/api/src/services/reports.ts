import type { ReportFilters, ReportResponse, ReportRow } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type { ReportQuery, ReportRepository, ReportRowRecord } from "../repositories.js";

export interface ReportService {
  list(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportResponse>;
}

export interface ReportServiceDependencies {
  reports: ReportRepository;
}

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

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

function compareRows(left: ReportRowRecord, right: ReportRowRecord): number {
  const byStart = right.startedAt.getTime() - left.startedAt.getTime();
  if (byStart !== 0) return byStart;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function totalDuration(rows: ReportRowRecord[]): number {
  return rows.reduce((total, row) => {
    const next = total + row.durationSeconds;
    if (!Number.isSafeInteger(row.durationSeconds) || row.durationSeconds < 0 || !Number.isSafeInteger(next)) {
      throw new RangeError("Report duration total exceeds the safe integer range.");
    }
    return next;
  }, 0);
}

export function createReportService(dependencies: ReportServiceDependencies): ReportService {
  return {
    async list(subject: AuthenticatedSubject, filters: ReportFilters): Promise<ReportResponse> {
      const query = normalizedQuery(filters);
      if (query.projectId !== undefined && await dependencies.reports.findProjectForOrganization(subject, query.projectId) === null) {
        throw new AppError("not_found", "Project not found.");
      }
      if (query.userId !== undefined && await dependencies.reports.findUserForOrganization(subject, query.userId) === null) {
        throw new AppError("not_found", "User not found.");
      }
      const rows = await dependencies.reports.listForOrganization(subject, query);
      rows.sort(compareRows);
      return { filters, totalDurationSeconds: totalDuration(rows), rows: rows.map(asReportRow) };
    },
  };
}
