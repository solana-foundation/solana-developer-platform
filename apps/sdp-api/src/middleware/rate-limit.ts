import type { RateLimitTier } from "@sdp/types";
import type { Context, Next } from "hono";
import { extractApiKey, looksLikeApiKey } from "@/lib/api-key-format";
import { verifyClerkJwtForRequest } from "@/lib/clerk-token";
import { getClientIp } from "@/lib/client-ip";
import { rateLimited, serviceUnavailable } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { matchesFreePath } from "./path-match";

/** Length of every rate limit window; counter buckets align to it. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Maximum admitted requests per window, per API key, by tier. */
export const RATE_LIMIT_TIERS = {
  standard: 100,
  elevated: 500,
  unlimited: 10_000,
} as const satisfies Record<RateLimitTier, number>;

const ANONYMOUS_MAX_REQUESTS = 20;

/**
 * Per-user-per-org ceiling for dashboard traffic (Clerk JWT or cookie
 * session). Dashboard pages fan out many BFF calls in parallel, so this sits
 * well above interactive use while still bounding a scripted session; costly
 * endpoints layer tighter metered quotas on top (see metered-quota.ts).
 */
export const DASHBOARD_ACTOR_MAX_REQUESTS = 300;

/**
 * Per-IP ceiling for requests that present an sk_-shaped credential. Keyed
 * traffic gets its real limit per key id after auth (enforceRateLimit in the
 * auth middleware), so the anonymous limit must not apply — it would cap
 * every tier at 20/min per IP. The key is unverified at this point, so a high
 * IP ceiling still bounds invalid-key spray against the KV/DB lookup in auth.
 */
export const KEYED_IP_BACKSTOP_MAX_REQUESTS = Math.max(...Object.values(RATE_LIMIT_TIERS)) * 5;

/**
 * Per-user ceiling for verified Clerk dashboard traffic. Set well above what a person
 * driving the UI produces — a dashboard page can fan out to a dozen endpoints, and the
 * notification bell polls on a timer — so this is a runaway-loop backstop, not a
 * throttle anyone should meet while using the product.
 */
export const CLERK_USER_MAX_REQUESTS = 600;

/**
 * Builds the KV key for one identifier's counter in one window bucket.
 *
 * @param identifier - Counter scope (client IP or API key id).
 * @param windowStart - Bucket start in epoch ms, as produced by getWindowStart.
 * @returns The `ratelimit:<identifier>:<windowStart>` KV key.
 */
function getWindowKey(identifier: string, windowStart: number): string {
  return `ratelimit:${identifier}:${windowStart}`;
}

/**
 * Extracts the token from a `Bearer <token>` Authorization header.
 *
 * @param c - Request context.
 * @returns The token without the Bearer prefix, or null when the header is
 *   absent or uses another scheme.
 */
function extractBearerToken(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7);
}

/**
 * Checks whether a token has the three-segment shape of a JWT. Shape only —
 * no verification.
 *
 * @param token - Bearer token to inspect.
 * @returns True when the token has exactly three dot-separated segments.
 */
function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

/**
 * Strips trailing slashes so issuer URLs compare equal regardless of how the
 * environment or token happens to spell them.
 *
 * @param value - Issuer URL.
 * @returns The URL without trailing slashes.
 */
function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Decodes a JWT's payload segment (base64url) without verifying the
 * signature — only safe for cheap pre-checks like issuer matching.
 *
 * @param token - JWT to decode.
 * @returns The payload object, or null when the token is malformed or the
 *   payload is not a JSON object.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = atob(padded);
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Cheap unverified check that a JWT claims our Clerk issuer, used to decide
 * whether the expensive signature verification is worth attempting.
 *
 * @param token - JWT-shaped bearer token.
 * @param env - Environment providing CLERK_ISSUER.
 * @returns True when the token's iss claim matches CLERK_ISSUER; false when
 *   the claim is absent, different, or CLERK_ISSUER is unset.
 */
