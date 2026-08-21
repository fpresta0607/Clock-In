import { activitySegmentBatchRequestSchema, activitySegmentBatchResponseSchema } from "@siqshift/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { ActivityService } from "../services/activity.js";

async function requestBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AppError("validation_error", "Invalid request body.");
  }
}

export function createActivityRoutes(service: ActivityService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post("/segments", async (context) => {
    const input = activitySegmentBatchRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const result = await service.upload(getAuthenticatedSubject(context), input.data.segments.map((segment) => ({
      clientId: segment.clientId,
      deviceId: segment.deviceId,
      kind: segment.kind,
      ...(segment.processName === undefined ? {} : { processName: segment.processName }),
      startedAt: new Date(segment.startedAt),
      endedAt: new Date(segment.endedAt),
    })));
    return context.json(activitySegmentBatchResponseSchema.parse(result));
  });
  return routes;
}
