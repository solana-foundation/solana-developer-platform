/**
 * KV store test helpers
 *
 * Operate through the runtime-neutral KVStore abstraction so the helpers stay
 * valid once a Redis-backed implementation lands (HOO-510).
 */

import type { CachedApiKey } from "@sdp/types/api-keys";
import { getDb } from "@/db/client";
import { RATE_LIMIT_WINDOW_MS } from "@/middleware/rate-limit";
import { createKVStoreSet, getRedisClient } from "@/runtime/kv-redis";
import type { Env } from "@/types/env";

/**
 * Seeds a cached API key into KV for testing auth, and its `api_keys` row when
 * the suite has not inserted one: authentication re-reads the key's live row
 * on every request and refuses a cached key that has none (HOO-1955). A row
 * the suite already inserted is left as it is, so a test can still make the
 * cache and the row disagree on purpose.
 */
export async function seedCachedApiKey(
  env: Env,
  keyHash: string,
  data: CachedApiKey
): Promise<void> {
  await seedApiKeyRowFor(env, keyHash, data);
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
                AND cfg.project_id = ?
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
      organizationStatus: data.organizationStatus ?? "active",
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

/** Creates the user a seeded key row needs when the suite has none. */
const SEEDED_KEY_CREATOR_ID = "usr_seeded_key_creator";

/**
 * Inserts the `api_keys` row a cached key stands for, mirroring the cached
 * lifecycle columns. Authentication matches the row by key and organization
 * only, so when the suite has not seeded the key's project the row hangs off
 * an inactive placeholder project, which the one-active-project-per-
 * environment rule ignores and no request ever selects. Skipped when the row
 * (or its hash) already exists, or when the organization does not.
 */
export async function seedApiKeyRowFor(
  env: Env,
  keyHash: string,
  data: CachedApiKey
): Promise<void> {
  const db = getDb(env);
  const placeholderProjectId = `${data.organizationId}_seeded_key_project`;
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       SELECT ?, 'seeded-key-creator@example.test', 1, 'active'
        WHERE NOT EXISTS (SELECT 1 FROM users)
       ON CONFLICT DO NOTHING`
    )
    .bind(SEEDED_KEY_CREATOR_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
       SELECT ?, o.id, 'Seeded key project', ?, ?, 'inactive', (SELECT id FROM users ORDER BY id LIMIT 1)
         FROM organizations o
        WHERE o.id = ?
          AND NOT EXISTS (SELECT 1 FROM projects WHERE id = ? AND organization_id = o.id)
       ON CONFLICT DO NOTHING`
    )
    .bind(
      placeholderProjectId,
      placeholderProjectId,
      data.environment,
      data.organizationId,
      data.projectId
    )
    .run();
  await db
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
          role, permissions, status, expires_at, rotation_deadline, signing_wallet_id)
       SELECT ?, p.organization_id, p.id, (SELECT id FROM users ORDER BY id LIMIT 1),
              'Seeded test key', 'sk_test', ?, ?, ?, ?, ?, ?, ?
         FROM projects p
        WHERE p.organization_id = ? AND p.id IN (?, ?)
        ORDER BY (p.id = ?) DESC
        LIMIT 1
       ON CONFLICT DO NOTHING`
    )
    .bind(
      data.id,
      keyHash,
      data.role,
      JSON.stringify(data.permissions),
      data.status,
      data.expiresAt,
      data.rotationDeadline === undefined ? null : data.rotationDeadline,
      data.signingWalletId,
      data.organizationId,
      data.projectId,
      placeholderProjectId,
      data.projectId
    )
    .run();

  // Authentication reads wallet bindings from Postgres on every request
  // (HOO-2048), so an entry that names bindings replaces the key's rows with
  // them. One that names none leaves rows a test inserted itself.
  if (data.walletBindings === undefined && data.signingWalletIds === undefined) {
    return;
  }
  const bindings = [
    ...(data.walletBindings ?? []).map((binding) => ({
      walletId: binding.walletId,
      permissions: binding.permissions,
    })),
    ...(data.signingWalletIds ?? [])
      .filter((walletId) => !data.walletBindings?.some((binding) => binding.walletId === walletId))
      .map((walletId) => ({ walletId, permissions: ["*"] })),
  ];
  // One replacement: a failed insert must not leave the key partly unbound.
  await db.transaction(async (tx) => {
    await tx.execute("DELETE FROM api_key_wallet_permissions WHERE api_key_id = ?", [data.id]);
    for (const binding of bindings) {
      await tx.execute(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         SELECT ?, ak.id, ?, ? FROM api_keys ak WHERE ak.id = ?
         ON CONFLICT DO NOTHING`,
        [
          `akw_${crypto.randomUUID()}`,
          binding.walletId,
          JSON.stringify(binding.permissions),
          data.id,
        ]
      );
    }
  });
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
 * Empties this worker's Redis logical database. Every vitest worker shares one
 * Redis server on its own logical database (src/test/helpers/env.ts), so a
 * raw-Redis suite resets through FLUSHDB here and never FLUSHALL, which would
 * wipe other workers' in-flight state mid-test.
 *
 * @param env - Test environment bindings carrying this worker's REDIS_URL.
 * @returns Resolves once the worker's logical database is empty.
 */
export async function flushWorkerRedis(env: Env): Promise<void> {
  const redis = await getRedisClient(env);
  await redis.flushdb();
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
  // Raw, unweighted sum of charges across the two live buckets — NOT the
  // limiter's time-weighted sliding-window estimate. Tests assert "how many
  // charges were recorded", and reading only the current bucket made a charge
  // just before a window rollover read back as 0.
  const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const kv = createKVStoreSet(env);
  const [current, previous] = await Promise.all([
    kv.rateLimits.get(`ratelimit:${identifier}:${windowStart}`),
    kv.rateLimits.get(`ratelimit:${identifier}:${windowStart - RATE_LIMIT_WINDOW_MS}`),
  ]);
  return (current === null ? 0 : Number(current)) + (previous === null ? 0 : Number(previous));
}
