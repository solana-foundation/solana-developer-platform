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

import type { ApiKeyRole, ApiKeyWalletBinding, CachedApiKey } from "@sdp/types";
import { getPermissionsForApiKeyRole, type Permission } from "@sdp/types";
import type { Context, Next } from "hono";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import type { KVStore } from "@/runtime/kv";
import type { Env } from "@/types/env";

const KV_TTL_SECONDS = 3600; // 1 hour cache

interface ApiKeyContext {
  id: string;
  organizationId: string;
  projectId: string | null;
  role: ApiKeyRole;
  permissions: Permission[];
  environment: string;
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: ApiKeyWalletBinding[];
}

/**
 * Extract API key from Authorization header
 */
function extractApiKey(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return null;
  }

  // Support both "Bearer sk_xxx" and just "sk_xxx"
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  if (authHeader.startsWith("sk_")) {
    return authHeader;
  }

  return null;
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

function looksLikeApiKey(token: string): boolean {
  return token.startsWith("sk_");
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

/**
 * Look up API key in KV cache
 */
async function getFromKV(kv: KVStore, keyHash: string): Promise<CachedApiKey | null> {
  const cached = await kv.get<CachedApiKey>(`key:${keyHash}`, "json");
  return cached;
}

/**
 * Look up API key in Postgres and cache to KV
 */
async function getFromDatabaseAndCache(
  db: DatabaseClient,
  kv: KVStore,
  keyHash: string
): Promise<CachedApiKey | null> {
  const result = await db
    .prepare(
      `SELECT id, organization_id, project_id, role, permissions, environment,
              rate_limit_tier, allowed_ips, signing_wallet_id, status, expires_at
       FROM api_keys
       WHERE key_hash = ?`
    )
    .bind(keyHash)
    .first<{
      id: string;
      organization_id: string;
      project_id: string | null;
      role: ApiKeyRole;
      permissions: string | null;
      environment: string;
      rate_limit_tier: string;
      allowed_ips: string | null;
      signing_wallet_id: string | null;
      status: string;
      expires_at: string | null;
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

  const cached: CachedApiKey = {
    id: result.id,
    organizationId: result.organization_id,
    projectId: result.project_id,
    role: result.role,
    permissions: result.permissions
      ? JSON.parse(result.permissions)
      : getPermissionsForApiKeyRole(result.role),
    environment: result.environment as "sandbox" | "production",
    rateLimitTier: result.rate_limit_tier as "standard" | "elevated" | "unlimited",
    allowedIps: result.allowed_ips ? JSON.parse(result.allowed_ips) : null,
    signingWalletId,
    signingWalletIds,
    walletBindings,
    status: result.status as "active" | "revoked" | "expired" | "deactivated",
    expiresAt: result.expires_at,
  };

  // Cache to KV
  await kv.put(`key:${keyHash}`, JSON.stringify(cached), {
    expirationTtl: KV_TTL_SECONDS,
  });

  return cached;
}

/**
 * Update last_used_at timestamp (fire and forget)
 */
function updateLastUsed(db: DatabaseClient, keyId: string) {
  db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`)
    .bind(keyId)
    .run()
    .catch((err) => console.error("Failed to update last_used_at:", err));
}

function safeParsePermissionsArray(value: string | null | undefined): Permission[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is Permission => typeof entry === "string");
  } catch {
    return [];
  }
}

function normalizeWalletBindings(cachedKey: CachedApiKey): {
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: ApiKeyWalletBinding[];
} {
  const rawBindings = cachedKey.walletBindings ?? [];
  const walletBindings = rawBindings
    .filter((binding) => typeof binding.walletId === "string" && binding.walletId.length > 0)
    .map((binding) => ({
      walletId: binding.walletId,
      permissions:
        binding.permissions && binding.permissions.length > 0
          ? binding.permissions
          : (["*"] as Permission[]),
    }));

  if (walletBindings.length === 0 && cachedKey.signingWalletId) {
    walletBindings.push({
      walletId: cachedKey.signingWalletId,
      permissions: ["*"],
    });
  }

  const signingWalletIds = walletBindings.map((binding) => binding.walletId);
  const signingWalletId = cachedKey.signingWalletId ?? signingWalletIds[0] ?? null;

  return {
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
      cachedKey = await getFromDatabaseAndCache(getDb(c.env), apiKeysKV, keyHash);
    }

    if (!cachedKey) {
      throw new AppError("INVALID_API_KEY", "Invalid API key");
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

    // Set auth context
    const normalizedWalletBindings = normalizeWalletBindings(cachedKey);

    const authContext: ApiKeyContext = {
      id: cachedKey.id,
      organizationId: cachedKey.organizationId,
      projectId: cachedKey.projectId,
      role: cachedKey.role,
      permissions: cachedKey.permissions,
      environment: cachedKey.environment,
      signingWalletId: normalizedWalletBindings.signingWalletId,
      signingWalletIds: normalizedWalletBindings.signingWalletIds,
      walletBindings: normalizedWalletBindings.walletBindings,
    };

    c.set("apiKey", authContext);

    // Update last used (fire and forget)
    updateLastUsed(getDb(c.env), cachedKey.id);

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
      // Reuse the main auth logic but catch errors
      try {
        const authMw = authMiddleware();
        await authMw(c, async () => {});
      } catch {
        // Ignore auth errors for optional auth
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
