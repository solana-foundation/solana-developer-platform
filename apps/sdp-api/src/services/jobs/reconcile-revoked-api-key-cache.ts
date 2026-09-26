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
 *
 * The rotated scan is progress-safe: it pages the worklist by a
 * `(rotation_deadline, key_hash)` keyset and persists a resume cursor, so
 * converged rows cannot re-occupy every tick's page and starve later
 * deadlines (SOLA9-554). Each sweep continues where the previous one
 * stopped; draining the eligible set clears the cursor so the next tick
 * starts from the newest deadline again. Losing the cursor restarts from
 * the top — the pre-cursor behavior — so the mechanism can only ever cost
 * re-inspection, never coverage.
 *
 * A third pass starts from the cache instead of Postgres: every cached entry
 * whose key row is gone, or whose project is no longer active, is rewritten
 * to the authoritative state (a revoked tombstone when the row is gone). This
 * is the eviction path for keys removed underneath the cache — a project
 * dropped by migration, a row deleted by hand — which no Postgres scan can
 * find because there is no row left to list.
 */

import type { ApiKeyStatus, CachedApiKey } from "@sdp/types";
import { getDb } from "@/db";
import { apiKeyCacheKey, apiKeyHashFromCacheKey, refreshApiKeyCache } from "@/lib/api-key-cache";
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

/** Key hashes per `IN (...)` query when checking cached entries against Postgres. */
const LIVE_LOOKUP_CHUNK = 500;

const TERMINAL_STATUSES: ReadonlySet<ApiKeyStatus> = new Set(["revoked", "deactivated", "expired"]);

/**
 * Resume cursor for the rotated-deadline scan, persisted in the apiKeys KV
 * namespace. The name is deliberately not `key:`-prefixed, so
 * {@link apiKeyHashFromCacheKey} filters it out of the orphan scan's
 * enumeration and no cache reader can mistake it for a cached credential.
 *
 * Losing it (Redis eviction, failover, a failed write) is always safe: the
 * scan then resumes from the newest deadline, which is exactly the
 * pre-cursor behavior, and the next cycle re-establishes progress.
 */
export const ROTATED_DEADLINE_CURSOR_CACHE_KEY = "sweep:rotated-deadline-cursor";

/** Where the previous rotated sweep stopped inspecting. */
interface RotatedDeadlineCursor {
  rotationDeadline: string;
  keyHash: string;
}

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
  // Read before scanning (guarded): the rotated scan resumes strictly after
  // this position so converged rows it already inspected cannot monopolize
  // the top of the deadline ordering.
  const rotatedCursor = await readRotatedDeadlineCursor(kv);

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
  // exploit — and pagination resumes strictly after the persisted cursor
  // (a `(rotation_deadline, key_hash)` tuple), so converged rows can never
  // occupy every slot of every tick: each sweep continues where the last one
  // stopped, and every eligible row is eventually inspected.
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
    listRotatedKeyRows(db, cutoff, scanLimit, rotatedCursor),
  ]);

  const recentlyRevoked = rows.results ?? [];
  const recentlyRotated = rotatedRows;
  const orphaned = await listOrphanedCacheEntries(db, kv, scanLimit);

  // One pass over all scans rather than one pass each: the two Postgres row
  // sets are disjoint (status != 'active' versus status = 'active') and the
  // orphan set has no live row at all, so a single work list covers them
  // without processing any key twice — and it holds the whole sweep to one
  // SWEEP_CONCURRENCY budget instead of letting passes overlap into multiples
  // of the cache round-trips. Revoked targets lead, so the freshest
  // revocations are still repaired first under a truncating backlog.
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
    ...orphaned.map(
      (keyHash): SweepTarget => ({
        keyHash,
        kind: "orphaned",
        isConverged: (cached) => cached !== null && TERMINAL_STATUSES.has(cached.status),
      })
    ),
  ]);

  const repairedRevoked = repairedTargets.filter((target) => target.kind === "revoked").length;
  const repairedOrphaned = repairedTargets.filter((target) => target.kind === "orphaned").length;
  const repairedRotated = repairedTargets.length - repairedRevoked - repairedOrphaned;
  const repaired = repairedTargets.length;
  const scanned = recentlyRevoked.length + recentlyRotated.length + orphaned.length;

  // Advance the resume cursor only after the repair pass has run: a sweep
  // that fails midway re-inspects its whole page next tick (at-least-once),
  // never skips past un-repaired rows. A page short of the limit means the
  // eligible set below the cursor is drained — clear it so the next tick
  // starts from the newest deadline again and rows landing ahead of the
  // position are never stranded behind it.
  const lastRotated = recentlyRotated[recentlyRotated.length - 1];
  await saveRotatedDeadlineCursor(
    kv,
    recentlyRotated.length === scanLimit && lastRotated
      ? { rotationDeadline: lastRotated.rotation_deadline, keyHash: lastRotated.key_hash }
      : null
  );

  if (repaired > 0) {
    getLogger().warn(
      { repaired, repairedRevoked, repairedRotated, repairedOrphaned, scanned },
      "Repaired stale cache entries for revoked, rotated or orphaned API keys"
    );
  }

  if (
    recentlyRevoked.length === scanLimit ||
    recentlyRotated.length === scanLimit ||
    orphaned.length === scanLimit
  ) {
    // Never let a truncated sweep read as full coverage. For the rotated
    // scan the truncation is where the next tick resumes, so a worklist
    // that stays at its limit for consecutive ticks shows up as a cursor
    // that stops moving.
    getLogger().warn(
      { scanLimit, rotatedResumedFrom: rotatedCursor?.rotationDeadline ?? null },
      "API key cache sweep hit its scan limit; remaining keys roll into the next tick"
    );
  }

  return { scanned, repaired };
}

