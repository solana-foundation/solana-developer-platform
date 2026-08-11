import { pathToFileURL } from "node:url";

import * as Sentry from "@sentry/node";
import { runEarnCatalogueSyncIfDue } from "@/cron/earn-catalogue-sync";
import { PENDING_TRANSFERS_CRON, PENDING_TRANSFERS_MONITOR } from "@/cron/pending-transfers";
import { closeDatabasePools } from "@/db/client";
import { isEarnEnabled } from "@/lib/feature-flags";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { getSentryOptions, isSentryEnabled } from "@/runtime/observability";
import { initNodeSentry, nodeObservability } from "@/runtime/observability-node";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";

export async function runCronJob(): Promise<void> {
  const env = getProcessEnv();
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required for the reconciliation job");
  }
  if (!env.REDIS_URL?.trim()) {
    throw new Error("REDIS_URL is required for the reconciliation job");
  }

  initNodeSentry(getSentryOptions(env));

  const work = async () => {
    await trackPendingTransfers(env);
    await recoverApprovedWalletOperations(env);
  };
  try {
    await (isSentryEnabled(env)
      ? nodeObservability.withMonitor(PENDING_TRANSFERS_MONITOR, work, {
          schedule: { type: "crontab", value: PENDING_TRANSFERS_CRON },
        })
      : work());
    // The Earn catalogue sync rides this job behind the same gate as its
    // in-process registration (cron/runner.ts): both Earn feature flags on.
    // Its hourly cadence comes from the Redis slot inside
    // runEarnCatalogueSyncIfDue — not this job's schedule — and it reports to
    // its own Sentry monitor, so a sync failure never masquerades as a
    // reconciliation failure (and vice versa).
    if (isEarnEnabled(env)) {
      await runEarnCatalogueSyncIfDue(env, isSentryEnabled(env) ? nodeObservability : undefined);
    }
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
      getLogger().error({ error: err }, "Reconciliation job failed");
      process.exit(1);
    });
}
