import { pathToFileURL } from "node:url";
import * as solanaRpc from "@sdp/rpc/solana";

import { parse as parseCron, validate as validateCron } from "node-cron";
import { EARN_CATALOGUE_SYNC_MONITOR, runEarnCatalogueSyncIfDue } from "@/cron/earn-catalogue-sync";
import {
  EARN_METRICS_REFRESH_MONITOR,
  runEarnMetricsRefreshTick,
} from "@/cron/earn-metrics-refresh";
import { EARN_VAULT_MOVEMENTS_MONITOR } from "@/cron/earn-vault-movements";
import { PENDING_DEPOSITS_MONITOR } from "@/cron/pending-deposits";
import { PENDING_TRANSFERS_MONITOR } from "@/cron/pending-transfers";
import { PENDING_WITHDRAWALS_MONITOR } from "@/cron/pending-withdrawals";
import { RECURRING_PAYMENTS_COLLECTION_MONITOR } from "@/cron/recurring-payments";
import { RINGS_INDEXING_MONITOR } from "@/cron/rings-indexing";
import { runWithCronRunEvent } from "@/cron/run-event";
import { WORKFLOW_EXECUTIONS_MONITOR } from "@/cron/workflow-executions";
import { WORKFLOW_SECRET_RETIREMENTS_MONITOR } from "@/cron/workflow-secret-retirements";
import { closeDatabasePools } from "@/db/client";
import {
  isAssetProfilesEnabled,
  isEarnEnabled,
  isPrivateChannelsEnabled,
} from "@/lib/feature-flags";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { assertSigningProviderAllowed } from "@/services/adapters/signing";
import { assertCustodyEncryptionScheme } from "@/services/custody-cipher/cipher-router";
import { collectDueRecurringPayments } from "@/services/jobs/collect-recurring-payments";
import { waitForEgress } from "@/services/jobs/egress-warmup";
import { pollRingsIndexing } from "@/services/jobs/poll-rings-indexing";
import { reconcileEarnVaultMovements } from "@/services/jobs/reconcile-earn-vault-movements";
import { reconcileSponsorshipBudgets } from "@/services/jobs/reconcile-sponsorship-budgets";
import { retireOrphanedActionSecrets } from "@/services/jobs/retire-workflow-secrets";
import { runDueWorkflowExecutions } from "@/services/jobs/run-workflow-executions";
import { trackPendingDeposits } from "@/services/jobs/track-pending-deposits";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { trackPendingWithdrawals } from "@/services/jobs/track-pending-withdrawals";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import type { Env } from "@/types/env";

const MAX_MANAGED_SCHEDULER_GAP_MINUTES = 5;

/**
 * One-shot reconciliation entrypoint for the managed Cloud Run Job — the only
 * cron tick a managed deployment gets, since web replicas skip the in-process
 * scheduler under K_SERVICE (cron/runner.ts). Each execution is a fresh
 * process, so it closes every pool on the way out. Absence detection is the
 * Loki dead-man on the per-tick `sdp_cron_run` events.
 *
 * Failure semantics: every tick runs on every execution — a failing tick never
 * blocks the ticks after it, so one persistently broken reconciler cannot
 * starve the rest. Each tick emits `sdp_cron_run` under its monitor slug and
 * each failure is logged with that slug, so the failing tick is identifiable
 * from logs alone. Fatal ticks' failures are collected and rethrown
 * once everything has run (as an AggregateError when more than one failed, and
 * logged with full causes at the process exit below), failing the job loudly;
 * non-fatal ticks' failures are swallowed after their log. The next execution
 * retries everything. Workflow secret retirements and Earn metrics refresh are
 * intentionally the only ticks whose failures do not enter the final failure
 * collection.
 *
 * The sequence:
 *
 * 1. **Pending transfers** + approved-wallet-operation replay + sponsorship
 *    budget reconciliation — one monitored tick (the replay rides the
 *    transfers monitor, matching the in-process runner); the legs run settled
 *    so one failing never hides the other. Fatal.
 * 2. **Recurring-payment collection** — ungated, like the recurring routes: an
 *    always-on product surface. A money path, so it fails the job loudly. The
 *    deployment-provided Managed Reconciliation Cadence is its effective
 *    cadence, so no Redis slot is needed.
 * 3. **Private-channel deposit and withdrawal reconcilers** (gated on
 *    `PRIVATE_CHANNELS_ENABLED`) — siblings, not stages: concurrent under
 *    their own monitors so a failing leg never skips the other. The Managed
 *    Reconciliation Cadence is their effective cadence, the same degradation
 *    from the per-minute crontab that pending-transfers accepts. Fatal.
 * 4. **Rings indexing poll** — behind no gate here, because the job itself
 *    early-returns unless the rings flag is on. This job is the poll's only tick
 *    on managed deployments; without it an operation that reached `indexing`
 *    would neither complete nor ever time out. Fatal.
 * 5. **Earn vault-movement reconciliation** — deliberately outside the Earn
 *    gate: signed vault intents are an outbox, not feature state, so disabling
 *    new deposits cannot strand old ones. Fatal.
 * 6. **Workflow executions** (gated on asset profiles) — this job is the
 *    workflow engine's only tick on managed deployments; without it, enqueued
 *    executions would sit `pending` forever. Fatal.
 * 7. **Workflow secret retirements** — behind no flag, because the queue holds
 *    credentials that are ALREADY orphaned, so cleanup must outlive the
 *    feature that filled it — and managed Cloud Run is where GCP Secret
 *    Manager is the default backend, so it is precisely where retirements are
 *    queued. Non-fatal: a queued row is never abandoned, the next run picks it
 *    up, and a failing sweep must not sink the reconciliation this job exists
 *    for.
 * 8. **Earn metrics refresh, then catalogue sync** (both gated on the two Earn
 *    flags). Refresh first — unslotted, this job's schedule IS its cadence —
 *    so a slow catalogue pass cannot eat the tick and leave rates stale;
 *    non-fatal because rates going one tick stale must not stop the sync.
 *    The sync's hourly cadence comes from the Redis slot inside
 *    `runEarnCatalogueSyncIfDue`, not this job's schedule. Sync is fatal.
 *
 * @returns Resolves when every due tick ran clean; rejects after every tick
 * has run with the sole fatal failure, or an AggregateError of all of them.
 */
