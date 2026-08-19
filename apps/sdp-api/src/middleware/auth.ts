/**
 * API Key Authentication Middleware
 *
 * Flow:
 * 1. Extract API key from Authorization header
 * 2. Hash the key
 * 3. Look up in KV (fast path)
 * 4. If KV misses, look up in Postgres and cache to KV
 * 5. Validate key status, expiration
 * 6. Set auth context for downstream handlers
 */

import { hashString } from "@sdp/payments/hash";
import type {
  ApiKeyEnvironment,
  ApiKeyRole,
  ApiKeyWalletAuthorizationBinding,
  ApiKeyWalletScope,
  CachedApiKey,
  Permission,
} from "@sdp/types";
import type { Context, Next } from "hono";
import { getDb } from "@/db";
import {
  apiKeyCacheKey,
  fillApiKeyCache,
  isTrustedCachedApiKey,
  loadCachedApiKeyFromDb,
} from "@/lib/api-key-cache";
import { extractApiKey, looksLikeApiKey } from "@/lib/api-key-format";
import { isRotationDeadlineReached } from "@/lib/api-key-rotation";
import { getClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import { enforceOrganizationIpAllowlist } from "@/lib/organization-ip-allowlist";
import type { KVStore } from "@/runtime/kv";
import { getLogger } from "@/runtime/logger";
import { tryApprovedOperationReplayAuth } from "@/services/policy/approved-operation-replay";
import type { Env } from "@/types/env";
import { enforceRateLimit, RATE_LIMIT_TIERS } from "./rate-limit";

const INVALID_KEY_CACHE_TTL_SECONDS = 30;
const NODE_LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

interface LastUsedWriteState {
  lastSucceededAt: number | null;
  inFlight: Promise<void> | null;
}

interface LastUsedWriteCache {
  writes: Map<string, LastUsedWriteState>;
  nextSweepAt: number;
}

const nodeLastUsedWrites = new WeakMap<DatabaseClient, LastUsedWriteCache>();

interface ApiKeyContext {
  id: string;
  organizationId: string;
  projectId: string;
  role: ApiKeyRole;
  permissions: Permission[];
  environment: ApiKeyEnvironment;
  walletScope: ApiKeyWalletScope;
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: Array<ApiKeyWalletAuthorizationBinding & { custodyWalletId: string }>;
}

function extractBearerToken(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return null;
  }

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7);
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

/** Look up API key in KV cache */
async function getFromKV(kv: KVStore, keyHash: string): Promise<CachedApiKey | null> {
  const cached = await kv.get<CachedApiKey>(apiKeyCacheKey(keyHash), "json");
  // The shared predicate treats legacy payloads (pre rotation-deadline,
  // organization-status, or wallet-scope enforcement) and pending installs
  // as misses, so a deploy cannot extend an old key's validity and a fill's
  // not-yet-verified snapshot never authenticates a cache-hit reader.
  return cached && isTrustedCachedApiKey(cached) ? cached : null;
}

async function isKnownInvalidKey(kv: KVStore, keyHash: string): Promise<boolean> {
  const marker = await kv.get<{ invalid: true }>(`invalid:${keyHash}`, "json");
  return marker?.invalid === true;
}

async function cacheInvalidKey(kv: KVStore, keyHash: string): Promise<void> {
  try {
    await kv.put(`invalid:${keyHash}`, JSON.stringify({ invalid: true }), {
      expirationTtl: INVALID_KEY_CACHE_TTL_SECONDS,
    });
  } catch (err) {
    getLogger().error({ error: err }, "Failed to cache invalid api key");
  }
}

/** Look up API key in Postgres and cache to KV */
async function getFromDatabaseAndCache(
  db: DatabaseClient,
  kv: KVStore,
  keyHash: string
): Promise<CachedApiKey | null> {
  const cached = await loadCachedApiKeyFromDb(db, keyHash);

  if (!cached) {
    return null;
  }

  // Write-if-absent: a fill must never overwrite authoritative state a
  // concurrent revocation wrote after this function's DB read — and if that
  // happened, this request must authenticate against the newer state, not
  // the snapshot it read.
  return await fillApiKeyCache(db, kv, keyHash, cached);
}

