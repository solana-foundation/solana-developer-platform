import type { Permission } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";
import type { PolicyRepository, WalletOperationRow } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

const REPLAY_HEADER = "x-sdp-approved-operation-replay";
const capabilities = new Map<string, { operationId: string; path: string }>();

export interface WalletOperationExecutionRequest {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
}

export function walletOperationExecutionRequest(
  c: Context<{ Bindings: Env }>,
  body: Record<string, unknown>
): WalletOperationExecutionRequest {
  return {
    method: "POST",
    path: c.req.path,
    body,
    idempotencyKey: c.req.header("Idempotency-Key") ?? `approval-${crypto.randomUUID()}`,
  };
}

export function approvedWalletOperationId(c: Context<{ Bindings: Env }>): string | undefined {
  return c.get("approvedWalletOperationId");
}

export async function tryApprovedOperationReplayAuth(
  c: Context<{ Bindings: Env }>
): Promise<boolean> {
  const token = c.req.header(REPLAY_HEADER);
  if (!token) {
    return false;
  }

  const capability = capabilities.get(token);
  capabilities.delete(token);
  if (!capability || capability.path !== c.req.path) {
    throw new AppError("UNAUTHORIZED", "Invalid approved-operation replay capability");
  }

  const db = getDb(c.env);
  const operation = await db
    .prepare(
      `SELECT * FROM wallet_operations
       WHERE id = ? AND status = 'executing' AND execution_started_at IS NOT NULL`
    )
    .bind(capability.operationId)
    .first<Record<string, unknown>>();
  if (!operation) {
    throw new AppError("FORBIDDEN", "Approved wallet operation is not executable");
  }

  const organizationId = operation.organization_id as string;
  const projectId = (operation.project_id as string | null | undefined) ?? null;
  const apiKeyId = (operation.api_key_id as string | null | undefined) ?? null;
  const rawPayload = parsePostgresJsonOr<Record<string, unknown>>(operation.raw_payload, {});
  const actor = isObject(rawPayload.actor) ? rawPayload.actor : null;

  if (apiKeyId) {
    const apiKey = await loadActiveApiKey(db, apiKeyId, organizationId, projectId);
    c.set("apiKey", apiKey);
  } else {
    const userId =
      actor && typeof actor.userId === "string"
        ? actor.userId
        : actor && typeof actor.id === "string"
          ? actor.id
          : null;
    if (!userId) {
      throw new AppError("FORBIDDEN", "Original wallet-operation actor is unavailable");
    }
    const membership = await db
      .prepare(
        `SELECT om.role
         FROM organization_members om
         INNER JOIN users u ON u.id = om.user_id
         WHERE om.organization_id = ? AND om.user_id = ?
           AND om.status = 'active' AND u.status = 'active'
         LIMIT 1`
      )
      .bind(organizationId, userId)
      .first<{ role: string }>();
    if (!membership) {
      throw new AppError("FORBIDDEN", "Original wallet-operation actor is no longer authorized");
    }
    const { getPermissionsForOrgRole } = await import("@sdp/types");
    c.set("session", {
      id: `approved-operation:${capability.operationId}`,
      userId,
      organizationId,
      permissions: getPermissionsForOrgRole(membership.role),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  c.set("approvedWalletOperationId", capability.operationId);
  return true;
}

async function loadActiveApiKey(
  db: DatabaseClient,
  apiKeyId: string,
  organizationId: string,
  projectId: string | null
) {
  const row = await db
    .prepare(
      `SELECT ak.id, ak.organization_id, ak.project_id, ak.role, ak.permissions,
              p.environment, ak.signing_wallet_id, ak.status, ak.expires_at,
              ak.rotation_deadline
       FROM api_keys ak
       INNER JOIN projects p ON p.id = ak.project_id
       WHERE ak.id = ? AND ak.organization_id = ? AND ak.project_id IS NOT DISTINCT FROM ?`
    )
    .bind(apiKeyId, organizationId, projectId)
    .first<Record<string, unknown>>();
  if (row?.status !== "active") {
    throw new AppError("FORBIDDEN", "Original API key is no longer active");
  }
  for (const deadline of [row.expires_at, row.rotation_deadline]) {
    if (typeof deadline === "string" && new Date(deadline) <= new Date()) {
      throw new AppError("FORBIDDEN", "Original API key is no longer valid");
    }
  }

  const bindings = await db
    .prepare(
      `SELECT wallet_id, permissions FROM api_key_wallet_permissions
       WHERE api_key_id = ? ORDER BY created_at ASC`
    )
    .bind(apiKeyId)
    .all<{ wallet_id: string; permissions: unknown }>();
  const walletBindings = bindings.results.map((binding) => ({
    walletId: binding.wallet_id,
    permissions: parsePostgresJsonOr<Permission[]>(binding.permissions, ["*"]),
  }));
  const signingWalletId = (row.signing_wallet_id as string | null | undefined) ?? null;
  if (walletBindings.length === 0 && signingWalletId) {
    walletBindings.push({ walletId: signingWalletId, permissions: ["*"] });
  }
  const { getPermissionsForApiKeyRole } = await import("@sdp/types");
  const role = row.role as "api_admin" | "api_developer" | "api_readonly";
  return {
    id: apiKeyId,
    organizationId,
    projectId: projectId as string,
    role,
    permissions: parsePostgresJsonOr<Permission[]>(
      row.permissions,
      getPermissionsForApiKeyRole(role)
    ),
    environment: row.environment as "sandbox" | "production",
    signingWalletId,
    signingWalletIds: walletBindings.map((binding) => binding.walletId),
    walletBindings,
  };
}

export async function executeApprovedWalletOperation(
  env: Env,
  repository: PolicyRepository,
  operation: WalletOperationRow
): Promise<void> {
  const claimed = await repository.claimWalletOperationExecution(operation.id);
  if (!claimed) {
    return;
  }

  let request: WalletOperationExecutionRequest;
  try {
    request = readExecutionRequest(claimed);
  } catch (error) {
    await repository.completeWalletOperationExecution({
      walletOperationId: operation.id,
      status: "failed",
      error: errorMessage(error),
    });
    return;
  }

  const token = crypto.randomUUID();
  capabilities.set(token, { operationId: operation.id, path: request.path });
  let response: Response;
  try {
    const [{ createApp }, { nodeObservability }] = await Promise.all([
      import("@/app"),
      import("@/runtime/observability-node"),
    ]);
    const headers = new Headers({
      "content-type": "application/json",
      [REPLAY_HEADER]: token,
      "idempotency-key": request.idempotencyKey,
    });
    if (operation.project_id) {
      headers.set("x-project-id", operation.project_id);
    }
    response = await createApp({ observability: nodeObservability }).fetch(
      new Request(`http://approved-operation.internal${request.path}`, {
        method: request.method,
        headers,
        body: JSON.stringify(request.body),
      }),
      env
    );
    capabilities.delete(token);
  } catch (error) {
    capabilities.delete(token);
    await repository.completeWalletOperationExecution({
      walletOperationId: operation.id,
      status: "failed",
      error: errorMessage(error),
    });
    return;
  }

  const payload = await readResponsePayload(response);
  if (response.ok && response.status !== 202) {
    await repository.completeWalletOperationExecution({
      walletOperationId: operation.id,
      status: "completed",
      result: payload,
    });
    return;
  }

  const error = responseError(payload, response.status);
  await repository.completeWalletOperationExecution({
    walletOperationId: operation.id,
    status: "failed",
    result: payload,
    error,
  });
  getLogger().error(
    { walletOperationId: operation.id, status: response.status, error },
    "Approved wallet operation execution failed"
  );
}

function readExecutionRequest(operation: WalletOperationRow): WalletOperationExecutionRequest {
  const value = operation.raw_payload.executionRequest;
  if (
    !isObject(value) ||
    value.method !== "POST" ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/v1/") ||
    !isObject(value.body) ||
    typeof value.idempotencyKey !== "string"
  ) {
    throw new AppError("INTERNAL_ERROR", "Wallet operation has no executable request envelope");
  }
  return value as unknown as WalletOperationExecutionRequest;
}

async function readResponsePayload(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => null);
  return isObject(value) ? value : { status: response.status };
}

function responseError(payload: Record<string, unknown>, status: number): string {
  const error = isObject(payload.error) ? payload.error : null;
  return error && typeof error.message === "string"
    ? error.message
    : `Approved operation replay returned HTTP ${status}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function approvedOperationTenantScope(operation: WalletOperationRow) {
  return createTenantScope({
    organizationId: operation.organization_id,
    projectId: operation.project_id,
  });
}
