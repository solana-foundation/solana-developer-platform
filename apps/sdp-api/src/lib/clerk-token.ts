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

/**
 * A Clerk custom claim is only trusted when it actually looks like an address.
 * An invalid shortcode is not substituted by Clerk — it arrives verbatim, e.g.
 * `{{user.primary_email_address.email_address}}` — and that string was being
 * persisted as a user's email, then rendered throughout the dashboard.
 *
 * Rejecting it here means a misconfigured claim surfaces as a failed login
 * rather than as silent corruption that spreads and needs a data repair.
 */
export function isPlausibleEmail(value: string | undefined | null): value is string {
  const trimmed = value?.trim();
  return Boolean(trimmed) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed as string);
}

export function resolveClerkEmail(payload: ClerkJwtPayload): string | null {
  if (isPlausibleEmail(payload.email)) {
    return payload.email as string;
  }

  const first = payload.email_addresses?.[0]?.email_address;
  return isPlausibleEmail(first) ? first : null;
}

export function resolveClerkConfig(env: Env) {
  const issuer = env.CLERK_ISSUER?.trim();
  const jwksUrl = env.CLERK_JWKS_URL?.trim();

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
  };
}

/**
 * The tolerance must match Clerk's DEFAULT_CLOCK_SKEW_IN_MS (5s): the dashboard
 * forwards the session token, and Clerk's middleware treats it as valid for up
 * to 5s past `exp`. Verifying stricter than the issuer creates a window where
 * sdp-web forwards a token this API rejects, failing every SSR fetch in it.
 * Mirrored as a literal because `@clerk/backend` does not export the constant.
 */
const CLERK_CLOCK_TOLERANCE_SECONDS = 5;

/**
 * Verifies a Clerk session token against the instance JWKS.
 *
 * @param token - The bearer token forwarded by the dashboard.
 * @param env - Worker bindings holding the Clerk issuer configuration.
 * @returns The verified JWT payload.
 */
export async function verifyClerkJwt(token: string, env: Env): Promise<ClerkJwtPayload> {
  const config = resolveClerkConfig(env);
  const jwks = getJwks(config.jwksUrl);

  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.issuer,
    clockTolerance: CLERK_CLOCK_TOLERANCE_SECONDS,
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
