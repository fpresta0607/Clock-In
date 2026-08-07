import { meResponseSchema } from "@clock-in/shared";
import { bodyLimit } from "hono/body-limit";
import type { JWTVerifyGetKey } from "jose";
import { Hono, type Context, type MiddlewareHandler } from "hono";

import {
  verifyIdentity,
  type AccountStore,
  type AuthenticatedSubject,
  type AuthenticatedUser,
} from "./auth.js";
import type { AppConfig } from "./env.js";
import { AppError, handleAppError, jsonError } from "./errors.js";
import type { ProjectRepository, ReportRepository, SessionRepository } from "./repositories.js";
import { createProjectRoutes } from "./routes/projects.js";
import { createReportRoutes } from "./routes/reports.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createReportService } from "./services/reports.js";
import { createSessionService } from "./services/sessions.js";

export interface AppVariables {
  authenticatedSubject: AuthenticatedSubject;
  authenticatedUser: AuthenticatedUser;
  requestId: string;
}

export type ApiEnvironment = { Variables: AppVariables };

export interface CreateAppDependencies {
  config: AppConfig;
  keys: JWTVerifyGetKey;
  accounts: AccountStore;
  clock?: () => Date;
  bodyLimitBytes?: number;
  projectRepository?: ProjectRepository;
  reportRepository?: ReportRepository;
  sessionRepository?: SessionRepository;
}

function addSecurityHeaders(context: Context): void {
  context.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  context.header("referrer-policy", "no-referrer");
  context.header("x-content-type-options", "nosniff");
  context.header("x-frame-options", "DENY");
  context.header("cross-origin-resource-policy", "same-origin");
}

function createCorsMiddleware(config: AppConfig): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const origin = context.req.header("origin");
    const allowed = origin !== undefined && config.corsOrigins.includes(origin);
    if (origin !== undefined) {
      context.header("vary", "origin", { append: true });
    }
    if (allowed) {
      context.header("access-control-allow-origin", origin);
      context.header("access-control-allow-credentials", "true");
      context.header("access-control-expose-headers", "x-request-id");
    }
    if (context.req.method === "OPTIONS") {
      if (allowed) {
        context.header("access-control-allow-methods", "GET,POST,OPTIONS");
        context.header("access-control-allow-headers", "authorization,content-type");
        context.header("access-control-max-age", "600");
      }
      return context.body(null, 204);
    }
    await next();
  };
}

function parseAuthorizationHeader(header: string | undefined): string {
  const match = header === undefined ? null : /^Bearer ([^\s]+)$/i.exec(header);
  if (match?.[1] === undefined) {
    throw new AppError("unauthorized", "Authentication is required.");
  }
  return match[1];
}

export function createAuthenticationMiddleware(
  dependencies: Pick<CreateAppDependencies, "config" | "keys" | "accounts">,
  clock: () => Date = () => new Date(),
): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const token = parseAuthorizationHeader(context.req.header("authorization"));
    const identity = await verifyIdentity(token, dependencies.keys, dependencies.config, clock());
    const user = await dependencies.accounts.resolve(identity);
    context.set("authenticatedUser", user);
    context.set("authenticatedSubject", { userId: user.id, organizationId: user.organizationId });
    await next();
  };
}

export function getAuthenticatedSubject(context: Context<ApiEnvironment>): AuthenticatedSubject {
  const subject = context.get("authenticatedSubject");
  if (subject === undefined) {
    throw new AppError("unauthorized", "Authentication is required.");
  }
  return subject;
}

export function createApp(dependencies: CreateAppDependencies): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  const clock = dependencies.clock ?? (() => new Date());
  const authenticate = createAuthenticationMiddleware(dependencies, clock);
  const bodyLimitBytes = dependencies.bodyLimitBytes ?? 1_048_576;

  app.onError(handleAppError);
  app.notFound((context) => jsonError(context, new AppError("not_found", "Route not found.")));
  app.use("*", async (context, next) => {
    const requestId = crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    addSecurityHeaders(context);
    await next();
  });
  app.use("*", createCorsMiddleware(dependencies.config));
  app.use("*", bodyLimit({
    maxSize: bodyLimitBytes,
    onError: (context) => jsonError(context, new AppError("validation_error", "Request body is too large."), 413),
  }));

  app.get("/health", (context) => context.json({ status: "ok" }));

  app.use("/me", authenticate);
  app.get("/me", (context) => context.json(meResponseSchema.parse({ user: context.get("authenticatedUser") })));

  if (dependencies.projectRepository !== undefined) {
    app.use("/projects", authenticate);
    app.use("/projects/*", authenticate);
    app.route("/projects", createProjectRoutes(dependencies.projectRepository));
  }
  if (dependencies.sessionRepository !== undefined) {
    if (dependencies.projectRepository === undefined) {
      throw new Error("A project repository is required for session routes.");
    }
    const sessionService = createSessionService({
      projects: dependencies.projectRepository,
      sessions: dependencies.sessionRepository,
      clock,
    });
    app.use("/sessions", authenticate);
    app.use("/sessions/*", authenticate);
    app.route("/sessions", createSessionRoutes(sessionService));
  }
  if (dependencies.reportRepository !== undefined) {
    app.use("/reports", authenticate);
    app.use("/reports/*", authenticate);
    app.route("/reports", createReportRoutes(createReportService({ reports: dependencies.reportRepository })));
  }

  return app;
}
