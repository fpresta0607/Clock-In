import { meStatsFiltersSchema, meStatsResponseSchema } from "@clock-in/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { ReportService } from "../services/reports.js";

export function createMeStatsRoutes(service: ReportService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get("/", async (context) => {
    const parsed = meStatsFiltersSchema.safeParse(context.req.query());
    if (!parsed.success) throw new AppError("validation_error", "Invalid stats filters.");
    return context.json(meStatsResponseSchema.parse(
      await service.meStats(getAuthenticatedSubject(context), parsed.data),
    ));
  });
  return routes;
}
