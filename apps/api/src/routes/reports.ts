import { reportFiltersSchema, reportResponseSchema } from "@clock-in/shared";
import { Hono } from "hono";

import { reportToCsv } from "../csv.js";
import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { ReportService } from "../services/reports.js";

function requestFilters(context: { req: { query(): Record<string, string | undefined> } }) {
  const parsed = reportFiltersSchema.safeParse(context.req.query());
  if (!parsed.success) throw new AppError("validation_error", "Invalid report filters.");
  return parsed.data;
}

export function createReportRoutes(service: ReportService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get("/", async (context) => context.json(reportResponseSchema.parse(
    await service.list(getAuthenticatedSubject(context), requestFilters(context)),
  )));
  routes.get("/export.csv", async (context) => {
    const report = reportResponseSchema.parse(await service.list(getAuthenticatedSubject(context), requestFilters(context)));
    return new Response(reportToCsv(report), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="clock-in-report.csv"',
      },
    });
  });
  return routes;
}
