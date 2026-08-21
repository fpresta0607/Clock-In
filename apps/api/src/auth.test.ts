import { SignJWT, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyIdentity } from "./auth.js";
import { parseEnv } from "./env.js";

const config = parseEnv({
  DATABASE_URL: "postgres://siqshift:password@localhost:5432/siqshift",
  AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
  NODE_ENV: "test",
});

const user = {
  id: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  email: "alex@example.com",
  name: "Alex Morgan",
};

const issuedAt = new Date("2026-08-06T14:00:00.000Z");
let signingKey: CryptoKey;
let keys: JWTVerifyGetKey;
let otherKeys: JWTVerifyGetKey;

/** Mirrors the claims Neon Auth's /token endpoint issues. */
async function issue(
  overrides: Record<string, unknown> = {},
  options: { key?: CryptoKey; algorithm?: string; issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, banned: false, ...overrides })
    .setProtectedHeader({ alg: options.algorithm ?? "EdDSA" })
    .setIssuer(options.issuer ?? config.authIssuer)
    .setAudience(options.audience ?? config.authIssuer)
    .setSubject(user.id)
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1_000))
    .setExpirationTime(Math.floor(issuedAt.getTime() / 1_000) + 900)
    .sign(options.key ?? signingKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  const other = await generateKeyPair("EdDSA", { extractable: true });
  signingKey = pair.privateKey;
  keys = async () => pair.publicKey;
  otherKeys = async () => other.publicKey;
  // Confirms the key type is exportable as a JWK, as a remote JWKS would serve it.
  expect((await exportJWK(pair.publicKey)).kty).toBe("OKP");
});

describe("Neon Auth token verification", () => {
  it("accepts a current token and returns the signed-in identity", async () => {
    await expect(verifyIdentity(await issue(), keys, config, new Date(issuedAt.getTime() + 1_000))).resolves.toEqual({
      authUserId: user.id,
      email: user.email,
      name: user.name,
    });
  });

  it("rejects expired, malformed, and incorrectly signed tokens", async () => {
    const token = await issue();

    await expect(verifyIdentity(token, keys, config, new Date(issuedAt.getTime() + 901_000)))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyIdentity(token, otherKeys, config, issuedAt)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyIdentity("not.a.jwt", keys, config, issuedAt)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects tokens issued for another auth instance", async () => {
    const foreignIssuer = await issue({}, { issuer: "https://other.auth.test" });
    const foreignAudience = await issue({}, { audience: "https://other.auth.test" });

    await expect(verifyIdentity(foreignIssuer, keys, config, issuedAt)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyIdentity(foreignAudience, keys, config, issuedAt)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects a valid-claims token signed with an unexpected algorithm", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const token = await issue({}, { key: privateKey, algorithm: "RS256" });

    await expect(verifyIdentity(token, async () => publicKey, config, issuedAt)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects banned accounts and tokens missing identity claims", async () => {
    await expect(verifyIdentity(await issue({ banned: true }), keys, config, issuedAt))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyIdentity(await issue({ email: "not-an-email" }), keys, config, issuedAt))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyIdentity(await issue({ name: "" }), keys, config, issuedAt))
      .rejects.toMatchObject({ code: "unauthorized" });
  });
});