export async function runCronJob(): Promise<void> {
  const env = getProcessEnv();
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required for the reconciliation job");
  }
  if (!env.REDIS_URL?.trim()) {
    throw new Error("REDIS_URL is required for the reconciliation job");
  }
  assertCustodyEncryptionScheme(env);
  getManagedReconciliationCron(env);
  getManagedReconciliationMaxRuntimeMinutes(env);
  assertSigningProviderAllowed(env);

  let probeRpc: ReturnType<typeof solanaRpc.createRpc> | null = null;
  try {
    probeRpc = solanaRpc.createRpc(env, { requestTimeoutMs: 5_000 });
  } catch {
    // No RPC endpoint configured (some self-hosted setups): nothing to probe.
  }
  if (probeRpc) {
    const rpc = probeRpc;
    const egress = await waitForEgress({
      probe: () => rpc.getBlockHeight({ commitment: "confirmed" }).send(),
      deadlineMs: 120_000,
      intervalMs: 5_000,
    });
    if (egress.ready) {
      getLogger().info(
        { elapsed_ms: egress.elapsedMs, attempts: egress.attempts },
        "reconciliation job: egress ready"
      );
    } else {
      getLogger().error(
        { elapsed_ms: egress.elapsedMs, attempts: egress.attempts },
        "reconciliation job: egress warmup deadline reached, running ticks anyway"
      );
    }
  }

  const privateChannelsEnabled = isPrivateChannelsEnabled(env);
  const assetProfilesEnabled = isAssetProfilesEnabled(env);
  const earnEnabled = isEarnEnabled(env);

  try {
    const monitored = createManagedTickRunner();
    const failures: unknown[] = [];
    const collect = async (tick: Promise<unknown>) => {
      try {
        await tick;
      } catch (error) {
        failures.push(error);
      }
    };

    await collect(
      monitored(PENDING_TRANSFERS_MONITOR, async () => {
        const outcomes = await Promise.allSettled([
          (async () => {
            await trackPendingTransfers(env);
            await recoverApprovedWalletOperations(env);
          })(),
          reconcileSponsorshipBudgets(env),
        ]);
        throwCollected(rejectionReasons(outcomes), "pending-transfers tick had multiple failures");
      })
    );
    await collect(
      monitored(RECURRING_PAYMENTS_COLLECTION_MONITOR, () => collectDueRecurringPayments(env))
    );
    if (privateChannelsEnabled) {
      const outcomes = await Promise.allSettled([
        monitored(PENDING_DEPOSITS_MONITOR, () => trackPendingDeposits(env)),
        monitored(PENDING_WITHDRAWALS_MONITOR, () => trackPendingWithdrawals(env)),
      ]);
      failures.push(...rejectionReasons(outcomes));
    } else {
      await monitored(PENDING_DEPOSITS_MONITOR, async () => undefined);
      await monitored(PENDING_WITHDRAWALS_MONITOR, async () => undefined);
    }
    await collect(monitored(RINGS_INDEXING_MONITOR, () => pollRingsIndexing(env)));
    await collect(monitored(EARN_VAULT_MOVEMENTS_MONITOR, () => reconcileEarnVaultMovements(env)));
    if (assetProfilesEnabled) {
      await collect(monitored(WORKFLOW_EXECUTIONS_MONITOR, () => runDueWorkflowExecutions(env)));
    } else {
      await monitored(WORKFLOW_EXECUTIONS_MONITOR, async () => undefined);
    }
    await monitored(WORKFLOW_SECRET_RETIREMENTS_MONITOR, () =>
      retireOrphanedActionSecrets(env)
    ).catch(() => undefined);
    if (earnEnabled) {
      await monitored(EARN_METRICS_REFRESH_MONITOR, () =>
        runEarnMetricsRefreshTick(env, undefined)
      ).catch(() => undefined);
      await collect(
        runWithCronRunEvent(getManagedMonitorSlug(EARN_CATALOGUE_SYNC_MONITOR), () =>
          runEarnCatalogueSyncIfDue(env, undefined)
        )
      );
    } else {
      await monitored(EARN_METRICS_REFRESH_MONITOR, async () => undefined);
      await collect(
        runWithCronRunEvent(getManagedMonitorSlug(EARN_CATALOGUE_SYNC_MONITOR), () =>
          runEarnCatalogueSyncIfDue(env, undefined, { workEnabled: false })
        )
      );
    }
    throwCollected(failures, "reconciliation job had multiple tick failures");
  } finally {
    await Promise.allSettled([closeAllRedisClients(), closeDatabasePools()]);
  }
}

