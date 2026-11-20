import { currentClusterScope } from "@sdp/rpc/scope";
import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import { AppError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { createOperationObservationRpc } from "@/services/earn/operation-observation-rpc";
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
  const service = createOperationsService(env);
  const candidates = await service.repository.listDueRecovery(environment);
  const observations = createOperationObservationRpc();
  let failures = 0;
  let cursor = 0;
  async function recoverNext(): Promise<void> {
    while (Date.now() < runExpiresAt) {
      const candidate = candidates[cursor++];
      if (candidate === undefined) return;
      const scope = {
        organizationId: candidate.organizationId,
        projectId: candidate.projectId,
        environment,
      };
      // Lease only work that can start now, never the whole candidate page.
      const claim = await service.repository.claimRecovery(scope, candidate.id);
      if (claim === null) continue;
      try {
        if (Date.now() >= runExpiresAt) return;
        await runAsRecordedOperationPrincipal(env, scope, claim, () =>
          advanceEarnOperation(env, scope, claim, observations)
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
        await service.repository.releaseRecovery(scope, claim);
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: 4 }, recoverNext));
  for (const outcome of workers) {
    if (outcome.status === "rejected") {
      failures += 1;
      getLogger().error({ error: outcome.reason }, "Operation recovery worker failed");
    }
  }
  if (failures > 0) throw new Error(`${failures} operation recovery attempts failed`);
}
