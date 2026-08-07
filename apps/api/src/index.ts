import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Env, Hono } from "hono";

import type { AppConfig } from "./env.js";

export { createApp, createAuthenticationMiddleware, getAuthenticatedSubject } from "./app.js";
export type { CreateAppDependencies } from "./app.js";
export { createNeonAuthKeys, verifyIdentity } from "./auth.js";
export type { AccountStore, AuthenticatedSubject, AuthenticatedUser, AuthIdentity } from "./auth.js";
export { parseEnv } from "./env.js";
export type { AppConfig } from "./env.js";
export { AppError } from "./errors.js";
export { DrizzleAccountStore, DrizzleProjectRepository, DrizzleReportRepository, DrizzleSessionRepository } from "./drizzle-repositories.js";
export { createProjectRoutes } from "./routes/projects.js";
export { createReportRoutes } from "./routes/reports.js";
export { createSessionRoutes } from "./routes/sessions.js";
export { listProjects } from "./services/projects.js";
export { createReportService } from "./services/reports.js";
export { createSessionService } from "./services/sessions.js";
export { SessionRepositoryError } from "./repositories.js";
export type {
  CreateRunningSession,
  ProjectRecord,
  ProjectRepository,
  ReportLookupRecord,
  ReportExportRead,
  ReportPageOptions,
  ReportPageRead,
  ReportQuery,
  ReportRepository,
  ReportRowRecord,
  ReportSummaryRecord,
  SessionRecord,
  SessionRepository,
  SessionRepositoryConflict,
  StopRunningSession,
} from "./repositories.js";
export type { SessionService, SessionServiceDependencies, StartSessionInput, StopSessionInput } from "./services/sessions.js";
export type { ReportService, ReportServiceDependencies } from "./services/reports.js";

export function serveApp<E extends Env>(app: Hono<E>, config: Pick<AppConfig, "port">): ServerType {
  return serve({ fetch: app.fetch, port: config.port });
}
