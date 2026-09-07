import { SigningError } from "@sdp/custody/signing";
import type {
  ApiKeyRole,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  Permission,
  PolicyRule,
  RotateApiKeyResponse,
} from "@sdp/types";
import type { Context } from "hono";
import { asTransactionalClient, getDb } from "@/db";
import {
  createPolicyRepository,
  type UpsertApiKeyWalletPolicyBindingInput,
} from "@/db/repositories";
import {
  dropApiKeyCacheEntry,
  isApiKeyCacheWritable,
  refreshApiKeyCache,
} from "@/lib/api-key-cache";
import { requireProjectId } from "@/lib/auth";
import { AppError, badRequest, forbidden, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import { ApiKeyService, isApiKeyAlreadyRotated } from "@/services/api-key.service";
import {
  resolveCreateWalletScope,
  resolveUpdateWalletScope,
  resolveWalletBindingsInScope,
} from "@/services/api-key-scope.service";
import { provisionApiKeyWallet } from "@/services/api-key-wallet-provisioning.service";
import {
  type ExactApiKeyWalletBinding,
  replaceApiKeyWalletBindings,
} from "@/services/api-key-wallets.service";
import { AuditService } from "@/services/audit.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { ApiKeyPolicyStore } from "@/services/policy/api-key-policy.store";
import type { Env } from "@/types/env";
import { buildApiKeyAccessSummaries } from "./access-response";
import type {
  apiKeyControlProfileCreateSchema,
  apiKeyControlProfileRevisionCreateSchema,
  apiKeyCreateSchema,
  apiKeyPolicyBindingsWriteSchema,
  apiKeyRevokeSchema,
  apiKeyRotateSchema,
  apiKeyUpdateSchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

/**
 * A mutation must not report success while the cache may still serve the
 * pre-mutation authorization. refreshApiKeyCache returns false when CAS
 * contention left a possibly-stale trusted entry in the slot; retry with
 * backoff, and if it never converges surface a retriable failure — the DB
 * mutation is already committed, so the caller re-issues the request rather
 * than trusting a success that silently kept the old cached authorization.
 */
async function ensureApiKeyCacheRefreshed(
  db: DatabaseClient,
  kv: Parameters<typeof refreshApiKeyCache>[1],
  keyHash: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
    if (await refreshApiKeyCache(db, kv, keyHash)) {
      return;
    }
  }
  throw new AppError(
    "INTERNAL_ERROR",
    "The change was saved but the key's cached authorization could not be refreshed yet; retry the request"
  );
}

/**
 * Best-effort variant for rotation, the one mutation that must NOT fail the
 * request over this write: the replacement key's one-time secret is already
 * committed and exists only in the pending response, so a 500 here pushes
 * the caller into rotating again — minting a second live credential while
 * the first one's secret is lost.
 *
 * Retries absorb transient failures. When they are exhausted the slot may
 * still hold the pre-rotation entry, whose `rotationDeadline: null` would let
 * the old secret reach protected endpoints past the deadline Postgres now
 * carries — and with `gracePeriodHours: 0` that deadline is immediate. So the
 * entry is dropped instead of left standing: the next request misses and
 * re-reads the real deadline, rather than waiting on the reconciliation
 * sweep. Only when that also fails is the sweep the remaining path.
 */
async function tryRefreshApiKeyCache(
  db: DatabaseClient,
  kv: Parameters<typeof refreshApiKeyCache>[1],
  keyHash: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
    try {
      if (await refreshApiKeyCache(db, kv, keyHash)) {
        return true;
      }
    } catch {
      // Thrown store errors retry like lost CAS rounds; the drop below and
      // then the sweep are the remaining paths if the store stays down.
    }
  }

  try {
    await dropApiKeyCacheEntry(kv, keyHash);
    return true;
  } catch {
    return false;
  }
}

/**
 * Undo a committed rotation whose cache invalidation failed, putting Postgres
 * back into the state the stale cached entry already describes.
 *
 * This is the last repair that does not need the cache, so it retries rather
 * than settling for the one outcome nothing can fix: Postgres carrying a
 * rotation deadline the cache does not know about, which lets the old secret
 * authenticate past it. A single attempt would concede that on a dropped
 * connection or a lock timeout — far likelier than an outage lasting the whole
 * window. The undo is idempotent (clear the deadline, revoke the replacement),
 * so a retry after a partial-looking failure is safe.
 *
 * Failing every attempt means neither store accepts writes. Nothing can then
 * record the deadline anywhere the reader looks — not this handler, and not
 * the reconciliation sweep, which writes to the same cache — so the caller is
 * told which key to revoke by hand.
 */
