import { agentSessionEventBatchRequestSchema, agentSessionEventBatchResponseSchema } from "@clock-in/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { AgentSessionService } from "../services/agent-sessions.js";

async function requestBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AppError("validation_error", "Invalid request body.");
  }
}

export function createAgentSessionRoutes(service: AgentSessionService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post("/", async (context) => {
    const input = agentSessionEventBatchRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const result = await service.ingest(getAuthenticatedSubject(context), input.data.events.map((event) => ({
      source: event.source,
      externalSessionId: event.externalSessionId,
      event: event.event,
      occurredAt: new Date(event.occurredAt),
      ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
      ...(event.ruleId === undefined ? {} : { ruleId: event.ruleId }),
    })));
    return context.json(agentSessionEventBatchResponseSchema.parse(result));
  });
  return routes;
}
