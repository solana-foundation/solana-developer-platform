/**
 * Approved wallet-operation recovery entrypoint.
 *
 * Reclaims approved operations whose execution process stopped renewing its
 * lease. Atomic attempt fencing in the policy repository makes overlapping
 * cron ticks safe across replicas.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import type { Env } from "@/types/env";

export const APPROVED_WALLET_OPERATIONS_MONITOR = "sdp-api-recover-approved-wallet-operations";
export const APPROVED_WALLET_OPERATIONS_CRON = "* * * * *";

export interface ApprovedWalletOperationRecoveryDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runApprovedWalletOperationRecovery(
  deps: ApprovedWalletOperationRecoveryDeps
): void {
  const work = () => recoverApprovedWalletOperations(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(APPROVED_WALLET_OPERATIONS_MONITOR, work, {
        schedule: { type: "crontab", value: APPROVED_WALLET_OPERATIONS_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
