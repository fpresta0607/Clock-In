import { describe, expect, it } from "vitest";
import type { ReportFilters } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type { ReportPageQuery, ReportRepository, ReportRowRecord } from "../repositories.js";
import { createReportService } from "./reports.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  session: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user };

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
    ...overrides,
  };
}

class Reports implements ReportRepository {
  public lastQuery: Parameters<ReportRepository["listForOrganization"]>[1] | null = null;
  public constructor(private readonly rows: ReportRowRecord[] = [], private readonly accessible = new Set([ids.project, ids.user])) {}
  public async findProjectForOrganization(_subject: AuthenticatedSubject, projectId: string) {
    return this.accessible.has(projectId) && projectId === ids.project ? { id: projectId, name: "Timer" } : null;
  }
  public async findUserForOrganization(_subject: AuthenticatedSubject, userId: string) {
    return this.accessible.has(userId) && userId === ids.user ? { id: userId, name: "Alex" } : null;
  }
  public async listForOrganization(_subject: AuthenticatedSubject, query: Parameters<ReportRepository["listForOrganization"]>[1]) {
    this.lastQuery = query;
    return this.rows;
  }

  public async summarizeForOrganization() {
    return { totalRows: this.rows.length, totalDurationSeconds: this.rows.reduce((total, record) => total + record.durationSeconds, 0) };
  }

  public async listPageForOrganization(_subject: AuthenticatedSubject, query: ReportPageQuery) {
    this.lastQuery = query;
    return this.rows.slice(query.offset, query.offset + query.limit);
  }
}

describe("report service", () => {
  it("scopes report queries to the authenticated organization and normalizes inclusive UTC calendar bounds", async () => {
    const reports = new Reports([row({ id: ids.otherProject, durationSeconds: 60, startedAt: new Date("2026-08-06T16:00:00.000Z") }), row()]);
    const service = createReportService({ reports });

    await expect(service.list(subject, { from: "2026-08-01", to: "2026-08-06", projectId: ids.project, userId: ids.user, page: 1, pageSize: 50 })).resolves.toMatchObject({
      filters: { from: "2026-08-01", to: "2026-08-06", projectId: ids.project, userId: ids.user, page: 1, pageSize: 50 },
      totalDurationSeconds: 3_600,
      rows: [{ id: ids.otherProject }, { id: ids.session }],
    });
    expect(reports.lastQuery).toEqual({
      from: new Date("2026-08-01T00:00:00.000Z"),
      toExclusive: new Date("2026-08-07T00:00:00.000Z"),
      projectId: ids.project,
      userId: ids.user,
      limit: 50,
      offset: 0,
    });
  });

  it("returns an empty report with a zero total", async () => {
    await expect(createReportService({ reports: new Reports() }).list(subject, { page: 1, pageSize: 50 })).resolves.toEqual({ filters: { page: 1, pageSize: 50 }, totalDurationSeconds: 0, pagination: { page: 1, pageSize: 50, totalRows: 0, totalPages: 0 }, rows: [] });
  });

  it("rejects reversed or excessive date ranges", async () => {
    const service = createReportService({ reports: new Reports() });
    await expect(service.list(subject, { from: "2026-08-07", to: "2026-08-06", page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "validation_error" });
    await expect(service.list(subject, { from: "2025-01-01", to: "2026-01-02", page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("defends the repository from pathological page offsets", async () => {
    const service = createReportService({ reports: new Reports() });
    await expect(service.list(subject, { page: 10_001, pageSize: 1 } as ReportFilters)).rejects.toMatchObject({ code: "validation_error" });
  });

  it("returns stable not_found for project and user filters outside the subject organization", async () => {
    const service = createReportService({ reports: new Reports([], new Set()) });
    await expect(service.list(subject, { projectId: ids.otherProject, page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "not_found", message: "Project not found." });
    await expect(service.list(subject, { userId: ids.otherUser, page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "not_found", message: "User not found." });
  });

  it("rejects unsafe report duration totals", async () => {
    const service = createReportService({ reports: new Reports([row({ durationSeconds: Number.MAX_SAFE_INTEGER }), row({ id: ids.otherProject, durationSeconds: 1 })]) });
    await expect(service.list(subject, { page: 1, pageSize: 50 })).rejects.toThrow(RangeError);
  });

  it("uses the exact filtered summary while returning only the requested deterministic page", async () => {
    const reports = new Reports([
      row({ id: "b1c7e513-b094-4d4c-ae55-21790ae019a4", startedAt: new Date("2026-08-06T14:00:00.000Z") }),
      row({ id: "a1c7e513-b094-4d4c-ae55-21790ae019a4", startedAt: new Date("2026-08-06T14:00:00.000Z"), durationSeconds: 60 }),
    ]);
    const result = await createReportService({ reports }).list(subject, { page: 2, pageSize: 1 });

    expect(result).toMatchObject({
      totalDurationSeconds: 3_600,
      pagination: { page: 2, pageSize: 1, totalRows: 2, totalPages: 2 },
      rows: [{ id: "a1c7e513-b094-4d4c-ae55-21790ae019a4" }],
    });
  });

  it("rejects oversized exports before fetching rows and fetches valid exports in bounded batches", async () => {
    const oversized = new Reports();
    oversized.summarizeForOrganization = async () => ({ totalRows: 10_001, totalDurationSeconds: 0 });
    let oversizedFetches = 0;
    oversized.listPageForOrganization = async () => {
      oversizedFetches += 1;
      return [];
    };
    const oversizedService = createReportService({ reports: oversized });
    await expect(oversizedService.export(subject, { page: 1, pageSize: 50 })).rejects.toMatchObject({ code: "validation_error" });
    expect(oversizedFetches).toBe(0);

    const exported = new Reports([row()]);
    const calls: Array<{ limit: number; offset: number }> = [];
    exported.listPageForOrganization = async (_subject: AuthenticatedSubject, query: { limit: number; offset: number }) => {
      calls.push(query);
      return query.offset === 0 ? [row()] : [];
    };
    const exportService = createReportService({ reports: exported });
    const result = await exportService.export(subject, { page: 1, pageSize: 50 });
    for await (const _chunk of result.rows) { /* consume */ }
    expect(calls).toEqual([{ limit: 1, offset: 0 }]);
  });
});
