/**
 * KV store test helpers
 *
 * Operate through the runtime-neutral KVStore abstraction so the helpers stay
 * valid once a Redis-backed implementation lands (HOO-510).
 */

import type { CachedApiKey } from "@sdp/types";
import { createKVStoreSet } from "@/runtime/factory";
import type { Env } from "@/types/env";

/**
 * Seeds a cached API key into KV for testing auth
 */
export async function seedCachedApiKey(
  env: Env,
  keyHash: string,
  data: CachedApiKey
): Promise<void> {
  const kv = createKVStoreSet(env);
  await kv.apiKeys.put(`key:${keyHash}`, JSON.stringify(data), {
    expirationTtl: 3600,
  });
}

/**
 * Clears all KV data
 */
export async function clearKVNamespaces(env: Env): Promise<void> {
  const kv = createKVStoreSet(env);
  const stores = [kv.apiKeys, kv.rateLimits, kv.cache];

  for (const store of stores) {
    const list = await store.list();
    for (const key of list.keys) {
      await store.delete(key.name);
    }
  }
}

/**
 * Seeds rate limit data
 */
export async function seedRateLimit(env: Env, identifier: string, count: number): Promise<void> {
  const windowMs = 60_000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const key = `ratelimit:${identifier}:${windowStart}`;

  const kv = createKVStoreSet(env);
  await kv.rateLimits.put(key, JSON.stringify({ count, windowStart }), {
    expirationTtl: 120,
  });
}
