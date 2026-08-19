import { SigningError } from "@sdp/custody/signing";
import type { ApiKeyRole, CreateApiKeyResponse } from "@sdp/types";
import type { Context } from "hono";
import { asTransactionalClient, getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { createTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { buildApiKeyAccessSummaries } from "@/routes/api-keys/access-response";
import type { apiKeyCreateSchema } from "@/routes/api-keys/schemas";
import { ApiKeyService } from "@/services/api-key.service";
import {
  resolveCreateWalletScope,
  resolveWalletBindingsInScope,
} from "@/services/api-key-scope.service";
import { provisionApiKeyWallet } from "@/services/api-key-wallet-provisioning.service";
import {
  type ExactApiKeyWalletBinding,
  replaceApiKeyWalletBindings,
} from "@/services/api-key-wallets.service";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import { assertApiKeyProjectAccess } from "../project-access";

type AppContext = Context<{ Bindings: Env }>;

async function assertProjectAccess(
  c: AppContext,
  auth: ReturnType<typeof getAuth>,
  projectId: string
): Promise<void> {
  assertApiKeyProjectAccess(auth, projectId);

  if (auth.authType === "api_key") {
    return;
  }

  if (!auth.userId) {
    throw notFound("Project");
  }

  const row = await getDb(c.env)
    .prepare(
      `SELECT 1 FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE pm.project_id = ? AND pm.user_id = ? AND p.organization_id = ? AND p.status = 'active'
       LIMIT 1`
    )
    .bind(projectId, auth.userId, auth.organizationId)
    .first();

  if (!row) {
    throw notFound("Project");
  }
}

export const listProjectApiKeys = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  await assertProjectAccess(c, auth, projectId);

  const db = getDb(c.env);
  const apiKeyService = new ApiKeyService(
    db,
    createTenantScope({
      organizationId: auth.organizationId,
      projectId,
    })
  );
  const apiKeys = await apiKeyService.listForProject(projectId);
  const accessSummaryByKeyId = await buildApiKeyAccessSummaries(
    c.env,
    db,
    createTenantScope({
      organizationId: auth.organizationId,
      projectId,
    }),
    apiKeys.map((key) => key.id)
  );

  return success(c, {
    apiKeys: apiKeys.map((key) => {
      const accessSummary = accessSummaryByKeyId.get(key.id);
      const walletBindings = accessSummary?.walletBindings ?? [];

      return {
        id: key.id,
        name: key.name,
        description: key.description,
        keyPrefix: key.keyPrefix,
        role: key.role as ApiKeyRole,
        environment: key.environment as "sandbox" | "production",
        status: key.status,
        walletScope: key.walletScope,
        signingWalletId: key.signingWalletId,
        signingWalletIds: walletBindings.map((binding) => binding.walletId),
        walletBindings,
        policyBindings: accessSummary?.policyBindings ?? [],
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      };
    }),
  });
};

export const createProjectApiKey = async (c: ValidatedBodyContext<typeof apiKeyCreateSchema>) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const body = c.req.valid("json");

  await assertProjectAccess(c, auth, projectId);

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
  } = body;

  const connectionId =
    typeof provisionWallet === "object" ? provisionWallet.connectionId : undefined;
  const provisionWalletRequested = Boolean(provisionWallet);

  const walletSelection = resolveCreateWalletScope({
    walletScope,
    signingWalletId,
    signingWalletIds,
    walletBindings,
    provisionWallet: provisionWalletRequested,
    connectionId,
  });

  let resolvedSigningWalletId: string | null = walletSelection.defaultSigningWalletId;
  let resolvedWalletBindings: ExactApiKeyWalletBinding[] = [];

  if (provisionWalletRequested) {
    if (!(auth.permissions.includes("*") || auth.permissions.includes("custody:admin"))) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "Required permissions: custody:admin");
    }

    try {
      const wallet = await provisionApiKeyWallet(getDb(c.env), c.env, {
        organizationId: auth.organizationId,
        projectId,
        legacyConfigProjectId: projectId,
        connectionId,
        label: walletLabel,
        purpose: walletPurpose,
      });
      resolvedSigningWalletId = wallet.walletId;
      resolvedWalletBindings = [
        { walletId: wallet.walletId, custodyWalletId: wallet.id, permissions: ["*"] },
      ];
    } catch (error) {
      if (error instanceof SigningError) {
        if (error.code === "NOT_FOUND") {
          throw new AppError("CONFLICT", error.message);
        }
        throw badRequest(error.message);
      }
      throw error;
    }
  } else {
    resolvedWalletBindings = await resolveWalletBindingsInScope(
      getDb(c.env),
      auth.organizationId,
      projectId,
      walletSelection.bindings
    );
  }

  const tenantScope = createTenantScope({
    organizationId: auth.organizationId,
    projectId,
  });
  const createdKey = await getDb(c.env).transaction(async (tx) => {
    const txDb = asTransactionalClient(tx);
    const key = await new ApiKeyService(txDb, tenantScope).createApiKey({
      organizationId: auth.organizationId,
      projectId,
      createdByKeyId: auth.apiKeyId ?? undefined,
      createdByUserId: auth.userId ?? undefined,
      actorPermissions: auth.permissions,
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
      await replaceApiKeyWalletBindings(txDb, key.id, resolvedWalletBindings);
    }
    return key;
  });

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
      environment: createdKey.environment,
      walletScope: resolvedWalletBindings.length > 0 ? "selected" : "all",
      signingWalletId: resolvedSigningWalletId,
      signingWalletIds: resolvedWalletBindings.map((binding) => binding.walletId),
      provisionedWallet: provisionWalletRequested,
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
