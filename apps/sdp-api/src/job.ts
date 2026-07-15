import { pathToFileURL } from "node:url";

import * as Sentry from "@sentry/node";
import { PENDING_TRANSFERS_CRON, PENDING_TRANSFERS_MONITOR } from "@/cron/pending-transfers";
import { closeDatabasePools } from "@/db/client";
import { withProcessEnvFallback } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { getSentryOptions, isSentryEnabled } from "@/runtime/observability";
import { initNodeSentry, nodeObservability } from "@/runtime/observability-node";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import type { Env } from "@/types/env";

export async function runCronJob(): Promise<void> {
  const env = withProcessEnvFallback({} as Env);
  env.SDP_RUNTIME = "node";
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required for the reconciliation job");
  }
  if (!env.REDIS_URL?.trim()) {
    throw new Error("REDIS_URL is required for the reconciliation job");
  }

  initNodeSentry(getSentryOptions(env));

  const work = () => trackPendingTransfers(env);
  try {
    await (isSentryEnabled(env)
      ? nodeObservability.withMonitor(PENDING_TRANSFERS_MONITOR, work, {
          schedule: { type: "crontab", value: PENDING_TRANSFERS_CRON },
        })
      : work());
  } finally {
    await Promise.allSettled([closeAllRedisClients(), closeDatabasePools()]);
    await Sentry.close(2000);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runCronJob()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("Reconciliation job failed:", err);
      process.exit(1);
    });
}
