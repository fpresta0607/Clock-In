import { z } from "zod";

const rawEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_BASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  CORS_ORIGINS: z.string().default(""),
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

function parseAuthBaseUrl(value: string): { authJwksUrl: string; authIssuer: string } {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    return invalidEnvironment("AUTH_BASE_URL must use HTTPS outside loopback.", "AUTH_BASE_URL");
  }
  // Neon Auth issues tokens whose iss and aud are the origin of the auth host,
  // while JWKS lives under the branch-scoped base path.
  return {
    authJwksUrl: new URL(`${url.pathname.replace(/\/$/, "")}/.well-known/jwks.json`, url.origin).toString(),
    authIssuer: url.origin,
  };
}

export interface AppConfig {
  databaseUrl: string;
  authJwksUrl: string;
  authIssuer: string;
  port: number;
  corsOrigins: readonly string[];
  nodeEnv: "development" | "test" | "production";
}

export function parseEnv(input: Record<string, string | undefined>): AppConfig {
  const raw = rawEnvironmentSchema.parse({
    DATABASE_URL: input.DATABASE_URL,
    AUTH_BASE_URL: input.AUTH_BASE_URL,
    PORT: input.PORT,
    CORS_ORIGINS: input.CORS_ORIGINS,
    NODE_ENV: input.NODE_ENV,
  });
  return {
    databaseUrl: parseDatabaseUrl(raw.DATABASE_URL),
    ...parseAuthBaseUrl(raw.AUTH_BASE_URL),
    port: raw.PORT,
    corsOrigins: parseCorsOrigins(raw.CORS_ORIGINS, raw.NODE_ENV),
    nodeEnv: raw.NODE_ENV,
  };
}
