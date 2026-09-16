import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { detectOrphanedEarnSplitSwaps } from "@/services/jobs/detect-orphaned-earn-split-swaps";
import type { Env } from "@/types/env";

export const EARN_SPLIT_SWAPS_MONITOR = "sdp-api-detect-orphaned-earn-split-swaps";
export const EARN_SPLIT_SWAPS_CRON = "* * * * *";

/**
 * Orphaned split-swap detection (PRO-1864, threat model EARN-026): the
 * advisory sweep over swaps SDP handed to a partner but never saw deposited.
 * Same wrapping as every other sweep: a Sentry cron monitor when observability
 * is supplied, and the promise handed to the BackgroundRunner so it outlives
 * the tick and drains on shutdown.
 */
export function runEarnSplitSwapDetection(deps: {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}): void {
  const work = () => detectOrphanedEarnSplitSwaps(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(EARN_SPLIT_SWAPS_MONITOR, work, {
        schedule: { type: "crontab", value: EARN_SPLIT_SWAPS_CRON },
      })
    : Promise.resolve().then(work);
  deps.bg.run(promise);
}
