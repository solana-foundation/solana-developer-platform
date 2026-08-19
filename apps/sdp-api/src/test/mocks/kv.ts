/**
 * KV store test helpers
 *
 * Operate through the runtime-neutral KVStore abstraction so the helpers stay
 * valid once a Redis-backed implementation lands (HOO-510).
 */

import type { CachedApiKey } from "@sdp/types";
import { getDb } from "@/db/client";
import { RATE_LIMIT_WINDOW_MS } from "@/middleware/rate-limit";
import { createKVStoreSet } from "@/runtime/kv-redis";
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
  const walletBindings = await Promise.all(
    (data.walletBindings ?? []).map(async (binding) => {
      if (binding.custodyWalletId) {
        return binding;
      }

      const matches = await getDb(env).queryMany<{ id: string }>(
        `SELECT w.id
           FROM custody_wallets w
           LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
           LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
          WHERE w.wallet_id = ?
            AND w.status = 'active'
            AND (
              (
                cfg.status = 'active'
                AND cfg.organization_id = ?
                AND (cfg.project_id IS NULL OR cfg.project_id = ?)
              )
              OR (
                conn.status = 'active'
                AND conn.organization_id = ?
                AND conn.project_id = ?
              )
            )
          ORDER BY w.id
          LIMIT 2`,
        [binding.walletId, data.organizationId, data.projectId, data.organizationId, data.projectId]
      );

      // ponytail: legacy execution fixtures still use Provider IDs; HOO-1023 will make them exact.
      return {
        ...binding,
        custodyWalletId: matches.length === 1 && matches[0] ? matches[0].id : binding.walletId,
      };
    })
  );
  await kv.apiKeys.put(
    `key:${keyHash}`,
    JSON.stringify({
      ...data,
      rotationDeadline: data.rotationDeadline ?? null,
      walletScope:
        data.walletScope ??
        ((data.walletBindings?.length ?? 0) > 0 || data.signingWalletId ? "selected" : "all"),
      walletBindings,
    }),
    {
      expirationTtl: 3600,
    }
  );
}

/**
 * Clears all KV data
 */
export async function clearKVStores(env: Env): Promise<void> {
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
 * Seeds a rate limit counter bucket.
 *
 * @param env - Test environment bindings.
 * @param identifier - Counter scope (client IP or API key id).
 * @param count - Request count to seed the bucket with.
 * @param windowsAgo - How many whole windows before the current one to seed
 *   (0 = current bucket, 1 = previous bucket for sliding-window overlap).
 */
export async function seedRateLimit(
  env: Env,
  identifier: string,
  count: number,
  windowsAgo = 0
): Promise<void> {
  const windowStart =
    Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS -
    windowsAgo * RATE_LIMIT_WINDOW_MS;
  const key = `ratelimit:${identifier}:${windowStart}`;

  const kv = createKVStoreSet(env);
  await kv.rateLimits.put(key, String(count), {
    expirationTtl: 120,
  });
}

/**
 * Reads a rate limit bucket's current count.
 *
 * @param env - Test environment bindings.
 * @param identifier - Counter scope (client IP or API key id).
 * @returns The current bucket's count, or 0 when the bucket does not exist.
 */
export async function readRateLimitCount(env: Env, identifier: string): Promise<number> {
  const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const kv = createKVStoreSet(env);
  const raw = await kv.rateLimits.get(`ratelimit:${identifier}:${windowStart}`);
  return raw === null ? 0 : Number(raw);
}
