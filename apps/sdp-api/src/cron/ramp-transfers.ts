/**
 * Ramp-transfers reconciliation entrypoint.
 *
 * Wraps `reconcileRampTransfers` with a Sentry cron monitor when observability
 * is supplied, and hands the resulting promise to the BackgroundRunner so the
 * Node background runner keeps it alive past the initiating tick and drains it
 * during graceful shutdown. Deliberately its own schedule, separate from
 * pending-transfers: that job reconciles on-chain wallet transfers against the
 * cluster, this one reconciles ramp transfers against the provider's API.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { reconcileRampTransfers } from "@/services/jobs/reconcile-ramp-transfers";
import type { Env } from "@/types/env";

export const RAMP_TRANSFERS_MONITOR = "sdp-api-reconcile-ramp-transfers";
export const RAMP_TRANSFERS_CRON = "*/5 * * * *";

export interface RampTransfersReconciliationDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runRampTransfersReconciliation(deps: RampTransfersReconciliationDeps): void {
  const work = async () => {
    await reconcileRampTransfers(deps.env);
  };

  // Both branches must hand bg.run() a promise — never invoke `work` eagerly,
  // since a sync throw before the first await would otherwise propagate to the
  // runtime entrypoint instead of becoming a rejected promise the
  // BackgroundRunner can track and the platform can log.
  const promise = deps.observability
    ? deps.observability.withMonitor(RAMP_TRANSFERS_MONITOR, work, {
        schedule: { type: "crontab", value: RAMP_TRANSFERS_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
