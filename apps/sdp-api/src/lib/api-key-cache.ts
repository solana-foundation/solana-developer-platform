/**
 * API key KV cache: read, fill, and invalidation invariants.
 *
 * Two rules keep cached authentication from outliving authoritative
 * revocation in Postgres:
 *
 * 1. Miss-path fills are write-if-absent, and every successful install is
 *    verified against Postgres afterwards. A fill computed from a DB read
 *    that happened before a revocation can never overwrite the authoritative
 *    state a revocation wrote moments later — and when cache eviction or TTL
 *    expiry empties the slot of that authoritative write, the post-install
 *    verification catches the stale install and repairs it.
 * 2. Mutation paths (revoke, update, rotate, organization delete) re-read the
 *    key from Postgres and overwrite the cache with that state instead of
 *    deleting the entry. Deleting would leave an empty slot an in-flight
 *    stale fill could repopulate with pre-revocation data for the full TTL.
 *
 * Terminal statuses are sticky: a cached revoked/deactivated/expired entry is
 * never replaced by an active one — only by another terminal state or TTL
 * expiry (after which fills re-read the authoritative row anyway).
 */

import type { ApiKeyStatus, ApiKeyWalletBinding, CachedApiKey } from "@sdp/types";
import { getPermissionsForApiKeyRole, type Permission } from "@sdp/types";
import {
  parseOptionalPostgresJson,
  parsePostgresJson,
  parsePostgresJsonOr,
} from "@/db/postgres-utils";
import type { KVStore } from "@/runtime/kv";

export const API_KEY_CACHE_TTL_SECONDS = 3600; // 1 hour

const TERMINAL_STATUSES: ReadonlySet<ApiKeyStatus> = new Set(["revoked", "deactivated", "expired"]);

export function apiKeyCacheKey(keyHash: string): string {
  return `key:${keyHash}`;
}

function isTerminalStatus(status: ApiKeyStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function safeParsePermissionsArray(value: string | null | undefined): Permission[] {
  if (!value) {
    return [];
  }

  const parsed = parsePostgresJsonOr<unknown>(value, []);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry): entry is Permission => typeof entry === "string");
}

/** Read the authoritative key row (and wallet bindings) from Postgres. */
export async function loadCachedApiKeyFromDb(
  db: DatabaseClient,
  keyHash: string
): Promise<CachedApiKey | null> {
  const result = await db
    .prepare(
      `SELECT ak.id, ak.organization_id, ak.project_id, ak.role, ak.permissions,
              p.environment,
              ak.rate_limit_tier, ak.allowed_ips, ak.signing_wallet_id, ak.status, ak.expires_at,
              ak.rotation_deadline, o.status AS organization_status
       FROM api_keys ak
       JOIN projects p ON p.id = ak.project_id
       JOIN organizations o ON o.id = ak.organization_id
       WHERE ak.key_hash = ?`
    )
    .bind(keyHash)
    .first<{
      id: string;
      organization_id: string;
      project_id: string;
      role: CachedApiKey["role"];
      permissions: string | null;
      environment: string;
      rate_limit_tier: string;
      allowed_ips: string | null;
      signing_wallet_id: string | null;
      status: string;
      expires_at: string | null;
      rotation_deadline: string | null;
      organization_status: string;
    }>();

  if (!result) {
    return null;
  }

  const walletBindingsResult = await db
    .prepare(
      `SELECT wallet_id, permissions
       FROM api_key_wallet_permissions
       WHERE api_key_id = ?
       ORDER BY created_at ASC`
    )
    .bind(result.id)
    .all<{ wallet_id: string; permissions: string }>();

  const walletBindings: ApiKeyWalletBinding[] = (walletBindingsResult.results ?? []).map((row) => {
    // Stored permissions are authoritative: an explicitly empty array grants
    // nothing, and unparseable values fail closed — never widen to "*".
    return {
      walletId: row.wallet_id,
      permissions: safeParsePermissionsArray(row.permissions),
    };
  });

  const signingWalletIds = walletBindings.map((binding) => binding.walletId);
  const signingWalletId = result.signing_wallet_id ?? signingWalletIds[0] ?? null;

  return {
    id: result.id,
    organizationId: result.organization_id,
    projectId: result.project_id,
    role: result.role,
    permissions: result.permissions
      ? parsePostgresJson<Permission[]>(result.permissions)
      : getPermissionsForApiKeyRole(result.role),
    environment: result.environment as "sandbox" | "production",
    rateLimitTier: result.rate_limit_tier as "standard" | "elevated" | "unlimited",
    allowedIps: parseOptionalPostgresJson<string[]>(result.allowed_ips),
    signingWalletId,
    signingWalletIds,
    walletBindings,
    status: result.status as ApiKeyStatus,
    expiresAt: result.expires_at,
    rotationDeadline: result.rotation_deadline,
    organizationStatus: result.organization_status,
  };
}

