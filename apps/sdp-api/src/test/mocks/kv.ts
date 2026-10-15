/**
 * KV store test helpers
 *
 * Operate through the runtime-neutral KVStore abstraction so the helpers stay
 * valid once a Redis-backed implementation lands (HOO-510).
 */

import type {
  Action,
  ApiKeyEnvironment,
  ApiKeyStatus,
  ApiKeyWalletScope,
  RateLimitTier,
} from "@sdp/types";
import { getDb } from "@/db/client";
import { resetTerminalRefusalsForTesting } from "@/lib/api-key-refusal-cache";
import { RATE_LIMIT_WINDOW_MS } from "@/middleware/rate-limit";
import { createKVStoreSet, getRedisClient } from "@/runtime/kv-redis";
import { DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_SLUG } from "@/test/helpers/projects";
import type { Env } from "@/types/env";

/**
 * The state of an API key a suite seeds: the `api_keys` columns authentication
 * reads, plus the signing wallets to list. Authentication reads all of it from
 * Postgres on every request, so this is exactly what a request sees.
 */
export interface SeededApiKey {
  id: string;
  organizationId: string;
  projectId: string;
  /** The key's explicit grants (`api_keys.grants`). */
  grants: readonly Action[];
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  allowedIps: string[] | null;
  /** `api_keys.wallet_scope`; `all` unless the seed names a scope or wallets. */
  walletScope?: ApiKeyWalletScope;
  /**
   * Custody wallet ids (`custody_wallets.id`) a `selected` key lists. Naming
   * them makes the key `selected` and replaces its list; the wallets must
   * already exist (the list has a foreign key).
   */
  walletIds?: string[];
  status: ApiKeyStatus;
  expiresAt: string | null;
  rotationDeadline?: string | null;
  /** Ignored: authentication reads the organization row's own status. */
  organizationStatus?: string;
}

/** Creates the user a seeded key row needs when the suite has none. */
const SEEDED_KEY_CREATOR_ID = "usr_seeded_key_creator";

/**
 * Writes the `api_keys` row for a seeded key, inserting it or overwriting the
 * columns authentication reads, so a second seed of the same key changes what
 * its next request sees. The key joins `projectId` when the organization has
 * it; otherwise the organization's active project in the key's environment
 * (one per environment), which is created as `projectId`, with the default
 * project's name and slug, when there is none.
 * Skipped when the organization does not exist.
 */
export async function seedApiKeyRow(env: Env, keyHash: string, data: SeededApiKey): Promise<void> {
  // A seed can bring a refused key back to life within a test; the
  // instance's refusal cache must not outlive that.
  resetTerminalRefusalsForTesting();
  const db = getDb(env);
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
       SELECT ?, o.id, ?, ?, ?, 'active',
              (SELECT id FROM users ORDER BY id LIMIT 1)
         FROM organizations o
        WHERE o.id = ?
          AND NOT EXISTS (
            SELECT 1 FROM projects
             WHERE organization_id = o.id AND environment = ? AND status = 'active'
          )
       ON CONFLICT DO NOTHING`
    )
    .bind(
      data.projectId,
      DEFAULT_PROJECT_NAME[data.environment],
      DEFAULT_PROJECT_SLUG[data.environment],
      data.environment,
      data.organizationId,
      data.environment
    )
    .run();
  await db
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
          grants, status, expires_at, rotation_deadline, wallet_scope,
          allowed_ips, rate_limit_tier)
       SELECT ?, p.organization_id, p.id, (SELECT id FROM users ORDER BY id LIMIT 1),
              'Seeded test key', 'sk_test', ?, ?, ?, ?, ?, ?, ?, ?
         FROM projects p
        WHERE p.organization_id = ?
          AND (p.id = ? OR (p.environment = ? AND p.status = 'active'))
        ORDER BY (p.id = ?) DESC
        LIMIT 1
       ON CONFLICT (id) DO UPDATE SET
         key_hash = EXCLUDED.key_hash,
         grants = EXCLUDED.grants,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         rotation_deadline = EXCLUDED.rotation_deadline,
         wallet_scope = EXCLUDED.wallet_scope,
         allowed_ips = EXCLUDED.allowed_ips,
         rate_limit_tier = EXCLUDED.rate_limit_tier`
    )
    .bind(
      data.id,
      keyHash,
      [...data.grants],
      data.status,
      data.expiresAt,
      data.rotationDeadline ?? null,
      data.walletScope ?? (data.walletIds === undefined ? "all" : "selected"),
      data.allowedIps === null ? null : JSON.stringify(data.allowedIps),
      data.rateLimitTier,
      data.organizationId,
      data.projectId,
      data.environment,
      data.projectId
    )
    .run();

  // The signing list lives in its own table: a seed that names wallets
  // replaces the key's rows with them. One that names none leaves rows a test
  // inserted itself.
  if (data.walletIds === undefined) {
    return;
  }
  const walletIds = data.walletIds;
  // One replacement: a failed insert must not leave the key partly listed.
  await db.transaction(async (tx) => {
    await tx.execute("DELETE FROM api_key_signing_wallets WHERE api_key_id = ?", [data.id]);
    await tx.execute(
      `INSERT INTO api_key_signing_wallets (api_key_id, custody_wallet_id)
       SELECT ak.id, w FROM api_keys ak CROSS JOIN unnest(?::text[]) AS w WHERE ak.id = ?
       ON CONFLICT DO NOTHING`,
      [walletIds, data.id]
    );
  });
}

/**
 * Clears all KV data
 */
export async function clearKVStores(env: Env): Promise<void> {
  const kv = createKVStoreSet(env);
  const stores = [kv.rateLimits, kv.cache];

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
 * @param identifier - Counter scope (client IP, `api-key:<hash>`, actor, org).
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
 * @param identifier - Counter scope (client IP, `api-key:<hash>`, actor, org).
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
