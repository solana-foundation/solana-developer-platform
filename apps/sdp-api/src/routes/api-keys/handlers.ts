import type {
  ApiKeyRole,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  Permission,
  RotateApiKeyResponse,
} from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { requireProjectId } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { ApiKeyService } from "@/services/api-key.service";
import {
  assertWalletBindingsInScope,
  resolveCreateWalletScope,
  resolveUpdateWalletScope,
} from "@/services/api-key-scope.service";
import {
  listApiKeyWalletBindings,
  replaceApiKeyWalletBindings,
} from "@/services/api-key-wallets.service";
import { AuditService } from "@/services/audit.service";
import { createSigningService } from "@/services/domain/signing.service";
import { SigningError } from "@/services/ports";
import type { WalletPurpose } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { apiKeyCreateSchema, apiKeyRotateSchema, apiKeyUpdateSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

function resolveActor(c: AppContext): {
  organizationId: string;
  permissions: Permission[];
  apiKeyId: string | null;
  userId: string | null;
} {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return {
      organizationId: apiKey.organizationId,
      permissions: apiKey.permissions,
      apiKeyId: apiKey.id,
      userId: null,
    };
  }

  const clerk = c.get("clerk");
  if (clerk) {
    return {
      organizationId: clerk.organizationId,
      permissions: clerk.permissions,
      apiKeyId: null,
      userId: clerk.userId,
    };
  }

  const session = c.get("session");
  if (session) {
    return {
      organizationId: session.organizationId,
      permissions: session.permissions,
      apiKeyId: null,
      userId: session.userId,
    };
  }

  throw new AppError("UNAUTHORIZED", "Authentication required");
}

export const listApiKeys = async (c: AppContext) => {
  resolveActor(c);
  const projectId = requireProjectId(c);

  const apiKeyService = new ApiKeyService(getDb(c.env));
  const apiKeys = await apiKeyService.listForProject(projectId);

  const response: ListApiKeysResponse = {
    apiKeys: apiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      role: key.role as ApiKeyRole,
      environment: key.environment as "sandbox" | "production",
      status: key.status,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    })),
  };

  return success(c, response);
};

