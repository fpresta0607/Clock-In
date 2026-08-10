import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

import type { AppConfig } from "./env.js";
import { AppError } from "./errors.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  role?: "admin" | "member";
}

export interface AuthenticatedSubject {
  userId: string;
  organizationId: string;
  role?: "admin" | "member";
}

export type FirstAdminClaimResult =
  | { kind: "claimed"; user: AuthenticatedUser }
  | { kind: "already_claimed" }
  | { kind: "not_member" };

/** A signed-in Neon Auth identity, before it is mapped onto a Clock-In account. */
export interface AuthIdentity {
  authUserId: string;
  email: string;
  name: string;
}

export interface AccountStore {
  /**
   * Returns the Clock-In account for a Neon Auth identity. On first sign-in it
   * either joins the organization the invite code names, or creates a personal
   * one — named workspaceName when given — with a starter project. Both are
   * ignored for an existing account.
   */
  resolve(identity: AuthIdentity, inviteCode?: string, workspaceName?: string): Promise<AuthenticatedUser>;
  findOrganization(organizationId: string): Promise<OrganizationRecord | null>;
  /**
   * Moves an existing account into the organization an invite code names, for
   * someone who signed up before they were given one.
   */
  joinOrganization(subject: AuthenticatedSubject, inviteCode: string): Promise<AuthenticatedUser>;
  /**
   * Lets one active member explicitly bootstrap an ownerless legacy workspace.
   * Production stores make this a tenant-scoped atomic claim; test stores may
   * omit it when they do not expose organization administration routes.
   */
  claimFirstAdmin?(subject: AuthenticatedSubject): Promise<FirstAdminClaimResult>;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  inviteCode: string;
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
