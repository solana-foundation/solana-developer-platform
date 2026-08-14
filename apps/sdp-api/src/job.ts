import { pathToFileURL } from "node:url";

import * as Sentry from "@sentry/node";
import { runEarnCatalogueSyncIfDue } from "@/cron/earn-catalogue-sync";
import { runEarnMetricsRefreshTick } from "@/cron/earn-metrics-refresh";
import { PENDING_TRANSFERS_CRON, PENDING_TRANSFERS_MONITOR } from "@/cron/pending-transfers";
import { WORKFLOW_EXECUTIONS_CRON, WORKFLOW_EXECUTIONS_MONITOR } from "@/cron/workflow-executions";
import {
  WORKFLOW_SECRET_RETIREMENTS_CRON,
  WORKFLOW_SECRET_RETIREMENTS_MONITOR,
} from "@/cron/workflow-secret-retirements";
import { closeDatabasePools } from "@/db/client";
import { isAssetProfilesEnabled, isEarnEnabled } from "@/lib/feature-flags";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { getSentryOptions, isSentryEnabled } from "@/runtime/observability";
import { initNodeSentry, nodeObservability } from "@/runtime/observability-node";
import { reconcileSponsorshipBudgets } from "@/services/jobs/reconcile-sponsorship-budgets";
import { retireOrphanedActionSecrets } from "@/services/jobs/retire-workflow-secrets";
import { runDueWorkflowExecutions } from "@/services/jobs/run-workflow-executions";
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

  const sentryEnabled = isSentryEnabled(env);
  const monitored = (monitor: string, cron: string, work: () => Promise<unknown>) =>
    sentryEnabled
      ? nodeObservability.withMonitor(monitor, work, {
          schedule: { type: "crontab", value: cron },
        })
      : work();

  try {
    // Approved-wallet-operation replay rides the pending-transfers tick (same
    // cadence/monitor), matching the in-process cron runner.
    await monitored(PENDING_TRANSFERS_MONITOR, PENDING_TRANSFERS_CRON, async () => {
      const outcomes = await Promise.allSettled([
        (async () => {
          await trackPendingTransfers(env);
          await recoverApprovedWalletOperations(env);
        })(),
        reconcileSponsorshipBudgets(env),
      ]);
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
      );
      if (rejected.length === 1) throw rejected[0].reason;
      if (rejected.length > 1) {
        throw new AggregateError(
          rejected.map((outcome) => outcome.reason),
          "pending-transfers tick had multiple failures"
        );
      }
    });
    // The workflow engine has no other tick in the Cloud Run deployment shape (the
    // in-process cron scheduler is skipped under K_SERVICE) — without this, enqueued
    // executions would sit 'pending' forever in production.
    if (isAssetProfilesEnabled(env)) {
      await monitored(WORKFLOW_EXECUTIONS_MONITOR, WORKFLOW_EXECUTIONS_CRON, () =>
        runDueWorkflowExecutions(env)
      );
    }
    // Behind no flag, for the same reason its in-process registration is (cron/runner.ts):
    // the queue holds credentials that are ALREADY orphaned, so its cleanup has to outlive
    // the feature that filled it. And it has to be HERE as well — this job is the only tick
    // a Cloud Run deployment gets, which is also where GCP Secret Manager is the default
    // backend, so it is precisely where retirements are queued. Non-fatal: the sweep
    // reports to its own monitor, and a failing one must not fail the reconciliation this
    // job exists for (a queued row is never abandoned — the next run picks it up).
    await monitored(WORKFLOW_SECRET_RETIREMENTS_MONITOR, WORKFLOW_SECRET_RETIREMENTS_CRON, () =>
      retireOrphanedActionSecrets(env)
    ).catch((error: unknown) => {
      getLogger().error(
        { error: error instanceof Error ? error.message : String(error) },
        "reconciliation job: secret retirement sweep failed"
      );
    });
    // The Earn catalogue sync rides this job behind the same gate as its
    // in-process registration (cron/runner.ts): both Earn feature flags on.
    // Its hourly cadence comes from the Redis slot inside
    // runEarnCatalogueSyncIfDue — not this job's schedule — and it reports to
    // its own Sentry monitor, so a sync failure never masquerades as a
    // reconciliation failure (and vice versa).
    if (isEarnEnabled(env)) {
      // Unslotted — this job's five-minute schedule IS its cadence (see
      // runEarnMetricsRefreshTick's docstring) — and ordered FIRST so a slow
      // catalogue pass cannot eat the tick and leave rates stale. That
      // freshness promise is also why it goes through the MONITORED tick:
      // "it silently stopped running" is this pass's worst failure.
      await runEarnMetricsRefreshTick(env, sentryEnabled ? nodeObservability : undefined).catch(
        (error: unknown) => {
          // Never fails the job: the refresh degrades per provider internally,
          // so anything escaping is infrastructure-level, and rates going one
          // tick stale must not stop the catalogue sync that follows.
          getLogger().error(
            { error: error instanceof Error ? error.message : String(error) },
            "reconciliation job: earn metrics refresh failed"
          );
        }
      );
      await runEarnCatalogueSyncIfDue(env, sentryEnabled ? nodeObservability : undefined);
    }
  } finally {
    await Promise.allSettled([closeAllRedisClients(), closeDatabasePools()]);
    await Sentry.close(2000);
  }
}

export function describeCronFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof AggregateError)) return { error };
  return {
    error,
    causes: error.errors.map((cause: unknown) =>
      cause instanceof Error
        ? { message: cause.message, stack: cause.stack }
        : { message: String(cause) }
    ),
  };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runCronJob()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      getLogger().error(describeCronFailure(err), "Reconciliation job failed");
      process.exit(1);
    });
}
