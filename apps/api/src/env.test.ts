import { describe, expect, it } from "vitest";

import { parseEnv } from "./env.js";

const baseEnvironment = {
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  JWT_SECRET: "this-is-a-long-test-secret-with-enough-entropy-123",
  NODE_ENV: "test",
} as const;

describe("environment parsing", () => {
  it("rejects database URLs that are not PostgreSQL", () => {
    expect(() => parseEnv({ ...baseEnvironment, DATABASE_URL: "mysql://localhost/clock_in" })).toThrow();
    expect(() => parseEnv({ ...baseEnvironment, DATABASE_URL: "https://database.example/clock_in" })).toThrow();
  });

  it("canonicalizes and de-duplicates origin-only CORS entries", () => {
    expect(parseEnv({
      ...baseEnvironment,
      CORS_ORIGINS: "https://desktop.clock-in.test/,https://desktop.clock-in.test,https://admin.clock-in.test:443",
    }).corsOrigins).toEqual(["https://desktop.clock-in.test", "https://admin.clock-in.test"]);
    expect(() => parseEnv({ ...baseEnvironment, CORS_ORIGINS: "https://desktop.clock-in.test/path" })).toThrow();
    expect(() => parseEnv({ ...baseEnvironment, CORS_ORIGINS: "https://desktop.clock-in.test?preview=true" })).toThrow();
  });

  it("requires HTTPS CORS origins in production", () => {
    expect(() => parseEnv({
      ...baseEnvironment,
      NODE_ENV: "production",
      CORS_ORIGINS: "http://localhost:5173",
    })).toThrow();
    expect(parseEnv({
      ...baseEnvironment,
      NODE_ENV: "production",
      CORS_ORIGINS: "https://desktop.clock-in.test",
    }).corsOrigins).toEqual(["https://desktop.clock-in.test"]);
  });
});
