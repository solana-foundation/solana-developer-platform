/**
 * KV store middleware
 *
 * Populates c.var.kv with the runtime-appropriate KVStoreSet. Mounted before
 * any handler that needs KV access, which is effectively every authenticated
 * route — keep it near the top of the global middleware stack in index.ts.
 *
 * Accepts skip paths so KV-free routes (health probes, openapi spec, static
 * docs, webhooks) don't trip the missing-binding throw in createKVStoreSet
 * when a runtime is partially configured. Matching is exact OR segment-prefix
 * (`p` matches `p` and `p/...` but NOT `p<anything-else>`). Segment-prefix
 * is intentionally stricter than skipRateLimitPaths' bare `startsWith`: a
 * loose match here would leave `c.var.kv` undefined on look-alike routes
 * (e.g. `/healthz`) and the failure would surface as a deep handler NPE
 * instead of a clean middleware throw.
 */

import type { Context, Next } from "hono";
import { createKVStoreSet } from "@/runtime/factory";
import type { Env } from "@/types/env";

export function kvStoreMiddleware(...skipPaths: string[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const path = c.req.path;
    if (skipPaths.some((p) => path === p || path.startsWith(`${p}/`))) {
      return next();
    }
    c.set("kv", createKVStoreSet(c.env));
    await next();
  };
}
