import { beforeAll, describe, expect, it } from "vitest";

import { hashPassword, type UserCredential } from "./auth.js";
import { createApp } from "./app.js";
import { parseEnv, type AppConfig } from "./env.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
};

const config: AppConfig = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  JWT_SECRET: "this-is-a-long-test-secret-with-enough-entropy-123",
  CORS_ORIGINS: "https://desktop.clock-in.test,https://admin.clock-in.test",
  JWT_TTL_SECONDS: "300",
  LOGIN_RATE_LIMIT_MAX: "2",
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: "60",
  NODE_ENV: "test",
});

let credential: UserCredential;

beforeAll(async () => {
  credential = {
    email: "alex@example.com",
    passwordHash: await hashPassword("correct horse battery staple"),
    user: {
      id: ids.user,
      email: "alex@example.com",
      name: "Alex Morgan",
      organizationId: ids.organization,
    },
  };
});

function createTestApp(options: { now?: number; bodyLimitBytes?: number; credential?: UserCredential } = {}) {
  let now = options.now ?? Date.parse("2026-08-06T14:00:00.000Z");
  const entries = new Map<string, { count: number; resetAt: number }>();
  const app = createApp({
    config,
    ...(options.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: options.bodyLimitBytes }),
    credentials: {
      findByEmail: async (email) => (email === (options.credential ?? credential).email ? options.credential ?? credential : null),
    },
    clock: () => new Date(now),
    loginRateLimitStore: {
      take: (key, limit, windowMs, at) => {
        const current = entries.get(key);
        const record = current !== undefined && current.resetAt > at
          ? current
          : { count: 0, resetAt: at + windowMs };
        record.count += 1;
        entries.set(key, record);
        return { allowed: record.count <= limit, retryAfterSeconds: Math.ceil((record.resetAt - at) / 1_000) };
      },
    },
  });

  return { app, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe("API composition", () => {
  it("returns a JSON health response and request id", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("rejects request bodies larger than the configured limit", async () => {
    const { app } = createTestApp({ bodyLimitBytes: 32 });

    const response = await app.request("http://api.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alex@example.com", password: "a password longer than the body limit" }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: { code: "validation_error", message: "Request body is too large." } });
  });

  it("allows configured CORS origins and handles preflight", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/auth/login", {
      method: "OPTIONS",
      headers: {
        origin: "https://desktop.clock-in.test",
        "access-control-request-method": "POST",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://desktop.clock-in.test");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does not grant CORS access to an unconfigured origin", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/health", {
      headers: { origin: "https://evil.example" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("adds defensive security headers", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/health");

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  });

  it("returns stable validation errors for malformed JSON and invalid login input", async () => {
    const { app } = createTestApp();
    const malformed = await app.request("http://api.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const invalid = await app.request("http://api.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "" }),
    });

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });
  });

  it("returns the shared login response contract for valid credentials", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: " ALEX@EXAMPLE.COM ", password: "correct horse battery staple" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accessToken: expect.any(String),
      user: { id: ids.user, email: "alex@example.com", organizationId: ids.organization },
    });
  });

  it("returns the same stable error for invalid credentials", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "unknown@example.com", password: "incorrect password" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_credentials", message: "Invalid email or password." } });
  });

  it("rate limits normalized login identifiers deterministically", async () => {
    const { app, advance } = createTestApp();
    const request = () => app.request("http://api.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ALEX@EXAMPLE.COM", password: "wrong password" }),
    });

    expect((await request()).status).toBe(401);
    expect((await request()).status).toBe(401);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toEqual({ error: { code: "rate_limited", message: "Too many login attempts. Try again later." } });
    advance(60_000);
    expect((await request()).status).toBe(401);
  });
});
