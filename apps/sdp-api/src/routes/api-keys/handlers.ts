import { AppError, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { ApiKeyService } from "@/services/api-key.service";
import { AuditService } from "@/services/audit.service";
import { createSigningService } from "@/services/domain/signing.service";
import { KVService } from "@/services/kv.service";
import { SigningError } from "@/services/ports";
import type { WalletPurpose } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import type {
  ApiKeyRole,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  Permission,
  RotateApiKeyResponse,
} from "@sdp/types";
import type { Context } from "hono";
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
  const actor = resolveActor(c);
  const orgId = actor.organizationId;

  const apiKeyService = new ApiKeyService(c.env.DB);
  const apiKeys = await apiKeyService.listForOrganization(orgId);

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
    environment = "sandbox",
    permissions,
    allowedIps,
    expiresAt,
    signingWalletId,
    provisionWallet,
    walletLabel,
    walletPurpose,
  } = parsed.data;

  if (permissions && !actor.permissions.includes("*")) {
    throw new AppError("INSUFFICIENT_PERMISSIONS", "Custom permission sets require owner access");
  }

  if (provisionWallet && signingWalletId) {
    throw new AppError(
      "BAD_REQUEST",
      "Provide either signingWalletId or provisionWallet, not both"
    );
  }

  let resolvedSigningWalletId: string | null | undefined = signingWalletId ?? undefined;

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
    } catch (error) {
      if (error instanceof SigningError) {
        if (error.code === "NOT_FOUND") {
          throw new AppError("CONFLICT", error.message);
        }
        throw new AppError("BAD_REQUEST", error.message);
      }
      throw error;
    }
  } else if (resolvedSigningWalletId) {
    const wallet = await c.env.DB.prepare(
      `SELECT c.project_id as project_id
       FROM custody_wallets w
       JOIN custody_configs c ON c.id = w.custody_config_id
       WHERE c.organization_id = ? AND w.wallet_id = ? AND c.status = 'active' AND w.status = 'active'
       LIMIT 1`
    )
      .bind(orgId, resolvedSigningWalletId)
      .first<{ project_id: string | null }>();

    if (!wallet) {
      throw new AppError("BAD_REQUEST", "Unknown signingWalletId");
    }

    if (wallet.project_id) {
      throw new AppError("BAD_REQUEST", "Org-level API keys cannot bind to project wallets");
    }
  }

  const resolveCreatorFallback = async (): Promise<string | null> => {
    if (actor.userId) {
      return actor.userId;
    }

    if (!actor.apiKeyId) {
      return null;
    }

    const creator = await c.env.DB.prepare(
      `SELECT created_by
       FROM api_keys
       WHERE id = ? AND organization_id = ?`
    )
      .bind(actor.apiKeyId, orgId)
      .first<{ created_by: string }>();

    if (creator?.created_by) {
      return creator.created_by;
    }

    const orgOwner = await c.env.DB.prepare(
      `SELECT user_id
       FROM organization_members
       WHERE organization_id = ? AND role IN ('owner', 'admin')
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

  const apiKeyService = new ApiKeyService(c.env.DB);
  const createdKey = await apiKeyService.createApiKey({
    organizationId: orgId,
    createdByUserId: createdBy,
    createdByKeyId: actor.apiKeyId ?? undefined,
    name,
    description,
    role,
    permissions,
    environment,
    allowedIps,
    expiresAt,
    signingWalletId: resolvedSigningWalletId ?? null,
    pepper: c.env.API_KEY_PEPPER,
  });

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "create",
    resourceType: "api_key",
    resourceId: createdKey.id,
    metadata: {
      name,
      role,
      environment,
      signingWalletId: resolvedSigningWalletId ?? null,
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

  const apiKeyService = new ApiKeyService(c.env.DB);
  const key = await apiKeyService.getDetails(keyId, actor.organizationId);

  if (!key) {
    throw notFound("API key");
  }

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
    signingWalletId: key.signingWalletId,
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

  const body = await c.req.json();
  const parsed = apiKeyUpdateSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  // Verify key belongs to this organization
  const existing = await c.env.DB.prepare(
    "SELECT id, key_hash, project_id FROM api_keys WHERE id = ? AND organization_id = ?"
  )
    .bind(keyId, actor.organizationId)
    .first<{ id: string; key_hash: string; project_id: string | null }>();

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

  if (parsed.data.permissions !== undefined) {
    if (parsed.data.permissions && !actor.permissions.includes("*")) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "Custom permission sets require owner access");
    }

    updates.push("permissions = ?");
    values.push(parsed.data.permissions ? JSON.stringify(parsed.data.permissions) : null);
  }

  if (parsed.data.signingWalletId !== undefined) {
    if (parsed.data.signingWalletId) {
      const wallet = await c.env.DB.prepare(
        `SELECT c.project_id as project_id
         FROM custody_wallets w
         JOIN custody_configs c ON c.id = w.custody_config_id
         WHERE c.organization_id = ? AND w.wallet_id = ? AND c.status = 'active' AND w.status = 'active'
         LIMIT 1`
      )
        .bind(actor.organizationId, parsed.data.signingWalletId)
        .first<{ project_id: string | null }>();

      if (!wallet) {
        throw new AppError("BAD_REQUEST", "Unknown signingWalletId");
      }

      if (!existing.project_id && wallet.project_id) {
        throw new AppError("BAD_REQUEST", "Org-level API keys cannot bind to project wallets");
      }

      if (existing.project_id && wallet.project_id && wallet.project_id !== existing.project_id) {
        throw new AppError(
          "BAD_REQUEST",
          "Project API keys cannot bind to wallets from other projects"
        );
      }
    }

    updates.push("signing_wallet_id = ?");
    values.push(parsed.data.signingWalletId);
  }

  if (updates.length === 0) {
    throw new AppError("BAD_REQUEST", "No fields to update");
  }

  values.push(keyId);
  await c.env.DB.prepare(`UPDATE api_keys SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  // Invalidate cache if auth-relevant fields changed
  if (
    parsed.data.allowedIps !== undefined ||
    parsed.data.permissions !== undefined ||
    parsed.data.signingWalletId !== undefined
  ) {
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
  const actor = resolveActor(c);

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

  const apiKeyService = new ApiKeyService(c.env.DB);
  const rotation = await apiKeyService.rotateApiKey(
    keyId,
    actor.organizationId,
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
  const actor = resolveActor(c);

  // Prevent revoking your own key
  if (actor.apiKeyId && keyId === actor.apiKeyId) {
    throw new AppError("BAD_REQUEST", "Cannot revoke the API key being used for this request");
  }

  const body = await c.req.json().catch(() => ({}));
  const confirmation = (body && typeof body === "object" && typeof (body as { confirmation?: unknown }).confirmation === "string")
    ? String((body as { confirmation: string }).confirmation).trim()
    : "";

  const existing = await c.env.DB.prepare(
    "SELECT id, name, status, revoked_at FROM api_keys WHERE id = ? AND organization_id = ?"
  )
    .bind(keyId, actor.organizationId)
    .first<{ id: string; name: string; status: string; revoked_at: string | null }>();

  if (!existing) {
    throw notFound("API key");
  }

  if (existing.status === "deactivated" || existing.status === "revoked") {
    return success(c, { success: true, revokedAt: existing.revoked_at ?? new Date().toISOString() });
  }

  if (!confirmation) {
    throw new AppError("BAD_REQUEST", "Confirmation is required to deactivate an API key");
  }

  if (confirmation !== existing.name) {
    throw new AppError("BAD_REQUEST", "Confirmation did not match the key name");
  }

  const apiKeyService = new ApiKeyService(c.env.DB);
  const revokedKey = await apiKeyService.revokeApiKey(keyId, actor.organizationId);

  if (!revokedKey) {
    throw notFound("API key");
  }

  // Invalidate KV cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.deleteApiKey(revokedKey.keyHash);

  // Audit log
  const auditService = new AuditService(c.env.DB);
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
