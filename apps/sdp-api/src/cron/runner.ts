/**
 * node-cron wrapper for the API runtime. Schedules reconciliation through the
 * shared helpers so observability and background tracking are wired
 * consistently.
 *
 * Cloud Run services skip registration by default, leaving reconciliation to
 * the dedicated Cloud Run job rather than firing once per web replica.
 * `DISABLE_CRON=false` explicitly opts a service back in; self-hosted runtimes
 * keep the historical enabled-by-default behavior.
 */

import { type ScheduledTask, schedule } from "node-cron";
import { runWithSystemDatabaseIdentity } from "@/db";
import {
  isAssetProfilesEnabled,
  isEarnEnabled,
  isPrivateChannelsEnabled,
} from "@/lib/feature-flags";
import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";
import {
  APPROVED_WALLET_OPERATIONS_CRON,
  runApprovedWalletOperationRecovery,
} from "./approved-wallet-operations";
import { EARN_CATALOGUE_SYNC_CRON, runEarnCatalogueSync } from "./earn-catalogue-sync";
import { EARN_METRICS_REFRESH_CRON, runEarnMetricsRefresh } from "./earn-metrics-refresh";
import {
  EARN_VAULT_MOVEMENTS_CRON,
  runEarnVaultMovementsReconciliation,
} from "./earn-vault-movements";
import { PENDING_DEPOSITS_CRON, runPendingDepositsReconciliation } from "./pending-deposits";
import { PENDING_TRANSFERS_CRON, runPendingTransfersReconciliation } from "./pending-transfers";
import {
  PENDING_WITHDRAWALS_CRON,
  runPendingWithdrawalsReconciliation,
} from "./pending-withdrawals";
import {
  RECURRING_PAYMENTS_COLLECTION_CRON,
  runRecurringPaymentsCollection,
} from "./recurring-payments";
import { RINGS_INDEXING_CRON, runRingsIndexingPoll } from "./rings-indexing";
import { runWorkflowExecutions, WORKFLOW_EXECUTIONS_CRON } from "./workflow-executions";
import {
  runWorkflowSecretRetirements,
  WORKFLOW_SECRET_RETIREMENTS_CRON,
} from "./workflow-secret-retirements";

export interface CronDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export interface CronHandle {
  stop(): void | Promise<void>;
}

const TRUTHY_DISABLE_CRON: ReadonlySet<string> = new Set(["true", "1"]);
const FALSY_DISABLE_CRON: ReadonlySet<string> = new Set(["false", "0"]);

// Strict whitelist so a typo (`DISABLE_CRON=treu`) fails loudly instead of
// silently enabling cron and double-firing across replicas.
function isCronDisabled(env: Env): boolean {
  const raw = env.DISABLE_CRON;
  if (raw === undefined) {
    return Boolean(env.K_SERVICE);
  }
  const normalised = raw.trim().toLowerCase();
  if (TRUTHY_DISABLE_CRON.has(normalised)) {
    return true;
  }
  if (FALSY_DISABLE_CRON.has(normalised)) {
    return false;
  }
  throw new Error(
    `Invalid DISABLE_CRON: ${JSON.stringify(raw)} (expected 'true', 'false', '1', or '0')`
  );
}

