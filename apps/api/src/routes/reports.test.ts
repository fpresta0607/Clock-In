import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { signAccessToken } from "../auth.js";
import { parseEnv } from "../env.js";
import type { ReportRepository, ReportRowRecord } from "../repositories.js";
import type { AuthenticatedSubject } from "../auth.js";
import { createReportRoutes } from "./reports.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  outsideProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  JWT_SECRET: "this-is-a-long-test-secret-with-enough-entropy-123",
  NODE_ENV: "test",
});
const user = { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization };

class Reports implements ReportRepository {
  public failExport: Error | null = null;
  public async findProjectForOrganization(_subject: AuthenticatedSubject, projectId: string) {
    return projectId === ids.project ? { id: ids.project, name: "Timer" } : null;
  }
  public async findUserForOrganization(_subject: AuthenticatedSubject, userId: string) {
    return userId === ids.user ? { id: ids.user, name: "Alex" } : null;
  }
  private readonly rows: ReportRowRecord[] = [{
      id: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
      user: { id: ids.user, name: "Alex" },
      project: { id: ids.project, name: "Timer" },
      description: "=formula",
      status: "stopped",
      startedAt: new Date("2026-08-06T14:00:00.000Z"),
      stoppedAt: new Date("2026-08-06T15:00:00.000Z"),
      idleSeconds: 0,
      durationSeconds: 3_600,
    }];
  public async readPageForOrganization(_subject: AuthenticatedSubject, _query: Parameters<ReportRepository["readPageForOrganization"]>[1], _options: Parameters<ReportRepository["readPageForOrganization"]>[2]) {
    return { summary: { totalRows: 1, totalDurationSeconds: "3600" }, rows: this.rows };
  }
  public async readExportForOrganization(_subject: AuthenticatedSubject, _query: Parameters<ReportRepository["readExportForOrganization"]>[1], _maxRows: number) {
    if (this.failExport !== null) throw this.failExport;
    return { summary: { totalRows: 1, totalDurationSeconds: "3600" }, rows: this.rows };
  }
}

function app(reports = new Reports()) {
  return createApp({
    config,
    credentials: { findByEmail: async () => null },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    reportRepository: reports,
  });
}

describe("report routes", () => {
  it("requires a signed bearer token", async () => {
    expect(createReportRoutes).toBeTypeOf("function");
    expect((await app().request("http://api.test/reports")).status).toBe(401);
  });

  it("returns stable validation and not-found responses", async () => {
    const token = await signAccessToken(user, config, new Date("2026-08-06T14:00:00.000Z"));
    const headers = { authorization: `Bearer ${token}` };
    const invalid = await app().request("http://api.test/reports?from=2026-08-07&to=2026-08-06", { headers });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: { code: "validation_error", message: "The report date range must be between zero and 366 days." } });
    const outside = await app().request(`http://api.test/reports?projectId=${ids.outsideProject}`, { headers });
    expect(outside.status).toBe(404);
    await expect(outside.json()).resolves.toEqual({ error: { code: "not_found", message: "Project not found." } });
  });

  it("returns the shared JSON report and a safe CSV attachment", async () => {
    const token = await signAccessToken(user, config, new Date("2026-08-06T14:00:00.000Z"));
    const headers = { authorization: `Bearer ${token}` };
    const json = await app().request("http://api.test/reports?from=2026-08-06", { headers });
    expect(json.status).toBe(200);
    await expect(json.json()).resolves.toMatchObject({ filters: { from: "2026-08-06", page: 1, pageSize: 50 }, totalDurationSeconds: 3_600, pagination: { totalRows: 1, totalPages: 1 }, rows: [{ status: "stopped" }] });
    const csv = await app().request("http://api.test/reports/export.csv?from=2026-08-06", { headers });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="clock-in-report.csv"');
    expect(csv.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(csv.text()).resolves.toContain("'=formula");
  });

  it("rejects invalid report pagination", async () => {
    const token = await signAccessToken(user, config, new Date("2026-08-06T14:00:00.000Z"));
    const response = await app().request("http://api.test/reports?pageSize=201", { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid report filters." } });
  });

  it("returns a stable JSON error before a CSV stream begins when the snapshot read fails", async () => {
    const reports = new Reports();
    reports.failExport = new Error("database unavailable");
    const token = await signAccessToken(user, config, new Date("2026-08-06T14:00:00.000Z"));
    const response = await app(reports).request("http://api.test/reports/export.csv", { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.text()).resolves.not.toContain("sessionId,userId");
  });
});
