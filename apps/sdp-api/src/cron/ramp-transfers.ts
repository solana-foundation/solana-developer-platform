/**
 * Ramp transfer reconciliation entrypoint: runs `reconcileRampTransfers`, the
 * same list the managed reconciliation job (job.ts) runs. Registered behind no
 * flag; replay skips providers the release channel leaves out.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { reconcileRampTransfers } from "@/services/jobs/reconcile-ramp-transfers";
import type { Env } from "@/types/env";

export const RAMP_TRANSFERS_MONITOR = "sdp-api-reconcile-ramp-transfers";
export const RAMP_TRANSFERS_CRON = "* * * * *";

export interface RampTransfersReconciliationDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runRampTransfersReconciliation(deps: RampTransfersReconciliationDeps): void {
  const work = () => reconcileRampTransfers(deps.env);
  // Never invoke `work` eagerly: a sync throw before its first await would
  // escape to the scheduler instead of becoming a tracked rejected promise.
  const promise = deps.observability
    ? deps.observability.withMonitor(RAMP_TRANSFERS_MONITOR, work, {
        schedule: { type: "crontab", value: RAMP_TRANSFERS_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
