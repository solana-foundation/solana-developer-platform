import type { CreateApiKeyResponse } from "@sdp/types/api-keys";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { createTenantScope } from "@/lib/tenant-scope";
import { requireHumanActor } from "@/middleware/human-session";
import type { ValidatedBodyContext } from "@/middleware/validate";
import type { apiKeyCreateSchema } from "@/routes/api-keys/schemas";
import { resolveCreateWalletScope, walletScopeAuditMetadata } from "@/routes/api-keys/wallet-scope";
import { ApiKeyService } from "@/services/api-key.service";
import {
  assertApiKeyGrantsInReleaseChannel,
  assertGrantableApiKeyGrants,
  requestApiKeyGrantChannel,
} from "@/services/api-key-scope.service";
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

  const apiKeyService = new ApiKeyService(
    getDb(c.env),
    createTenantScope({
      organizationId: actor.organizationId,
      projectId,
    })
  );
  const apiKeys = await apiKeyService.listForProject(projectId);

  return success(c, {
    apiKeys: apiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      description: key.description,
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
  });
};

export const createProjectApiKey = async (c: ValidatedBodyContext<typeof apiKeyCreateSchema>) => {
  const { projectId } = c.req.param();
  const actor = requireHumanActor(c);

  const body = c.req.valid("json");

  await assertProjectAccess(c, actor, projectId);

  // Refused before anything is written; the service refuses them again.
  assertGrantableApiKeyGrants(actor.role, body.grants);
  assertApiKeyGrantsInReleaseChannel(requestApiKeyGrantChannel(c), body.grants);

  const walletScope = await resolveCreateWalletScope(
    c,
    { organizationId: actor.organizationId, projectId },
    body
  );

  const tenantScope = createTenantScope({
    organizationId: actor.organizationId,
    projectId,
  });
  // The key, its wallet list and its audit record commit together: if the audit
  // write fails nothing commits, and the secret is never returned.
  const createdKey = await new AuditService(getDb(c.env)).logWithin(c, async (txDb) => {
    const key = await new ApiKeyService(txDb, tenantScope).createApiKey({
      organizationId: actor.organizationId,
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
          projectId,
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
