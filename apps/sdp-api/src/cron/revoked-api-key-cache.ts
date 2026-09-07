/**
 * Revoked API-key cache reconciliation entrypoint.
 *
 * Repairs cache entries that still authenticate a key Postgres has already
 * revoked — the residue of a revocation whose post-commit cache write failed
 * (e.g. a transient Redis outage during organization deletion). This is a
 * security recovery path, not a feature: it is scheduled unconditionally
 * wherever reconciliation runs, so no deployment is left without it.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { reconcileRevokedApiKeyCache } from "@/services/jobs/reconcile-revoked-api-key-cache";
import type { Env } from "@/types/env";

export const REVOKED_API_KEY_CACHE_MONITOR = "sdp-api-reconcile-revoked-api-key-cache";
export const REVOKED_API_KEY_CACHE_CRON = "* * * * *";

export interface RevokedApiKeyCacheReconciliationDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runRevokedApiKeyCacheReconciliation(
  deps: RevokedApiKeyCacheReconciliationDeps
): void {
  const work = () => reconcileRevokedApiKeyCache(deps.env);
  // Never invoke `work` eagerly: a sync throw before its first await would
  // escape to the scheduler instead of becoming a tracked rejected promise.
  const promise = deps.observability
    ? deps.observability.withMonitor(REVOKED_API_KEY_CACHE_MONITOR, work, {
        schedule: { type: "crontab", value: REVOKED_API_KEY_CACHE_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