/**
 * Payloads written before rotation-deadline enforcement (or corrupted ones)
 * are treated as cache misses by every reader; they must never be adopted as
 * authoritative state.
 */
function tryParseAuthoritativeEntry(raw: string): CachedApiKey | null {
  try {
    const parsed = JSON.parse(raw) as CachedApiKey;
    // Pending installs are another fill's not-yet-verified snapshot — no
    // more trustworthy than this fill's own.
    if (parsed.pendingVerification) {
      return null;
    }
    return Object.hasOwn(parsed, "rotationDeadline") && Object.hasOwn(parsed, "organizationStatus")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Cache an entry produced by a miss-path DB read and return the entry the
 * caller must authenticate against. Write-if-absent: losing the write means
 * something newer than this fill's DB read landed in the slot (e.g. a
 * revocation), so the current request adopts that newer state instead of
 * proceeding on its stale snapshot. Legacy pre-rotation-deadline payloads are
 * the exception — readers treat them as misses, so they are upgraded to the
 * fresh DB state rather than adopted. If every attempt loses without an
 * authoritative entry ever being observed, the key is re-read from Postgres
 * rather than authenticated from this fill's own pre-race snapshot — and a
 * WON attempt is verified against Postgres too, because an empty slot may
 * mean eviction of a newer write rather than absence of one.
 */
export async function fillApiKeyCache(
  db: DatabaseClient,
  kv: KVStore,
  keyHash: string,
  entry: CachedApiKey
): Promise<CachedApiKey> {
  const cacheKey = apiKeyCacheKey(keyHash);
  // Installs go in marked pending: readers treat them as misses until the
  // post-install Postgres read clears them. Publishing a trusted entry
  // straight from the CAS would let concurrent cache-hit readers authorize
  // from a snapshot whose win proves nothing under eviction.
  const pending: CachedApiKey = { ...entry, pendingVerification: true };
  const pendingValue = JSON.stringify(pending);
  let expected: string | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (
      await kv.compareAndSet(cacheKey, expected, pendingValue, {
        expirationTtl: API_KEY_CACHE_TTL_SECONDS,
      })
    ) {
      return await verifyInstalledFill(db, kv, cacheKey, keyHash, entry, pendingValue);
    }

    const currentRaw = await kv.get(cacheKey);
    if (currentRaw === null) {
      // Slot emptied between attempts (TTL expiry or delete); try to claim it.
      expected = null;
      continue;
    }

    const current = tryParseAuthoritativeEntry(currentRaw);
    if (current) {
      return current;
    }

    // Legacy or unparseable payload: replace it with the fresh DB state.
    expected = currentRaw;
  }

  // Lost every attempt without ever observing an authoritative entry. The
  // final CAS failure proves a competing write landed after this fill's DB
  // read — re-read and adopt it rather than authenticate the stale snapshot.
  const finalRaw = await kv.get(cacheKey);
  if (finalRaw !== null) {
    const current = tryParseAuthoritativeEntry(finalRaw);
    if (current) {
      return current;
    }
  }

  // Slot empty or legacy even now. The CAS losses prove competing writes
  // landed after this fill's DB read, and the slot's current emptiness (TTL
  // expiry, cache eviction) says nothing about what they contained — this
  // fill's own snapshot is too old to trust.
  return await resolveContendedFill(db, kv, cacheKey, keyHash, entry);
}

