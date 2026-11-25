import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import { AppError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { createOperationObservationRpc } from "@/services/earn/operation-observation-rpc";
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

/** Execute one fenced claim through the canonical recorded-principal and recovery path. */
export async function recoverOperationClaim(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim,
  observations: ReturnType<typeof createOperationObservationRpc>
): Promise<boolean> {
  const service = createOperationsService(env);
  try {
    await runAsRecordedOperationPrincipal(env, scope, claim, () =>
      advanceEarnOperation(env, scope, claim, observations)
    );
    return true;
  } catch (error) {
    getLogger().error({ error, operationId: claim.operation.id }, "Operation recovery failed");
    try {
      await recordRecoveryFailure(service, scope, claim, error);
    } catch (projectionError) {
      getLogger().error(
        { error: projectionError, operationId: claim.operation.id },
        "Operation failure projection failed"
      );
    }
    return false;
  } finally {
    await service.repository.releaseRecovery(scope, claim);
  }
}
