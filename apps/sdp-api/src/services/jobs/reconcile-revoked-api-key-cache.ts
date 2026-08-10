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

/**
 * Hard cap on rows per tick, newest revocations first. Anything beyond it is
 * picked up by later ticks (repaired entries turn terminal and become cheap
 * skips) and bounded regardless by the one-hour cache TTL.
 */
const DEFAULT_SCAN_LIMIT = 10_000;

/** Cache reads/repairs in flight at once — bounds Redis and pool pressure. */
const SWEEP_CONCURRENCY = 25;

const TERMINAL_STATUSES: ReadonlySet<ApiKeyStatus> = new Set(["revoked", "deactivated", "expired"]);

export interface RevokedApiKeyCacheReconciliation {
  scanned: number;
  repaired: number;
}

/**
 * Guarded parse: a malformed or legacy non-JSON value must read as "needs
 * repair", never crash the sweep — this cron tick also runs the payment and
 * custody reconciliation jobs.
 */
function tryParseCachedEntry(raw: string): CachedApiKey | null {
  try {
    const parsed = JSON.parse(raw) as CachedApiKey | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export interface ReconcileRevokedApiKeyCacheOptions {
  /** Maximum rows examined per tick. Defaults to DEFAULT_SCAN_LIMIT. */
  scanLimit?: number;
}

export async function reconcileRevokedApiKeyCache(
  env: Env,
  options: ReconcileRevokedApiKeyCacheOptions = {}
): Promise<RevokedApiKeyCacheReconciliation> {
  const db = getDb(env);
  const kv = createKVStoreSet(env).apiKeys;
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;

  // revoked_at is TEXT with two writer formats (sdp_datetime_now() and
  // toISOString()); the timestamptz casts make the comparison format-proof.
  // Newest first under a hard LIMIT so a bulk revocation cannot hand this
  // tick an unbounded row set: the freshest divergences — the ones with the
  // most cache TTL left to exploit — are always repaired first, and the
  // remainder rolls into later ticks.
  const rows = await db
    .prepare(
      `SELECT key_hash FROM api_keys
       WHERE status != 'active'
         AND revoked_at IS NOT NULL
         AND revoked_at::timestamptz > ?::timestamptz
       ORDER BY revoked_at::timestamptz DESC
       LIMIT ?`
    )
    .bind(cutoff, scanLimit)
    .all<{ key_hash: string }>();

  const recentlyRevoked = rows.results ?? [];
  let repaired = 0;

  // Fixed-width chunks: bounded overlap keeps a large backlog from becoming
  // thousands of sequential round-trips, without unbounded fan-out starving
  // the connection pool that the payment/custody jobs share.
  for (let offset = 0; offset < recentlyRevoked.length; offset += SWEEP_CONCURRENCY) {
    const chunk = recentlyRevoked.slice(offset, offset + SWEEP_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (row) => {
        const raw = await kv.get(apiKeyCacheKey(row.key_hash));
        if (raw === null) {
          return false;
        }
        const cached = tryParseCachedEntry(raw);
        if (cached && TERMINAL_STATUSES.has(cached.status)) {
          return false;
        }
        // Stale-active or unparseable: overwrite with authoritative state.
        await refreshApiKeyCache(db, kv, row.key_hash);
        return true;
      })
    );
    repaired += outcomes.filter(Boolean).length;
  }

  if (repaired > 0) {
    getLogger().warn(
      { repaired, scanned: recentlyRevoked.length },
      "Repaired stale active cache entries for revoked API keys"
    );
  }

  if (recentlyRevoked.length === scanLimit) {
    // Never let a truncated sweep read as full coverage.
    getLogger().warn(
      { scanLimit },
      "Revoked API key cache sweep hit its scan limit; remaining keys roll into the next tick"
    );
  }

  return { scanned: recentlyRevoked.length, repaired };
}
