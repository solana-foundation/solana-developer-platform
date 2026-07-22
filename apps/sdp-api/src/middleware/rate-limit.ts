import type { RateLimitTier } from "@sdp/types";
import type { Context, Next } from "hono";
import { extractApiKey, looksLikeApiKey } from "@/lib/api-key-format";
import { verifyClerkJwtForRequest } from "@/lib/clerk-token";
import { getClientIp } from "@/lib/client-ip";
import { rateLimited } from "@/lib/errors";
import type { Env } from "@/types/env";
import { matchesFreePath } from "./path-match";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const RATE_LIMIT_TIERS = {
  standard: {
    windowMs: 60_000,
    maxRequests: 100,
  },
  elevated: {
    windowMs: 60_000,
    maxRequests: 500,
  },
  unlimited: {
    windowMs: 60_000,
    maxRequests: 10_000,
  },
} as const satisfies Record<RateLimitTier, RateLimitConfig>;

const ANONYMOUS_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 20,
};

/**
 * Per-IP ceiling for requests that present an sk_-shaped credential. Keyed
 * traffic gets its real limit per key id after auth (enforceApiKeyRateLimit),
 * so the anonymous limit must not apply — it would cap every tier at 20/min
 * per IP. The key is unverified at this point, so a high IP ceiling still
 * bounds invalid-key spray against the KV/DB lookup in auth.
 */
const KEYED_IP_BACKSTOP: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 10_000,
};

interface RateLimitState {
  count: number;
  windowStart: number;
}

function getWindowKey(identifier: string, windowStart: number): string {
  return `ratelimit:${identifier}:${windowStart}`;
}

function getWindowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

function extractBearerToken(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7);
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, "");
}

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

async function isVerifiedClerkJwt(c: Context<{ Bindings: Env }>, token: string): Promise<boolean> {
  try {
    await verifyClerkJwtForRequest(c, token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforces an approximate sliding-window rate limit for the identifier: reads
 * the current + previous window counters from KV, weights the previous window
 * by elapsed time, sets X-RateLimit-* headers, throws RATE_LIMITED when the
 * estimate reaches the cap, and increments the current window (TTL 2x window).
 * A failed counter write logs and fails open.
 */
async function enforceRateLimit(
  c: Context<{ Bindings: Env }>,
  identifier: string,
  config: RateLimitConfig
): Promise<void> {
  const kv = c.var.kv.rateLimits;

  const now = Date.now();
  const windowStart = getWindowStart(now, config.windowMs);
  const previousWindowStart = windowStart - config.windowMs;

  const windowKey = getWindowKey(identifier, windowStart);
  const previousWindowKey = getWindowKey(identifier, previousWindowStart);

  const [current, previous] = await Promise.all([
    kv.get<RateLimitState>(windowKey, "json"),
    kv.get<RateLimitState>(previousWindowKey, "json"),
  ]);

  const currentCount = current?.count || 0;
  const previousCount = previous?.count || 0;
  const elapsed = now - windowStart;
  const previousWeight = Math.max(0, 1 - elapsed / config.windowMs);
  const estimatedCount = currentCount + previousCount * previousWeight;

  c.header("X-RateLimit-Limit", config.maxRequests.toString());
  c.header(
    "X-RateLimit-Remaining",
    Math.max(0, Math.floor(config.maxRequests - (estimatedCount + 1))).toString()
  );
  const resetAtSeconds = Math.ceil((windowStart + config.windowMs) / 1000);
  c.header("X-RateLimit-Reset", resetAtSeconds.toString());

  if (estimatedCount >= config.maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + config.windowMs - now) / 1000));
    c.header("Retry-After", retryAfter.toString());
    throw rateLimited(`Rate limit exceeded. Retry after ${retryAfter} seconds.`);
  }

  const newState: RateLimitState = {
    count: currentCount + 1,
    windowStart,
  };

  try {
    await kv.put(windowKey, JSON.stringify(newState), {
      expirationTtl: Math.ceil((config.windowMs * 2) / 1000),
    });
  } catch (err) {
    console.error("Failed to update rate limit:", err);
  }
}

/**
 * Enforces the API key's tier limit, keyed by key id. Called by the auth
 * middleware once the key is resolved (KV cache or DB), because the global
 * rateLimitMiddleware runs before route-level auth and never sees the key.
 */
export async function enforceApiKeyRateLimit(
  c: Context<{ Bindings: Env }>,
  apiKeyId: string,
  tier: RateLimitTier
): Promise<void> {
  await enforceRateLimit(c, apiKeyId, RATE_LIMIT_TIERS[tier]);
}

/**
 * Pre-auth rate limiting middleware: verified Clerk dashboard JWTs are
 * exempt, sk_-shaped requests get the high per-IP backstop (their real limit
 * is enforced per key after auth via enforceApiKeyRateLimit), everything else
 * gets the anonymous per-IP limit.
 *
 * Requires c.var.kv to be populated (by kvStoreMiddleware). Any path that
 * kv-store skips must also be skipped here via skipRateLimitPaths — the
 * `c.var.kv.rateLimits` deref has no guard.
 */
export function rateLimitMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const bearerToken = extractBearerToken(c);

    if (bearerToken && looksLikeJwt(bearerToken) && looksLikeClerkJwt(bearerToken, c.env)) {
      const isClerkToken = await isVerifiedClerkJwt(c, bearerToken);
      if (isClerkToken) {
        await next();
        return;
      }
    }

    const apiKey = extractApiKey(c);
    const presentsApiKey = apiKey !== null && looksLikeApiKey(apiKey);

    await enforceRateLimit(
      c,
      getClientIp(c) ?? "unknown",
      presentsApiKey ? KEYED_IP_BACKSTOP : ANONYMOUS_LIMIT
    );
    await next();
  };
}

/**
 * Skip rate limiting for specific paths (e.g., health check).
 *
 * Matching (see matchesFreePath) is exact, segment-prefix, or a single-segment
 * `*` wildcard. Bare `startsWith` would mis-skip the whole API when `/` is
 * listed, since every pathname starts with `/`.
 */
export function skipRateLimitPaths(...paths: string[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const path = c.req.path;

    if (matchesFreePath(path, paths)) {
      await next();
      return;
    }

    // Apply rate limiting
    const rateLimiter = rateLimitMiddleware();
    await rateLimiter(c, next);
  };
}
