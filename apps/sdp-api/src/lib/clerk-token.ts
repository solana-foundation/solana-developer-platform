import type { Context } from "hono";
import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import { z } from "zod";
import { AppError, internalError, serviceUnavailable } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

export interface ClerkJwtPayload extends JWTPayload {
  sub?: string;
  v?: number;
  o?: {
    id?: string | null;
    rol?: string | null;
    slg?: string | null;
  } | null;
  org_id?: string | null;
  org_role?: string | null;
  org_slug?: string | null;
  email?: string;
  email_addresses?: Array<{ email_address: string }>;
}

export interface ClerkOrganizationClaims {
  organizationId: string | null;
  organizationSlug: string | null;
}

/**
 * Read organization context from both Clerk JWT formats.
 *
 * Version 2 session tokens compact the organization fields under `o`; older
 * tokens and customized templates expose the long-form `org_*` claims. The
 * Clerk role claim is not read: SDP holds the only Organization Role (ADR 0012).
 */
export function resolveClerkOrganizationClaims(payload: ClerkJwtPayload): ClerkOrganizationClaims {
  if (payload.v === 2 && payload.o) {
    return {
      organizationId: payload.o.id ?? null,
      organizationSlug: payload.o.slg ?? null,
    };
  }

  return {
    organizationId: payload.org_id ?? null,
    organizationSlug: payload.org_slug ?? null,
  };
}

/**
 * Clerk's signing keys could not be fetched, so the token was never checked.
 * That says nothing about the credential, which is why callers answer 503.
 */
export class ClerkKeysUnavailableError extends Error {
  constructor(options: { cause: unknown }) {
    super("Clerk signing keys unavailable", options);
    this.name = "ClerkKeysUnavailableError";
  }
}

/**
 * jose reports every verdict on a token with its own error subclasses. A
 * rejected fetch (network, DNS, TLS), a timeout, a non-200 or unparseable
 * response (the generic JOSEError) and a malformed key set mean the keys were
 * never read.
 */
export function isSigningKeyFetchFailure(cause: unknown): boolean {
  if (!(cause instanceof errors.JOSEError)) {
    return true;
  }
  return (
    cause instanceof errors.JWKSTimeout ||
    cause instanceof errors.JWKSInvalid ||
    cause.code === errors.JOSEError.code
  );
}

interface ClerkSigningKeys {
  keys: ReturnType<typeof createRemoteJWKSet>;
  resolveKey: JWTVerifyGetKey;
}

const signingKeysCache = new Map<string, ClerkSigningKeys>();

function getSigningKeys(jwksUrl: string): ClerkSigningKeys {
  const cached = signingKeysCache.get(jwksUrl);
  if (cached) {
    return cached;
  }
  const keys = createRemoteJWKSet(new URL(jwksUrl));
  const signingKeys: ClerkSigningKeys = {
    keys,
    resolveKey: async (protectedHeader, token) => {
      try {
        return await keys(protectedHeader, token);
      } catch (error) {
        throw isSigningKeyFetchFailure(error)
          ? new ClerkKeysUnavailableError({ cause: error })
          : error;
      }
    },
  };
  signingKeysCache.set(jwksUrl, signingKeys);
  return signingKeys;
}

/**
 * Fetches Clerk's signing keys into the cache every verification reads, so a
 * successful call also proves this instance can reach the internet.
 */
export async function warmClerkSigningKeys(env: Env): Promise<void> {
  await getSigningKeys(resolveClerkConfig(env).jwksUrl).keys.reload();
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

function resolveClerkConfig(env: Env) {
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

  const { payload } = await jwtVerify(token, getSigningKeys(config.jwksUrl).resolveKey, {
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
  // A session presented alongside a gateway identity must be the session the
  // gateway authenticated (HOO-2256): its user and its active organization,
  // where an identity with no organization matches only a session with none.
  // The gateway limits and meters by that organization, so it must be the
  // one SDP serves; the role still comes from SDP's own membership row.
  const gatewayIdentity = c.get("gatewayIdentity");
  if (
    gatewayIdentity &&
    (gatewayIdentity.clerkUserId !== payload.sub ||
      gatewayIdentity.orgId !== resolveClerkOrganizationClaims(payload).organizationId)
  ) {
    throw new Error("Clerk session does not match the gateway identity");
  }
  c.set("verifiedClerkJwt", { token, payload });
  return payload;
}

const SIGNING_KEYS_RETRY_AFTER_SECONDS = 2;
const ERROR_CHAIN_MAX_DEPTH = 4;
const errorCodeSchema = z.object({ code: z.string() });

/**
 * undici reports every transport failure as `TypeError: fetch failed` and puts
 * the reason (connect timeout, DNS, refused or reset socket) in `cause`; Node's
 * happy-eyeballs connect wraps one failed attempt per address in an
 * AggregateError.
 */
function describeErrorChain(cause: unknown): Array<{ name: string; code: string | null }> {
  const chain: Array<{ name: string; code: string | null }> = [];
  let current = cause;
  while (current instanceof Error && chain.length < ERROR_CHAIN_MAX_DEPTH) {
    const coded = errorCodeSchema.safeParse(current);
    chain.push({ name: current.name, code: coded.success ? coded.data.code : null });
    current = current instanceof AggregateError ? current.errors[0] : current.cause;
  }
  return chain;
}

/**
 * Verifies the bearer token an auth middleware was handed. A token that fails
 * verification is 401. Unreachable signing keys are a retryable 503 instead:
 * the dashboard reads a 401 as lost access.
 *
 * @throws AppError `UNAUTHORIZED` for a token that fails verification, or
 *   `SERVICE_UNAVAILABLE` with `Retry-After` when the keys cannot be fetched.
 */
export async function verifyClerkSessionToken(
  c: Context<{ Bindings: Env }>,
  token: string
): Promise<ClerkJwtPayload> {
  try {
    return await verifyClerkJwtForRequest(c, token);
  } catch (error) {
    if (error instanceof ClerkKeysUnavailableError) {
      getLogger().warn(
        {
          event: "sdp_api_clerk_signing_keys_unavailable",
          error_chain: describeErrorChain(error.cause),
        },
        "Clerk signing keys unavailable"
      );
      c.header("Retry-After", String(SIGNING_KEYS_RETRY_AFTER_SECONDS));
      throw serviceUnavailable("Authentication is temporarily unavailable");
    }
    throw new AppError("UNAUTHORIZED", "Invalid Clerk token", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
