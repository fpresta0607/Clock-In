import { z } from "zod";

const rawEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters long."),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  CORS_ORIGINS: z.string().default(""),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100).default(5),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
}).strict();

function invalidEnvironment(message: string, path: string): never {
  throw new z.ZodError([{
    code: z.ZodIssueCode.custom,
    message,
    path: [path],
  }]);
}

function parseDatabaseUrl(value: string): string {
  const protocol = new URL(value).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    return invalidEnvironment("DATABASE_URL must use postgres or postgresql.", "DATABASE_URL");
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseCorsOrigins(value: string, nodeEnv: AppConfig["nodeEnv"]): string[] {
  const origins = new Set<string>();
  for (const entry of value.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0)) {
    if (entry === "*") {
      invalidEnvironment("CORS_ORIGINS cannot include a wildcard when credentials are enabled.", "CORS_ORIGINS");
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      invalidEnvironment("CORS_ORIGINS must contain valid origins.", "CORS_ORIGINS");
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username.length > 0
      || url.password.length > 0
      || url.pathname !== "/"
      || url.search.length > 0
      || url.hash.length > 0
    ) {
      invalidEnvironment("CORS_ORIGINS must contain origins without credentials, paths, queries, or fragments.", "CORS_ORIGINS");
    }
    if (nodeEnv === "production" && url.protocol !== "https:") {
      invalidEnvironment("Production CORS origins must use HTTPS.", "CORS_ORIGINS");
    }
    if (nodeEnv !== "production" && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      invalidEnvironment("HTTP CORS origins must use a loopback host outside production.", "CORS_ORIGINS");
    }
    origins.add(url.origin);
  }
  return [...origins];
}

export interface AppConfig {
  databaseUrl: string;
  jwtSecret: string;
  port: number;
  corsOrigins: readonly string[];
  jwtTtlSeconds: number;
  loginRateLimitMax: number;
  loginRateLimitWindowSeconds: number;
  nodeEnv: "development" | "test" | "production";
}

export function parseEnv(input: Record<string, string | undefined>): AppConfig {
  const raw = rawEnvironmentSchema.parse({
    DATABASE_URL: input.DATABASE_URL,
    JWT_SECRET: input.JWT_SECRET,
    PORT: input.PORT,
    CORS_ORIGINS: input.CORS_ORIGINS,
    JWT_TTL_SECONDS: input.JWT_TTL_SECONDS,
    LOGIN_RATE_LIMIT_MAX: input.LOGIN_RATE_LIMIT_MAX,
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: input.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    NODE_ENV: input.NODE_ENV,
  });
  const databaseUrl = parseDatabaseUrl(raw.DATABASE_URL);
  const corsOrigins = parseCorsOrigins(raw.CORS_ORIGINS, raw.NODE_ENV);
  return {
    databaseUrl,
    jwtSecret: raw.JWT_SECRET,
    port: raw.PORT,
    corsOrigins,
    jwtTtlSeconds: raw.JWT_TTL_SECONDS,
    loginRateLimitMax: raw.LOGIN_RATE_LIMIT_MAX,
    loginRateLimitWindowSeconds: raw.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    nodeEnv: raw.NODE_ENV,
  };
}
