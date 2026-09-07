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
  // The two scans are independent, so they issue together. Their repair
  // passes stay sequential below: each fans out to SWEEP_CONCURRENCY cache
  // round-trips, and overlapping them would double the load this job is
  // deliberately bounded to.
  //
  // Second scan: keys mid-grace (deadline ahead) or whose deadline passed
  // inside the lookback. A cached entry written before the rotation still
  // reports no deadline and would honor the old credential past it for the
  // rest of the cache TTL. Newest deadlines first — they belong to the
  // freshest rotations, whose stale entries have the most TTL left to
  // exploit.
  const [rows, rotatedRows] = await Promise.all([
    db
      .prepare(
        `SELECT key_hash FROM api_keys
       WHERE status != 'active'
         AND revoked_at IS NOT NULL
         AND revoked_at::timestamptz > ?::timestamptz
       ORDER BY revoked_at::timestamptz DESC
       LIMIT ?`
      )
      .bind(cutoff, scanLimit)
      .all<{ key_hash: string }>(),
    db
      .prepare(
        `SELECT key_hash, rotation_deadline FROM api_keys
       WHERE status = 'active'
         AND rotation_deadline IS NOT NULL
         AND rotation_deadline::timestamptz > ?::timestamptz
       ORDER BY rotation_deadline::timestamptz DESC
       LIMIT ?`
      )
      .bind(cutoff, scanLimit)
      .all<{ key_hash: string; rotation_deadline: string }>(),
  ]);

  const recentlyRevoked = rows.results ?? [];
  const recentlyRotated = rotatedRows.results ?? [];

  // One pass over both scans rather than one pass each: the two row sets are
  // disjoint (status != 'active' versus status = 'active'), so a single work
  // list covers them without processing any key twice — and it holds the
  // whole sweep to one SWEEP_CONCURRENCY budget instead of letting two
  // passes overlap into double the cache round-trips. Revoked targets lead,
  // so the freshest revocations are still repaired first under a truncating
  // backlog.
  const repairedTargets = await repairDivergentEntries(db, kv, [
    ...recentlyRevoked.map(
      (row): SweepTarget => ({
        keyHash: row.key_hash,
        kind: "revoked",
        // Stale-active or unparseable entries need the terminal state
        // written; an entry already terminal is converged.
        isConverged: (cached) => cached !== null && TERMINAL_STATUSES.has(cached.status),
      })
    ),
    ...recentlyRotated.map(
      (row): SweepTarget => ({
        keyHash: row.key_hash,
        kind: "rotated",
        // A terminal entry is stickier than any deadline; otherwise the
        // entry is converged only when it carries the row's exact deadline.
        isConverged: (cached) =>
          cached !== null &&
          (TERMINAL_STATUSES.has(cached.status) ||
            cached.rotationDeadline === row.rotation_deadline),
      })
    ),
  ]);

  const repairedRevoked = repairedTargets.filter((target) => target.kind === "revoked").length;
  const repairedRotated = repairedTargets.length - repairedRevoked;
  const repaired = repairedTargets.length;
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

/** One key to check, and what "already converged" means for it. */
interface SweepTarget {
  keyHash: string;
  kind: "revoked" | "rotated";
  /** A null `cached` means the slot held a payload that did not parse. */
  isConverged: (cached: CachedApiKey | null) => boolean;
}

/**
 * Read each target's cache entry and refresh the ones that diverge,
 * returning the targets repaired. An empty slot is always converged (the
 * next request misses and re-reads Postgres through the verified fill path).
 *
 * Fixed-width chunks: bounded overlap keeps a large backlog from becoming
 * thousands of sequential round-trips, without unbounded fan-out starving
 * the connection pool that the payment/custody jobs share.
 */
async function repairDivergentEntries(
  db: ReturnType<typeof getDb>,
  kv: ReturnType<typeof createKVStoreSet>["apiKeys"],
  targets: SweepTarget[]
): Promise<SweepTarget[]> {
  const repaired: SweepTarget[] = [];

  for (let offset = 0; offset < targets.length; offset += SWEEP_CONCURRENCY) {
    const chunk = targets.slice(offset, offset + SWEEP_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (target) => {
        const raw = await kv.get(apiKeyCacheKey(target.keyHash));
        if (raw === null) {
          return null;
        }
        if (target.isConverged(tryParseCachedEntry(raw))) {
          return null;
        }
        await refreshApiKeyCache(db, kv, target.keyHash);
        return target;
      })
    );
    repaired.push(...outcomes.filter((target): target is SweepTarget => target !== null));
  }

  return repaired;
}