export const createApiKey = async (c: AppContext) => {
  const actor = resolveActor(c);
  const orgId = actor.organizationId;

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
    permissions,
    walletScope,
    allowedIps,
    expiresAt,
    signingWalletId,
    signingWalletIds,
    walletBindings,
    provisionWallet,
    walletLabel,
    walletPurpose,
  } = parsed.data;

  const projectId = requireProjectId(c);

  const hasOrgAdminAccess =
    actor.permissions.includes("*") || actor.permissions.includes("org:admin");

  if (permissions && !hasOrgAdminAccess) {
    throw new AppError("INSUFFICIENT_PERMISSIONS", "Custom permission sets require admin access");
  }

  const walletSelection = resolveCreateWalletScope({
    walletScope,
    signingWalletId,
    signingWalletIds,
    walletBindings,
    provisionWallet,
  });

  let resolvedSigningWalletId: string | null = walletSelection.defaultSigningWalletId;
  let resolvedWalletBindings = walletSelection.bindings;

  if (provisionWallet) {
    if (!(actor.permissions.includes("*") || actor.permissions.includes("custody:admin"))) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "Required permissions: custody:admin");
    }

    const signingService = createSigningService(c.env);
    try {
      const wallet = await signingService.createWallet(actor.organizationId, undefined, {
        label: walletLabel,
        purpose: walletPurpose as WalletPurpose | undefined,
      });
      resolvedSigningWalletId = wallet.walletId;
      resolvedWalletBindings = [{ walletId: wallet.walletId, permissions: ["*"] }];
    } catch (error) {
      if (error instanceof SigningError) {
        if (error.code === "NOT_FOUND") {
          throw new AppError("CONFLICT", error.message);
        }
        throw new AppError("BAD_REQUEST", error.message);
      }
      throw error;
    }
  } else {
    await assertWalletBindingsInScope(getDb(c.env), orgId, projectId, resolvedWalletBindings);
  }

  const resolveCreatorFallback = async (): Promise<string | null> => {
    if (actor.userId) {
      return actor.userId;
    }

    if (!actor.apiKeyId) {
      return null;
    }

    const creator = await getDb(c.env)
      .prepare(
        `SELECT created_by
       FROM api_keys
       WHERE id = ? AND organization_id = ?`
      )
      .bind(actor.apiKeyId, orgId)
      .first<{ created_by: string }>();

    if (creator?.created_by) {
      return creator.created_by;
    }

    const orgOwner = await getDb(c.env)
      .prepare(
        `SELECT user_id
       FROM organization_members
       WHERE organization_id = ? AND role IN ('admin', 'owner')
       ORDER BY created_at ASC
       LIMIT 1`
      )
      .bind(orgId)
      .first<{ user_id: string }>();

    return orgOwner?.user_id ?? null;
  };

  const createdBy = await resolveCreatorFallback();

  if (!createdBy) {
    throw new AppError("UNAUTHORIZED", "Could not resolve authenticated user for API key creation");
  }

  const apiKeyService = new ApiKeyService(getDb(c.env));
  const createdKey = await apiKeyService.createApiKey({
    organizationId: orgId,
    projectId,
    createdByUserId: createdBy,
    createdByKeyId: actor.apiKeyId ?? undefined,
    name,
    description,
    role,
    permissions,
    allowedIps,
    expiresAt,
    signingWalletId: resolvedSigningWalletId,
    pepper: c.env.API_KEY_PEPPER,
  });

  if (resolvedWalletBindings.length > 0) {
    await replaceApiKeyWalletBindings(getDb(c.env), createdKey.id, resolvedWalletBindings);
  }

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "create",
    resourceType: "api_key",
    resourceId: createdKey.id,
    metadata: {
      name,
      role,
      environment: createdKey.environment,
      walletScope: resolvedWalletBindings.length > 0 ? "selected" : "all",
      signingWalletId: resolvedSigningWalletId,
      signingWalletIds: resolvedWalletBindings.map((binding) => binding.walletId),
      provisionedWallet: Boolean(provisionWallet),
    },
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
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  const apiKeyService = new ApiKeyService(getDb(c.env));
  const key = await apiKeyService.getDetails(keyId, actor.organizationId, projectId);

  if (!key) {
    throw notFound("API key");
  }

  const walletBindings = await listApiKeyWalletBindings(getDb(c.env), key.id);

  return success(c, {
    id: key.id,
    name: key.name,
    description: key.description,
    keyPrefix: key.keyPrefix,
    role: key.role,
    permissions: key.permissions,
    environment: key.environment,
    status: key.status,
    projectId: key.projectId,
    allowedIps: key.allowedIps,
    walletScope: walletBindings.length > 0 ? "selected" : "all",
    signingWalletId: key.signingWalletId,
    signingWalletIds: walletBindings.map((binding) => binding.walletId),
    walletBindings,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    rotatedFrom: key.rotatedFrom,
    rotationDeadline: key.rotationDeadline,
    createdAt: key.createdAt,
  });
};