/**
 * The rotated-deadline page for this tick: newest deadlines first, ties
 * broken by key hash so the order is total and a resume cursor can never
 * skip past a same-deadline row. With a cursor, only rows strictly after it
 * in that ordering are returned — already-inspected (converged) rows cannot
 * re-occupy the page and starve later ones.
 *
 * @param db - Database client for the rotated-key scan.
 * @param cutoff - ISO timestamp; only deadlines newer than it are eligible.
 * @param scanLimit - Maximum rows this tick may inspect.
 * @param cursor - Where the previous sweep stopped, or null to start from the newest.
 * @returns The page of rotated key rows to inspect.
 */
async function listRotatedKeyRows(
  db: ReturnType<typeof getDb>,
  cutoff: string,
  scanLimit: number,
  cursor: RotatedDeadlineCursor | null
): Promise<{ key_hash: string; rotation_deadline: string }[]> {
  if (cursor) {
    const resumed = await db
      .prepare(
        `SELECT key_hash, rotation_deadline FROM api_keys
       WHERE status = 'active'
         AND rotation_deadline IS NOT NULL
         AND rotation_deadline::timestamptz > ?::timestamptz
         AND (rotation_deadline::timestamptz, key_hash) < (?::timestamptz, ?::text)
       ORDER BY rotation_deadline::timestamptz DESC, key_hash DESC
       LIMIT ?`
      )
      .bind(cutoff, cursor.rotationDeadline, cursor.keyHash, scanLimit)
      .all<{ key_hash: string; rotation_deadline: string }>();
    return resumed.results ?? [];
  }

  const fresh = await db
    .prepare(
      `SELECT key_hash, rotation_deadline FROM api_keys
       WHERE status = 'active'
         AND rotation_deadline IS NOT NULL
         AND rotation_deadline::timestamptz > ?::timestamptz
       ORDER BY rotation_deadline::timestamptz DESC, key_hash DESC
       LIMIT ?`
    )
    .bind(cutoff, scanLimit)
    .all<{ key_hash: string; rotation_deadline: string }>();
  return fresh.results ?? [];
}

/**
 * Read the rotated sweep's resume cursor. Any failure or malformed value
 * reads as absent: the scan then starts from the newest deadline — the
 * pre-cursor behavior — so cursor bookkeeping can never fail the sweep or
 * widen what it examines.
 */
async function readRotatedDeadlineCursor(
  kv: ReturnType<typeof createKVStoreSet>["apiKeys"]
): Promise<RotatedDeadlineCursor | null> {
  try {
    const parsed = await kv.get<RotatedDeadlineCursor>(ROTATED_DEADLINE_CURSOR_CACHE_KEY, "json");
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.rotationDeadline === "string" &&
      parsed.rotationDeadline.length > 0 &&
      typeof parsed.keyHash === "string" &&
      parsed.keyHash.length > 0
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist (or clear) the resume cursor. Best-effort: a failed write is
 * logged and costs one cycle of re-inspection, never repair coverage.
 */
async function saveRotatedDeadlineCursor(
  kv: ReturnType<typeof createKVStoreSet>["apiKeys"],
  cursor: RotatedDeadlineCursor | null
): Promise<void> {
  try {
    if (cursor) {
      await kv.put(ROTATED_DEADLINE_CURSOR_CACHE_KEY, JSON.stringify(cursor));
    } else {
      await kv.delete(ROTATED_DEADLINE_CURSOR_CACHE_KEY);
    }
  } catch (error) {
    getLogger().warn(
      { error },
      "Failed to persist the rotated-deadline sweep cursor; the next tick resumes from the newest deadline"
    );
  }
}

/**
 * Cached key hashes with no live backing: the api_keys row is gone, or its
 * project is no longer active. Bounded by `scanLimit` entries per tick.
 *
 * @param db - Database client for the liveness lookup.
 * @param kv - API-key cache namespace to enumerate.
 * @param scanLimit - Maximum cached entries examined this tick.
 * @returns Key hashes whose cached entry must be rewritten.
 */
async function listOrphanedCacheEntries(
  db: ReturnType<typeof getDb>,
  kv: ReturnType<typeof createKVStoreSet>["apiKeys"],
  scanLimit: number
): Promise<string[]> {
  const cached = (await kv.list()).keys
    .map((key) => apiKeyHashFromCacheKey(key.name))
    .filter((hash): hash is string => hash !== null)
    .slice(0, scanLimit);

  const live = new Set<string>();
  for (let offset = 0; offset < cached.length; offset += LIVE_LOOKUP_CHUNK) {
    const chunk = cached.slice(offset, offset + LIVE_LOOKUP_CHUNK);
    const rows = await db
      .prepare(
        `SELECT ak.key_hash FROM api_keys ak
         JOIN projects p ON p.id = ak.project_id
         WHERE p.status = 'active'
           AND ak.key_hash IN (${chunk.map(() => "?").join(", ")})`
      )
      .bind(...chunk)
      .all<{ key_hash: string }>();
    for (const row of rows.results) {
      live.add(row.key_hash);
    }
  }

  return cached.filter((hash) => !live.has(hash));
}

/** One key to check, and what "already converged" means for it. */
interface SweepTarget {
  keyHash: string;
  kind: "revoked" | "rotated" | "orphaned";
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
