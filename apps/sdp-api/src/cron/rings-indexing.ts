/**
 * Rings indexing-poll entrypoint.
 *
 * Mirrors `pending-deposits`: wraps `pollRingsIndexing` with a Sentry cron
 * monitor when observability is supplied and hands the promise to the
 * BackgroundRunner. The job itself early-returns unless the rings flag is on
 * and HELIUS_RINGS_ADAPTER is "http" (the Track B live-gateway selector), so
 * scheduling it everywhere is free.
 */

import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { pollRingsIndexing } from "@/services/jobs/poll-rings-indexing";
import type { Env } from "@/types/env";

export const RINGS_INDEXING_MONITOR = "sdp-api-poll-rings-indexing";
export const RINGS_INDEXING_CRON = "* * * * *";

export interface RingsIndexingPollDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runRingsIndexingPoll(deps: RingsIndexingPollDeps): void {
  const work = () => pollRingsIndexing(deps.env);

  const promise = deps.observability
    ? deps.observability.withMonitor(RINGS_INDEXING_MONITOR, work, {
        schedule: { type: "crontab", value: RINGS_INDEXING_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
