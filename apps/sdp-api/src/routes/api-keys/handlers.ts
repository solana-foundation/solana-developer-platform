import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { ApiKeyService } from "@/services/api-key.service";
import { AuditService } from "@/services/audit.service";
import { KVService } from "@/services/kv.service";
import type { Env } from "@/types/env";
import type {
  ApiKeyRole,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  RotateApiKeyResponse,
} from "@sdp/types";
import type { Context } from "hono";
import { apiKeyCreateSchema, apiKeyRotateSchema, apiKeyUpdateSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

export const listApiKeys = async (c: AppContext) => {
  const auth = getAuth(c);
  const orgId = auth.organizationId;

  const apiKeyService = new ApiKeyService(c.env.DB);
  const apiKeys = await apiKeyService.listForOrganization(orgId);

  const response: ListApiKeysResponse = {
    apiKeys: apiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      role: key.role as ApiKeyRole,
      environment: key.environment as "sandbox" | "production",
      status: key.status as "active" | "revoked" | "expired",
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    })),
  };

  return success(c, response);
};

export const createApiKey = async (c: AppContext) => {
  const auth = getAuth(c);
  const orgId = auth.organizationId;

  const body = await c.req.json();
  const parsed = apiKeyCreateSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const {
    name,
    description,
    role = "api_developer",
    environment = "sandbox",
    allowedIps,
    expiresAt,
  } = parsed.data;

  const apiKeyService = new ApiKeyService(c.env.DB);
  const createdKey = await apiKeyService.createApiKey({
    organizationId: orgId,
    createdByKeyId: auth.id,
    name,
    description,
    role,
    environment,
    allowedIps,
    expiresAt,
    pepper: c.env.API_KEY_PEPPER,
  });

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "create",
    resourceType: "api_key",
    resourceId: createdKey.id,
    metadata: { name, role, environment },
  });

  const response: CreateApiKeyResponse = {
    apiKey: {
      id: createdKey.id,
      name: createdKey.name,
      key: createdKey.key, // Full key - only shown once!
      keyPrefix: createdKey.keyPrefix,
      role: createdKey.role,
      environment: createdKey.environment,
      expiresAt: createdKey.expiresAt,
      createdAt: createdKey.createdAt,
    },
  };

  return created(c, response);
};

export const getApiKey = async (c: AppContext) => {
  const { keyId } = c.req.param();
  const auth = getAuth(c);

  const apiKeyService = new ApiKeyService(c.env.DB);
  const key = await apiKeyService.getDetails(keyId, auth.organizationId);

  if (!key) {
    throw notFound("API key");
  }

  return success(c, {
    id: key.id,
    name: key.name,
    description: key.description,
    keyPrefix: key.keyPrefix,
    role: key.role,
    environment: key.environment,
    status: key.status,
    projectId: key.projectId,
    allowedIps: key.allowedIps,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    rotatedFrom: key.rotatedFrom,
    rotationDeadline: key.rotationDeadline,
    createdAt: key.createdAt,
  });
};

export const updateApiKey = async (c: AppContext) => {
  const { keyId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = apiKeyUpdateSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  // Verify key belongs to this organization
  const existing = await c.env.DB.prepare(
    "SELECT id, key_hash FROM api_keys WHERE id = ? AND organization_id = ?"
  )
    .bind(keyId, auth.organizationId)
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
};

export const rotateApiKey = async (c: AppContext) => {
  const { keyId } = c.req.param();
  const auth = getAuth(c);

  // Prevent rotating the key being used
  if (keyId === auth.id) {
    throw new AppError("BAD_REQUEST", "Cannot rotate the API key being used for this request");
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = apiKeyRotateSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const gracePeriodHours = parsed.data.gracePeriodHours ?? 24;

  const apiKeyService = new ApiKeyService(c.env.DB);
  const rotation = await apiKeyService.rotateApiKey(
    keyId,
    auth.organizationId,
    gracePeriodHours,
    c.env.API_KEY_PEPPER
  );

  if (!rotation) {
    throw notFound("API key");
  }

  // Invalidate old key cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.deleteApiKey(rotation.previousKeyHash);

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "update",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: { action: "rotate", newKeyId: rotation.apiKey.id, gracePeriodHours },
  });

  const response: RotateApiKeyResponse = {
    apiKey: rotation.apiKey,
    previousKey: rotation.previousKey,
  };

  return created(c, response);
};

export const revokeApiKey = async (c: AppContext) => {
  const { keyId } = c.req.param();
  const auth = getAuth(c);

  // Prevent revoking your own key
  if (keyId === auth.id) {
    throw new AppError("BAD_REQUEST", "Cannot revoke the API key being used for this request");
  }

  const apiKeyService = new ApiKeyService(c.env.DB);
  const revokedKey = await apiKeyService.revokeApiKey(keyId, auth.organizationId);

  if (!revokedKey) {
    throw notFound("API key");
  }

  // Invalidate KV cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.deleteApiKey(revokedKey.keyHash);

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
};
