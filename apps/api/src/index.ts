import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";

import type { AppConfig } from "./env.js";

export { createApp, createAuthenticationMiddleware, getAuthenticatedSubject, MemoryLoginRateLimitStore } from "./app.js";
export type { ClientKeyResolver, CreateAppDependencies, LoginRateLimitStore, RateLimitDecision } from "./app.js";
export { createAuthService, hashPassword, normalizeEmail, signAccessToken, verifyAccessToken } from "./auth.js";
export type {
  AuthenticatedSubject,
  AuthenticatedUser,
  AuthServiceDependencies,
  UserCredential,
  UserCredentialStore,
} from "./auth.js";
export { parseEnv } from "./env.js";
export type { AppConfig } from "./env.js";
export { AppError } from "./errors.js";
export { DrizzleProjectRepository, DrizzleSessionRepository } from "./drizzle-repositories.js";
export { createProjectRoutes } from "./routes/projects.js";
export { createSessionRoutes } from "./routes/sessions.js";
export { listProjects } from "./services/projects.js";
export { createSessionService } from "./services/sessions.js";
export { SessionRepositoryError } from "./repositories.js";
export type {
  CreateRunningSession,
  ProjectRecord,
  ProjectRepository,
  SessionRecord,
  SessionRepository,
  SessionRepositoryConflict,
  StopRunningSession,
} from "./repositories.js";
export type { SessionService, SessionServiceDependencies, StartSessionInput, StopSessionInput } from "./services/sessions.js";

export function serveApp(app: Hono, config: Pick<AppConfig, "port">): ServerType {
  return serve({ fetch: app.fetch, port: config.port });
}
