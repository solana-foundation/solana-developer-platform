/**
 * KV Namespace test helpers
 */

import type { CachedApiKey } from "@sdp/types";
import type { Env } from "@/types/env";

/**
 * Seeds a cached API key into KV for testing auth
 */
export async function seedCachedApiKey(
  env: Env,
  keyHash: string,
  data: CachedApiKey
): Promise<void> {
  await env.SDP_API_KEYS!.put(`key:${keyHash}`, JSON.stringify(data), {
    expirationTtl: 3600,
  });
}

/**
 * Clears all KV data
 */
export async function clearKVNamespaces(env: Env): Promise<void> {
  const namespaces = [env.SDP_API_KEYS!, env.SDP_RATE_LIMITS!, env.SDP_CACHE!];

  for (const ns of namespaces) {
    const list = await ns.list();
    for (const key of list.keys) {
      await ns.delete(key.name);
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

  await env.SDP_RATE_LIMITS!.put(key, JSON.stringify({ count, windowStart }), {
    expirationTtl: 120,
  });
}
