import * as argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";

import type { LoginRequest } from "@clock-in/shared";

import type { AppConfig } from "./env.js";
import { AppError } from "./errors.js";

const jwtIssuer = "clock-in-api";
const jwtAudience = "clock-in-desktop";
const argon2Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;
const dummyPasswordHash = "$argon2id$v=19$m=19456,t=2,p=1$PVxtCqfAWVCJG2mkNkkxpw$Nsyu+LFmsfrXW2P41qwUkjWleh2pPX0hCywM8l3ldQ0";

const tokenPayloadSchema = z.object({
  sub: z.string().uuid(),
  organizationId: z.string().uuid(),
});

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

export interface UserCredential {
  email: string;
  passwordHash: string;
  user: AuthenticatedUser;
}

export interface UserCredentialStore {
  findByEmail(email: string): Promise<UserCredential | null>;
}

export interface AuthServiceDependencies {
  config: AppConfig;
  credentials: UserCredentialStore;
  clock?: () => Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, argon2Options);
}

export async function signAccessToken(user: AuthenticatedUser, config: AppConfig, issuedAt = new Date()): Promise<string> {
  return new SignJWT({ organizationId: user.organizationId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(jwtIssuer)
    .setAudience(jwtAudience)
    .setSubject(user.id)
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1_000))
    .setExpirationTime(Math.floor(issuedAt.getTime() / 1_000) + config.jwtTtlSeconds)
    .sign(new TextEncoder().encode(config.jwtSecret));
}

export async function verifyAccessToken(token: string, config: AppConfig, now = new Date()): Promise<AuthenticatedSubject> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), {
      issuer: jwtIssuer,
      audience: jwtAudience,
      currentDate: now,
    });
    const parsed = tokenPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError("unauthorized", "Authentication is required.");
    }
    return { userId: parsed.data.sub, organizationId: parsed.data.organizationId };
  } catch {
    throw new AppError("unauthorized", "Authentication is required.");
  }
}

export function createAuthService(dependencies: AuthServiceDependencies) {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async login(input: LoginRequest): Promise<{ accessToken: string; user: AuthenticatedUser }> {
      const email = normalizeEmail(input.email);
      const credential = await dependencies.credentials.findByEmail(email);
      const verified = await argon2.verify(credential?.passwordHash ?? dummyPasswordHash, input.password).catch(() => false);

      if (credential === null || !verified) {
        throw new AppError("invalid_credentials", "Invalid email or password.");
      }
      return { accessToken: await signAccessToken(credential.user, dependencies.config, clock()), user: credential.user };
    },
  };
}
