import { reportFiltersSchema, reportResponseSchema } from "@clock-in/shared";
import { Hono } from "hono";
import { streamText } from "hono/streaming";

import { reportCsvHeader, reportCsvRow, reportCsvTotal } from "../csv.js";
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
    const report = await service.export(getAuthenticatedSubject(context), requestFilters(context));
    const response = streamText(context, async (stream) => {
      await stream.write(reportCsvHeader());
      for (const row of report.rows) await stream.write(reportCsvRow(row));
      await stream.write(reportCsvTotal(report.totalDurationSeconds));
    });
    response.headers.set("content-type", "text/csv; charset=utf-8");
    response.headers.set("content-disposition", 'attachment; filename="clock-in-report.csv"');
    return response;
  });
  return routes;
}
