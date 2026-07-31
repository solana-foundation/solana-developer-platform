/**
 * Pending-deposits reconciliation entrypoint.
 *
 * Mirrors `pending-transfers`: wraps `trackPendingDeposits` with a Sentry cron
 * monitor when observability is supplied, and hands the resulting promise to the
 * BackgroundRunner so it survives past the initiating tick and drains during
 * graceful shutdown. Gated on the Private Channels feature flag.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { trackPendingDeposits } from "@/services/jobs/track-pending-deposits";
import type { Env } from "@/types/env";

export const PENDING_DEPOSITS_MONITOR = "sdp-api-track-pending-deposits";
export const PENDING_DEPOSITS_CRON = "* * * * *";

export interface PendingDepositsReconciliationDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runPendingDepositsReconciliation(deps: PendingDepositsReconciliationDeps): void {
  const work = () => trackPendingDeposits(deps.env);

  // Never invoke `work` eagerly — a sync throw before the first await must become
  // a rejected promise the BackgroundRunner can track, not propagate to the
  // runtime entrypoint.
  const promise = deps.observability
    ? deps.observability.withMonitor(PENDING_DEPOSITS_MONITOR, work, {
        schedule: { type: "crontab", value: PENDING_DEPOSITS_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
