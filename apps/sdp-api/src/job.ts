import { pathToFileURL } from "node:url";

import * as Sentry from "@sentry/node";
import { PENDING_TRANSFERS_CRON, PENDING_TRANSFERS_MONITOR } from "@/cron/pending-transfers";
import { WORKFLOW_EXECUTIONS_CRON, WORKFLOW_EXECUTIONS_MONITOR } from "@/cron/workflow-executions";
import { closeDatabasePools } from "@/db/client";
import { isAssetProfilesEnabled } from "@/lib/feature-flags";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { getSentryOptions, isSentryEnabled } from "@/runtime/observability";
import { initNodeSentry, nodeObservability } from "@/runtime/observability-node";
import { runDueWorkflowExecutions } from "@/services/jobs/run-workflow-executions";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";

export async function runCronJob(): Promise<void> {
  const env = getProcessEnv();
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required for the reconciliation job");
  }
  if (!env.REDIS_URL?.trim()) {
    throw new Error("REDIS_URL is required for the reconciliation job");
  }

  initNodeSentry(getSentryOptions(env));

  const sentryEnabled = isSentryEnabled(env);
  const monitored = (monitor: string, cron: string, work: () => Promise<unknown>) =>
    sentryEnabled
      ? nodeObservability.withMonitor(monitor, work, {
          schedule: { type: "crontab", value: cron },
        })
      : work();

  try {
    await monitored(PENDING_TRANSFERS_MONITOR, PENDING_TRANSFERS_CRON, () =>
      trackPendingTransfers(env)
    );
    // The workflow engine has no other tick in the Cloud Run deployment shape (the
    // in-process cron scheduler is skipped under K_SERVICE) — without this, enqueued
    // executions would sit 'pending' forever in production.
    if (isAssetProfilesEnabled(env)) {
      await monitored(WORKFLOW_EXECUTIONS_MONITOR, WORKFLOW_EXECUTIONS_CRON, () =>
        runDueWorkflowExecutions(env)
      );
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
      console.error("Reconciliation job failed:", err);
      process.exit(1);
    });
}
