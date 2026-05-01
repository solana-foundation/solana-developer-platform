import type { ApiKeyRole, CreateApiKeyResponse } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { apiKeyCreateSchema } from "@/routes/api-keys/schemas";
import { ApiKeyService } from "@/services/api-key.service";
import {
  assertWalletBindingsInScope,
  resolveCreateWalletScope,
} from "@/services/api-key-scope.service";
import { replaceApiKeyWalletBindings } from "@/services/api-key-wallets.service";
import { AuditService } from "@/services/audit.service";
import { createSigningService } from "@/services/domain/signing.service";
import { SigningError } from "@/services/ports";
import { ProjectService } from "@/services/project.service";
import type { WalletPurpose } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

export const listProjectApiKeys = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const projectService = new ProjectService(getDb(c.env));

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  const apiKeyService = new ApiKeyService(getDb(c.env));
  const apiKeys = await apiKeyService.listForProject(projectId);

  return success(c, {
    apiKeys: apiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      description: key.description,
      keyPrefix: key.keyPrefix,
      role: key.role as ApiKeyRole,
      environment: key.environment as "sandbox" | "production",
      status: key.status,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    })),
  });
};

export const createProjectApiKey = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = apiKeyCreateSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectService = new ProjectService(getDb(c.env));

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  const {
    name,
    description,
    role = "api_developer",
    environment = "sandbox",
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

  const hasOrgAdminAccess =
    auth.permissions.includes("*") || auth.permissions.includes("org:admin");

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
    if (!(auth.permissions.includes("*") || auth.permissions.includes("custody:admin"))) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "Required permissions: custody:admin");
    }

    const signingService = createSigningService(c.env);
    try {
      const wallet = await signingService.createWallet(auth.organizationId, projectId, {
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
    await assertWalletBindingsInScope(
      getDb(c.env),
      auth.organizationId,
      projectId,
      resolvedWalletBindings
    );
  }

  const apiKeyService = new ApiKeyService(getDb(c.env));
  const createdKey = await apiKeyService.createApiKey({
    organizationId: auth.organizationId,
    projectId,
    createdByKeyId: auth.apiKeyId ?? undefined,
    createdByUserId: auth.userId ?? undefined,
    name,
    description,
    role,
    permissions,
    environment,
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
      projectId,
      name,
      role,
      environment,
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
