import { currentClusterScope } from "@sdp/rpc/scope";
import { getDb } from "@/db/client";
import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import { AppError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { OPERATION_WORKER_BUDGET_MS } from "@/services/earn/operation-worker-budget";
import {
  advanceEarnOperation,
  isTerminalOperation,
} from "@/services/earn/strategy-operations.service";
import type { OperationsService } from "@/services/operations.service";
import { createOperationsService } from "@/services/operations.service";
import { runAsRecordedOperationPrincipal } from "@/services/operations-principal";
import type { Env } from "@/types/env";

async function recordRecoveryFailure(
  service: OperationsService,
  scope: OperationScope,
  claim: OperationClaim,
  error: unknown
) {
  const current = await service.repository.get(scope, claim.operation.id);
  if (current === null || current.claimToken !== claim.token) return;
  if (isTerminalOperation(current.operation)) return;
  await service.transition(scope, claim, {
    status: current.operation.status,
    resourceRef: current.operation.resourceRef,
    nextAction: { type: "wait", reason: "Recovery will retry this operation" },
    error: {
      code: error instanceof AppError ? error.code : "SERVICE_UNAVAILABLE",
      message:
        error instanceof AppError
          ? error.toResponse().error.message
          : "The operation could not advance; recovery will retry",
    },
  });
}

/** Resume durable attempts; a worker never executes an unsubmitted preparation. */
export async function reconcileOperations(env: Env): Promise<void> {
  const runExpiresAt = Date.now() + OPERATION_WORKER_BUDGET_MS;
  const { environment } = currentClusterScope();
  const candidates = await getDb(env).queryMany<{
    id: string;
    organization_id: string;
    project_id: string;
  }>(
    `SELECT operation.id, operation.organization_id, operation.project_id
     FROM operations operation JOIN operation_attempts attempt
       ON attempt.operation_id = operation.id AND attempt.action_id = operation.action_id
       AND attempt.action_version = operation.action_version
     WHERE operation.environment = ? AND operation.status NOT IN ('completed', 'failed', 'cancelled')
       AND (attempt.execution_requested_at IS NOT NULL OR attempt.dispatch_started_at IS NOT NULL OR attempt.signed_transaction IS NOT NULL)
       AND (operation.claim_until IS NULL OR operation.claim_until <= now())
     ORDER BY operation.updated_at, operation.id LIMIT 100`,
    [environment]
  );
  const service = createOperationsService(env);
  let failures = 0;
  // Each provider wake is bounded by its own execution lease. Keep pressure
  // bounded too; a slow custody account must not fan out unbounded RPC work.
  for (const candidate of candidates) {
    if (Date.now() >= runExpiresAt) break;
    const scope = {
      organizationId: candidate.organization_id,
      projectId: candidate.project_id,
      environment,
    };
    const claim = await service.repository.claimRecovery(scope, candidate.id);
    if (claim === null) continue;
    try {
      await runAsRecordedOperationPrincipal(env, scope, claim, () =>
        advanceEarnOperation(env, scope, claim)
      );
    } catch (error) {
      failures += 1;
      getLogger().error({ error, operationId: candidate.id }, "Operation recovery failed");
      try {
        await recordRecoveryFailure(service, scope, claim, error);
      } catch (projectionError) {
        getLogger().error(
          { error: projectionError, operationId: candidate.id },
          "Operation failure projection failed"
        );
      }
    } finally {
      await service.repository.release(scope, claim);
    }
  }
  if (failures > 0) throw new Error(`${failures} operation recovery attempts failed`);
}
