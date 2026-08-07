import type { JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { AccountStore, AuthenticatedUser } from "./auth.js";
import { createApp } from "./app.js";
import { parseEnv, type AppConfig } from "./env.js";
import { createTestAuth } from "./test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
};

const config: AppConfig = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
  CORS_ORIGINS: "https://desktop.clock-in.test,https://admin.clock-in.test",
  NODE_ENV: "test",
});

const account: AuthenticatedUser = {
  id: ids.user,
  email: "alex@example.com",
  name: "Alex Morgan",
  organizationId: ids.organization,
};

const now = new Date("2026-08-06T14:00:00.000Z");
let keys: JWTVerifyGetKey;
let bearer: () => Promise<string>;

beforeAll(async () => {
  const auth = await createTestAuth(config, now);
  keys = auth.keys;
  bearer = () => auth.bearer(ids.user);
});

function createTestApp(options: { bodyLimitBytes?: number; accounts?: AccountStore } = {}) {
  const resolved: string[] = [];
  const accounts: AccountStore = options.accounts ?? {
    resolve: async (identity) => {
      resolved.push(identity.authUserId);
      return account;
    },
  };
  const app = createApp({
    config,
    keys,
    accounts,
    ...(options.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: options.bodyLimitBytes }),
    clock: () => now,
  });

  return { app, resolved };
}

describe("API composition", () => {
  it("returns a JSON health response and request id without authentication", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns the signed-in account and provisions it through the account store", async () => {
    const { app, resolved } = createTestApp();

    const response = await app.request("http://api.test/me", { headers: { authorization: await bearer() } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ user: account });
    expect(resolved).toEqual([ids.user]);
  });

  it("rejects missing, malformed, and untrusted bearer tokens", async () => {
    const { app } = createTestApp();
    const request = (headers: Record<string, string>) => app.request("http://api.test/me", { headers });

    expect((await request({})).status).toBe(401);
    expect((await request({ authorization: "Basic abc" })).status).toBe(401);
    expect((await request({ authorization: "Bearer not.a.jwt" })).status).toBe(401);
    await expect((await request({})).json()).resolves.toEqual({
      error: { code: "unauthorized", message: "Authentication is required." },
    });
  });

  it("rejects request bodies larger than the configured limit", async () => {
    const { app } = createTestApp({ bodyLimitBytes: 32 });

    const response = await app.request("http://api.test/me", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await bearer() },
      body: JSON.stringify({ padding: "a body that is longer than the configured limit" }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: { code: "validation_error", message: "Request body is too large." } });
  });

  it("allows configured CORS origins and handles preflight", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/me", {
      method: "OPTIONS",
      headers: { origin: "https://desktop.clock-in.test", "access-control-request-method": "GET" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://desktop.clock-in.test");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does not grant CORS access to an unconfigured origin", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/health", { headers: { origin: "https://evil.example" } });

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

  it("returns a stable not-found error for unknown routes", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/nope");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: { code: "not_found", message: "Route not found." } });
  });
});
