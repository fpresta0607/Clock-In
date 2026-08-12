import { viewPreferencesSchema, viewPreferencesUpdateSchema } from "@clock-in/shared";
import { Hono } from "hono";

import { getAuthenticatedSubject, type ApiEnvironment } from "../app.js";
import { AppError } from "../errors.js";
import type { ProjectRepository, ViewPreferencesRepository } from "../repositories.js";

/**
 * The dashboard view state both surfaces share: project scope and time range.
 * Reads fall back to the defaults, and a scope naming a project that has since
 * been deleted or archived reads as `all` rather than a broken filter.
 */
export function createPreferencesRoutes(
  repository: ViewPreferencesRepository,
  projects: ProjectRepository,
): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();

  routes.get("/", async (context) => {
    const subject = getAuthenticatedSubject(context);
    const stored = await repository.readForMember(subject);
    let scope = stored?.scope ?? "all";
    if (scope !== "all" && scope !== "unassigned" && await projects.findForMember(subject, scope) === null) {
      scope = "all";
    }
    return context.json(viewPreferencesSchema.parse({ scope, range: stored?.range ?? "30d" }));
  });

  routes.put("/", async (context) => {
    const subject = getAuthenticatedSubject(context);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      throw new AppError("validation_error", "Invalid request body.");
    }
    const input = viewPreferencesUpdateSchema.safeParse(body);
    if (!input.success) throw new AppError("validation_error", "Invalid view preferences.");
    const scope = input.data.scope;
    if (scope !== undefined && scope !== "all" && scope !== "unassigned"
      && await projects.findForMember(subject, scope) === null) {
      throw new AppError("not_found", "Project not found.");
    }
    const written = await repository.writeForMember(subject, input.data);
    return context.json(viewPreferencesSchema.parse(written));
  });

  return routes;
}
