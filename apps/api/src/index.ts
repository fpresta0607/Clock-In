import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Env, Hono } from "hono";

import type { AppConfig } from "./env.js";

export { createApp, createAuthenticationMiddleware, createIdentityMiddleware, getAuthenticatedSubject } from "./app.js";
export type { CreateAppDependencies } from "./app.js";
export { createNeonAuthKeys, verifyIdentity } from "./auth.js";
export type { AccountStore, AuthenticatedSubject, AuthenticatedUser, AuthIdentity, FirstAdminClaimResult, OrganizationRecord } from "./auth.js";
export { parseEnv } from "./env.js";
export type { AppConfig } from "./env.js";
export { AppError } from "./errors.js";
export {
  DrizzleAccountStore,
  DrizzleActivitySegmentRepository,
  DrizzleAgentSessionRepository,
  DrizzlePathMappingRepository,
  DrizzleProjectRepository,
  DrizzleReportRepository,
  DrizzleSessionRepository,
} from "./drizzle-repositories.js";
export { createActivityRoutes } from "./routes/activity.js";
export { createAgentSessionRoutes } from "./routes/agent-sessions.js";
export { createMeStatsRoutes } from "./routes/me-stats.js";
export { createPathMappingRoutes } from "./routes/path-mappings.js";
export { createProjectRoutes } from "./routes/projects.js";
export { createReportRoutes } from "./routes/reports.js";
export { createSessionRoutes } from "./routes/sessions.js";
export { createActivityService } from "./services/activity.js";
export { createAgentSessionReaper, createAgentSessionService } from "./services/agent-sessions.js";
export { normalizePath, resolveProjectForCwd, resolveProjectForRuleId } from "./services/attribution.js";
export { createPathMappingService } from "./services/path-mappings.js";
export { listProjects } from "./services/projects.js";
export { createReportService } from "./services/reports.js";
export { createSessionService } from "./services/sessions.js";
export { PathMappingRepositoryError, SessionRepositoryError } from "./repositories.js";
export type {
  ActivitySegmentInsert,
  ActivitySegmentRepository,
  AgentSessionRecord,
  AgentSessionRepository,
  CreatePathMapping,
  CreateRunningSession,
  InsertEndedAgentSession,
  PathMappingRecord,
  PathMappingRepository,
  PathMappingRepositoryConflict,
  ProjectRecord,
  ProjectRepository,
  ProjectTotalRecord,
  LeaderboardRowRecord,
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
  SiteTotalRecord,
  StopRunningSession,
  UpdatePathMapping,
  UpsertStartedAgentSession,
} from "./repositories.js";
export type { ActivityService, ActivityServiceDependencies, ActivitySegmentInput } from "./services/activity.js";
export type { AgentSessionEventInput, AgentSessionReaper, AgentSessionService, AgentSessionServiceDependencies } from "./services/agent-sessions.js";
export type { PathMappingCandidate, UrlRuleCandidate } from "./services/attribution.js";
export type {
  CreatePathMappingInput,
  PathMappingService,
  PathMappingServiceDependencies,
  UpdatePathMappingInput,
} from "./services/path-mappings.js";
export type { SessionService, SessionServiceDependencies, StartSessionInput, StopSessionInput } from "./services/sessions.js";
export type { ReportService, ReportServiceDependencies } from "./services/reports.js";

export function serveApp<E extends Env>(app: Hono<E>, config: Pick<AppConfig, "port">): ServerType {
  return serve({ fetch: app.fetch, port: config.port });
}
