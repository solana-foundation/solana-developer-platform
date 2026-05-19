/**
 * Runtime factory — single dispatch point for runtime-specific implementations.
 *
 * Cloudflare branch returns the Workers KV bindings (HOO-506). Node branch
 * returns the Redis-backed set (HOO-510). Switch is driven by SDP_RUNTIME.
 */

import { getRuntime } from "@/lib/runtime-env";
import type { Env } from "@/types/env";
import type { KVStoreSet } from "./kv";
import { createRedisKVStoreSet } from "./kv-redis";
import { createWorkersKVStoreSet } from "./kv-workers";

export function createKVStoreSet(env: Env): KVStoreSet {
  const runtime = getRuntime(env);
  if (runtime === "node") {
    return createRedisKVStoreSet(env);
  }
  return createWorkersKVStoreSet(env);
}
