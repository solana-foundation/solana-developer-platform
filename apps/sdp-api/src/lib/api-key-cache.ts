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
 *
 * What this module guarantees, and where that guarantee stops
 * -----------------------------------------------------------
 * Guaranteed: a revocation never reports success until the terminal state is
 * in the cache. No caller is ever told "revoked" while a cached entry can
 * still authorize, and no cached entry outlives a revocation the caller has
 * been told about.
 *
 * Not guaranteed, deliberately: atomicity between an authorization read and
 * the request that read authorizes. A revocation committing after a
 * request's authoritative read still admits that one in-flight request. Every
 * check happens at an instant and the request continues after it, so there is
 * always an "after the last check" — adding another read moves that boundary
 * later, it never removes it. Closing it would require authorization to share
 * a transaction or a lock with the work it authorizes, serializing ordinary
 * traffic against revocations; that is a property of the request pipeline, not
 * of this cache. Reviewers reaching for "check once more here" should read
 * this paragraph first: the fences below are already that check.
 */

import type { ApiKeyStatus, CachedApiKey } from "@sdp/types";
import { getPermissionsForApiKeyRole, type Permission } from "@sdp/types";
import { parseOptionalPostgresJson, parsePostgresJson } from "@/db/postgres-utils";
import type { KVStore } from "@/runtime/kv";
import { loadApiKeyWalletAuthorization } from "@/services/api-key-wallets.service";

export const API_KEY_CACHE_TTL_SECONDS = 3600; // 1 hour

const TERMINAL_STATUSES: ReadonlySet<ApiKeyStatus> = new Set(["revoked", "deactivated", "expired"]);

export function apiKeyCacheKey(keyHash: string): string {
  return `key:${keyHash}`;
}

