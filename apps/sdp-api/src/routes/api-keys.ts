/**
 * API Keys Routes
 */

import { generateApiKey, generateApiKeyId, hashString } from "@/lib/crypto";
import { AppError, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { authMiddleware, requirePermissions } from "@/middleware/auth";
import { AuditService } from "@/services/audit.service";
import { KVService } from "@/services/kv.service";
import type { Env } from "@/types/env";
import type { ApiKeyRole, CreateApiKeyResponse, ListApiKeysResponse } from "@sdp/types";
import { Hono } from "hono";
import { z } from "zod";

const apiKeys = new Hono<{ Bindings: Env }>();

// All routes require authentication
apiKeys.use("*", authMiddleware());

// Validation schemas
const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(["api_admin", "api_developer", "api_readonly"]).optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  expiresAt: z.string().datetime().optional(),
});

/**
 * List API keys for the organization
 * GET /v1/api-keys
 */
apiKeys.get("/", requirePermissions("api-keys:read"), async (c) => {
  const auth = c.get("apiKey");
  const orgId = auth!.organizationId;

  const results = await c.env.DB.prepare(
    `SELECT id, name, key_prefix, role, environment, status,
            last_used_at, expires_at, created_at
     FROM api_keys
     WHERE organization_id = ? AND status != 'revoked'
     ORDER BY created_at DESC`
  )
    .bind(orgId)
    .all();

  const response: ListApiKeysResponse = {
    apiKeys: results.results.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      keyPrefix: row.key_prefix as string,
      role: row.role as ApiKeyRole,
      environment: row.environment as "sandbox" | "production",
      status: row.status as "active" | "revoked" | "expired",
      lastUsedAt: row.last_used_at as string | null,
      expiresAt: row.expires_at as string | null,
      createdAt: row.created_at as string,
    })),
  };

  return success(c, response);
});

/**
 * Create a new API key
 * POST /v1/api-keys
 */
apiKeys.post("/", requirePermissions("api-keys:write"), async (c) => {
  const auth = c.get("apiKey");
  const orgId = auth!.organizationId;

  const body = await c.req.json();
  const parsed = createKeySchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { name, role = "api_developer", environment = "sandbox", expiresAt } = parsed.data;

  // Generate key
  const keyId = generateApiKeyId();
  const { key, prefix } = generateApiKey(environment);
  const keyHash = await hashString(key, c.env.API_KEY_PEPPER);

  // Get user ID from the creating key (for audit)
  const creatorKey = await c.env.DB.prepare("SELECT created_by FROM api_keys WHERE id = ?")
    .bind(auth!.id)
    .first<{ created_by: string }>();

  await c.env.DB.prepare(
    `INSERT INTO api_keys (
      id, organization_id, created_by, name, key_prefix, key_hash,
      role, environment, expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  )
    .bind(
      keyId,
      orgId,
      creatorKey?.created_by || "system",
      name,
      prefix,
      keyHash,
      role,
      environment,
      expiresAt || null
    )
    .run();

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "create",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: { name, role, environment },
  });

  const response: CreateApiKeyResponse = {
    apiKey: {
      id: keyId,
      name,
      key, // Full key - only shown once!
      keyPrefix: prefix,
      role,
      environment,
      expiresAt: expiresAt || null,
      createdAt: new Date().toISOString(),
    },
  };

  return created(c, response);
});

/**
 * Get API key details
 * GET /v1/api-keys/:keyId
 */
apiKeys.get("/:keyId", requirePermissions("api-keys:read"), async (c) => {
  const { keyId } = c.req.param();
  const auth = c.get("apiKey");

  const key = await c.env.DB.prepare(
    `SELECT id, name, key_prefix, role, environment, status,
            last_used_at, expires_at, created_at
     FROM api_keys
     WHERE id = ? AND organization_id = ?`
  )
    .bind(keyId, auth!.organizationId)
    .first();

  if (!key) {
    throw notFound("API key");
  }

  return success(c, {
    id: key.id,
    name: key.name,
    keyPrefix: key.key_prefix,
    role: key.role,
    environment: key.environment,
    status: key.status,
    lastUsedAt: key.last_used_at,
    expiresAt: key.expires_at,
    createdAt: key.created_at,
  });
});

/**
 * Revoke an API key
 * DELETE /v1/api-keys/:keyId
 */
apiKeys.delete("/:keyId", requirePermissions("api-keys:write"), async (c) => {
  const { keyId } = c.req.param();
  const auth = c.get("apiKey");

  // Prevent revoking your own key
  if (keyId === auth!.id) {
    throw new AppError("BAD_REQUEST", "Cannot revoke the API key being used for this request");
  }

  // Verify key belongs to this organization
  const key = await c.env.DB.prepare(
    "SELECT id, key_hash FROM api_keys WHERE id = ? AND organization_id = ?"
  )
    .bind(keyId, auth!.organizationId)
    .first<{ id: string; key_hash: string }>();

  if (!key) {
    throw notFound("API key");
  }

  // Revoke
  await c.env.DB.prepare(
    `UPDATE api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?`
  )
    .bind(keyId)
    .run();

  // Invalidate KV cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.deleteApiKey(key.key_hash);

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "revoke",
    resourceType: "api_key",
    resourceId: keyId,
  });

  return success(c, {
    success: true,
    revokedAt: new Date().toISOString(),
  });
});

export default apiKeys;