export function startCron(deps: CronDeps): CronHandle | null {
  if (isCronDisabled(deps.env)) {
    return null;
  }

  // node-cron's `task.stop()` halts future scheduling but doesn't promise
  // to interrupt a tick already mid-flight. A `stopping` flag short-circuits
  // any callback that fires concurrent with shutdown so no extra background
  // work gets registered after the awaitAll() snapshot is taken.
  let stopping = false;

  const tasks: ScheduledTask[] = [];

  // Every tick runs under a named system database identity: reconciliation is
  // inherently cross-tenant, and row-level security (migration 0063) denies
  // database access to any workload that never declared one.
  const scheduleSystemTask = (
    cronExpression: string,
    component: string,
    run: (deps: CronDeps) => void
  ): ScheduledTask =>
    schedule(cronExpression, () => {
      if (stopping) {
        return;
      }
      runWithSystemDatabaseIdentity(component, () =>
        run({
          env: deps.env,
          bg: deps.bg,
          observability: deps.observability,
        })
      );
    });

  tasks.push(
    scheduleSystemTask(
      APPROVED_WALLET_OPERATIONS_CRON,
      "cron:approved-wallet-operations",
      runApprovedWalletOperationRecovery
    )
  );

  tasks.push(
    scheduleSystemTask(
      PENDING_TRANSFERS_CRON,
      "cron:pending-transfers",
      runPendingTransfersReconciliation
    )
  );

  tasks.push(
    scheduleSystemTask(
      RECURRING_PAYMENTS_COLLECTION_CRON,
      "cron:recurring-payments",
      runRecurringPaymentsCollection
    )
  );

  if (isAssetProfilesEnabled(deps.env)) {
    tasks.push(
      scheduleSystemTask(
        WORKFLOW_EXECUTIONS_CRON,
        "cron:workflow-executions",
        runWorkflowExecutions
      )
    );
  }

  if (isPrivateChannelsEnabled(deps.env)) {
    tasks.push(
      scheduleSystemTask(
        PENDING_DEPOSITS_CRON,
        "cron:pending-deposits",
        runPendingDepositsReconciliation
      )
    );
    tasks.push(
      scheduleSystemTask(
        PENDING_WITHDRAWALS_CRON,
        "cron:pending-withdrawals",
        runPendingWithdrawalsReconciliation
      )
    );
  }

  // Cheap to schedule unconditionally: the job early-returns unless the rings
  // flag is on and the live gateway adapter is selected.
  tasks.push(
    schedule(RINGS_INDEXING_CRON, () => {
      if (stopping) {
        return;
      }
      runRingsIndexingPoll({
        env: deps.env,
        bg: deps.bg,
        observability: deps.observability,
      });
    })
  );

  if (isEarnEnabled(deps.env)) {
    tasks.push(
      scheduleSystemTask(EARN_CATALOGUE_SYNC_CRON, "cron:earn-catalogue-sync", runEarnCatalogueSync)
    );
    // Separate task, not folded into the sync above: the two have different
    // cadences on purpose (catalogue drift is hourly, rates are not) and
    // different blast radii — this one can only rewrite figures on rows that
    // already exist. See cron/earn-metrics-refresh.ts.
    tasks.push(
      scheduleSystemTask(
        EARN_METRICS_REFRESH_CRON,
        "cron:earn-metrics-refresh",
        runEarnMetricsRefresh
      )
    );
  }

  // Deliberately outside every feature gate, and in particular outside the asset-profiles
  // block above. The queue this drains is durable and outlives the feature that filled
  // it: a rule's signing-secret version is already orphaned by the time a row exists —
  // the rule is gone, nothing references the version, and it stays readable in the
  // backend until something destroys it. Riding on the workflow tick meant turning asset
  // profiles off stranded that cleanup permanently, which is the opposite of what
  // disabling a feature should do (and disabling it is a plausible incident response,
  // exactly when the cleanup matters most). The sweep is a no-op on the empty queue every
  // other deployment has.
  tasks.push(
    scheduleSystemTask(
      WORKFLOW_SECRET_RETIREMENTS_CRON,
      "cron:workflow-secret-retirements",
      runWorkflowSecretRetirements
    )
  );

  // Durable signed intents outlive the feature flag that admitted them. Keep
  // draining their outbox even when Earn is disabled during an incident.
  tasks.push(
    scheduleSystemTask(
      EARN_VAULT_MOVEMENTS_CRON,
      "cron:earn-vault-movements",
      runEarnVaultMovementsReconciliation
    )
  );

  return {
    stop() {
      stopping = true;
      for (const task of tasks) {
        task.stop();
      }
    },
  };
}