export const updateApiKey = async (c: AppContext) => {
  const { keyId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  const body = await c.req.json();
  const parsed = apiKeyUpdateSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  // Verify key belongs to this organization and the current project scope
  const existing = await getDb(c.env)
    .prepare(
      "SELECT id, key_hash, project_id FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?"
    )
    .bind(keyId, actor.organizationId, projectId)
    .first<{ id: string; key_hash: string; project_id: string }>();

  if (!existing) {
    throw notFound("API key");
  }

  const walletSelection = resolveUpdateWalletScope({
    walletScope: parsed.data.walletScope,
    signingWalletId: parsed.data.signingWalletId,
    signingWalletIds: parsed.data.signingWalletIds,
    walletBindings: parsed.data.walletBindings,
  });

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

  if (parsed.data.permissions !== undefined) {
    const hasOrgAdminAccess =
      actor.permissions.includes("*") || actor.permissions.includes("org:admin");

    if (parsed.data.permissions && !hasOrgAdminAccess) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "Custom permission sets require admin access");
    }

    updates.push("permissions = ?");
    values.push(parsed.data.permissions ? JSON.stringify(parsed.data.permissions) : null);
  }

  if (walletSelection.touched) {
    await assertWalletBindingsInScope(
      getDb(c.env),
      actor.organizationId,
      existing.project_id,
      walletSelection.bindings
    );
    updates.push("signing_wallet_id = ?");
    values.push(walletSelection.defaultSigningWalletId);
  }

  if (updates.length === 0) {
    throw new AppError("BAD_REQUEST", "No fields to update");
  }

  values.push(keyId);
  await getDb(c.env)
    .prepare(`UPDATE api_keys SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  if (walletSelection.touched) {
    await replaceApiKeyWalletBindings(getDb(c.env), keyId, walletSelection.bindings);
  }

  // Invalidate cache if auth-relevant fields changed
  if (
    parsed.data.allowedIps !== undefined ||
    parsed.data.permissions !== undefined ||
    walletSelection.touched
  ) {
    await c.var.kv.apiKeys.delete(`key:${existing.key_hash}`);
  }

  // Audit log
  const auditService = new AuditService(getDb(c.env));
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
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  // Prevent rotating the key being used
  if (actor.apiKeyId && keyId === actor.apiKeyId) {
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

  const apiKeyService = new ApiKeyService(getDb(c.env));
  const rotation = await apiKeyService.rotateApiKey(
    keyId,
    actor.organizationId,
    projectId,
    gracePeriodHours,
    c.env.API_KEY_PEPPER
  );

  if (!rotation) {
    throw notFound("API key");
  }

  // Invalidate old key cache
  await c.var.kv.apiKeys.delete(`key:${rotation.previousKeyHash}`);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
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
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  // Prevent revoking your own key
  if (actor.apiKeyId && keyId === actor.apiKeyId) {
    throw new AppError("BAD_REQUEST", "Cannot revoke the API key being used for this request");
  }

  const body = await c.req.json().catch(() => ({}));
  const confirmation =
    body &&
    typeof body === "object" &&
    typeof (body as { confirmation?: unknown }).confirmation === "string"
      ? String((body as { confirmation: string }).confirmation).trim()
      : "";

  const existing = await getDb(c.env)
    .prepare(
      "SELECT id, name, status, revoked_at FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?"
    )
    .bind(keyId, actor.organizationId, projectId)
    .first<{ id: string; name: string; status: string; revoked_at: string | null }>();

  if (!existing) {
    throw notFound("API key");
  }

  if (existing.status === "deactivated" || existing.status === "revoked") {
    return success(c, {
      success: true,
      revokedAt: existing.revoked_at ?? new Date().toISOString(),
    });
  }

  if (!confirmation) {
    throw new AppError("BAD_REQUEST", "Confirmation is required to deactivate an API key");
  }

  if (confirmation !== existing.name) {
    throw new AppError("BAD_REQUEST", "Confirmation did not match the key name");
  }

  const apiKeyService = new ApiKeyService(getDb(c.env));
  const revokedKey = await apiKeyService.revokeApiKey(keyId, actor.organizationId, projectId);

  if (!revokedKey) {
    throw notFound("API key");
  }

  // Invalidate KV cache
  await c.var.kv.apiKeys.delete(`key:${revokedKey.keyHash}`);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: { action: "deactivate" },
  });

  return success(c, {
    success: true,
    revokedAt: revokedKey.revokedAt,
  });
};
