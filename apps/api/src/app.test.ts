import type { JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { AccountStore, AuthenticatedUser } from "./auth.js";
import { createApp } from "./app.js";
import { AppError } from "./errors.js";
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
    findOrganization: async (id) => ({ id, name: "SIQstack", inviteCode: "ACDEF-GHJKM" }),
    joinOrganization: async () => account,
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

  it("provisions a new account with a typed invite code, however it was typed", async () => {
    const seen: (string | undefined)[] = [];
    const { app } = createTestApp({
      accounts: {
        resolve: async (_identity, inviteCode) => { seen.push(inviteCode); return account; },
        findOrganization: async (id) => ({ id, name: "SIQstack", inviteCode: "ACDEF-GHJKM" }),
        joinOrganization: async () => account,
      },
    });
    const authorization = await bearer();
    const post = (body: unknown) => app.request("http://api.test/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(body),
    });

    expect((await post({ inviteCode: "acdefghjkm" })).status).toBe(200);
    expect((await post({ inviteCode: "  ACDEF-GHJKM " })).status).toBe(200);
    expect((await post({})).status).toBe(200);

    // Every spelling normalizes to the same stored code; no code stays undefined.
    expect(seen).toEqual(["ACDEF-GHJKM", "ACDEF-GHJKM", undefined]);
  });

  it("rejects an invite code that could not be one", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await bearer() },
      body: JSON.stringify({ inviteCode: "nope" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "validation_error" } });
  });

  it("does not create a personal organization while a coded sign-up is in flight", async () => {
    const codes: (string | undefined)[] = [];
    const { app } = createTestApp({
      accounts: {
        resolve: async (_identity, inviteCode) => { codes.push(inviteCode); return account; },
        findOrganization: async (id) => ({ id, name: "SIQstack", inviteCode: "ACDEF-GHJKM" }),
        joinOrganization: async () => account,
      },
    });

    await app.request("http://api.test/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await bearer() },
      body: JSON.stringify({ inviteCode: "ACDEF-GHJKM" }),
    });

    // Exactly one resolve, carrying the code. A second, code-less resolve from
    // the standard middleware would have already made a personal workspace.
    expect(codes).toEqual(["ACDEF-GHJKM"]);
  });

  it("requires a bearer token to provision an account", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });

  it("returns the organization with the invite code a member can share", async () => {
    const { app } = createTestApp();

    const response = await app.request("http://api.test/organization", { headers: { authorization: await bearer() } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      organization: { id: ids.organization, name: "SIQstack", inviteCode: "ACDEF-GHJKM" },
    });
  });

  it("does not expose an invite code without authentication", async () => {
    const { app } = createTestApp();

    expect((await app.request("http://api.test/organization")).status).toBe(401);
  });

  it("moves an existing account into a workspace, however the code was typed", async () => {
    const seen: string[] = [];
    const { app } = createTestApp({
      accounts: {
        resolve: async () => account,
        findOrganization: async (id) => ({ id, name: "SIQstack", inviteCode: "ACDEF-GHJKM" }),
        joinOrganization: async (_subject, code) => { seen.push(code); return account; },
      },
    });
    const authorization = await bearer();
    const join = (inviteCode: string) => app.request("http://api.test/organization/join", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ inviteCode }),
    });

    expect((await join("acdefghjkm")).status).toBe(200);
    expect((await join(" ACDEF-GHJKM ")).status).toBe(200);

    expect(seen).toEqual(["ACDEF-GHJKM", "ACDEF-GHJKM"]);
  });

  it("surfaces a refusal to move an account that already recorded time", async () => {
    const { app } = createTestApp({
      accounts: {
        resolve: async () => account,
        findOrganization: async (id) => ({ id, name: "SIQstack", inviteCode: "ACDEF-GHJKM" }),
        joinOrganization: async () => {
          throw new AppError("conflict", "This account has already recorded time in its current workspace, so it cannot be moved.");
        },
      },
    });

    const response = await app.request("http://api.test/organization/join", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await bearer() },
      body: JSON.stringify({ inviteCode: "ACDEF-GHJKM" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "conflict", message: expect.stringContaining("already recorded time") },
    });
  });

  it("rejects a malformed join code and an unauthenticated join", async () => {
    const { app } = createTestApp();

    const malformed = await app.request("http://api.test/organization/join", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await bearer() },
      body: JSON.stringify({ inviteCode: "nope" }),
    });
    const anonymous = await app.request("http://api.test/organization/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteCode: "ACDEF-GHJKM" }),
    });

    expect(malformed.status).toBe(400);
    expect(anonymous.status).toBe(401);
  });
});
