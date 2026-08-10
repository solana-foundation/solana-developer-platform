/**
 * API key KV cache: read, fill, and invalidation invariants.
 *
 * Two rules keep cached authentication from outliving authoritative
 * revocation in Postgres:
 *
 * 1. Miss-path fills are write-if-absent. A fill computed from a DB read that
 *    happened before a revocation can never overwrite the authoritative state
 *    a revocation wrote moments later.
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
              ak.rotation_deadline
       FROM api_keys ak
       JOIN projects p ON p.id = ak.project_id
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
    const parsed = safeParsePermissionsArray(row.permissions);
    return {
      walletId: row.wallet_id,
      permissions: parsed.length > 0 ? parsed : ["*"],
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
    return Object.hasOwn(parsed, "rotationDeadline") ? parsed : null;
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
 * fresh DB state rather than adopted.
 */
export async function fillApiKeyCache(
  kv: KVStore,
  keyHash: string,
  entry: CachedApiKey
): Promise<CachedApiKey> {
  const cacheKey = apiKeyCacheKey(keyHash);
  const value = JSON.stringify(entry);
  let expected: string | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (
      await kv.compareAndSet(cacheKey, expected, value, {
        expirationTtl: API_KEY_CACHE_TTL_SECONDS,
      })
    ) {
      return entry;
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

  // Extreme contention; use this fill's own DB read. Revocation paths write
  // unconditionally, so authoritative state still lands regardless.
  return entry;
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
    // Row is gone entirely (hard delete); nothing authoritative to cache.
    await kv.delete(cacheKey);
    return;
  }

  const value = JSON.stringify(fresh);
  const freshIsTerminal = isTerminalStatus(fresh.status);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await kv.get(cacheKey);
    if (current !== null && !freshIsTerminal) {
      const currentStatus = tryParseStatus(current);
      if (currentStatus !== null && isTerminalStatus(currentStatus)) {
        // Terminal states are sticky: this refresh raced a revocation whose
        // DB write our own read pre-dated. Keep the revoked entry.
        return;
      }
    }
    if (
      await kv.compareAndSet(cacheKey, current, value, {
        expirationTtl: API_KEY_CACHE_TTL_SECONDS,
      })
    ) {
      return;
    }
  }

  if (freshIsTerminal) {
    // A revocation must always land, and can never downgrade anything.
    await kv.put(cacheKey, value, { expirationTtl: API_KEY_CACHE_TTL_SECONDS });
  }
  // Non-terminal refresh that lost every round: leave the cache as-is.
  // Whatever won those races was written later than our DB read, and TTL
  // bounds any residual staleness.
}
