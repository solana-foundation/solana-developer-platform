/**
 * KV store test helpers
 *
 * Operate through the runtime-neutral KVStore abstraction so the helpers stay
 * valid once a Redis-backed implementation lands (HOO-510).
 */

import type { AllowedOperation } from "@sdp/types/allowed-operations";
import type {
  ApiKeyEnvironment,
  ApiKeyStatus,
  ApiKeyWalletAuthorizationBinding,
  ApiKeyWalletScope,
  RateLimitTier,
} from "@sdp/types/api-keys";
import type { ApiKeyRole, Permission } from "@sdp/types/permissions";
import { getDb } from "@/db/client";
import { resetTerminalRefusalsForTesting } from "@/lib/api-key-refusal-cache";
import { RATE_LIMIT_WINDOW_MS } from "@/middleware/rate-limit";
import { createKVStoreSet, getRedisClient } from "@/runtime/kv-redis";
import { DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_SLUG } from "@/test/helpers/projects";
import type { Env } from "@/types/env.d";

/**
 * The state of an API key a suite seeds: the `api_keys` columns authentication
 * reads, plus the wallet bindings to store. Authentication reads all of it from
 * Postgres on every request, so this is exactly what a request sees.
 */
export interface SeededApiKey {
  id: string;
  organizationId: string;
  projectId: string;
  role: ApiKeyRole;
  permissions: Permission[];
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  allowedIps: string[] | null;
  allowedOperations?: AllowedOperation[] | null;
  signingWalletId: string | null;
  /** Ignored: a key's scope follows from its stored bindings. */
  walletScope?: ApiKeyWalletScope;
  signingWalletIds?: string[];
  walletBindings?: ApiKeyWalletAuthorizationBinding[];
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
          role, permissions, status, expires_at, rotation_deadline, signing_wallet_id,
          allowed_ips, allowed_operations, rate_limit_tier)
       SELECT ?, p.organization_id, p.id, (SELECT id FROM users ORDER BY id LIMIT 1),
              'Seeded test key', 'sk_test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM projects p
        WHERE p.organization_id = ?
          AND (p.id = ? OR (p.environment = ? AND p.status = 'active'))
        ORDER BY (p.id = ?) DESC
        LIMIT 1
       ON CONFLICT (id) DO UPDATE SET
         key_hash = EXCLUDED.key_hash,
         role = EXCLUDED.role,
         permissions = EXCLUDED.permissions,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         rotation_deadline = EXCLUDED.rotation_deadline,
         signing_wallet_id = EXCLUDED.signing_wallet_id,
         allowed_ips = EXCLUDED.allowed_ips,
         allowed_operations = EXCLUDED.allowed_operations,
         rate_limit_tier = EXCLUDED.rate_limit_tier`
    )
    .bind(
      data.id,
      keyHash,
      data.role,
      JSON.stringify(data.permissions),
      data.status,
      data.expiresAt,
      data.rotationDeadline ?? null,
      data.signingWalletId,
      data.allowedIps === null ? null : JSON.stringify(data.allowedIps),
      data.allowedOperations ? JSON.stringify(data.allowedOperations) : null,
      data.rateLimitTier,
      data.organizationId,
      data.projectId,
      data.environment,
      data.projectId
    )
    .run();

  // Wallet bindings live in their own table: a key that names bindings
  // replaces the key's rows with them. One that names none leaves rows a test
  // inserted itself.
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
