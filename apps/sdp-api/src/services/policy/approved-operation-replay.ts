import type { Permission } from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { asTransactionalClient, type DatabaseClient, getDb } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";
import {
  createPolicyRepository,
  createPostgresPolicyRepository,
  type PolicyRepository,
  type WalletOperationRow,
} from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { createTenantScope, getRequestTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { loadApiKeyWalletAuthorization } from "@/services/api-key-wallets.service";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

const REPLAY_HEADER = "x-sdp-approved-operation-replay";
const EXECUTION_HEARTBEAT_MS = 30_000;
const capabilities = new Map<
  string,
  { operationId: string; executionAttemptId: string; path: string }
>();

const walletOperationExecutionRequestSchema = z.object({
  method: z.literal("POST"),
  path: z.string().refine((path) => path.startsWith("/v1/")),
  body: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string(),
});

const legacyPaymentExecutionBodySchema = z.object({ source: z.string() }).catchall(z.unknown());

export type WalletOperationExecutionRequest = z.infer<typeof walletOperationExecutionRequestSchema>;

export function walletOperationExecutionRequest(
  c: Context<{ Bindings: Env }>,
  body: Record<string, unknown>
): WalletOperationExecutionRequest {
  return {
    method: "POST",
    path: c.req.path,
    body,
    idempotencyKey: c.req.header?.("Idempotency-Key") ?? `approval-${crypto.randomUUID()}`,
  };
}

export function approvedWalletOperationId(c: Context<{ Bindings: Env }>): string | undefined {
  return c.get("approvedWalletOperationId");
}

export function approvedWalletOperationAttemptId(
  c: Context<{ Bindings: Env }>
): string | undefined {
  return c.get("approvedWalletOperationAttemptId");
}

export async function assertApprovedWalletOperationCustodyWallet(
  c: Context<{ Bindings: Env }>,
  custodyWalletId: string | null
): Promise<void> {
  const operationId = approvedWalletOperationId(c);
  if (!operationId) {
    return;
  }

  const operation = await createPolicyRepository(
    c.env,
    getRequestTenantScope(c)
  ).getWalletOperationById(operationId);
  if (!operation || operation.custody_wallet_id !== custodyWalletId) {
    throw new AppError(
      "FORBIDDEN",
      "Approved wallet operation does not match persisted wallet identity"
    );
  }
}

/**
 * Durably fences an approved replay immediately before an external submission.
 * Normal requests are a no-op and repeat fences for the same leased attempt are
 * idempotent. Once set, an expired attempt is never automatically replayed
 * because the external result may be ambiguous.
 */
export async function beginApprovedWalletOperationEffect(
  c: Context<{ Bindings: Env }>
): Promise<void> {
  const operationId = approvedWalletOperationId(c);
  const executionAttemptId = approvedWalletOperationAttemptId(c);
  if (!operationId && !executionAttemptId) {
    return;
  }
  if (!operationId || !executionAttemptId) {
    throw new AppError("FORBIDDEN", "Approved-operation execution context is incomplete");
  }

  const repository = createPolicyRepository(c.env, getRequestTenantScope(c));
  const began = await repository.beginWalletOperationExecutionEffect(
    operationId,
    executionAttemptId
  );
  if (!began) {
    throw new AppError("FORBIDDEN", "Approved-operation execution lease was lost");
  }
}

/**
 * Commit an approved replay's effect fence and its first durable pre-submit
 * mutation together. Without the shared transaction, a lease can expire after
 * the mutation commits but before the fence is written. A recovered attempt
 * could then mistake that durable state for a completed idempotent replay even
 * though no external submission occurred.
 *
 * Normal requests run the mutation directly without an execution fence.
 */
export async function runApprovedWalletOperationEffectTransaction<T>(
  c: Context<{ Bindings: Env }>,
  mutation: (db: DatabaseClient) => Promise<T>
): Promise<T> {
  const operationId = approvedWalletOperationId(c);
  const executionAttemptId = approvedWalletOperationAttemptId(c);
  if (!operationId && !executionAttemptId) {
    return mutation(getDb(c.env));
  }
  if (!operationId || !executionAttemptId) {
    throw new AppError("FORBIDDEN", "Approved-operation execution context is incomplete");
  }

  const scope = getRequestTenantScope(c);
  return getDb(c.env).transaction(async (transaction) => {
    const db = asTransactionalClient(transaction);
    const repository = createPostgresPolicyRepository(db, scope);
    const began = await repository.beginWalletOperationExecutionEffect(
      operationId,
      executionAttemptId
    );
    if (!began) {
      throw new AppError("FORBIDDEN", "Approved-operation execution lease was lost");
    }
    return mutation(db);
  });
}

/**
 * Reserve mint supply at the approved replay's external-effect boundary. The
 * reservation and execution fence share one transaction so neither can survive
 * without the other.
 */
export async function reserveMintSupplyAtApprovedEffectBoundary(
  c: Context<{ Bindings: Env }>,
  tokenId: string,
  amountBaseUnits: string
): Promise<string> {
  return runApprovedWalletOperationEffectTransaction(c, async (db) => {
    const tokenService = new TokenService(db, getRequestTenantScope(c));
    const reservedSupply = await tokenService.reserveMintSupply(tokenId, amountBaseUnits);
    if (reservedSupply === null) {
      throw new AppError("MAX_SUPPLY_EXCEEDED", "Mint amount would exceed maximum supply");
    }
    return reservedSupply;
  });
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
       WHERE id = ?
         AND status = 'executing'
         AND execution_started_at IS NOT NULL
         AND execution_attempt_id = ?
         AND execution_lease_expires_at > ?`
    )
    .bind(capability.operationId, capability.executionAttemptId, new Date().toISOString())
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
  c.set("approvedWalletOperationAttemptId", capability.executionAttemptId);
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

  const { walletScope, signingWalletId, signingWalletIds, walletBindings } =
    await loadApiKeyWalletAuthorization(
      db,
      apiKeyId,
      organizationId,
      projectId as string,
      (row.signing_wallet_id as string | null | undefined) ?? null
    );
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
    walletScope,
    signingWalletId,
    signingWalletIds,
    walletBindings,
  };
}

export async function executeApprovedWalletOperation(
  env: Env,
  repository: PolicyRepository,
  operation: Pick<WalletOperationRow, "id" | "project_id">
): Promise<boolean> {
  const executionAttemptId = crypto.randomUUID();
  const claimed = await repository.claimWalletOperationExecution(operation.id, executionAttemptId);
  if (!claimed) {
    return false;
  }

  let request: WalletOperationExecutionRequest;
  try {
    request = readExecutionRequest(claimed);
  } catch (error) {
    await repository.completeWalletOperationExecution({
      walletOperationId: operation.id,
      executionAttemptId,
      status: "failed",
      error: errorMessage(error),
    });
    return true;
  }

  const token = crypto.randomUUID();
  capabilities.set(token, { operationId: operation.id, executionAttemptId, path: request.path });
  const heartbeat = startExecutionLeaseHeartbeat(repository, operation.id, executionAttemptId);
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
        signal: heartbeat.signal,
      }),
      env
    );
    capabilities.delete(token);
  } catch (error) {
    capabilities.delete(token);
    await heartbeat.stop();
    await repository.completeWalletOperationExecution({
      walletOperationId: operation.id,
      executionAttemptId,
      status: "failed",
      error: errorMessage(error),
    });
    return true;
  }
  await heartbeat.stop();

  const payload = await readResponsePayload(response);
  if (response.ok && response.status !== 202) {
    await repository.completeWalletOperationExecution({
      walletOperationId: operation.id,
      executionAttemptId,
      status: "completed",
      result: payload,
    });
    return true;
  }

  const error = responseError(payload, response.status);
  await repository.completeWalletOperationExecution({
    walletOperationId: operation.id,
    executionAttemptId,
    status: "failed",
    result: payload,
    error,
  });
  getLogger().error(
    { walletOperationId: operation.id, status: response.status, error },
    "Approved wallet operation execution failed"
  );
  return true;
}

export async function recoverApprovedWalletOperations(env: Env, limit = 25): Promise<number> {
  const db = getDb(env);
  const now = new Date().toISOString();

  // If an attempt disappeared after crossing an external boundary, its result is
  // ambiguous. Fail closed for operator reconciliation instead of risking a
  // second signer/provider submission from an automatic retry.
  await db
    .prepare(
      `UPDATE wallet_operations wo
       SET status = 'failed',
           execution_completed_at = ?,
           execution_error = ?,
           execution_lease_expires_at = NULL,
           updated_at = ?
       WHERE wo.status = 'executing'
         AND wo.execution_effect_started_at IS NOT NULL
         AND (wo.execution_lease_expires_at IS NULL OR wo.execution_lease_expires_at <= ?)
         AND EXISTS (
           SELECT 1 FROM approval_requests ar
           WHERE ar.wallet_operation_id = wo.id AND ar.status = 'approved'
         )`
    )
    .bind(
      now,
      "Approved execution was interrupted after its external effect began; manual reconciliation is required",
      now,
      now
    )
    .run();

  const rows = await db
    .prepare(
      `SELECT wo.id, wo.organization_id, wo.project_id
       FROM wallet_operations wo
       WHERE wo.status = 'executing'
         AND wo.execution_effect_started_at IS NULL
         AND (wo.execution_lease_expires_at IS NULL OR wo.execution_lease_expires_at <= ?)
         AND EXISTS (
           SELECT 1 FROM approval_requests ar
           WHERE ar.wallet_operation_id = wo.id AND ar.status = 'approved'
         )
       ORDER BY wo.updated_at ASC, wo.id ASC
       LIMIT ?`
    )
    .bind(now, limit)
    .all<{ id: string; organization_id: string; project_id: string | null }>();

  let recovered = 0;
  for (const operation of rows.results) {
    const repository = createPolicyRepository(
      env,
      createTenantScope({
        organizationId: operation.organization_id,
        projectId: operation.project_id,
      })
    );
    if (await executeApprovedWalletOperation(env, repository, operation)) {
      recovered += 1;
    }
  }
  return recovered;
}

function startExecutionLeaseHeartbeat(
  repository: PolicyRepository,
  walletOperationId: string,
  executionAttemptId: string
) {
  const controller = new AbortController();
  let renewal: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewal) {
      return;
    }
    renewal = repository
      .renewWalletOperationExecutionLease(walletOperationId, executionAttemptId)
      .then((renewed) => {
        if (!renewed) {
          controller.abort(new Error("Approved-operation execution lease was lost"));
        }
      })
      .catch((error) => {
        getLogger().error(
          { walletOperationId, executionAttemptId, error: errorMessage(error) },
          "Approved wallet operation lease renewal failed"
        );
        controller.abort(error);
      })
      .finally(() => {
        renewal = null;
      });
  }, EXECUTION_HEARTBEAT_MS);
  timer.unref?.();

  return {
    signal: controller.signal,
    async stop() {
      clearInterval(timer);
      await renewal;
    },
  };
}

function readExecutionRequest(operation: WalletOperationRow): WalletOperationExecutionRequest {
  const parsedRequest = walletOperationExecutionRequestSchema.safeParse(
    operation.raw_payload.executionRequest
  );
  if (!parsedRequest.success) {
    throw new AppError("INTERNAL_ERROR", "Wallet operation has no executable request envelope");
  }
  const request = parsedRequest.data;
  const expectedPaymentPath =
    operation.operation_type === "payment_transfer_execute"
      ? "/v1/payments/transfers"
      : operation.operation_type === "payment_transfer_batch_execute"
        ? "/v1/payments/transfer-batches"
        : null;
  if (expectedPaymentPath === null) {
    return request;
  }
  const parsedBody = legacyPaymentExecutionBodySchema.safeParse(request.body);
  if (
    !operation.custody_wallet_id ||
    request.path !== expectedPaymentPath ||
    !parsedBody.success ||
    parsedBody.data.source !== operation.wallet_id
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Approved wallet operation does not match persisted wallet identity"
    );
  }

  // HOO-1023: remove after rollback support ends and the release audit reports
  // no nonterminal legacy Payments envelopes.
  const { source: _source, ...body } = parsedBody.data;
  return {
    ...request,
    body: { ...body, sourceCustodyWalletId: operation.custody_wallet_id },
  };
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