/**
 * Authoritative resolution for a fill that lost a race it cannot decode
 * from the cache alone (CAS exhaustion, a lost publish whose competing
 * write may already be evicted): re-read Postgres — which cannot be
 * evicted — so the state this request authenticates against postdates
 * every lost race. No cache write: a plain put could clobber a revocation
 * landing right after this read; the next miss re-fills through the
 * write-if-absent path.
 */
async function resolveContendedFill(
  db: DatabaseClient,
  kv: KVStore,
  cacheKey: string,
  keyHash: string,
  entry: CachedApiKey
): Promise<CachedApiKey> {
  const authoritative = await loadCachedApiKeyFromDb(db, keyHash);
  if (authoritative) {
    if (!isTerminalStatus(authoritative.status)) {
      // Fence the re-read: a revocation can commit right after it, and
      // terminal states land in the slot with an unconditional write. Check
      // the slot once more and let any terminal entry observed there win —
      // the same stickiness every other path honors. (A terminal entry
      // appearing after our active re-read can only mean a commit newer
      // than that re-read.)
      const fenced = await readTerminalSlotEntry(kv, cacheKey);
      if (fenced) {
        return fenced;
      }
    }
    return authoritative;
  }

  // The row is gone (hard-deleted mid-flight): reject as terminal.
  return { ...entry, status: "revoked", organizationStatus: "deleted" };
}

/**
 * A write-if-absent win proves nothing when cache eviction is possible: an
 * empty slot is indistinguishable from a slot whose newer authoritative
 * write (a revocation's terminal entry, a hard-delete tombstone) Redis
 * evicted moments earlier — and TTL expiry of that entry looks the same.
 * Winning the CAS would then install this fill's pre-race snapshot as
 * authoritative for a fresh TTL.
 *
 * So installs are two-phase. The CAS lands a pendingVerification-marked
 * entry that every reader treats as a miss, then this verify re-reads
 * Postgres and only a clean result publishes the trusted entry. The verify
 * read postdates the install, so any revocation it cannot see must commit
 * later — and from the install onward the slot is occupied, so that later
 * revocation's unconditional cache write always has this entry to
 * overwrite; eviction anywhere in the chain only ever degrades to a miss.
 * Drifted installs are repaired and the caller authenticates against the
 * verified state.
 */
async function verifyInstalledFill(
  db: DatabaseClient,
  kv: KVStore,
  cacheKey: string,
  keyHash: string,
  entry: CachedApiKey,
  pendingValue: string
): Promise<CachedApiKey> {
  const fresh = await loadCachedApiKeyFromDb(db, keyHash);
  if (!fresh) {
    // The row vanished between this fill's DB read and now (hard delete).
    await writeRevokedTombstone(kv, cacheKey);
    return { ...entry, status: "revoked", organizationStatus: "deleted" };
  }

  const trustedValue = JSON.stringify(entry);
  if (JSON.stringify(fresh) === trustedValue) {
    if (
      await kv.compareAndSet(cacheKey, pendingValue, trustedValue, {
        expirationTtl: API_KEY_CACHE_TTL_SECONDS,
      })
    ) {
      // The slot went pending → trusted untouched: no competing write — in
      // particular no revocation's terminal write — landed since the
      // install.
      return entry;
    }
    // Losing the publish is a signal, not noise: something replaced our
    // pending marker after the verify read — possibly a revocation whose
    // commit that read predates, and whose terminal entry eviction may
    // already have erased. Only Postgres can say what that write meant.
    return await resolveContendedFill(db, kv, cacheKey, keyHash, entry);
  }

  const kept = await overwriteWithAuthoritativeState(kv, cacheKey, fresh);
  if (kept) {
    // The overwrite deferred to a stickier terminal entry; authenticate
    // against the state it observed there and then.
    return kept;
  }
  return fresh;
}

