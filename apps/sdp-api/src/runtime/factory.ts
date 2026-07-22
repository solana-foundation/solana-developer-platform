/** Build the Redis-backed KV stores used by the Node runtime. */

import type { Env } from "@/types/env";
import type { KVStoreSet } from "./kv";
import { createRedisKVStoreSet } from "./kv-redis";

export function createKVStoreSet(env: Env): KVStoreSet {
  return createRedisKVStoreSet(env);
}
