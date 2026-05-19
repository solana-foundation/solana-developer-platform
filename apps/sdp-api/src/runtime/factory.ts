/**
 * Runtime factory — single dispatch point for runtime-specific implementations.
 *
 * Cloudflare branch returns the Workers KV bindings (HOO-506). Node branch
 * returns the Redis-backed set (HOO-510). Switch is driven by SDP_RUNTIME.
 *
 * The Redis branch holds a Promise<Redis> internally (created lazily in
 * kv-redis), so this factory stays synchronous and ioredis stays out of the
 * Cloudflare bundle / Workers test pool's module graph.
 */

import { getRuntime } from "@/lib/runtime-env";
import type { Env } from "@/types/env";
import type { KVStoreSet } from "./kv";
import { createRedisKVStoreSet } from "./kv-redis";
import { createWorkersKVStoreSet } from "./kv-workers";

export function createKVStoreSet(env: Env): KVStoreSet {
  if (getRuntime(env) === "node") {
    return createRedisKVStoreSet(env);
  }
  return createWorkersKVStoreSet(env);
}
