import { projectCreateRequestSchema, projectListItemSchema, projectListResponseSchema, projectUpdateRequestSchema } from "@clock-in/shared";
import { Hono } from "hono";
import { z } from "zod";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { ProjectRepository } from "../repositories.js";
import { createProject, listProjects, updateProject } from "../services/projects.js";

const projectIdSchema = z.string().uuid();

async function requestBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AppError("validation_error", "Invalid request body.");
  }
}

export function createProjectRoutes(repository: ProjectRepository): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get("/", async (context) => context.json(projectListResponseSchema.parse(
    await listProjects(repository, getAuthenticatedSubject(context)),
  )));
  routes.post("/", async (context) => {
    const input = projectCreateRequestSchema.safeParse(await requestBody(context));
    if (!input.success) throw new AppError("validation_error", "Invalid request body.");
    const created = await createProject(repository, getAuthenticatedSubject(context), input.data.name);
    return context.json(projectListItemSchema.parse(created), 201);
  });
  routes.patch("/:id", async (context) => {
    const projectId = projectIdSchema.safeParse(context.req.param("id"));
    const input = projectUpdateRequestSchema.safeParse(await requestBody(context));
    if (!projectId.success || !input.success) throw new AppError("validation_error", "Invalid request body.");
    return context.json(projectListItemSchema.parse(await updateProject(
      repository,
      getAuthenticatedSubject(context),
      projectId.data,
      input.data,
    )));
  });
  routes.delete("/:id", async (context) => {
    const projectId = projectIdSchema.safeParse(context.req.param("id"));
    const input = projectUpdateRequestSchema.safeParse(await requestBody(context));
    if (!projectId.success || !input.success) throw new AppError("validation_error", "Invalid request body.");
    return context.json(projectListItemSchema.parse(await updateProject(
      repository,
      getAuthenticatedSubject(context),
      projectId.data,
      { ...input.data, isArchived: true },
    )));
  });
  return routes;
}
