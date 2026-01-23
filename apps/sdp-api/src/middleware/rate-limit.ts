/**
 * Rate Limiting Middleware
 *
 * Uses sliding window counter stored in KV.
 * Different tiers have different limits.
 */

import type { Context, Next } from "hono";
import type { Env } from "@/types/env";
import { AppError } from "@/lib/errors";

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
 * Get the current window key
 */
function getWindowKey(identifier: string, windowMs: number): string {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  return `ratelimit:${identifier}:${windowStart}`;
}

/**
 * Rate limiting middleware
 */
export function rateLimitMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const kv = c.env.SDP_RATE_LIMITS;
    const auth = c.get("apiKey");

    // Determine rate limit tier
    let identifier: string;
    let config: RateLimitConfig;

    if (auth) {
      identifier = auth.id;
      const tier = auth.role === "api_admin" ? "unlimited" : "standard";
      config = RATE_LIMIT_TIERS[tier] || RATE_LIMIT_TIERS.standard;
    } else {
      // Use IP for anonymous requests
      identifier = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
      config = ANONYMOUS_LIMIT;
    }

    const windowKey = getWindowKey(identifier, config.windowMs);

    // Get current count
    const current = await kv.get<RateLimitState>(windowKey, "json");
    const count = current?.count || 0;

    // Set rate limit headers
    c.header("X-RateLimit-Limit", config.maxRequests.toString());
    c.header("X-RateLimit-Remaining", Math.max(0, config.maxRequests - count - 1).toString());
    c.header("X-RateLimit-Reset", (Math.floor(Date.now() / config.windowMs) + 1).toString());

    // Check limit
    if (count >= config.maxRequests) {
      const retryAfter = Math.ceil(
        (config.windowMs - (Date.now() % config.windowMs)) / 1000
      );
      c.header("Retry-After", retryAfter.toString());
      throw new AppError("RATE_LIMITED", `Rate limit exceeded. Retry after ${retryAfter} seconds.`);
    }

    // Increment counter (fire and forget)
    const newState: RateLimitState = {
      count: count + 1,
      windowStart: Math.floor(Date.now() / config.windowMs) * config.windowMs,
    };

    // TTL is 2x window to ensure cleanup
    kv.put(windowKey, JSON.stringify(newState), {
      expirationTtl: Math.ceil((config.windowMs * 2) / 1000),
    }).catch((err) => console.error("Failed to update rate limit:", err));

    await next();
  };
}

/**
 * Skip rate limiting for specific paths (e.g., health check)
 */
export function skipRateLimitPaths(...paths: string[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const path = new URL(c.req.url).pathname;

    if (paths.some((p) => path === p || path.startsWith(p))) {
      await next();
      return;
    }

    // Apply rate limiting
    const rateLimiter = rateLimitMiddleware();
    await rateLimiter(c, next);
  };
}
