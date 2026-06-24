/**
 * Pending-transfers reconciliation entrypoint, runtime-neutral.
 *
 * Wraps `trackPendingTransfers` with a Sentry cron monitor when observability
 * is supplied, and hands the resulting promise to the BackgroundRunner so the
 * caller's runtime (CF `waitUntil`, Node SIGTERM drain) keeps it alive past
 * return. The CF entrypoint calls this from `scheduled`; the Node entrypoint
 * (HOO-511) will call it from its `node-cron` tick.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import type { Env } from "@/types/env";

export const PENDING_TRANSFERS_MONITOR = "sdp-api-track-pending-transfers";
export const PENDING_TRANSFERS_CRON = "* * * * *";

export interface PendingTransfersReconciliationDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runPendingTransfersReconciliation(deps: PendingTransfersReconciliationDeps): void {
  const work = () => trackPendingTransfers(deps.env);

  // Both branches must hand bg.run() a promise — never invoke `work` eagerly,
  // since a sync throw before the first await inside trackPendingTransfers
  // (e.g. createPaymentsRepository construction) would otherwise propagate to
  // the runtime entrypoint instead of becoming a rejected promise the
  // BackgroundRunner can track and the platform can log.
  const promise = deps.observability
    ? deps.observability.withMonitor(PENDING_TRANSFERS_MONITOR, work, {
        schedule: { type: "crontab", value: PENDING_TRANSFERS_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
