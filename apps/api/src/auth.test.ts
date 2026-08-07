import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import {
  createAuthService,
  hashPassword,
  signAccessToken,
  verifyAccessToken,
  type UserCredential,
} from "./auth.js";
import { parseEnv } from "./env.js";

const config = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  JWT_SECRET: "this-is-a-long-test-secret-with-enough-entropy-123",
  NODE_ENV: "test",
});

const user = {
  id: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  email: "alex@example.com",
  name: "Alex Morgan",
  organizationId: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
};

describe("authentication service", () => {
  it("verifies Argon2id credentials and normalizes the identifier", async () => {
    const credential: UserCredential = { email: user.email, passwordHash: await hashPassword("correct horse battery staple"), user };
    const service = createAuthService({
      config,
      credentials: { findByEmail: async (email) => (email === user.email ? credential : null) },
      clock: () => new Date("2026-08-06T14:00:00.000Z"),
    });

    const login = await service.login({ email: " ALEX@EXAMPLE.COM ", password: "correct horse battery staple" });

    expect(login.user).toEqual(user);
    expect(await verifyAccessToken(login.accessToken, config, new Date("2026-08-06T14:00:01.000Z"))).toEqual({
      userId: user.id,
      organizationId: user.organizationId,
    });
  });

  it("uses an indistinguishable public error for a wrong password or unknown user", async () => {
    const credential: UserCredential = { email: user.email, passwordHash: await hashPassword("correct horse battery staple"), user };
    const service = createAuthService({
      config,
      credentials: { findByEmail: async (email) => (email === user.email ? credential : null) },
      clock: () => new Date("2026-08-06T14:00:00.000Z"),
    });

    await expect(service.login({ email: user.email, password: "wrong password" })).rejects.toMatchObject({
      code: "invalid_credentials",
      status: 401,
    });
    await expect(service.login({ email: "unknown@example.com", password: "wrong password" })).rejects.toMatchObject({
      code: "invalid_credentials",
      status: 401,
    });
  });

  it("rejects expired, malformed, and incorrectly signed bearer tokens", async () => {
    const issuedAt = new Date("2026-08-06T14:00:00.000Z");
    const expired = await signAccessToken(user, config, issuedAt);
    const otherConfig = parseEnv({
      DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
      JWT_SECRET: "a-different-long-test-secret-with-enough-entropy-456",
      NODE_ENV: "test",
    });

    await expect(verifyAccessToken(expired, config, new Date("2026-08-06T14:15:01.000Z"))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyAccessToken(expired, otherConfig, issuedAt)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyAccessToken("not.a.jwt", config, issuedAt)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects a valid-claims token signed with HS384", async () => {
    const issuedAt = new Date("2026-08-06T14:00:00.000Z");
    const token = await new SignJWT({ organizationId: user.organizationId })
      .setProtectedHeader({ alg: "HS384", typ: "JWT" })
      .setIssuer("clock-in-api")
      .setAudience("clock-in-desktop")
      .setSubject(user.id)
      .setIssuedAt(Math.floor(issuedAt.getTime() / 1_000))
      .setExpirationTime(Math.floor(issuedAt.getTime() / 1_000) + config.jwtTtlSeconds)
      .sign(new TextEncoder().encode(config.jwtSecret));

    await expect(verifyAccessToken(token, config, issuedAt)).rejects.toMatchObject({ code: "unauthorized" });
  });
});