function writeLastUsed(db: DatabaseClient, keyId: string): Promise<void> {
  return db
    .prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`)
    .bind(keyId)
    .run()
    .then(() => {});
}

function logLastUsedWriteError(error: unknown): void {
  getLogger().error({ error }, "Failed to update last_used_at");
}

function getLastUsedWriteCache(db: DatabaseClient): LastUsedWriteCache {
  const existing = nodeLastUsedWrites.get(db);
  if (existing) {
    return existing;
  }

  const cache: LastUsedWriteCache = {
    writes: new Map(),
    nextSweepAt: 0,
  };
  nodeLastUsedWrites.set(db, cache);
  return cache;
}

function sweepExpiredLastUsedWrites(cache: LastUsedWriteCache, now: number): void {
  if (now < cache.nextSweepAt) {
    return;
  }

  for (const [keyId, state] of cache.writes) {
    if (
      !state.inFlight &&
      state.lastSucceededAt !== null &&
      now - state.lastSucceededAt >= NODE_LAST_USED_WRITE_INTERVAL_MS
    ) {
      cache.writes.delete(keyId);
    }
  }

  cache.nextSweepAt = now + NODE_LAST_USED_WRITE_INTERVAL_MS;
}

/** Updates last_used_at without putting a write on every request. */
export function scheduleApiKeyLastUsedUpdate(
  db: DatabaseClient,
  keyId: string,
  now = Date.now()
): Promise<void> {
  const cache = getLastUsedWriteCache(db);
  sweepExpiredLastUsedWrites(cache, now);
  const existing = cache.writes.get(keyId);
  if (existing?.inFlight) {
    return existing.inFlight;
  }
  const lastSucceededAt = existing?.lastSucceededAt;
  if (
    lastSucceededAt !== null &&
    lastSucceededAt !== undefined &&
    now - lastSucceededAt < NODE_LAST_USED_WRITE_INTERVAL_MS
  ) {
    return Promise.resolve();
  }

  const state: LastUsedWriteState = existing ?? {
    lastSucceededAt: null,
    inFlight: null,
  };
  const pending = Promise.resolve()
    .then(() => writeLastUsed(db, keyId))
    .then(
      () => {
        if (cache.writes.get(keyId) === state) {
          state.lastSucceededAt = now;
          state.inFlight = null;
        }
      },
      (error) => {
        if (cache.writes.get(keyId) === state) {
          state.inFlight = null;
          if (state.lastSucceededAt === null) {
            cache.writes.delete(keyId);
          }
        }
        logLastUsedWriteError(error);
      }
    );

  state.inFlight = pending;
  cache.writes.set(keyId, state);
  return pending;
}

function normalizeWalletBindings(cachedKey: CachedApiKey): {
  walletScope: ApiKeyWalletScope;
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: Array<ApiKeyWalletAuthorizationBinding & { custodyWalletId: string }>;
} {
  const rawBindings = cachedKey.walletBindings ?? [];
  const walletBindings = rawBindings
    .filter(
      (binding): binding is ApiKeyWalletAuthorizationBinding & { custodyWalletId: string } =>
        typeof binding.walletId === "string" &&
        binding.walletId.length > 0 &&
        typeof binding.custodyWalletId === "string" &&
        binding.custodyWalletId.length > 0
    )
    .map((binding) => ({
      walletId: binding.walletId,
      custodyWalletId: binding.custodyWalletId,
      // An explicitly empty list grants nothing; it must never widen to "*".
      permissions: binding.permissions ?? ([] as Permission[]),
    }));

  const signingWalletIds = walletBindings.map((binding) => binding.walletId);
  const signingWalletId = cachedKey.signingWalletId ?? signingWalletIds[0] ?? null;

  return {
    walletScope: cachedKey.walletScope as ApiKeyWalletScope,
    signingWalletId,
    signingWalletIds,
    walletBindings,
  };
}

/**
 * Authentication middleware
 * Validates API key and sets auth context
 */
export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const apiKey = extractApiKey(c);

    if (!apiKey) {
      throw new AppError("UNAUTHORIZED", "API key required");
    }

    // Validate key format
    if (!apiKey.startsWith("sk_test_") && !apiKey.startsWith("sk_live_")) {
      throw new AppError("INVALID_API_KEY", "Invalid API key format");
    }

    // Hash the key
    const pepper = c.env.API_KEY_PEPPER;
    const keyHash = await hashString(apiKey, pepper);

    // Try KV first, then Postgres
    const apiKeysKV = c.var.kv.apiKeys;
    let cachedKey = await getFromKV(apiKeysKV, keyHash);
    if (!cachedKey) {
      if (await isKnownInvalidKey(apiKeysKV, keyHash)) {
        throw new AppError("INVALID_API_KEY", "Invalid API key");
      }
      cachedKey = await getFromDatabaseAndCache(getDb(c.env), apiKeysKV, keyHash);
      if (!cachedKey) {
        await cacheInvalidKey(apiKeysKV, keyHash);
      }
    }

    if (!cachedKey) {
      throw new AppError("INVALID_API_KEY", "Invalid API key");
    }

    // Reject on organization status before key status: even when the key
    // row still says active, a key created or rotated after an organization
    // deletion enumerated that org's keys is covered by neither the
    // deletion's revocation nor its cache refresh.
    if (cachedKey.organizationStatus !== "active") {
      throw new AppError("REVOKED_API_KEY");
    }

    // Check status
    if (cachedKey.status === "revoked" || cachedKey.status === "deactivated") {
      throw new AppError("REVOKED_API_KEY");
    }

    if (cachedKey.status === "expired") {
      throw new AppError("EXPIRED_API_KEY");
    }

    // Check expiration
    if (cachedKey.expiresAt && new Date(cachedKey.expiresAt) < new Date()) {
      throw new AppError("EXPIRED_API_KEY");
    }

    if (isRotationDeadlineReached(cachedKey.rotationDeadline)) {
      throw new AppError("EXPIRED_API_KEY");
    }

    if (!isClientIpAllowed(getClientIp(c), cachedKey.allowedIps)) {
      throw new AppError("FORBIDDEN", "Request origin is not allowed for this API key");
    }

    await enforceRateLimit(c, cachedKey.id, RATE_LIMIT_TIERS[cachedKey.rateLimitTier]);

    // Uncached Postgres read (so enabling it takes effect immediately) — which
    // is why it must sit behind the KV-backed limiter: ahead of it, a flooding
    // key costs one DB read per rejected request. Behind it, reads are capped
    // at the tier; the quota this spends belongs to whoever holds the key.
    await enforceOrganizationIpAllowlist(c, cachedKey.organizationId);

    // Set auth context
    const normalizedWalletBindings = normalizeWalletBindings(cachedKey);

    const authContext: ApiKeyContext = {
      id: cachedKey.id,
      organizationId: cachedKey.organizationId,
      projectId: cachedKey.projectId,
      role: cachedKey.role,
      permissions: cachedKey.permissions,
      environment: cachedKey.environment,
      walletScope: normalizedWalletBindings.walletScope,
      signingWalletId: normalizedWalletBindings.signingWalletId,
      signingWalletIds: normalizedWalletBindings.signingWalletIds,
      walletBindings: normalizedWalletBindings.walletBindings,
    };

    c.set("apiKey", authContext);

    // Update last used (fire and forget). Node coalesces this write per key.
    void scheduleApiKeyLastUsedUpdate(getDb(c.env), cachedKey.id);

    await next();
  };
}

/**
 * Require specific permissions
 */
export function requirePermissions(...required: Permission[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const apiKey = c.get("apiKey");
    const clerk = c.get("clerk");
    const session = c.get("session");

    const permissions = apiKey?.permissions ?? clerk?.permissions ?? session?.permissions ?? null;

    if (!permissions) {
      throw new AppError("UNAUTHORIZED");
    }

    // Check for wildcard
    if (permissions.includes("*")) {
      await next();
      return;
    }

    // Check each required permission
    const hasAll = required.every((p) => permissions.includes(p));
    if (!hasAll) {
      throw new AppError(
        "INSUFFICIENT_PERMISSIONS",
        `Required permissions: ${required.join(", ")}`
      );
    }

    await next();
  };
}

/**
 * Optional auth - doesn't fail if no key provided
 */
export function optionalAuth() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const apiKey = extractApiKey(c);

    if (apiKey && looksLikeApiKey(apiKey)) {
      // Reuse the main auth logic; swallow auth failures (the key is optional)
      // but never rate limiting — a limited key must not proceed as anonymous.
      try {
        const authMw = authMiddleware();
        await authMw(c, async () => {});
      } catch (error) {
        if (error instanceof AppError && error.code === "RATE_LIMITED") {
          throw error;
        }
      }
    }

    await next();
  };
}

/**
 * Unified auth middleware that supports both API key and session auth.
 * Useful for endpoints that can be accessed by both API clients and UI.
 */
export function unifiedAuthMiddleware(
  options: { allowSession?: boolean; allowClerk?: boolean } = {}
) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (await tryApprovedOperationReplayAuth(c)) {
      return next();
    }
    // Try API key first
    const apiKey = extractApiKey(c);
    if (apiKey && looksLikeApiKey(apiKey)) {
      const authMw = authMiddleware();
      return await authMw(c, next);
    }

    const bearerToken = extractBearerToken(c);

    if (bearerToken) {
      // Non-JWT bearer tokens should still be treated as API keys
      // so invalid formats return INVALID_API_KEY consistently.
      if (looksLikeApiKey(bearerToken) || !looksLikeJwt(bearerToken)) {
        const authMw = authMiddleware();
        return await authMw(c, next);
      }

      // JWT bearer token path (Clerk)
      if (options.allowClerk) {
        const { clerkAuthMiddleware } = await import("./clerk-auth");
        const clerkMw = clerkAuthMiddleware();
        return await clerkMw(c, next);
      }
    }

    // Try session if allowed
    if (options.allowSession) {
      const { sessionAuthMiddleware } = await import("./session-auth");
      const sessionMw = sessionAuthMiddleware();
      return await sessionMw(c, next);
    }

    throw new AppError("UNAUTHORIZED", "API key required");
  };
}
