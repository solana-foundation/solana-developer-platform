/**
 * KV store middleware
 *
 * Populates c.var.kv with the runtime-appropriate KVStoreSet. Mounted before
 * any handler that needs KV access, which is effectively every authenticated
 * route — keep it near the top of the global middleware stack in index.ts.
 *
 * Accepts skip paths so KV-free routes (health probes, openapi spec, static
 * docs, webhooks) don't trip the missing-binding throw in createKVStoreSet
 * when a runtime is partially configured. Matching (see matchesFreePath) is
 * exact, segment-prefix, or a single-segment `*` wildcard — the public
 * token-metadata route uses the wildcard so it skips KV without freeing the
 * sibling authed token routes a coarse prefix would.
 *
 * Every path skipped here MUST also be skipped by skipRateLimitPaths in the
 * same wiring — rateLimitMiddleware dereferences c.var.kv without a guard,
 * so a kv-skipped path that reaches rate-limit blows up as a TypeError. The
 * call site in index.ts shares a single KV_FREE_PATHS constant for both
 * middlewares to enforce this by construction.
 */

import type { Context, Next } from "hono";
import { createKVStoreSet } from "@/runtime/factory";
import type { Env } from "@/types/env";
import { matchesFreePath } from "./path-match";

export function kvStoreMiddleware(...skipPaths: string[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const path = c.req.path;
    if (matchesFreePath(path, skipPaths)) {
      return next();
    }
    c.set("kv", createKVStoreSet(c.env));
    await next();
  };
}
