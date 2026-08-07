import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

import type { AppConfig } from "./env.js";
import { AppError } from "./errors.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  organizationId: string;
}

export interface AuthenticatedSubject {
  userId: string;
  organizationId: string;
}

/** A signed-in Neon Auth identity, before it is mapped onto a Clock-In account. */
export interface AuthIdentity {
  authUserId: string;
  email: string;
  name: string;
}

export interface AccountStore {
  /**
   * Returns the Clock-In account for a Neon Auth identity, creating the
   * organization, user, and starter project on first sign-in.
   */
  resolve(identity: AuthIdentity): Promise<AuthenticatedUser>;
}

const claimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  banned: z.boolean().nullish(),
});

export function createNeonAuthKeys(config: AppConfig): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(config.authJwksUrl));
}

export async function verifyIdentity(
  token: string,
  keys: JWTVerifyGetKey,
  config: AppConfig,
  now = new Date(),
): Promise<AuthIdentity> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["EdDSA"],
      issuer: config.authIssuer,
      audience: config.authIssuer,
      currentDate: now,
    });
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success || claims.data.banned === true) {
      throw new AppError("unauthorized", "Authentication is required.");
    }
    return { authUserId: claims.data.sub, email: claims.data.email, name: claims.data.name };
  } catch {
    throw new AppError("unauthorized", "Authentication is required.");
  }
}
