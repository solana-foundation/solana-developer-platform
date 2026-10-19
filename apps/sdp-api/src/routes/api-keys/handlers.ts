import { SigningError } from "@sdp/custody/signing";
import type {
  CreateApiKeyResponse,
  ListApiKeysResponse,
  RotateApiKeyResponse,
} from "@sdp/types/api-keys";
import type { OrganizationRole } from "@sdp/types/permissions";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { requireProjectId } from "@/lib/auth";
import { AppError, badRequest, internalError, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { requireHumanActor } from "@/middleware/human-session";
import { callerMayPerform } from "@/middleware/require-action";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import { ApiKeyService, isApiKeyAlreadyRotated } from "@/services/api-key.service";
import {
  assertApiKeyGrantsInReleaseChannel,
  assertGrantableApiKeyGrants,
  requestApiKeyGrantChannel,
  resolveCreateWalletScope,
  resolveUpdateWalletScope,
  resolveWalletBindingsInScope,
} from "@/services/api-key-scope.service";
import { provisionApiKeyWallet } from "@/services/api-key-wallet-provisioning.service";
import {
  type ExactApiKeyWalletBinding,
  replaceApiKeyWalletBindings,
} from "@/services/api-key-wallets.service";
import { type AuditLogEntry, AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import { buildApiKeyAccessSummaries } from "./access-response";
import type {
  apiKeyCreateSchema,
  apiKeyRevokeSchema,
  apiKeyRotateSchema,
  apiKeyUpdateSchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

/** The signed-in person managing keys; the router refuses API keys first. */
function resolveActor(c: AppContext): {
  organizationId: string;
  role: OrganizationRole;
  userId: string;
} {
  const clerk = requireHumanActor(c);
  return {
    organizationId: clerk.organizationId,
    role: clerk.role,
    userId: clerk.userId,
  };
}

/**
 * Audit a reduction of authority that has already committed. The reduction
 * must not depend on the ledger or Redis being healthy, so a failed write is
 * logged as `sdp_audit_reduction_unaudited` for operators instead of failing
 * the request.
 */
async function logReductionBestEffort(c: AppContext, entry: AuditLogEntry): Promise<void> {
  try {
    await new AuditService(getDb(c.env)).log(c, entry);
  } catch (error) {
    getLogger().error(
      {
        event: "sdp_audit_reduction_unaudited",
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        error,
      },
      "A committed reduction of authority could not be audited"
    );
  }
}

export const listApiKeys = async (c: AppContext) => {
  resolveActor(c);
  const projectId = requireProjectId(c);

  const db = getDb(c.env);
  const apiKeyService = new ApiKeyService(db, getRequestTenantScope(c));
  const apiKeys = await apiKeyService.listForProject(projectId);
  const accessSummaryByKeyId = await buildApiKeyAccessSummaries(
    db,
    apiKeys.map((key) => key.id)
  );

  const response: ListApiKeysResponse = {
    apiKeys: apiKeys.map((key) => {
      const accessSummary = accessSummaryByKeyId.get(key.id);
      const walletBindings = accessSummary?.walletBindings ?? [];

      return {
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        grants: key.grants,
        environment: key.environment as "sandbox" | "production",
        status: key.status,
        walletScope: key.walletScope,
        signingWalletId: key.signingWalletId,
        signingWalletIds: walletBindings.map((binding) => binding.walletId),
        walletBindings,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      };
    }),
  };

  return success(c, response);
};

export const createApiKey = async (c: ValidatedBodyContext<typeof apiKeyCreateSchema>) => {
  const actor = resolveActor(c);
  const orgId = actor.organizationId;

  const {
    name,
    description,
    grants,
    walletScope,
    allowedIps,
    expiresAt,
    signingWalletId,
    signingWalletIds,
    walletBindings,
    provisionWallet,
    walletLabel,
    walletPurpose,
  } = c.req.valid("json");

  // Refused before any wallet is provisioned; the service refuses them again.
  assertGrantableApiKeyGrants(actor.role, grants);
  assertApiKeyGrantsInReleaseChannel(requestApiKeyGrantChannel(c), grants);

  const provisionWalletRequested = provisionWallet !== undefined;

  const projectId = requireProjectId(c);

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
    // Provisioning creates a custody wallet, which is wallet lifecycle.
    if (!callerMayPerform(c, "wallets.manage")) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "Missing action: wallets.manage", {
        action: "wallets.manage",
      });
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
      orgId,
      projectId,
      walletSelection.bindings
    );
  }

  // The key, its bindings and its audit record commit together: if the audit
  // write fails nothing commits, and the secret is never returned.
  const createdKey = await new AuditService(getDb(c.env)).logWithin(c, async (txDb) => {
    const key = await new ApiKeyService(txDb, getRequestTenantScope(c)).createApiKey({
      organizationId: orgId,
      projectId,
      createdByUserId: actor.userId,
      actorRole: actor.role,
      grantChannel: requestApiKeyGrantChannel(c),
      name,
      description,
      grants,
      allowedIps,
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
          name,
          grants: key.grants,
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
      grants: createdKey.grants,
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

  const apiKeyService = new ApiKeyService(getDb(c.env), getRequestTenantScope(c));
  const key = await apiKeyService.getDetails(keyId, actor.organizationId, projectId);

  if (!key) {
    throw notFound("API key");
  }

  const accessSummaryByKeyId = await buildApiKeyAccessSummaries(getDb(c.env), [key.id]);
  const accessSummary = accessSummaryByKeyId.get(key.id);
  const walletBindings = accessSummary?.walletBindings ?? [];

  return success(c, {
    id: key.id,
    name: key.name,
    description: key.description,
    keyPrefix: key.keyPrefix,
    grants: key.grants,
    environment: key.environment,
    status: key.status,
    projectId: key.projectId,
    allowedIps: key.allowedIps,
    walletScope: key.walletScope,
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

export const updateApiKey = async (c: ValidatedBodyContext<typeof apiKeyUpdateSchema>) => {
  const { keyId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  const body = c.req.valid("json");

  // Verify key belongs to this organization and the current project scope
  const existing = await getDb(c.env)
    .prepare(
      "SELECT id, project_id FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?"
    )
    .bind(keyId, actor.organizationId, projectId)
    .first<{ id: string; project_id: string }>();

  if (!existing) {
    throw notFound("API key");
  }

  const walletSelection = resolveUpdateWalletScope({
    walletScope: body.walletScope,
    signingWalletId: body.signingWalletId,
    signingWalletIds: body.signingWalletIds,
    walletBindings: body.walletBindings,
  });

  let resolvedWalletBindings: ExactApiKeyWalletBinding[] = [];

  if (walletSelection.touched) {
    resolvedWalletBindings = await resolveWalletBindingsInScope(
      getDb(c.env),
      actor.organizationId,
      existing.project_id,
      walletSelection.bindings
    );
  }

  // The change and its audit record commit together.
  await new AuditService(getDb(c.env)).logWithin(c, async (txDb) => {
    await new ApiKeyService(txDb, getRequestTenantScope(c)).updateApiKey({
      keyId,
      organizationId: actor.organizationId,
      projectId,
      actorRole: actor.role,
      grantChannel: requestApiKeyGrantChannel(c),
      name: body.name,
      description: body.description,
      grants: body.grants,
      allowedIps: body.allowedIps,
      expiresAt: body.expiresAt,
      signingWallet: walletSelection.touched
        ? { walletId: walletSelection.defaultSigningWalletId }
        : undefined,
    });
    if (walletSelection.touched) {
      await replaceApiKeyWalletBindings(txDb, keyId, resolvedWalletBindings);
    }
    return {
      result: undefined,
      entry: { action: "update", resourceType: "api_key", resourceId: keyId, metadata: body },
    };
  });

  return success(c, { success: true });
};

export const rotateApiKey = async (c: ValidatedBodyContext<typeof apiKeyRotateSchema>) => {
  const { keyId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  const body = c.req.valid("json");
  const gracePeriodHours = body.gracePeriodHours ?? 24;

  // The replacement, the target's deadline and the audit record commit
  // together: if the audit write fails nothing commits, and the new secret is
  // never returned (APE-418).
  const rotation = await new AuditService(getDb(c.env)).logWithin(c, async (txDb) => {
    const result = await new ApiKeyService(txDb, getRequestTenantScope(c)).rotateApiKey(
      keyId,
      actor.organizationId,
      projectId,
      gracePeriodHours,
      actor.role,
      c.env.API_KEY_PEPPER
    );
    return {
      result,
      entry:
        result === null || isApiKeyAlreadyRotated(result)
          ? null
          : {
              action: "update",
              resourceType: "api_key",
              resourceId: keyId,
              metadata: {
                action: "rotate",
                newKeyId: result.apiKey.id,
                gracePeriodHours,
                rotationDeadline: result.previousKey.rotationDeadline,
              },
            },
    };
  });

  if (!rotation) {
    throw notFound("API key");
  }

  if (isApiKeyAlreadyRotated(rotation)) {
    // A live replacement already exists, so an earlier attempt committed
    // one. Its secret was delivered only in that attempt's response, so
    // minting a second key here would leave a live credential nobody holds
    // — name the replacement instead and let the caller decide.
    throw new AppError(
      "CONFLICT",
      `This API key was already rotated; its replacement is ${rotation.alreadyRotatedTo}. Revoke that key and rotate again if its secret was never received.`
    );
  }

  const response: RotateApiKeyResponse = {
    apiKey: rotation.apiKey,
    previousKey: rotation.previousKey,
  };

  return created(c, response);
};

export const revokeApiKey = async (c: ValidatedBodyContext<typeof apiKeyRevokeSchema>) => {
  const { keyId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  const { confirmation } = c.req.valid("json");

  const existing = await getDb(c.env)
    .prepare(
      "SELECT id, name, status, revoked_at FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?"
    )
    .bind(keyId, actor.organizationId, projectId)
    .first<{
      id: string;
      name: string;
      status: string;
      revoked_at: string | null;
    }>();

  if (!existing) {
    throw notFound("API key");
  }

  if (existing.status === "deactivated" || existing.status === "revoked") {
    if (existing.revoked_at === null) {
      throw internalError("A deactivated API key has no revocation time");
    }
    return success(c, { success: true, revokedAt: existing.revoked_at });
  }

  if (!confirmation) {
    throw badRequest("Confirmation is required to deactivate an API key");
  }

  if (confirmation !== existing.name) {
    throw badRequest("Confirmation did not match the key name");
  }

  // A reduction of authority commits first and never waits on the audit
  // ledger or Redis: a key must stay revocable while either is down. Grants
  // (create, rotate, update) keep their record in the same transaction and
  // fail closed; this record is best-effort and a failure is logged loudly.
  const revokedKey = await new ApiKeyService(getDb(c.env), getRequestTenantScope(c)).revokeApiKey(
    keyId,
    actor.organizationId,
    projectId
  );
  if (revokedKey && !revokedKey.alreadyRevoked) {
    await logReductionBestEffort(c, {
      action: "delete",
      resourceType: "api_key",
      resourceId: keyId,
      metadata: { action: "deactivate" },
    });
  }

  if (!revokedKey) {
    throw notFound("API key");
  }

  return success(c, {
    success: true,
    revokedAt: revokedKey.revokedAt,
  });
};