/** Read the slot and return the terminal entry it holds, if any. */
async function readTerminalSlotEntry(kv: KVStore, cacheKey: string): Promise<CachedApiKey | null> {
  const raw = await kv.get(cacheKey);
  if (raw === null) {
    return null;
  }
  const parsed = tryParseAuthoritativeEntry(raw);
  return parsed && isTerminalStatus(parsed.status) ? parsed : null;
}

function tryParseStatus(raw: string): ApiKeyStatus | null {
  try {
    const parsed = JSON.parse(raw) as { status?: unknown };
    return typeof parsed.status === "string" ? (parsed.status as ApiKeyStatus) : null;
  } catch {
    return null;
  }
}

/**
 * Re-read the key from Postgres and overwrite the cache with that state.
 * Every mutation path (revoke, update, rotate, organization delete) must call
 * this before reporting success so the next request observes the change.
 */
export async function refreshApiKeyCache(
  db: DatabaseClient,
  kv: KVStore,
  keyHash: string
): Promise<void> {
  const fresh = await loadCachedApiKeyFromDb(db, keyHash);
  const cacheKey = apiKeyCacheKey(keyHash);

  if (!fresh) {
    await writeRevokedTombstone(kv, cacheKey);
    return;
  }

  await overwriteWithAuthoritativeState(kv, cacheKey, fresh);
}

/**
 * Row is gone entirely (hard delete). Deleting the slot would leave it
 * empty for an in-flight fill from a pre-delete DB read to repopulate
 * with the stale active snapshot for the full TTL — the same race the
 * rest of this module exists to prevent. Occupy the slot with a revoked
 * tombstone instead: fills lose their write-if-absent race against it,
 * adopt it, and the middleware rejects on its terminal status before
 * reading any other field.
 */
async function writeRevokedTombstone(kv: KVStore, cacheKey: string): Promise<void> {
  const tombstone: CachedApiKey = {
    id: "",
    organizationId: "",
    projectId: "",
    role: "api_readonly",
    permissions: [],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    signingWalletIds: [],
    walletBindings: [],
    status: "revoked",
    expiresAt: null,
    rotationDeadline: null,
    organizationStatus: "deleted",
  };
  await kv.put(cacheKey, JSON.stringify(tombstone), {
    expirationTtl: API_KEY_CACHE_TTL_SECONDS,
  });
}

/**
 * Overwrite the slot with fresh Postgres state; terminal states are sticky.
 * Returns the terminal entry it deferred to when stickiness kept the slot —
 * captured at observation time, because eviction could erase it before any
 * later look — and null when the fresh state was written (or the slot left
 * to a newer non-terminal winner).
 */
async function overwriteWithAuthoritativeState(
  kv: KVStore,
  cacheKey: string,
  fresh: CachedApiKey
): Promise<CachedApiKey | null> {
  const value = JSON.stringify(fresh);
  const freshIsTerminal = isTerminalStatus(fresh.status);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await kv.get(cacheKey);
    if (current !== null && !freshIsTerminal) {
      const currentStatus = tryParseStatus(current);
      if (currentStatus !== null && isTerminalStatus(currentStatus)) {
        // Terminal states are sticky: this refresh raced a revocation whose
        // DB write our own read pre-dated. Keep the revoked entry. Legacy
        // and pending terminal payloads reject via a synthesized entry.
        const kept = tryParseAuthoritativeEntry(current);
        return kept && isTerminalStatus(kept.status) ? kept : { ...fresh, status: currentStatus };
      }
    }
    if (
      await kv.compareAndSet(cacheKey, current, value, {
        expirationTtl: API_KEY_CACHE_TTL_SECONDS,
      })
    ) {
      return null;
    }
  }

  if (freshIsTerminal) {
    // A revocation must always land, and can never downgrade anything.
    await kv.put(cacheKey, value, { expirationTtl: API_KEY_CACHE_TTL_SECONDS });
  }
  // Non-terminal refresh that lost every round: leave the cache as-is.
  // Whatever won those races was written later than our DB read, and TTL
  // bounds any residual staleness.
  return null;
}
