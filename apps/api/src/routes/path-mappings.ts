import {
  pathMappingCreateRequestSchema,
  pathMappingListResponseSchema,
  pathMappingUpdateRequestSchema,
  projectPathMappingSchema,
  type ProjectPathMapping,
} from "@siqshift/shared";
import { Hono } from "hono";
import { z } from "zod";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { PathMappingRecord } from "../repositories.js";
import type { PathMappingService } from "../services/path-mappings.js";

const mappingIdSchema = z.string().uuid();

function asMapping(record: PathMappingRecord): ProjectPathMapping {
  return projectPathMappingSchema.parse({
    id: record.id,
    kind: record.kind,
    pathPrefix: record.pathPrefix,
    repoUrl: record.repoUrl,
    projectId: record.projectId,
  });
}

async function requestBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AppError("validation_error", "Invalid request body.");
  }
}

function mappingId(context: { req: { param(name: string): string } }): string {
  const parsed = mappingIdSchema.safeParse(context.req.param("id"));
  if (!parsed.success) throw new AppError("validation_error", "Invalid path mapping id.");
  return parsed.data;
}

export function createPathMappingRoutes(service: PathMappingService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get("/", async (context) => {
    const mappings = await service.list(getAuthenticatedSubject(context));
    return context.json(pathMappingListResponseSchema.parse({ mappings: mappings.map(asMapping) }));
  });
  routes.post("/", async (context) => {
    const input = pathMappingCreateRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const created = await service.create(getAuthenticatedSubject(context), {
      kind: input.data.kind,
      pathPrefix: input.data.pathPrefix,
      ...(input.data.repoUrl === undefined ? {} : { repoUrl: input.data.repoUrl }),
      projectId: input.data.projectId,
    });
    return context.json(asMapping(created));
  });
  routes.patch("/:id", async (context) => {
    const id = mappingId(context);
    const input = pathMappingUpdateRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const updated = await service.update(getAuthenticatedSubject(context), id, {
      ...(input.data.kind === undefined ? {} : { kind: input.data.kind }),
      ...(input.data.pathPrefix === undefined ? {} : { pathPrefix: input.data.pathPrefix }),
      ...(input.data.repoUrl === undefined ? {} : { repoUrl: input.data.repoUrl }),
      ...(input.data.projectId === undefined ? {} : { projectId: input.data.projectId }),
    });
    return context.json(asMapping(updated));
  });
  routes.delete("/:id", async (context) => {
    await service.remove(getAuthenticatedSubject(context), mappingId(context));
    return context.body(null, 204);
  });
  return routes;
}
