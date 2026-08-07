import { loginRequestSchema, loginResponseSchema } from "@clock-in/shared";
import { bodyLimit } from "hono/body-limit";
import { Hono, type Context, type MiddlewareHandler } from "hono";

import {
  createAuthService,
  normalizeEmail,
  verifyAccessToken,
  type AuthenticatedSubject,
  type UserCredentialStore,
} from "./auth.js";
import type { AppConfig } from "./env.js";
import { AppError, handleAppError, jsonError } from "./errors.js";

interface AppVariables {
  authenticatedSubject: AuthenticatedSubject;
  requestId: string;
}

type ApiEnvironment = { Variables: AppVariables };

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface LoginRateLimitStore {
  take(key: string, limit: number, windowMs: number, now: number): RateLimitDecision;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class MemoryLoginRateLimitStore implements LoginRateLimitStore {
  private readonly entries = new Map<string, RateLimitEntry>();

  public take(key: string, limit: number, windowMs: number, now: number): RateLimitDecision {
    for (const [entryKey, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(entryKey);
      }
    }
    const entry = this.entries.get(key) ?? { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    return {
      allowed: entry.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)),
    };
  }
}

export interface CreateAppDependencies {
  config: AppConfig;
  credentials: UserCredentialStore;
  clock?: () => Date;
  bodyLimitBytes?: number;
  loginRateLimitStore?: LoginRateLimitStore;
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
  config: AppConfig,
  clock: () => Date = () => new Date(),
): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const token = parseAuthorizationHeader(context.req.header("authorization"));
    context.set("authenticatedSubject", await verifyAccessToken(token, config, clock()));
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

function normalizeLoginRequestBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return body;
  }
  const record = body as Record<string, unknown>;
  return {
    ...record,
    email: typeof record.email === "string" ? normalizeEmail(record.email) : record.email,
  };
}

export function createApp(dependencies: CreateAppDependencies): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  const clock = dependencies.clock ?? (() => new Date());
  const auth = createAuthService({ config: dependencies.config, credentials: dependencies.credentials, clock });
  const rateLimitStore = dependencies.loginRateLimitStore ?? new MemoryLoginRateLimitStore();
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
  app.post("/auth/login", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      throw new AppError("validation_error", "Invalid request body.");
    }
    const input = loginRequestSchema.safeParse(normalizeLoginRequestBody(body));
    if (!input.success) {
      throw new AppError("validation_error", "Invalid request body.");
    }
    const now = clock().getTime();
    const rateLimit = rateLimitStore.take(
      input.data.email,
      dependencies.config.loginRateLimitMax,
      dependencies.config.loginRateLimitWindowSeconds * 1_000,
      now,
    );
    if (!rateLimit.allowed) {
      context.header("retry-after", rateLimit.retryAfterSeconds.toString());
      throw new AppError("rate_limited", "Too many login attempts. Try again later.");
    }
    return context.json(loginResponseSchema.parse(await auth.login(input.data)));
  });

  return app;
}
