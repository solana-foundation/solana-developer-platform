/**
 * API Key Authentication Middleware
 *
 * Flow:
 * 1. Extract the API key from Authorization, or the key ID from a verified
 *    gateway identity (HOO-2256)
 * 2. Check a presented key's format (an `sf_` key's checksum) and hash it
 * 3. Flood guard per key hash at the highest rate-limit tier
 * 4. Read and judge the key's live rows in one Postgres statement
 * 5. Enforce the key's own tier per key id
 * 6. Set auth context for downstream handlers
 */

import type { Action } from "@sdp/types/actions";
import type { ApiKeyEnvironment } from "@sdp/types/api-keys";
import type { Context, Next } from "hono";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import { extractApiKey, parsePresentedApiKey, presentsApiKey } from "@/lib/api-key-format";
import { hashApiKey } from "@/lib/api-key-hash";
import {
  assertNoCachedTerminalRefusal,
  assertNotThrottled,
  rememberThrottled,
} from "@/lib/api-key-refusal-cache";
import type { WalletAccess } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import { type ApiKeyLookup, apiKeyRefusalKey, authorizeApiKey } from "@/lib/organization-access";
import { recordOrganizationEntitlements } from "@/lib/production-entitlement";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import {
  API_KEY_PRE_READ_MAX_REQUESTS,
  apiKeyFloodGuardIdentifier,
  enforceRateLimit,
  InProcessRateLimiter,
  RATE_LIMIT_TIERS,
} from "./rate-limit";

const NODE_LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

/** Distinct (key hash, client IP) pairs the fallback flood guard remembers. */
const FLOOD_GUARD_FALLBACK_MAX_TRACKED = 10_000;

/** The flood guard's in-process stand-in while the shared counter store is down. */
export const apiKeyFloodGuardFallback = new InProcessRateLimiter(
  "api_key_flood_guard",
  FLOOD_GUARD_FALLBACK_MAX_TRACKED
);

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
  grants: readonly Action[];
  environment: ApiKeyEnvironment;
  walletAccess: WalletAccess;
}

/**
 * The rest of an authenticated API-key request: narrowed to the key's
 * organization, and moving money as the key (HOO-2099). The signing waists
 * re-read the key's row whenever it signs for it.
 */
function runAsAuthenticatedKey(
  key: Pick<ApiKeyContext, "id" | "organizationId">,
  next: Next
): Promise<void> {
  return runWithTenantDatabaseIdentity({ organizationId: key.organizationId }, () =>
    runAsMoneyPrincipal({ kind: "api_key", apiKeyId: key.id }, next)
  );
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

/**
 * Authentication middleware
 * Validates API key and sets auth context
 */
export function authMiddleware() {
  // Key resolution reads api_keys and organization allowlists before any
  // tenant is known, so it runs under the system database identity; the rest
  // of the request narrows to the key's organization (row-level security then
  // holds every downstream query inside that tenant).
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authContext = await runWithSystemDatabaseIdentity("http:auth", () =>
      authenticateApiKeyRequest(c)
    );
    await runAsAuthenticatedKey(authContext, next);
  };
}

/**
 * Names the request's API key row: a presented key (hashed here), or the key
 * ID a verified gateway identity carries (HOO-2256). A key presented alongside
 * an identity must be the key the gateway authenticated.
 */
async function resolveApiKeyLookup(c: Context<{ Bindings: Env }>): Promise<ApiKeyLookup> {
  const gatewayIdentity = c.get("gatewayIdentity");
  const apiKey = extractApiKey(c);

  if (!apiKey) {
    if (gatewayIdentity?.keyId) {
      return { kind: "gateway", publicId: gatewayIdentity.keyId };
    }
    throw new AppError("UNAUTHORIZED", "API key required");
  }

  // Validate key format. An `sf_` key's checksum rejects a typo here, before
  // any hash, Redis call or DB read.
  const presented = parsePresentedApiKey(apiKey);
  if (!presented) {
    throw new AppError("INVALID_API_KEY", "Invalid API key format");
  }
  if (gatewayIdentity && (presented.format !== "sf" || presented.keyId !== gatewayIdentity.keyId)) {
    throw new AppError("INVALID_API_KEY", "API key does not match the gateway identity");
  }

  // Hash the key: an `sf_` key's secret alone, as the gateway will; a legacy
  // `sk_` key whole, as it was issued.
  const keyHash = await hashApiKey(
    presented.format === "sf" ? presented.secret : presented.key,
    c.env.API_KEY_PEPPER
  );
  return {
    kind: "secret",
    keyHash,
    publicId: presented.format === "sf" ? presented.keyId : null,
  };
}

