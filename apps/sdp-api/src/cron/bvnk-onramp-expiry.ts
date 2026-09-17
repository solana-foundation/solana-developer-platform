/**
 * BVNK on-ramp expiry cron entrypoint.
 *
 * Schedules and monitors the on-ramp expiry reconciliation implemented in
 * `services/jobs/bvnk-onramp-expiry.ts`, and hands the resulting promise to
 * the BackgroundRunner so the Node background runner keeps it alive past the
 * initiating tick and drains it during graceful shutdown.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { reconcileBvnkOnrampExpiry } from "@/services/jobs/bvnk-onramp-expiry";
import type { Env } from "@/types/env";

export const BVNK_ONRAMP_EXPIRY_MONITOR = "sdp-api-bvnk-onramp-expiry";
export const BVNK_ONRAMP_EXPIRY_CRON = "*/15 * * * *";

export interface BvnkOnrampExpiryDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

/**
 * Wraps `reconcileBvnkOnrampExpiry` with a Sentry cron monitor when
 * observability is supplied, and hands the resulting promise to the
 * BackgroundRunner so the Node background runner keeps it alive past the
 * initiating tick and drains it during graceful shutdown.
 *
 * @param deps - Environment, background runner, and optional observability.
 * @returns Nothing; the work promise is owned by the background runner.
 */
export function runBvnkOnrampExpiryReconciliation(deps: BvnkOnrampExpiryDeps): void {
  const work = () => reconcileBvnkOnrampExpiry(deps.env);

  // Never invoke `work` eagerly: a sync throw before the first await must become
  // a rejected promise the BackgroundRunner can track, not propagate to the
  // runtime entrypoint.
  const promise = deps.observability
    ? deps.observability.withMonitor(BVNK_ONRAMP_EXPIRY_MONITOR, work, {
        schedule: { type: "crontab", value: BVNK_ONRAMP_EXPIRY_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
