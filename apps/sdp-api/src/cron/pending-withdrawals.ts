/**
 * Pending-withdrawals reconciliation entrypoint.
 *
 * Mirrors `pending-deposits`: wraps `trackPendingWithdrawals` with a Sentry cron
 * monitor when observability is supplied, and hands the resulting promise to the
 * BackgroundRunner so it survives past the initiating tick and drains during
 * graceful shutdown. Gated on the Private Channels feature flag.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { trackPendingWithdrawals } from "@/services/jobs/track-pending-withdrawals";
import type { Env } from "@/types/env";

export const PENDING_WITHDRAWALS_MONITOR = "sdp-api-track-pending-withdrawals";
export const PENDING_WITHDRAWALS_CRON = "* * * * *";

export interface PendingWithdrawalsReconciliationDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runPendingWithdrawalsReconciliation(
  deps: PendingWithdrawalsReconciliationDeps
): void {
  const work = () => trackPendingWithdrawals(deps.env);

  // Never invoke `work` eagerly — a sync throw before the first await must become
  // a rejected promise the BackgroundRunner can track, not propagate to the
  // runtime entrypoint.
  const promise = deps.observability
    ? deps.observability.withMonitor(PENDING_WITHDRAWALS_MONITOR, work, {
        schedule: { type: "crontab", value: PENDING_WITHDRAWALS_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
