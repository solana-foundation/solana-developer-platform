/**
 * Rate Limiting Middleware
 *
 * Uses an approximate sliding window counter stored in KV.
 * Different tiers have different limits.
 */

import type { Context, Next } from "hono";
import { verifyClerkJwtForRequest } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import { matchesFreePath } from "./path-match";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const RATE_LIMIT_TIERS: Record<string, RateLimitConfig> = {
  standard: {
    windowMs: 60_000, // 1 minute
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
};

// Fallback for unauthenticated requests
const ANONYMOUS_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 20,
};

interface RateLimitState {
  count: number;
  windowStart: number;
}

/**
 * Get the window key
 */
function getWindowKey(identifier: string, windowStart: number): string {
  return `ratelimit:${identifier}:${windowStart}`;
}

function getWindowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

function getClientIdentifier(c: Context<{ Bindings: Env }>): string {
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) {
    return cfIp;
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }

  return "unknown";
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
 * Rate limiting middleware
 *
 * Requires c.var.kv to be populated (by kvStoreMiddleware). Any path that
 * kv-store skips must also be skipped here via skipRateLimitPaths — the
 * `c.var.kv.rateLimits` deref below has no guard.
 */
export function rateLimitMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const kv = c.var.kv.rateLimits;
    const auth = c.get("apiKey");
    const bearerToken = extractBearerToken(c);

    // Clerk-authenticated dashboard traffic is not rate-limited.
    // Only bypass when the bearer token verifies as a Clerk JWT.
    if (
      !auth &&
      bearerToken &&
      looksLikeJwt(bearerToken) &&
      looksLikeClerkJwt(bearerToken, c.env)
    ) {
      const isClerkToken = await isVerifiedClerkJwt(c, bearerToken);
      if (isClerkToken) {
        await next();
        return;
      }
    }

    // Determine rate limit tier
    let identifier: string;
    let config: RateLimitConfig;

    if (auth) {
      identifier = auth.id;
      const tier = auth.role === "api_admin" ? "unlimited" : "standard";
      config = RATE_LIMIT_TIERS[tier] || RATE_LIMIT_TIERS.standard;
    } else {
      // Use IP for anonymous requests
      identifier = getClientIdentifier(c);
      config = ANONYMOUS_LIMIT;
    }

    const now = Date.now();
    const windowStart = getWindowStart(now, config.windowMs);
    const previousWindowStart = windowStart - config.windowMs;

    const windowKey = getWindowKey(identifier, windowStart);
    const previousWindowKey = getWindowKey(identifier, previousWindowStart);

    // Get current + previous window counts for sliding window approximation
    const [current, previous] = await Promise.all([
      kv.get<RateLimitState>(windowKey, "json"),
      kv.get<RateLimitState>(previousWindowKey, "json"),
    ]);

    const currentCount = current?.count || 0;
    const previousCount = previous?.count || 0;
    const elapsed = now - windowStart;
    const previousWeight = Math.max(0, 1 - elapsed / config.windowMs);
    const estimatedCount = currentCount + previousCount * previousWeight;

    // Set rate limit headers
    c.header("X-RateLimit-Limit", config.maxRequests.toString());
    c.header(
      "X-RateLimit-Remaining",
      Math.max(0, Math.floor(config.maxRequests - (estimatedCount + 1))).toString()
    );
    const resetAtSeconds = Math.ceil((windowStart + config.windowMs) / 1000);
    c.header("X-RateLimit-Reset", resetAtSeconds.toString());

    // Check limit
    if (estimatedCount >= config.maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((windowStart + config.windowMs - now) / 1000));
      c.header("Retry-After", retryAfter.toString());
      throw new AppError("RATE_LIMITED", `Rate limit exceeded. Retry after ${retryAfter} seconds.`);
    }

    // Increment counter for the current window
    const newState: RateLimitState = {
      count: currentCount + 1,
      windowStart,
    };

    // TTL is 2x window to ensure cleanup
    try {
      await kv.put(windowKey, JSON.stringify(newState), {
        expirationTtl: Math.ceil((config.windowMs * 2) / 1000),
      });
    } catch (err) {
      console.error("Failed to update rate limit:", err);
    }

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
