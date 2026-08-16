import { agentUsageBatchRequestSchema, agentUsageBatchResponseSchema } from "@clock-in/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { AgentUsageService } from "../services/agent-usage.js";

export function createAgentUsageRoutes(service: AgentUsageService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post("/", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      throw new AppError("validation_error", "Invalid request body.");
    }
    const input = agentUsageBatchRequestSchema.safeParse(body);
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    return context.json(agentUsageBatchResponseSchema.parse(
      await service.ingest(getAuthenticatedSubject(context), input.data.usage),
    ));
  });
  return routes;
}
