import { SigningError } from "@sdp/custody/signing";
import type { CreateApiKeyResponse } from "@sdp/types/api-keys";
import type { ApiKeyRole } from "@sdp/types/permissions";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { createTenantScope } from "@/lib/tenant-scope";
import { requireHumanActor } from "@/middleware/human-session";
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

type AppContext = Context<{ Bindings: Env }>;

/** The signed-in person must be a member of the active project. */
async function assertProjectAccess(
  c: AppContext,
  actor: { userId: string; organizationId: string },
  projectId: string
): Promise<void> {
  const row = await getDb(c.env)
    .prepare(
      `SELECT 1 FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE pm.project_id = ? AND pm.user_id = ? AND p.organization_id = ? AND p.status = 'active'
       LIMIT 1`
    )
    .bind(projectId, actor.userId, actor.organizationId)
    .first();

  if (!row) {
    throw notFound("Project");
  }
}

export const listProjectApiKeys = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const actor = requireHumanActor(c);

  await assertProjectAccess(c, actor, projectId);

  const db = getDb(c.env);
  const apiKeyService = new ApiKeyService(
    db,
    createTenantScope({
      organizationId: actor.organizationId,
      projectId,
    })
  );
  const apiKeys = await apiKeyService.listForProject(projectId);
  const accessSummaryByKeyId = await buildApiKeyAccessSummaries(
    db,
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
        allowedOperations: key.allowedOperations,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      };
    }),
  });
};

export const createProjectApiKey = async (c: ValidatedBodyContext<typeof apiKeyCreateSchema>) => {
  const { projectId } = c.req.param();
  const actor = requireHumanActor(c);

  const body = c.req.valid("json");

  await assertProjectAccess(c, actor, projectId);

  const {
    name,
    description,
    role = "api_developer",
    permissions,
    walletScope,
    allowedIps,
    allowedOperations,
    expiresAt,
    signingWalletId,
    signingWalletIds,
    walletBindings,
    provisionWallet,
    walletLabel,
    walletPurpose,
  } = body;

  const provisionWalletRequested = provisionWallet !== undefined;

  const walletSelection = resolveCreateWalletScope({
    walletScope,
    signingWalletId,
    signingWalletIds,
    walletBindings,
    provisionWallet: provisionWalletRequested,
  });

  let resolvedSigningWalletId: string | null = walletSelection.defaultSigningWalletId;
  let resolvedWalletBindings: ExactApiKeyWalletBinding[] = [];

  if (provisionWalletRequested) {
    if (!(actor.permissions.includes("*") || actor.permissions.includes("custody:admin"))) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "Required permissions: custody:admin");
    }

    try {
      const wallet = await provisionApiKeyWallet(getDb(c.env), c.env, {
        auditContext: c,
        creationReason: "api_key",
        organizationId: actor.organizationId,
        projectId,
        owner: provisionWallet,
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
      actor.organizationId,
      projectId,
      walletSelection.bindings
    );
  }

  const tenantScope = createTenantScope({
    organizationId: actor.organizationId,
    projectId,
  });
  // The key, its bindings and its audit record commit together: if the audit
  // write fails nothing commits, and the secret is never returned.
  const createdKey = await new AuditService(getDb(c.env)).logWithin(c, async (txDb) => {
    const key = await new ApiKeyService(txDb, tenantScope).createApiKey({
      organizationId: actor.organizationId,
      projectId,
      createdByUserId: actor.userId,
      actorPermissions: actor.permissions,
      name,
      description,
      role,
      permissions,
      allowedIps,
      allowedOperations,
      expiresAt,
      signingWalletId: resolvedSigningWalletId,
      pepper: c.env.API_KEY_PEPPER,
    });
    if (resolvedWalletBindings.length > 0) {
      await replaceApiKeyWalletBindings(txDb, key.id, resolvedWalletBindings);
    }
    return {
      result: key,
      entry: {
        action: "create",
        resourceType: "api_key",
        resourceId: key.id,
        metadata: {
          projectId,
          name,
          role,
          environment: key.environment,
          walletScope: resolvedWalletBindings.length > 0 ? "selected" : "all",
          signingWalletId: resolvedSigningWalletId,
          signingWalletIds: resolvedWalletBindings.map((binding) => binding.walletId),
          provisionedWallet: provisionWalletRequested,
        },
      },
    };
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
