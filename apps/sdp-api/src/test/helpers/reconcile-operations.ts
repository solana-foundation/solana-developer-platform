import { currentClusterScope } from "@sdp/rpc/scope";
import { getLogger } from "@/runtime/logger";
import { createOperationObservationRpc } from "@/services/earn/operation-observation-rpc";
import { OPERATION_WORKER_BUDGET_MS } from "@/services/earn/operation-worker-budget";
import { recoverOperationClaim } from "@/services/jobs/reconcile-operations";
import { createOperationsService } from "@/services/operations.service";
import type { Env } from "@/types/env";

/** Drain due claims deterministically in integration tests, using production claims/reducers. */
export async function reconcileOperations(env: Env): Promise<void> {
  const runExpiresAt = Date.now() + OPERATION_WORKER_BUDGET_MS;
  const { environment } = currentClusterScope();
  const service = createOperationsService(env);
  const observations = createOperationObservationRpc();
  let remaining = 100;
  let failures = 0;
  async function recoverNext(): Promise<void> {
    while (Date.now() < runExpiresAt && remaining > 0) {
      remaining -= 1;
      const next = await service.repository.claimNextRecovery(environment);
      if (next === null) return;
      const { scope, claim } = next;
      if (Date.now() >= runExpiresAt) {
        await service.repository.releaseRecovery(scope, claim);
        return;
      }
      if (!(await recoverOperationClaim(env, scope, claim, observations))) failures += 1;
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