function createManagedTickRunner(): <T>(monitor: string, work: () => Promise<T>) => Promise<T> {
  return async <T>(monitor: string, work: () => Promise<T>): Promise<T> => {
    const monitorSlug = getManagedMonitorSlug(monitor);
    try {
      return await runWithCronRunEvent(monitorSlug, work);
    } catch (error) {
      getLogger().error(
        {
          monitor: monitorSlug,
          error: error instanceof Error ? error.message : String(error),
        },
        "reconciliation job: tick failed"
      );
      throw error;
    }
  };
}

export function getManagedMonitorSlug(monitor: string): string {
  const prefix = "sdp-api-";
  return `sdp-api-managed-${monitor.startsWith(prefix) ? monitor.slice(prefix.length) : monitor}`;
}

export function getManagedReconciliationCron(
  env: Pick<Env, "SDP_MANAGED_RECONCILIATION_CRON">
): string {
  const value = env.SDP_MANAGED_RECONCILIATION_CRON?.trim();
  if (!value) {
    throw new Error("SDP_MANAGED_RECONCILIATION_CRON is required for the reconciliation job");
  }
  if (value.split(/\s+/).length !== 5 || !validateCron(value)) {
    throw new Error("SDP_MANAGED_RECONCILIATION_CRON must be a valid crontab");
  }
  const parsed = parseCron(value);
  if (
    getMaximumMinuteGap(parsed.minute) > MAX_MANAGED_SCHEDULER_GAP_MINUTES ||
    parsed.hour.length !== 24 ||
    parsed.dayOfMonth.length !== 31 ||
    parsed.month.length !== 12 ||
    parsed.dayOfWeek.length !== 7
  ) {
    throw new Error(
      `SDP_MANAGED_RECONCILIATION_CRON must run at least once every ${MAX_MANAGED_SCHEDULER_GAP_MINUTES} minutes of every hour for the hourly Earn catalogue monitor`
    );
  }
  return value;
}

function getMaximumMinuteGap(minutes: readonly number[]): number {
  if (minutes.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...minutes].sort((left, right) => left - right);
  return Math.max(
    ...sorted.map((minute, index) => {
      const next = sorted[(index + 1) % sorted.length];
      return next > minute ? next - minute : next + 60 - minute;
    })
  );
}

function getManagedReconciliationMaxRuntimeMinutes(
  env: Pick<Env, "SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS">
): number {
  const seconds = Number(env.SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS?.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      "SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS must be a positive number for the reconciliation job"
    );
  }
  return Math.ceil(seconds / 60);
}

/**
 * Extracts the rejection reasons from a settled result set.
 *
 * @param outcomes - Settled results of a tick's concurrent tasks.
 * @returns The reasons of the rejected outcomes, in order.
 */
function rejectionReasons(outcomes: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
    .map((outcome) => outcome.reason);
}

/**
 * Rethrows collected failures: one propagates unchanged, several collapse into
 * an AggregateError so no cause is lost.
 *
 * @param reasons - Failure reasons collected while the ticks ran.
 * @param message - AggregateError message when more than one failure occurred.
 */
function throwCollected(reasons: readonly unknown[], message: string): void {
  if (reasons.length === 1) throw reasons[0];
  if (reasons.length > 1) throw new AggregateError(reasons, message);
}

/**
 * Renders one failure cause for the structured exit log, expanding nested
 * AggregateErrors recursively so a multi-leg tick's leaf causes are never
 * hidden inside the job-wide aggregate.
 *
 * @param cause - A failure reason collected while the ticks ran.
 * @returns The cause's message plus its stack or its recursively rendered
 * child causes.
 */
function describeCause(cause: unknown): Record<string, unknown> {
  if (cause instanceof AggregateError) {
    return { message: cause.message, causes: cause.errors.map(describeCause) };
  }
  if (cause instanceof Error) {
    return { message: cause.message, stack: cause.stack };
  }
  return { message: String(cause) };
}

export function describeCronFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof AggregateError)) return { error };
  return {
    error,
    causes: error.errors.map(describeCause),
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
