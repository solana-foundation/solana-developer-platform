import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { pruneIdempotencyKeys } from "@/services/jobs/prune-idempotency-keys";
import type { Env } from "@/types/env";

export const IDEMPOTENCY_KEY_PRUNE_MONITOR = "sdp-api-prune-idempotency-keys";
// Hourly: rows are kept for 24 hours and every claim already ignores an
// expired row, so pruning only reclaims space.
export const IDEMPOTENCY_KEY_PRUNE_CRON = "17 * * * *";

export interface IdempotencyKeyPruneDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runIdempotencyKeyPrune(deps: IdempotencyKeyPruneDeps): void {
  const work = () => pruneIdempotencyKeys(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(IDEMPOTENCY_KEY_PRUNE_MONITOR, work, {
        schedule: { type: "crontab", value: IDEMPOTENCY_KEY_PRUNE_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
