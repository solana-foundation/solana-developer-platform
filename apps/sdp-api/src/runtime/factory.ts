/**
 * Runtime factory — dispatch to the runtime-specific KVStore. The Redis
 * branch is lazily loaded inside kv-redis so ioredis stays out of the
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
