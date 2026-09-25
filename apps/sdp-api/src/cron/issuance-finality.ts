/**
 * Issuance-finality reconciliation entrypoint.
 *
 * Advances Solana-`confirmed` issuance transactions to `finalized` once the
 * cluster reports finality — the only write that lets the unified ledger read
 * them as succeeded. Wraps the job with a Sentry cron monitor when
 * observability is supplied and hands the resulting promise to the
 * BackgroundRunner so the Node background runner keeps it alive past the
 * initiating tick and drains it during graceful shutdown.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { finalizeConfirmedIssuanceTransactions } from "@/services/jobs/finalize-confirmed-issuance-transactions";
import type { Env } from "@/types/env";

export const ISSUANCE_FINALITY_MONITOR = "sdp-api-issuance-finality";
export const ISSUANCE_FINALITY_CRON = "* * * * *";

export interface IssuanceFinalityReconciliationDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runIssuanceFinalityReconciliation(deps: IssuanceFinalityReconciliationDeps): void {
  const work = () => finalizeConfirmedIssuanceTransactions(deps.env);
  // Always hand bg.run() a promise — never invoke `work` eagerly, since a sync
  // throw before the first await (e.g. repository construction) would
  // otherwise propagate to the runtime entrypoint instead of becoming a
  // rejected promise the BackgroundRunner can track and the platform can log.
  const promise = deps.observability
    ? deps.observability.withMonitor(ISSUANCE_FINALITY_MONITOR, work, {
        schedule: { type: "crontab", value: ISSUANCE_FINALITY_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
