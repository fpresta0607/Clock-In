import {
  agentMergeRequestSchema,
  agentPatchRequestSchema,
  agentPaystubFiltersSchema,
  agentPaystubResponseSchema,
  agentSchema,
  agentsListResponseSchema,
} from "@clock-in/shared";
import { Hono } from "hono";
import { z } from "zod";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import { asAgentView, type AgentService } from "../services/agents.js";

const agentIdSchema = z.string().uuid();

function agentId(context: { req: { param(name: string): string } }): string {
  const parsed = agentIdSchema.safeParse(context.req.param("id"));
  if (!parsed.success) throw new AppError("validation_error", "Invalid agent id.");
  return parsed.data;
}

async function requestBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AppError("validation_error", "Invalid request body.");
  }
}

export function createAgentRoutes(service: AgentService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();

  routes.get("/", async (context) => {
    const subject = getAuthenticatedSubject(context);
    const records = await service.list(subject);
    return context.json(agentsListResponseSchema.parse({ agents: records.map((record) => asAgentView(record, subject)) }));
  });

  routes.patch("/:id", async (context) => {
    const id = agentId(context);
    const input = agentPatchRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const subject = getAuthenticatedSubject(context);
    const updated = await service.patch(subject, id, {
      ...(input.data.name === undefined ? {} : { name: input.data.name }),
      ...(input.data.status === undefined ? {} : { status: input.data.status }),
      ...(input.data.ownerUserId === undefined ? {} : { ownerUserId: input.data.ownerUserId }),
    });
    return context.json(agentSchema.parse(asAgentView(updated, subject)));
  });

  routes.post("/:id/merge", async (context) => {
    const winnerId = agentId(context);
    const input = agentMergeRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    await service.merge(getAuthenticatedSubject(context), winnerId, input.data.loserId);
    return context.body(null, 204);
  });

  routes.get("/:id/paystub", async (context) => {
    const id = agentId(context);
    const filters = agentPaystubFiltersSchema.safeParse(context.req.query());
    if (!filters.success) throw new AppError("validation_error", "Invalid paystub filters.");
    return context.json(agentPaystubResponseSchema.parse(
      await service.paystub(getAuthenticatedSubject(context), id, filters.data),
    ));
  });

  return routes;
}