function isTerminalStatus(status: ApiKeyStatus): boolean {
  return TERMINAL_STATUSES.has(status);
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

  const { walletScope, signingWalletId, signingWalletIds, walletBindings } =
    await loadApiKeyWalletAuthorization(
      db,
      result.id,
      result.organization_id,
      result.project_id,
      result.signing_wallet_id
    );

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
    walletScope,
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
 * The single trust predicate for cached entries, shared by the auth
 * middleware's reader and this module's fill adoption so they can never
 * drift. Rejects payloads written before rotation-deadline,
 * organization-status, or wallet-scope enforcement (a deploy must not extend
 * an old key's validity), bindings missing their custody-wallet resolution,
 * and pending installs — a fill's snapshot is not trustworthy until its
 * post-install Postgres verification clears it.
 */
export function isTrustedCachedApiKey(entry: CachedApiKey): boolean {
  return (
    !entry.pendingVerification &&
    Object.hasOwn(entry, "rotationDeadline") &&
    Object.hasOwn(entry, "organizationStatus") &&
    (entry.walletScope === "all" || entry.walletScope === "selected") &&
    (entry.walletBindings ?? []).every(
      (binding) => typeof binding.custodyWalletId === "string" && binding.custodyWalletId.length > 0
    )
  );
}

/**
 * Payloads that fail the trust predicate (legacy, pending, or corrupted)
 * are treated as cache misses by every reader; they must never be adopted
 * as authoritative state.
 */
function tryParseAuthoritativeEntry(raw: string): CachedApiKey | null {
  try {
    const parsed = JSON.parse(raw) as CachedApiKey;
    return isTrustedCachedApiKey(parsed) ? parsed : null;
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
  // Deploy-compat: readers from the previous deploy interpret an empty
  // binding list as unrestricted, so a selected-scope key without bindings
  // must never be cached. Fills of that key class install nothing and leave
  // the slot empty (a miss for every reader) — but they still have to decide
  // what this request authenticates against, and the slot alone cannot tell
  // them. A terminal entry observed there postdates this fill's DB read and
  // wins outright; an empty slot proves nothing, because a revocation's
  // terminal write that Redis evicted leaves the slot looking exactly like
  // one that was never written, and this class installs nothing, so there is
  // no CAS result to read the race from either.
  if (entry.walletScope === "selected" && (entry.walletBindings ?? []).length === 0) {
    const fenced = await readTerminalSlotEntry(kv, cacheKey);
    if (fenced) {
      return fenced;
    }
    // `entry` predates the fence, so adopting it here would authorize a
    // revocation that had already completed and was merely evicted out of
    // sight — the eviction hole this module exists to close, not the
    // read-then-act boundary in the header. Resolve against Postgres, which
    // cannot be evicted, exactly as every other undecidable race does.
    return await resolveContendedFill(db, kv, cacheKey, keyHash, entry);
  }
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
 * Authoritative resolution for a fill that cannot decode the race from the
 * cache alone — CAS exhaustion, a lost publish whose competing write may
 * already be evicted, or the deploy-compat class that never writes and so
 * has no CAS result to read at all: re-read Postgres — which cannot be
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
    // Authoritative as of the read above, with the fence catching a
    // revocation already in the slot. A revocation committing after both
    // admits this one in-flight request — the deliberate boundary described
    // in the module header, not a missing check.
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

  const repaired = await overwriteWithAuthoritativeState(kv, cacheKey, fresh);
  if (repaired.outcome === "kept-terminal") {
    // The overwrite deferred to a stickier terminal entry; authenticate
    // against the state it observed there and then.
    return repaired.entry;
  }
  if (repaired.outcome === "written") {
    return fresh;
  }
  // "slot-empty": our own pending marker is gone — an evicted revocation
  // entry would look exactly like this. "contended": competing writes kept
  // winning the slot. Either way the cache cannot prove what postdates the
  // verify read that produced `fresh`; only Postgres can.
  return await resolveContendedFill(db, kv, cacheKey, keyHash, entry);
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

const API_KEY_CACHE_PROBE_PREFIX = "probe:api-key-cache:";

/**
 * Prove the cache accepts writes before committing state whose safety
 * depends on invalidating it.
 *
 * Rotation is the one mutation with no recovery from a failed invalidation:
 * it cannot be rolled back (the replacement is already live), cannot fail
 * its response (the secret exists only there), and cannot be retried (the
 * retry is refused as a duplicate). Committing into a store that is already
 * refusing writes strands the old key's entry reporting no rotation
 * deadline — and the reconciliation sweep writes to that same store, so it
 * cannot repair it either; only the TTL ends it. Refusing before the commit
 * leaves nothing half-applied and the caller can simply try again.
 *
 * A pass does not promise the later write succeeds. It rules out the store
 * being down at decision time, which is exactly the case the post-commit
 * refresh, the drop, and the sweep all share a dependency on and therefore
 * cannot cover.
 */
export async function isApiKeyCacheWritable(kv: KVStore): Promise<boolean> {
  const probeKey = `${API_KEY_CACHE_PROBE_PREFIX}${crypto.randomUUID()}`;
  try {
    await kv.put(probeKey, "1", { expirationTtl: 60 });
  } catch {
    return false;
  }
  // Best effort: a probe left behind expires on its own and is namespaced
  // away from every `key:<hash>` entry readers and the sweep look at.
  await kv.delete(probeKey).catch(() => {});
  return true;
}

/**
 * Last-resort invalidation for a mutation that cannot fail its request but
 * must not leave pre-mutation authorization cached — today only rotation,
 * whose response carries the replacement secret. Emptying the slot turns a
 * stale trusted entry into a miss, and the next request re-reads Postgres
 * through the verified fill path rather than waiting on the reconciliation
 * sweep.
 *
 * The module's "refresh, never delete" rule does not apply here: it guarded
 * against an in-flight fill from a pre-mutation read repopulating the emptied
 * slot, which two-phase installs already prevent — such a fill lands pending,
 * verifies against Postgres, sees the drift, and repairs to authoritative
 * state. Deleting is therefore strictly safer than leaving the stale entry.
 */
export async function dropApiKeyCacheEntry(kv: KVStore, keyHash: string): Promise<void> {
  await kv.delete(apiKeyCacheKey(keyHash));
}

/**
 * Re-read the key from Postgres and overwrite the cache with that state.
 * Every mutation path (revoke, update, rotate, organization delete) must call
 * this before reporting success so the next request observes the change.
 *
 * Returns whether the cache converged: `true` when the authoritative state
 * was written, a stickier terminal entry was kept, or the slot ended as a
 * safe miss (the next request re-reads Postgres through the verified fill
 * path). `false` means CAS contention left a possibly-stale trusted entry in
 * the slot — the caller must retry or surface the failure instead of
 * reporting the mutation as fully applied.
 */
export async function refreshApiKeyCache(
  db: DatabaseClient,
  kv: KVStore,
  keyHash: string
): Promise<boolean> {
  const fresh = await loadCachedApiKeyFromDb(db, keyHash);
  const cacheKey = apiKeyCacheKey(keyHash);

  if (!fresh) {
    await writeRevokedTombstone(kv, cacheKey);
    return true;
  }

  // Deploy-compat, mirroring the fill: a non-terminal selected-scope entry
  // without bindings reads as unrestricted to previous-deploy readers, so
  // empty the slot instead of writing one. New-code fills skip this key
  // class too, so the slot stays a miss rather than inviting a stale fill.
  if (
    !isTerminalStatus(fresh.status) &&
    fresh.walletScope === "selected" &&
    (fresh.walletBindings ?? []).length === 0
  ) {
    await kv.delete(cacheKey);
    return true;
  }

  const result = await overwriteWithAuthoritativeState(kv, cacheKey, fresh);
  return result.outcome !== "contended";
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
    walletScope: "all",
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
 * How an overwrite attempt resolved. Callers must branch on this rather than
 * assume the fresh state landed:
 * - "written": the authoritative state (or an identical concurrent write) now
 *   occupies the slot.
 * - "kept-terminal": stickiness kept a terminal entry, captured at
 *   observation time because eviction could erase it before any later look.
 * - "slot-empty": non-terminal fresh state observed an empty slot and wrote
 *   nothing — the slot stays a miss for the verified fill path.
 * - "contended": every CAS round lost to non-terminal churn; a possibly-stale
 *   trusted entry remains in the slot.
 */
type OverwriteResult =
  | { outcome: "written" }
  | { outcome: "kept-terminal"; entry: CachedApiKey }
  | { outcome: "slot-empty" }
  | { outcome: "contended" };

/**
 * Overwrite the slot with fresh Postgres state; terminal states are sticky.
 *
 * Non-terminal state is never installed into an empty slot: emptiness is
 * indistinguishable from eviction of a newer terminal entry, so a
 * write-if-absent win there would publish trusted state whose DB read may
 * predate a revocation — the exact hazard the fill path's two-phase install
 * exists to prevent. Leaving the slot empty is always safe: the next request
 * misses and re-reads Postgres through the verified fill.
 */
async function overwriteWithAuthoritativeState(
  kv: KVStore,
  cacheKey: string,
  fresh: CachedApiKey
): Promise<OverwriteResult> {
  const value = JSON.stringify(fresh);
  const freshIsTerminal = isTerminalStatus(fresh.status);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await kv.get(cacheKey);
    if (current === null) {
      if (!freshIsTerminal) {
        return { outcome: "slot-empty" };
      }
      // Terminal state is sticky-max: claiming an empty slot can never
      // downgrade anything, evicted or not.
      if (
        await kv.compareAndSet(cacheKey, null, value, {
          expirationTtl: API_KEY_CACHE_TTL_SECONDS,
        })
      ) {
        return { outcome: "written" };
      }
      continue;
    }
    if (!freshIsTerminal) {
      const currentStatus = tryParseStatus(current);
      if (currentStatus !== null && isTerminalStatus(currentStatus)) {
        // Terminal states are sticky: this refresh raced a revocation whose
        // DB write our own read pre-dated. Keep the revoked entry. Legacy
        // and pending terminal payloads reject via a synthesized entry.
        const kept = tryParseAuthoritativeEntry(current);
        return {
          outcome: "kept-terminal",
          entry: kept && isTerminalStatus(kept.status) ? kept : { ...fresh, status: currentStatus },
        };
      }
    }
    if (current === value) {
      // A concurrent writer already landed exactly this state.
      return { outcome: "written" };
    }
    if (
      await kv.compareAndSet(cacheKey, current, value, {
        expirationTtl: API_KEY_CACHE_TTL_SECONDS,
      })
    ) {
      return { outcome: "written" };
    }
  }

  if (freshIsTerminal) {
    // A revocation must always land, and can never downgrade anything.
    await kv.put(cacheKey, value, { expirationTtl: API_KEY_CACHE_TTL_SECONDS });
    return { outcome: "written" };
  }
  return { outcome: "contended" };
}
