/**
 * Reconcile the API-key auth cache against authoritative revocations and
 * rotation deadlines.
 *
 * Revocation paths write the revoked state into the KV cache before
 * reporting success, but that write happens after the database commit and
 * can fail (e.g. a transient Redis outage during organization deletion).
 * When it does, the revoked key keeps authenticating from its cached
 * "active" entry for the rest of the cache TTL — and after an organization
 * deletion the administrator's own credentials are gone, so no client-side
 * retry can repair it.
 *
 * Rotation has the same post-commit cache write with a harder constraint:
 * its request cannot be failed or retried when the write is lost, because
 * the replacement key's one-time secret exists only in the pending response
 * and a retried rotation would mint a second live credential. The rotation
 * handler therefore never 500s over this write, and this sweep is the
 * durable path that makes the old key's cached entry pick up its rotation
 * deadline.
 *
 * The sweep runs from the per-minute reconciliation cron and needs no
 * request credentials: it lists keys revoked within the last two hours
 * (cache TTL is one hour; the extra hour absorbs clock skew between
 * writers) and keys whose rotation deadline is still ahead or passed within
 * that same window, reads each one's cache entry, and rewrites any that
 * diverge. Divergence therefore heals within about a minute of Redis
 * recovering, no matter how the original request ended.
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

  const repairedRevoked = await repairDivergentEntries(
    db,
    kv,
    recentlyRevoked,
    // Stale-active or unparseable entries need the terminal state written;
    // an entry already terminal is converged.
    (cached) => cached !== null && TERMINAL_STATUSES.has(cached.status)
  );

  // Keys mid-grace (deadline ahead) or whose deadline passed inside the
  // lookback: a cached entry written before the rotation still reports no
  // deadline and would honor the old credential past it for the rest of the
  // cache TTL. Newest deadlines first — they belong to the freshest
  // rotations, whose stale entries have the most TTL left to exploit.
  const rotatedRows = await db
    .prepare(
      `SELECT key_hash, rotation_deadline FROM api_keys
       WHERE status = 'active'
         AND rotation_deadline IS NOT NULL
         AND rotation_deadline::timestamptz > ?::timestamptz
       ORDER BY rotation_deadline::timestamptz DESC
       LIMIT ?`
    )
    .bind(cutoff, scanLimit)
    .all<{ key_hash: string; rotation_deadline: string }>();

  const recentlyRotated = rotatedRows.results ?? [];

  const repairedRotated = await repairDivergentEntries(
    db,
    kv,
    recentlyRotated,
    // A terminal entry is stickier than any deadline; otherwise the entry
    // is converged only when it carries the row's exact deadline.
    (cached, row) =>
      cached !== null &&
      (TERMINAL_STATUSES.has(cached.status) || cached.rotationDeadline === row.rotation_deadline)
  );

  const repaired = repairedRevoked + repairedRotated;
  const scanned = recentlyRevoked.length + recentlyRotated.length;

  if (repaired > 0) {
    getLogger().warn(
      { repaired, repairedRevoked, repairedRotated, scanned },
      "Repaired stale cache entries for revoked or rotated API keys"
    );
  }

  if (recentlyRevoked.length === scanLimit || recentlyRotated.length === scanLimit) {
    // Never let a truncated sweep read as full coverage.
    getLogger().warn(
      { scanLimit },
      "API key cache sweep hit its scan limit; remaining keys roll into the next tick"
    );
  }

  return { scanned, repaired };
}

/**
 * Read each row's cache entry and refresh the ones that diverge. An empty
 * slot is always converged (the next request misses and re-reads Postgres
 * through the verified fill path); a present entry is judged by
 * `isConverged`, with a null `cached` meaning the payload did not parse.
 *
 * Fixed-width chunks: bounded overlap keeps a large backlog from becoming
 * thousands of sequential round-trips, without unbounded fan-out starving
 * the connection pool that the payment/custody jobs share.
 */
async function repairDivergentEntries<T extends { key_hash: string }>(
  db: ReturnType<typeof getDb>,
  kv: ReturnType<typeof createKVStoreSet>["apiKeys"],
  rows: T[],
  isConverged: (cached: CachedApiKey | null, row: T) => boolean
): Promise<number> {
  let repaired = 0;

  for (let offset = 0; offset < rows.length; offset += SWEEP_CONCURRENCY) {
    const chunk = rows.slice(offset, offset + SWEEP_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (row) => {
        const raw = await kv.get(apiKeyCacheKey(row.key_hash));
        if (raw === null) {
          return false;
        }
        if (isConverged(tryParseCachedEntry(raw), row)) {
          return false;
        }
        await refreshApiKeyCache(db, kv, row.key_hash);
        return true;
      })
    );
    repaired += outcomes.filter(Boolean).length;
  }

  return repaired;
}