function looksLikeClerkJwt(token: string, env: Env): boolean {
  const expectedIssuer = env.CLERK_ISSUER?.trim();
  if (!expectedIssuer) {
    return false;
  }

  const payload = decodeJwtPayload(token);
  const tokenIssuer = typeof payload?.iss === "string" ? payload.iss : null;
  if (!tokenIssuer) {
    return false;
  }

  return normalizeIssuer(tokenIssuer) === normalizeIssuer(expectedIssuer);
}

/**
 * Verifies the token's signature against Clerk's JWKS.
 *
 * @param c - Request context (provides the JWKS configuration).
 * @param token - JWT-shaped bearer token.
 * @returns True when verification succeeds; false on any verification error.
 */
/**
 * The verified Clerk user id, or null when the token isn't a valid Clerk JWT.
 *
 * Dashboard traffic used to skip rate limiting entirely, which left every authenticated
 * endpoint unbounded per user: a signed-in caller could loop rule creation or execution
 * decisions (each several queries plus a write), and a `notify` rule turns that into
 * unbounded outbound email. Verification is already cached per request by
 * `verifyClerkJwtForRequest`, so keying on the user costs nothing extra.
 */
async function verifiedClerkUserId(
  c: Context<{ Bindings: Env }>,
  token: string
): Promise<string | null> {
  try {
    const payload = await verifyClerkJwtForRequest(c, token);
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Enforces an approximate sliding-window rate limit for the identifier.
 *
 * Time is bucketed into fixed RATE_LIMIT_WINDOW_MS windows. The trailing
 * window ending "now" covers all of the current bucket plus a slice of the
 * previous one, so the request count is estimated as
 * `current + previous * (1 - elapsed/windowMs)` — the previous bucket's
 * requests are assumed uniformly spread, and only the fraction still inside
 * the trailing window is counted. This closes the fixed-window boundary hole
 * (a full burst just before the boundary plus another just after) at the cost
 * of two counter reads instead of one true log of timestamps.
 *
 * Side effects: sets the X-RateLimit-Limit/-Remaining/-Reset response headers
 * (Remaining reserves one slot for the in-flight request), and on admission
 * increments the current bucket's counter with a 2x-window TTL so it survives
 * long enough to serve as the next bucket's "previous". Rejected requests do
 * not increment the counter.
 *
 * Storage failure semantics are chosen per call site: by default a failed
 * counter read/write logs and fails open, keeping cheap traffic flowing
 * through a KV outage. Costly or side-effecting operations pass
 * `failClosed: true`, which turns a missing KV binding or a storage error
 * into a 503 — an unmetered request to a paid upstream is worse than a
 * refused one.
 *
 * @param c - Request context; c.var.kv must be populated by kvStoreMiddleware.
 * @param identifier - Counter scope: client IP for anonymous traffic, API key
 *   id for keyed traffic.
 * @param maxRequests - Maximum admitted requests per window; the auth
 *   middleware passes RATE_LIMIT_TIERS[key.rateLimitTier].
 * @param options - failClosed: reject with 503 instead of admitting when the
 *   counter store is unavailable.
 * @returns Resolves once the request is admitted and the counter incremented.
 * @throws AppError RATE_LIMITED (429) with a Retry-After header when the
 *   estimated count has reached maxRequests; AppError SERVICE_UNAVAILABLE
 *   (503) when failClosed is set and the counter store is unavailable.
 */
export async function enforceRateLimit(
  c: Context<{ Bindings: Env }>,
  identifier: string,
  maxRequests: number,
  options: { failClosed?: boolean } = {}
): Promise<void> {
  const kv = c.var.kv?.rateLimits;
  if (!kv) {
    if (options.failClosed) {
      getLogger().error(
        { event: "sdp_api_rate_limit_unavailable", identifier, reason: "kv_missing" },
        "Rate limit store unavailable; failing closed"
      );
      throw serviceUnavailable("Rate limiting is unavailable; request refused");
    }
    return;
  }

  const now = Date.now();
  const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const previousWindowStart = windowStart - RATE_LIMIT_WINDOW_MS;

  const windowKey = getWindowKey(identifier, windowStart);
  const previousWindowKey = getWindowKey(identifier, previousWindowStart);

  const elapsed = now - windowStart;
  const previousWeight = Math.max(0, 1 - elapsed / RATE_LIMIT_WINDOW_MS);

  const admission = await kv
    .admitSlidingWindow(windowKey, previousWindowKey, {
      maxRequests,
      previousWeight,
      expirationTtl: Math.ceil((RATE_LIMIT_WINDOW_MS * 2) / 1000),
    })
    .catch((err) => {
      getLogger().error({ error: err, identifier }, "Failed to update rate limit");
      return null;
    });

  if (!admission) {
    if (options.failClosed) {
      getLogger().error(
        { event: "sdp_api_rate_limit_unavailable", identifier, reason: "storage_error" },
        "Rate limit store unavailable; failing closed"
      );
      throw serviceUnavailable("Rate limiting is unavailable; request refused");
    }
    return;
  }

  const estimatedCount = admission.current + admission.previous * previousWeight;

  c.header("X-RateLimit-Limit", maxRequests.toString());
  c.header(
    "X-RateLimit-Remaining",
    Math.max(0, Math.floor(maxRequests - estimatedCount)).toString()
  );
  const windowEndMs = windowStart + RATE_LIMIT_WINDOW_MS;
  c.header("X-RateLimit-Reset", Math.ceil(windowEndMs / 1000).toString());

  if (!admission.admitted) {
    const retryAfter = Math.max(1, Math.ceil((windowEndMs - now) / 1000));
    c.header("Retry-After", retryAfter.toString());
    throw rateLimited(`Rate limit exceeded. Retry after ${retryAfter} seconds.`);
  }
}

/**
 * Pre-auth rate limiting middleware. Paths matching an exempt pattern pass
 * straight through (exact, segment-prefix, or single-segment `*` wildcard —
 * see matchesFreePath; bare `startsWith` would mis-skip the whole API when
 * `/` is listed). For everything else: verified Clerk dashboard JWTs get a
 * generous per-user limit (not an exemption — see CLERK_USER_MAX_REQUESTS),
 * sk_-shaped requests get the high per-IP backstop (their real limit is
 * enforced per key after auth via enforceRateLimit), and everything else gets
 * the anonymous per-IP limit.
 *
 * Requires c.var.kv to be populated (by kvStoreMiddleware) on non-exempt
 * paths, so every path kv-store skips must be listed here too — the
 * `c.var.kv.rateLimits` deref has no guard.
 *
 * @param paths - Path patterns exempt from rate limiting.
 * @returns Hono middleware that admits or 429s the request before calling next.
 * @throws AppError RATE_LIMITED (429) from the returned middleware when the
 *   applicable per-IP limit is exceeded.
 */
export function skipRateLimitPaths(...paths: string[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (matchesFreePath(c.req.path, paths)) {
      await next();
      return;
    }

    const bearerToken = extractBearerToken(c);
    if (bearerToken && looksLikeJwt(bearerToken) && looksLikeClerkJwt(bearerToken, c.env)) {
      const clerkUserId = await verifiedClerkUserId(c, bearerToken);
      if (clerkUserId) {
        // Per user, not per IP: an office behind one NAT address is many people, and
        // the dashboard's own background polling would otherwise pool against them.
        await enforceRateLimit(c, `clerk:${clerkUserId}`, CLERK_USER_MAX_REQUESTS);
        await next();
        return;
      }
      // A JWT-shaped token that fails verification falls through to the anonymous
      // limit below, which is what bounds signature-spray against the JWKS check.
    }

    const apiKey = extractApiKey(c);
    const presentsApiKey = apiKey !== null && looksLikeApiKey(apiKey);

    await enforceRateLimit(
      c,
      getClientIp(c) ?? "unknown",
      presentsApiKey ? KEYED_IP_BACKSTOP_MAX_REQUESTS : ANONYMOUS_MAX_REQUESTS
    );
    await next();
  };
}
