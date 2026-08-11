import {
  currentSessionResponseSchema,
  observedSessionBatchRequestSchema,
  observedSessionBatchResponseSchema,
  sessionSchema,
  sessionStartRequestSchema,
  sessionStartResponseSchema,
  sessionStopRequestSchema,
  sessionStopResponseSchema,
  type Session,
} from "@clock-in/shared";
import { Hono } from "hono";
import { z } from "zod";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { SessionRecord } from "../repositories.js";
import type { SessionService } from "../services/sessions.js";

const sessionIdSchema = z.string().uuid();

function asSession(record: SessionRecord): Session {
  return sessionSchema.parse({
    id: record.id,
    clientId: record.clientId,
    projectId: record.projectId,
    description: record.description,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    stoppedAt: record.stoppedAt?.toISOString() ?? null,
    idleSeconds: record.idleSeconds,
    durationSeconds: record.durationSeconds,
    attribution: record.attribution,
  });
}

async function requestBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AppError("validation_error", "Invalid request body.");
  }
}

export function createSessionRoutes(service: SessionService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();

  // The desktop's only write path: finished sessions the monitor observed.
  routes.post("/observed", async (context) => {
    const input = observedSessionBatchRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const result = await service.recordObserved(
      getAuthenticatedSubject(context),
      input.data.sessions.map((session) => ({
        clientId: session.clientId,
        projectId: session.projectId,
        attribution: session.attribution,
        startedAt: new Date(session.startedAt),
        stoppedAt: new Date(session.stoppedAt),
        idleSeconds: session.idleSeconds,
      })),
    );
    return context.json(observedSessionBatchResponseSchema.parse(result));
  });

  // Deprecated: the manual timer is retired and no shipped client calls these.
  // They stay so an older installed build can still finish and upload its work.
  routes.post("/", async (context) => {
    const input = sessionStartRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const session = await service.start(getAuthenticatedSubject(context), {
      clientId: input.data.clientId,
      ...(input.data.projectId === undefined ? {} : { projectId: input.data.projectId }),
      deviceId: input.data.deviceId,
      ...(input.data.description === undefined ? {} : { description: input.data.description }),
      ...(input.data.startedAt === undefined ? {} : { startedAt: new Date(input.data.startedAt) }),
    });
    return context.json(sessionStartResponseSchema.parse({ session: asSession(session) }));
  });
  routes.post("/:id/stop", async (context) => {
    const sessionId = sessionIdSchema.safeParse(context.req.param("id"));
    if (!sessionId.success) throw new AppError("validation_error", "Invalid session id.");
    const input = sessionStopRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const session = await service.stop(getAuthenticatedSubject(context), sessionId.data, {
      stoppedAt: new Date(input.data.stoppedAt),
      idleSeconds: input.data.idleSeconds,
    });
    return context.json(sessionStopResponseSchema.parse({ session: asSession(session) }));
  });
  routes.get("/current", async (context) => {
    const session = await service.current(getAuthenticatedSubject(context));
    return context.json(currentSessionResponseSchema.parse({ session: session === null ? null : asSession(session) }));
  });
  return routes;
}
