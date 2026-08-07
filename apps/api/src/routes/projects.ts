import { projectListResponseSchema } from "@clock-in/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import type { ProjectRepository } from "../repositories.js";
import { listProjects } from "../services/projects.js";

export function createProjectRoutes(repository: ProjectRepository): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get("/", async (context) => context.json(projectListResponseSchema.parse(
    await listProjects(repository, getAuthenticatedSubject(context)),
  )));
  return routes;
}
