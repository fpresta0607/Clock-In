import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";

import type { AppConfig } from "./env.js";

export interface TestAuth {
  keys: JWTVerifyGetKey;
  /** Mints an authorization header value with the claims Neon Auth issues. */
  bearer(userId: string, claims?: Record<string, unknown>): Promise<string>;
}

export async function createTestAuth(config: AppConfig, now: Date): Promise<TestAuth> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const seconds = Math.floor(now.getTime() / 1_000);

  return {
    keys: async () => publicKey,
    bearer: async (userId, claims = {}) => {
      const token = await new SignJWT({ email: "alex@example.com", name: "Alex Morgan", banned: false, ...claims })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(config.authIssuer)
        .setAudience(config.authIssuer)
        .setSubject(userId)
        .setIssuedAt(seconds)
        .setExpirationTime(seconds + 900)
        .sign(privateKey);
      return `Bearer ${token}`;
    },
  };
}
