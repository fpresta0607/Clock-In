import { describe, expect, it } from "vitest";

import { parseEnv } from "./env.js";

const baseEnvironment = {
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
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

  it("derives the JWKS URL and token issuer from the auth base URL", () => {
    const config = parseEnv({ ...baseEnvironment, AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth/" });

    expect(config.authJwksUrl).toBe("https://auth.clock-in.test/neondb/auth/.well-known/jwks.json");
    expect(config.authIssuer).toBe("https://auth.clock-in.test");
  });

  it("rejects a plaintext auth base URL that is not loopback", () => {
    expect(() => parseEnv({ ...baseEnvironment, AUTH_BASE_URL: "http://auth.clock-in.test/neondb/auth" })).toThrow();
    expect(parseEnv({ ...baseEnvironment, AUTH_BASE_URL: "http://localhost:4000/auth" }).authIssuer).toBe("http://localhost:4000");
  });
});