async function authenticateApiKeyRequest(c: Context<{ Bindings: Env }>): Promise<ApiKeyContext> {
  const lookup = await resolveApiKeyLookup(c);
  const refusalKey = apiKeyRefusalKey(lookup);

  // A key this instance recently refused for good (unknown, revoked,
  // expired) is refused again from memory, with no Redis call or DB read.
  assertNoCachedTerminalRefusal(refusalKey);
  // A key its own tier refused stays refused from memory until the limiter
  // would next admit it, with no Redis call or DB read (see the cache).
  assertNotThrottled(refusalKey, (seconds) => c.header("Retry-After", seconds.toString()));

  // A flood guard per key and client IP before the row is read, at the
  // highest tier since the key's own is not known yet: a flooding credential,
  // valid or not, is bounded before it costs a DB read. It is keyed by the
  // client IP too, so a leaked key used from outside its IP allowlist only
  // ever exhausts its own bucket, never the owner's. Random-key spray (a
  // fresh hash each time) is bounded by the per-IP backstop in front of auth.
  // While Redis is down both count in this instance's memory instead, so the
  // auth read below never goes unbounded.
  await enforceRateLimit(
    c,
    apiKeyFloodGuardIdentifier(refusalKey, getClientIp(c)),
    API_KEY_PRE_READ_MAX_REQUESTS,
    { metricTier: "api_key_flood_guard", fallback: apiKeyFloodGuardFallback }
  );

  // The authoritative read: every authorization field from the key's live
  // rows, in one statement, so a change to any of them applies on this
  // request. It refuses an unknown, revoked, expired or out-of-scope key.
  const key = await authorizeApiKey(c, lookup);

  // The key's own tier, per key id. Only admitted requests count, so a client
  // above its tier still gets its tier's worth through.
  await enforceRateLimit(c, key.id, RATE_LIMIT_TIERS[key.rateLimitTier], {
    onRefused: (admitAtMs) => rememberThrottled(refusalKey, admitAtMs),
  });

  recordOrganizationEntitlements(c, key.settings);

  const authContext: ApiKeyContext = {
    id: key.id,
    organizationId: key.organizationId,
    projectId: key.projectId,
    grants: key.grants,
    environment: key.environment,
    walletAccess: key.walletAccess,
  };

  c.set("apiKey", authContext);

  // Update last used (fire and forget). Node coalesces this write per key.
  // Started inside the system identity frame so the deferred write keeps
  // its cross-tenant grant after the request narrows to the tenant.
  void scheduleApiKeyLastUsedUpdate(getDb(c.env), key.id);

  return authContext;
}

/**
 * Authenticates an API key when one is present and always admits a request
 * with no API key. A presented-but-invalid credential is rejected by default
 * so an expired key can never silently downgrade to anonymous access; opt out
 * only with `rejectInvalid: false` for surfaces that genuinely want that.
 */
export function optionalAuth(options: { rejectInvalid?: boolean } = {}) {
  const rejectInvalid = options.rejectInvalid ?? true;
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (presentsApiKey(c)) {
      // Reuse the main auth logic. Rate limiting and strict optional-auth
      // failures must never proceed as anonymous.
      try {
        const authMw = authMiddleware();
        await authMw(c, async () => {});
      } catch (error) {
        if (rejectInvalid || (error instanceof AppError && error.code === "RATE_LIMITED")) {
          throw error;
        }
      }
    }

    // Re-narrow explicitly: authMiddleware bound the tenant identity around
    // its own (no-op) next, so the real downstream runs here instead.
    const authenticated = c.get("apiKey");
    if (authenticated) {
      await runAsAuthenticatedKey(authenticated, next);
      return;
    }
    await next();
  };
}

/**
 * Authenticates a request with either an API key or a Clerk JWT, the only two
 * credentials the platform accepts.
 *
 * @returns Hono middleware that sets the matching auth context or throws 401.
 */
export function unifiedAuthMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Try API key first: a presented one, or one the gateway authenticated
    if (presentsApiKey(c)) {
      const authMw = authMiddleware();
      return await authMw(c, next);
    }

    const bearerToken = extractBearerToken(c);

    if (bearerToken) {
      // Non-JWT bearer tokens should still be treated as API keys
      // so invalid formats return INVALID_API_KEY consistently.
      if (!looksLikeJwt(bearerToken)) {
        const authMw = authMiddleware();
        return await authMw(c, next);
      }

      const { clerkAuthMiddleware } = await import("./clerk-auth");
      const clerkMw = clerkAuthMiddleware();
      return await clerkMw(c, next);
    }

    throw new AppError("UNAUTHORIZED", "API key required");
  };
}
