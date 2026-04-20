import type { Context } from "hono";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { internalError } from "@/lib/errors";
import type { Env } from "@/types/env";

export interface ClerkJwtPayload extends JWTPayload {
  sub?: string;
  org_id?: string | null;
  org_role?: string | null;
  org_slug?: string | null;
  email?: string;
  email_addresses?: Array<{ email_address: string }>;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUrl: string) {
  const cached = jwksCache.get(jwksUrl);
  if (cached) {
    return cached;
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  jwksCache.set(jwksUrl, jwks);
  return jwks;
}

export function extractBearerToken(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return null;
  }

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7);
}

export function resolveClerkEmail(payload: ClerkJwtPayload): string | null {
  if (payload.email) {
    return payload.email;
  }

  const first = payload.email_addresses?.[0]?.email_address;
  return first ?? null;
}

export function resolveClerkConfig(env: Env) {
  const issuer = env.CLERK_ISSUER?.trim();
  const jwksUrl = env.CLERK_JWKS_URL?.trim();
  const audience = env.CLERK_AUDIENCE?.trim();

  if (!issuer && !jwksUrl) {
    throw internalError("Clerk auth is not configured");
  }

  if (!issuer) {
    throw internalError("CLERK_ISSUER is required for Clerk auth");
  }

  const resolvedJwksUrl = jwksUrl || `${issuer}/.well-known/jwks.json`;

  return {
    issuer,
    jwksUrl: resolvedJwksUrl,
    audience: audience || undefined,
  };
}

export async function verifyClerkJwt(token: string, env: Env): Promise<ClerkJwtPayload> {
  const config = resolveClerkConfig(env);
  const jwks = getJwks(config.jwksUrl);

  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.issuer,
    audience: config.audience,
  });

  return payload as ClerkJwtPayload;
}

export async function verifyClerkJwtForRequest(
  c: Context<{ Bindings: Env }>,
  token: string
): Promise<ClerkJwtPayload> {
  const cached = c.get("verifiedClerkJwt");
  if (cached?.token === token) {
    return cached.payload;
  }

  const payload = await verifyClerkJwt(token, c.env);
  c.set("verifiedClerkJwt", { token, payload });
  return payload;
}
