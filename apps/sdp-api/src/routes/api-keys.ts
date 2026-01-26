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
import type {
  ApiKeyRole,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  RotateApiKeyResponse,
} from "@sdp/types";
import { Hono } from "hono";
import { z } from "zod";

const apiKeys = new Hono<{ Bindings: Env }>();

// All routes require authentication
apiKeys.use("*", authMiddleware());

// Validation schemas
const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  role: z.enum(["api_admin", "api_developer", "api_readonly"]).optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  allowedIps: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

const updateKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  allowedIps: z.array(z.string()).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

const rotateKeySchema = z.object({
  gracePeriodHours: z.number().min(0).max(168).optional(), // Max 7 days
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
    `SELECT id, name, description, key_prefix, role, environment, status,
            project_id, allowed_ips, last_used_at, expires_at, rotated_from, rotation_deadline, created_at
     FROM api_keys
     WHERE id = ? AND organization_id = ?`
  )
    .bind(keyId, auth!.organizationId)
    .first<{
      id: string;
      name: string;
      description: string | null;
      key_prefix: string;
      role: string;
      environment: string;
      status: string;
      project_id: string | null;
      allowed_ips: string | null;
      last_used_at: string | null;
      expires_at: string | null;
      rotated_from: string | null;
      rotation_deadline: string | null;
      created_at: string;
    }>();

  if (!key) {
    throw notFound("API key");
  }

  return success(c, {
    id: key.id,
    name: key.name,
    description: key.description,
    keyPrefix: key.key_prefix,
    role: key.role,
    environment: key.environment,
    status: key.status,
    projectId: key.project_id,
    allowedIps: key.allowed_ips ? JSON.parse(key.allowed_ips) : null,
    lastUsedAt: key.last_used_at,
    expiresAt: key.expires_at,
    rotatedFrom: key.rotated_from,
    rotationDeadline: key.rotation_deadline,
    createdAt: key.created_at,
  });
});

/**
 * Update API key
 * PATCH /v1/api-keys/:keyId
 */
apiKeys.patch("/:keyId", requirePermissions("api-keys:write"), async (c) => {
  const { keyId } = c.req.param();
  const auth = c.get("apiKey");

  const body = await c.req.json();
  const parsed = updateKeySchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  // Verify key belongs to this organization
  const existing = await c.env.DB.prepare(
    "SELECT id, key_hash FROM api_keys WHERE id = ? AND organization_id = ?"
  )
    .bind(keyId, auth!.organizationId)
    .first<{ id: string; key_hash: string }>();

  if (!existing) {
    throw notFound("API key");
  }

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (parsed.data.name !== undefined) {
    updates.push("name = ?");
    values.push(parsed.data.name);
  }

  if (parsed.data.description !== undefined) {
    updates.push("description = ?");
    values.push(parsed.data.description);
  }

  if (parsed.data.allowedIps !== undefined) {
    updates.push("allowed_ips = ?");
    values.push(parsed.data.allowedIps ? JSON.stringify(parsed.data.allowedIps) : null);
  }

  if (parsed.data.expiresAt !== undefined) {
    updates.push("expires_at = ?");
    values.push(parsed.data.expiresAt);
  }

  if (updates.length === 0) {
    throw new AppError("BAD_REQUEST", "No fields to update");
  }

  values.push(keyId);
  await c.env.DB.prepare(`UPDATE api_keys SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  // Invalidate cache if IP restrictions changed
  if (parsed.data.allowedIps !== undefined) {
    const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
    await kvService.deleteApiKey(existing.key_hash);
  }

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "update",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: parsed.data,
  });

  return success(c, { success: true });
});

/**
 * Rotate API key (create new key, set grace period on old)
 * POST /v1/api-keys/:keyId/rotate
 */
apiKeys.post("/:keyId/rotate", requirePermissions("api-keys:write"), async (c) => {
  const { keyId } = c.req.param();
  const auth = c.get("apiKey");

  // Prevent rotating the key being used
  if (keyId === auth!.id) {
    throw new AppError("BAD_REQUEST", "Cannot rotate the API key being used for this request");
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = rotateKeySchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const gracePeriodHours = parsed.data.gracePeriodHours ?? 24;

  // Get existing key
  const existing = await c.env.DB.prepare(
    `SELECT id, name, description, key_hash, role, environment, project_id, allowed_ips, created_by
     FROM api_keys
     WHERE id = ? AND organization_id = ? AND status = 'active'`
  )
    .bind(keyId, auth!.organizationId)
    .first<{
      id: string;
      name: string;
      description: string | null;
      key_hash: string;
      role: string;
      environment: string;
      project_id: string | null;
      allowed_ips: string | null;
      created_by: string;
    }>();

  if (!existing) {
    throw notFound("API key");
  }

  // Generate new key
  const newKeyId = generateApiKeyId();
  const { key: newKey, prefix: newPrefix } = generateApiKey(
    existing.environment as "sandbox" | "production"
  );
  const newKeyHash = await hashString(newKey, c.env.API_KEY_PEPPER);

  // Calculate rotation deadline
  const rotationDeadline = new Date(Date.now() + gracePeriodHours * 60 * 60 * 1000).toISOString();

  // Create new key
  await c.env.DB.prepare(
    `INSERT INTO api_keys (
      id, organization_id, project_id, created_by, name, description, key_prefix, key_hash,
      role, environment, allowed_ips, rotated_from, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  )
    .bind(
      newKeyId,
      auth!.organizationId,
      existing.project_id,
      existing.created_by,
      existing.name,
      existing.description,
      newPrefix,
      newKeyHash,
      existing.role,
      existing.environment,
      existing.allowed_ips,
      keyId
    )
    .run();

  // Update old key with rotation deadline
  await c.env.DB.prepare("UPDATE api_keys SET rotation_deadline = ? WHERE id = ?")
    .bind(rotationDeadline, keyId)
    .run();

  // Invalidate old key cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.deleteApiKey(existing.key_hash);

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "update",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: { action: "rotate", newKeyId, gracePeriodHours },
  });

  const response: RotateApiKeyResponse = {
    apiKey: {
      id: newKeyId,
      name: existing.name,
      key: newKey, // Full key - only shown once!
      keyPrefix: newPrefix,
      role: existing.role as ApiKeyRole,
      environment: existing.environment as "sandbox" | "production",
      expiresAt: null,
      createdAt: new Date().toISOString(),
    },
    previousKey: {
      id: keyId,
      rotationDeadline,
    },
  };

  return created(c, response);
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
