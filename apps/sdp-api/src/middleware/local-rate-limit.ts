import type { Context, Next } from "hono";
import { getClientIp } from "@/lib/client-ip";
import { rateLimited } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

interface LocalRateLimitOptions {
  /** Requests admitted per window, per tracked caller, per instance. */
  maxRequests: number;
  windowMs: number;
  /** Upper bound on distinct callers held in memory. */
  maxTrackedKeys: number;
  /** Limiter name, for the log line. */
  name: string;
}

interface Bucket {
  count: number;
  windowStart: number;
}

const UNTRACKED_KEY = "__untracked__";

/**
 * Fixed-window rate limit held in this instance's memory.
 *
 * The shared KV limiter is the right default everywhere it is available. This
 * one exists for the routes that must keep answering while KV is down —
 * refusing a provider's webhook is worse than serving it — so it trades exact
 * accounting across instances for having no dependency at all.
 */
export function localRateLimit(options: LocalRateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  let sweptWindow = Number.NEGATIVE_INFINITY;

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const now = Date.now();
    const windowStart = Math.floor(now / options.windowMs) * options.windowMs;

    if (sweptWindow !== windowStart) {
      for (const [key, bucket] of buckets) {
        if (bucket.windowStart < windowStart) {
          buckets.delete(key);
        }
      }
      sweptWindow = windowStart;
    }

    // An address the proxy did not verify, and everything past the tracking
    // cap, shares one bucket: the map stays bounded, so a spray of distinct
    // source addresses cannot grow it into the memory it was meant to protect.
    const clientIp = getClientIp(c);
    const key =
      clientIp && (buckets.has(clientIp) || buckets.size < options.maxTrackedKeys)
        ? clientIp
        : UNTRACKED_KEY;

    const bucket = buckets.get(key);
    const count = bucket && bucket.windowStart === windowStart ? bucket.count + 1 : 1;
    buckets.set(key, { count, windowStart });

    if (count > options.maxRequests) {
      getLogger().warn(
        {
          event: "sdp_api_local_rate_limit_exceeded",
          limiter: options.name,
          identified: key !== UNTRACKED_KEY,
          path: c.req.path,
        },
        "Local rate limit exceeded"
      );

      // The window is fixed, so the wait is exact rather than the estimate the
      // sliding KV limiter has to make. Only the two headers that survive this
      // limiter's design are sent: the count lives in one instance's memory, so
      // X-RateLimit-Limit and -Remaining would describe a per-replica allowance
      // as if it were the caller's budget across the deployment.
      const windowEndMs = windowStart + options.windowMs;
      const retryAfter = Math.max(1, Math.ceil((windowEndMs - now) / 1000));
      c.header("Retry-After", retryAfter.toString());
      c.header("X-RateLimit-Reset", Math.ceil(windowEndMs / 1000).toString());

      throw rateLimited(`Rate limit exceeded. Retry after ${retryAfter} seconds.`);
    }

    await next();
  };
}
