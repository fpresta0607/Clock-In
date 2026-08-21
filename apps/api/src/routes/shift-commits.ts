import { shiftCommitBatchRequestSchema, shiftCommitBatchResponseSchema } from "@siqshift/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { ShiftCommitService } from "../services/shift-commits.js";

export function createShiftCommitRoutes(service: ShiftCommitService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post("/", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      throw new AppError("validation_error", "Invalid request body.");
    }
    const input = shiftCommitBatchRequestSchema.safeParse(body);
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    return context.json(shiftCommitBatchResponseSchema.parse(
      await service.ingest(getAuthenticatedSubject(context), input.data.commits),
    ));
  });
  return routes;
}
