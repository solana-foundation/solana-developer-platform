/**
 * Reconcile the API-key auth cache against authoritative revocations.
 *
 * Revocation paths write the revoked state into the KV cache before
 * reporting success, but that write happens after the database commit and
 * can fail (e.g. a transient Redis outage during organization deletion).
 * When it does, the revoked key keeps authenticating from its cached
 * "active" entry for the rest of the cache TTL — and after an organization
 * deletion the administrator's own credentials are gone, so no client-side
 * retry can repair it.
 *
 * This sweep runs from the per-minute reconciliation cron and needs no
 * request credentials: it lists keys revoked within the last two hours
 * (cache TTL is one hour; the extra hour absorbs clock skew between
 * writers), reads each one's cache entry, and rewrites any that still
 * report a non-terminal status. Divergence therefore heals within about a
 * minute of Redis recovering, no matter how the original request ended.
 */

import type { ApiKeyStatus, CachedApiKey } from "@sdp/types";
import { getDb } from "@/db";
import { apiKeyCacheKey, refreshApiKeyCache } from "@/lib/api-key-cache";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

const LOOKBACK_MS = 2 * 60 * 60 * 1000;

const TERMINAL_STATUSES: ReadonlySet<ApiKeyStatus> = new Set(["revoked", "deactivated", "expired"]);

export interface RevokedApiKeyCacheReconciliation {
  scanned: number;
  repaired: number;
}

export async function reconcileRevokedApiKeyCache(
  env: Env
): Promise<RevokedApiKeyCacheReconciliation> {
  const db = getDb(env);
  const kv = createKVStoreSet(env).apiKeys;
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();

  // revoked_at is TEXT with two writer formats (sdp_datetime_now() and
  // toISOString()); the timestamptz casts make the comparison format-proof.
  const rows = await db
    .prepare(
      `SELECT key_hash FROM api_keys
       WHERE status != 'active'
         AND revoked_at IS NOT NULL
         AND revoked_at::timestamptz > ?::timestamptz`
    )
    .bind(cutoff)
    .all<{ key_hash: string }>();

  const recentlyRevoked = rows.results ?? [];
  let repaired = 0;

  for (const row of recentlyRevoked) {
    const cached = await kv.get<CachedApiKey>(apiKeyCacheKey(row.key_hash), "json");
    if (!cached || TERMINAL_STATUSES.has(cached.status)) {
      continue;
    }
    await refreshApiKeyCache(db, kv, row.key_hash);
    repaired += 1;
  }

  if (repaired > 0) {
    getLogger().warn(
      { repaired, scanned: recentlyRevoked.length },
      "Repaired stale active cache entries for revoked API keys"
    );
  }

  return { scanned: recentlyRevoked.length, repaired };
}
