/**
 * KV store middleware
 *
 * Populates c.var.kv with the runtime-appropriate KVStoreSet. Mounted before
 * any handler that needs KV access, which is effectively every authenticated
 * route — keep it near the top of the global middleware stack in index.ts.
 */

import type { Context, Next } from "hono";
import { createKVStoreSet } from "@/runtime/factory";
import type { Env } from "@/types/env";

export function kvStoreMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    c.set("kv", createKVStoreSet(c.env));
    await next();
  };
}
