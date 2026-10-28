import type {
  CreateApiKeyResponse,
  ListApiKeysResponse,
  RotateApiKeyResponse,
} from "@sdp/types/api-keys";
import type { OrganizationRole } from "@sdp/types/roles";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { requireProjectId } from "@/lib/auth";
import { AppError, badRequest, internalError, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { requireHumanActor } from "@/middleware/human-session";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { resolveCreateWalletScope } from "@/routes/api-keys/wallet-scope";
import { getLogger } from "@/runtime/logger";
import { ApiKeyService, isApiKeyAlreadyRotated } from "@/services/api-key.service";
import {
  assertApiKeyGrantsInReleaseChannel,
  assertGrantableApiKeyGrants,
  parseRequestedWalletScope,
  requestApiKeyGrantChannel,
  resolveSigningWalletsInProject,
} from "@/services/api-key-scope.service";
import { type AuditLogEntry, AuditService } from "@/services/audit.service";
import {
  type CancelActivatedByKeyResult,
  cancelRecurringPaymentsActivatedByKey,
} from "@/services/payments/recurring-payments/cancel-activated-by-key";
import type { Env } from "@/types/env";
import type {
  apiKeyCreateSchema,
  apiKeyRevokeSchema,
  apiKeyRotateSchema,
  apiKeyUpdateSchema,
} from "./schemas";
import { walletScopeAuditMetadata } from "./wallet-scope";

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

  const apiKeyService = new ApiKeyService(getDb(c.env), getRequestTenantScope(c));
  const apiKeys = await apiKeyService.listForProject(projectId);

  const response: ListApiKeysResponse = {
    apiKeys: apiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      grants: key.grants,
      environment: key.environment,
      status: key.status,
      walletScope: key.walletScope,
      walletIds: key.walletIds,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      rotationDeadline: key.rotationDeadline,
      createdAt: key.createdAt,
    })),
  };

  return success(c, response);
};

export const createApiKey = async (c: ValidatedBodyContext<typeof apiKeyCreateSchema>) => {
  const actor = resolveActor(c);
  const orgId = actor.organizationId;

  const body = c.req.valid("json");

  // Refused before anything is written; the service refuses them again.
  assertGrantableApiKeyGrants(actor.role, body.grants);
  assertApiKeyGrantsInReleaseChannel(requestApiKeyGrantChannel(c), body.grants);

  const projectId = requireProjectId(c);
  const walletScope = await resolveCreateWalletScope(
    c,
    { organizationId: actor.organizationId, projectId },
    body
  );

  // The key, its wallet list and its audit record commit together: if the
  // audit write fails nothing commits, and the secret is never returned.
  const createdKey = await new AuditService(getDb(c.env)).logWithin(c, async (txDb) => {
    const key = await new ApiKeyService(txDb, getRequestTenantScope(c)).createApiKey({
      organizationId: orgId,
      projectId,
      createdByUserId: actor.userId,
      actorRole: actor.role,
      grantChannel: requestApiKeyGrantChannel(c),
      name: body.name,
      description: body.description,
      grants: body.grants,
      allowedIps: body.allowedIps,
      expiresAt: body.expiresAt,
      walletScope,
      pepper: c.env.API_KEY_PEPPER,
    });
    return {
      result: key,
      entry: {
        action: "create",
        resourceType: "api_key",
        resourceId: key.id,
        metadata: {
          name: body.name,
          grants: key.grants,
          environment: key.environment,
          ...walletScopeAuditMetadata(walletScope),
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
    walletIds: key.walletIds,
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

  const requestedWalletScope = parseRequestedWalletScope({
    walletScope: body.walletScope,
    walletIds: body.walletIds,
  });
  const walletScope =
    requestedWalletScope === undefined
      ? undefined
      : await resolveSigningWalletsInProject(
          getDb(c.env),
          { organizationId: actor.organizationId, projectId: existing.project_id },
          requestedWalletScope
        );

  // The change, the key's wallet list and its audit record commit together.
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
      walletScope,
    });
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

  const { confirmation, cancelRecurringPayments } = c.req.valid("json");

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
    return success(c, {
      success: true,
      revokedAt: existing.revoked_at,
      recurringPayments: await cancelActivatedRecurringPayments(c, cancelRecurringPayments, keyId),
    });
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
    recurringPayments: await cancelActivatedRecurringPayments(c, cancelRecurringPayments, keyId),
  });
};

/**
 * After the revocation committed, and only when asked: cancel the recurring
 * payments the key activated (APE-343). Each cancel is audited by its own
 * lifecycle; a failure is reported, never undoes the revocation.
 */
async function cancelActivatedRecurringPayments(
  c: AppContext,
  requested: boolean | undefined,
  apiKeyId: string
): Promise<CancelActivatedByKeyResult | null> {
  if (requested !== true) {
    return null;
  }
  const recurringPayments = await cancelRecurringPaymentsActivatedByKey(c.env, {
    organizationId: requireHumanActor(c).organizationId,
    projectId: requireProjectId(c),
    apiKeyId,
  });
  await logReductionBestEffort(c, {
    action: "update",
    resourceType: "api_key",
    resourceId: apiKeyId,
    metadata: { action: "cancel_recurring_payments", ...recurringPayments },
  });
  return recurringPayments;
}