async function tryUndoRotation(
  apiKeyService: ApiKeyService,
  keyId: string,
  replacementKeyId: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
    try {
      await apiKeyService.undoRotation(keyId, replacementKeyId);
      return true;
    } catch (error) {
      getLogger().error(
        { error, keyId, replacementKeyId, attempt },
        "Rotation rollback attempt failed"
      );
    }
  }
  return false;
}

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

  const db = getDb(c.env);
  const apiKeyService = new ApiKeyService(db, getRequestTenantScope(c));
  const apiKeys = await apiKeyService.listForProject(projectId);
  const accessSummaryByKeyId = await buildApiKeyAccessSummaries(
    c.env,
    db,
    getRequestTenantScope(c),
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
  };

  return success(c, response);
};

export const createApiKey = async (c: ValidatedBodyContext<typeof apiKeyCreateSchema>) => {
  const actor = resolveActor(c);
  const orgId = actor.organizationId;

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
  } = c.req.valid("json");

  const connectionId =
    typeof provisionWallet === "object" ? provisionWallet.connectionId : undefined;
  const provisionWalletRequested = Boolean(provisionWallet);

  const projectId = requireProjectId(c);

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
    if (!(actor.permissions.includes("*") || actor.permissions.includes("custody:admin"))) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "Required permissions: custody:admin");
    }

    try {
      const wallet = await provisionApiKeyWallet(getDb(c.env), c.env, {
        organizationId: actor.organizationId,
        projectId,
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
      orgId,
      projectId,
      walletSelection.bindings
    );
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

  const db = getDb(c.env);
  const createdKey = await db.transaction(async (tx) => {
    const txDb = asTransactionalClient(tx);
    const key = await new ApiKeyService(txDb, getRequestTenantScope(c)).createApiKey({
      organizationId: orgId,
      projectId,
      createdByUserId: createdBy,
      createdByKeyId: actor.apiKeyId ?? undefined,
      actorPermissions: actor.permissions,
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

export const getApiKey = async (c: AppContext) => {
  const { keyId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  const apiKeyService = new ApiKeyService(getDb(c.env), getRequestTenantScope(c));
  const key = await apiKeyService.getDetails(keyId, actor.organizationId, projectId);

  if (!key) {
    throw notFound("API key");
  }

  const accessSummaryByKeyId = await buildApiKeyAccessSummaries(
    c.env,
    getDb(c.env),
    getRequestTenantScope(c),
    [key.id]
  );
  const accessSummary = accessSummaryByKeyId.get(key.id);
  const walletBindings = accessSummary?.walletBindings ?? [];

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
    walletScope: key.walletScope,
    signingWalletId: key.signingWalletId,
    signingWalletIds: walletBindings.map((binding) => binding.walletId),
    walletBindings,
    policyBindings: accessSummary?.policyBindings ?? [],
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
      "SELECT id, key_hash, project_id, role FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?"
    )
    .bind(keyId, actor.organizationId, projectId)
    .first<{ id: string; key_hash: string; project_id: string; role: ApiKeyRole }>();

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

  await getDb(c.env).transaction(async (tx) => {
    const txDb = asTransactionalClient(tx);
    await new ApiKeyService(txDb, getRequestTenantScope(c)).updateApiKey({
      keyId,
      organizationId: actor.organizationId,
      projectId,
      actorPermissions: actor.permissions,
      currentRole: existing.role,
      name: body.name,
      description: body.description,
      allowedIps: body.allowedIps,
      expiresAt: body.expiresAt,
      permissions: body.permissions,
      signingWallet: walletSelection.touched
        ? { walletId: walletSelection.defaultSigningWalletId }
        : undefined,
    });
    if (walletSelection.touched) {
      await replaceApiKeyWalletBindings(txDb, keyId, resolvedWalletBindings);
    }
  });

  // Refresh cache if auth-relevant fields changed. expiresAt matters too:
  // the middleware enforces expiration from the cached entry, so a stale one
  // would honor the old deadline for the full cache TTL. Refresh, never
  // delete: an emptied slot invites an in-flight stale fill to repopulate it.
  if (
    body.allowedIps !== undefined ||
    body.permissions !== undefined ||
    body.expiresAt !== undefined ||
    walletSelection.touched
  ) {
    await ensureApiKeyCacheRefreshed(getDb(c.env), c.var.kv.apiKeys, existing.key_hash);
  }

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: body,
  });

  return success(c, { success: true });
};

export const createApiKeyControlProfile = async (
  c: ValidatedBodyContext<typeof apiKeyControlProfileCreateSchema>
) => {
  const { keyId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const profile = await new ApiKeyPolicyStore(
    createPolicyRepository(c.env, getRequestTenantScope(c))
  ).createApiKeyControlProfile({
    organizationId: actor.organizationId,
    projectId,
    apiKeyId: keyId,
    name: body.name,
    createdBy: actor.userId ?? actor.apiKeyId,
  });

  await new AuditService(getDb(c.env)).log(c, {
    action: "create",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: { action: "create_control_profile", profileId: profile.id, name: profile.name },
  });

  return created(c, { profile });
};

export const createApiKeyControlProfileRevision = async (
  c: ValidatedBodyContext<typeof apiKeyControlProfileRevisionCreateSchema>
) => {
  const { keyId, profileId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const revision = await new ApiKeyPolicyStore(
    createPolicyRepository(c.env, getRequestTenantScope(c))
  ).createApiKeyControlProfileRevision({
    organizationId: actor.organizationId,
    projectId,
    apiKeyId: keyId,
    profileId,
    rules: body.rules as PolicyRule[],
    defaultAction: body.defaultAction,
    createdBy: actor.userId ?? actor.apiKeyId,
  });

  await new AuditService(getDb(c.env)).log(c, {
    action: "create",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: {
      action: "create_control_profile_revision",
      profileId,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
    },
  });

  return created(c, { revision });
};

export const activateApiKeyControlProfileRevision = async (c: AppContext) => {
  const { keyId, profileId, revisionId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);
  const active = await new ApiKeyPolicyStore(
    createPolicyRepository(c.env, getRequestTenantScope(c))
  ).activateApiKeyControlProfileRevision({
    organizationId: actor.organizationId,
    projectId,
    apiKeyId: keyId,
    profileId,
    revisionId,
  });

  await new AuditService(getDb(c.env)).log(c, {
    action: "update",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: { action: "activate_control_profile_revision", profileId, revisionId },
  });

  return success(c, active);
};

export const writeApiKeyPolicyBindings = async (
  c: ValidatedBodyContext<typeof apiKeyPolicyBindingsWriteSchema>
) => {
  const { keyId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const custodyTargets = new CustodyRuntimeTargets(getDb(c.env), c.env, new Map());
  const bindings: UpsertApiKeyWalletPolicyBindingInput[] =
    body.mode === "replace"
      ? await Promise.all(
          body.bindings.map(async (binding) => {
            if (binding.bindingScope === "all") {
              return { apiKeyId: keyId, ...binding };
            }

            const wallet = await custodyTargets.findOperationalWallet({
              organizationId: actor.organizationId,
              projectId,
              walletId: binding.walletId,
            });
            if (!wallet) {
              throw forbidden("API key is not authorized for the requested wallet");
            }
            return {
              apiKeyId: keyId,
              ...binding,
              walletId: wallet.walletId,
              custodyWalletId: wallet.id,
            };
          })
        )
      : [];

  await new ApiKeyPolicyStore(
    createPolicyRepository(c.env, getRequestTenantScope(c))
  ).replaceApiKeyWalletPolicyBindings({
    organizationId: actor.organizationId,
    projectId,
    apiKeyId: keyId,
    bindings,
  });

  const accessSummary = (
    await buildApiKeyAccessSummaries(c.env, getDb(c.env), getRequestTenantScope(c), [keyId])
  ).get(keyId);
  const policyBindings = accessSummary?.policyBindings ?? [];

  await new AuditService(getDb(c.env)).log(c, {
    action: "update",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: {
      action: `${body.mode}_policy_bindings`,
      bindingCount: policyBindings.length,
    },
  });

  return success(c, { policyBindings });
};

export const rotateApiKey = async (c: ValidatedBodyContext<typeof apiKeyRotateSchema>) => {
  const { keyId } = c.req.param();
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  // Prevent rotating the key being used
  if (actor.apiKeyId && keyId === actor.apiKeyId) {
    throw badRequest("Cannot rotate the API key being used for this request");
  }

  const body = c.req.valid("json");
  const gracePeriodHours = body.gracePeriodHours ?? 24;

  // Checked BEFORE anything commits. Once the rotation lands, the old key's
  // cached entry must be invalidated or it keeps authorizing past its new
  // deadline — and every recovery path (the refresh, the fallback drop, the
  // reconciliation sweep) writes to this same store, so none of them can
  // help if it is refusing writes. Rotation cannot be rolled back, cannot
  // fail its response, and cannot be retried, so the only safe answer to an
  // unwritable cache is to not start.
  if (!(await isApiKeyCacheWritable(c.var.kv.apiKeys))) {
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "Rotation is unavailable right now because cached credentials cannot be invalidated; nothing was changed, so retry shortly"
    );
  }

  const apiKeyService = new ApiKeyService(getDb(c.env), getRequestTenantScope(c));
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

  // Post-commit: the replacement exists and its secret lives only in the
  // response below, so this must not simply throw — a 500 here would lose
  // that secret. The pre-commit probe rules out a store that is already
  // down, but it cannot stop one from failing in the window that follows.
  const oldKeyCacheRefreshed = await tryRefreshApiKeyCache(
    getDb(c.env),
    c.var.kv.apiKeys,
    rotation.previousKeyHash
  );

  if (!oldKeyCacheRefreshed) {
    // The cache kept the pre-rotation entry: active, no deadline. Returning
    // the secret now would leave the old key usable past the deadline
    // Postgres carries, with every repair path blocked on the same store.
    // Undo instead — put Postgres back into the state that stale entry
    // already describes, so nothing is left inconsistent with it.
    if (await tryUndoRotation(apiKeyService, keyId, rotation.apiKey.id)) {
      getLogger().error(
        { keyId, newKeyId: rotation.apiKey.id },
        "Rotated key cache entry could not be refreshed or dropped; rotation rolled back"
      );
      throw new AppError(
        "SERVICE_UNAVAILABLE",
        "Rotation was rolled back because cached credentials could not be invalidated; nothing was changed, so retry shortly"
      );
    }

    // Neither store accepted writes, so the rotation stands with a cached
    // entry that still reports no deadline. Nothing here can repair that —
    // the sweep writes to the same cache — so name the key an operator has
    // to revoke by hand rather than imply an automatic recovery.
    getLogger().error(
      { keyId, newKeyId: rotation.apiKey.id },
      "Rotated key cache entry could not be invalidated and every rollback attempt failed; the old secret authenticates until the cache accepts writes or its entry expires"
    );
    throw new AppError(
      "INTERNAL_ERROR",
      `Rotation committed but cached credentials could not be invalidated and the rollback failed. The replacement key is ${rotation.apiKey.id}; revoke it and retry, as its secret was not delivered.`
    );
  }

  try {
    await new AuditService(getDb(c.env)).log(c, {
      action: "update",
      resourceType: "api_key",
      resourceId: keyId,
      metadata: { action: "rotate", newKeyId: rotation.apiKey.id, gracePeriodHours },
    });
  } catch (error) {
    getLogger().error(
      { error, keyId, newKeyId: rotation.apiKey.id },
      "Failed to audit an API key rotation that already committed"
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

  // Prevent revoking your own key
  if (actor.apiKeyId && keyId === actor.apiKeyId) {
    throw badRequest("Cannot revoke the API key being used for this request");
  }

  const { confirmation } = c.req.valid("json");

  const existing = await getDb(c.env)
    .prepare(
      "SELECT id, name, key_hash, status, revoked_at FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?"
    )
    .bind(keyId, actor.organizationId, projectId)
    .first<{
      id: string;
      name: string;
      key_hash: string;
      status: string;
      revoked_at: string | null;
    }>();

  if (!existing) {
    throw notFound("API key");
  }

  if (existing.status === "deactivated" || existing.status === "revoked") {
    // Already revoked in Postgres, but the cache may still say otherwise
    // (e.g. the earlier revocation crashed between the DB write and the
    // cache write). Re-assert before reporting success.
    await ensureApiKeyCacheRefreshed(getDb(c.env), c.var.kv.apiKeys, existing.key_hash);
    return success(c, {
      success: true,
      revokedAt: existing.revoked_at ?? new Date().toISOString(),
    });
  }

  if (!confirmation) {
    throw badRequest("Confirmation is required to deactivate an API key");
  }

  if (confirmation !== existing.name) {
    throw badRequest("Confirmation did not match the key name");
  }

  const apiKeyService = new ApiKeyService(getDb(c.env), getRequestTenantScope(c));
  const revokedKey = await apiKeyService.revokeApiKey(keyId, actor.organizationId, projectId);

  if (!revokedKey) {
    throw notFound("API key");
  }

  // Overwrite the cache with the revoked state before reporting success.
  // A plain delete would leave a window where an in-flight fill from a
  // pre-revocation DB read repopulates the entry for the full cache TTL.
  await ensureApiKeyCacheRefreshed(getDb(c.env), c.var.kv.apiKeys, revokedKey.keyHash);

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
