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

const originSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "CORS origins must use http or https.");

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
  const origins = raw.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0);

  if (origins.includes("*")) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      message: "CORS_ORIGINS cannot include a wildcard when credentials are enabled.",
      path: ["CORS_ORIGINS"],
    }]);
  }

  const parsedOrigins = z.array(originSchema).parse(origins);
  return {
    databaseUrl: raw.DATABASE_URL,
    jwtSecret: raw.JWT_SECRET,
    port: raw.PORT,
    corsOrigins: parsedOrigins,
    jwtTtlSeconds: raw.JWT_TTL_SECONDS,
    loginRateLimitMax: raw.LOGIN_RATE_LIMIT_MAX,
    loginRateLimitWindowSeconds: raw.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    nodeEnv: raw.NODE_ENV,
  };
}
