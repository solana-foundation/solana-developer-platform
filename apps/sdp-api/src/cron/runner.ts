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
import {
  isAssetProfilesEnabled,
  isEarnEnabled,
  isPrivateChannelsEnabled,
  isRecurringPaymentCollectionEnabled,
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

  tasks.push(
    schedule(APPROVED_WALLET_OPERATIONS_CRON, () => {
      if (stopping) {
        return;
      }
      runApprovedWalletOperationRecovery({
        env: deps.env,
        bg: deps.bg,
        observability: deps.observability,
      });
    })
  );

  tasks.push(
    schedule(PENDING_TRANSFERS_CRON, () => {
      if (stopping) {
        return;
      }
      runPendingTransfersReconciliation({
        env: deps.env,
        bg: deps.bg,
        observability: deps.observability,
      });
    })
  );

  if (isRecurringPaymentCollectionEnabled(deps.env)) {
    tasks.push(
      schedule(RECURRING_PAYMENTS_COLLECTION_CRON, () => {
        if (stopping) {
          return;
        }
        runRecurringPaymentsCollection({
          env: deps.env,
          bg: deps.bg,
          observability: deps.observability,
        });
      })
    );
  }

  if (isAssetProfilesEnabled(deps.env)) {
    tasks.push(
      schedule(WORKFLOW_EXECUTIONS_CRON, () => {
        if (stopping) {
          return;
        }
        runWorkflowExecutions({
          env: deps.env,
          bg: deps.bg,
          observability: deps.observability,
        });
      })
    );
  }

  if (isPrivateChannelsEnabled(deps.env)) {
    tasks.push(
      schedule(PENDING_DEPOSITS_CRON, () => {
        if (stopping) {
          return;
        }
        runPendingDepositsReconciliation({
          env: deps.env,
          bg: deps.bg,
          observability: deps.observability,
        });
      })
    );
    tasks.push(
      schedule(PENDING_WITHDRAWALS_CRON, () => {
        if (stopping) {
          return;
        }
        runPendingWithdrawalsReconciliation({
          env: deps.env,
          bg: deps.bg,
          observability: deps.observability,
        });
      })
    );
  }

  if (isEarnEnabled(deps.env)) {
    tasks.push(
      schedule(EARN_CATALOGUE_SYNC_CRON, () => {
        if (stopping) {
          return;
        }
        runEarnCatalogueSync({
          env: deps.env,
          bg: deps.bg,
          observability: deps.observability,
        });
      })
    );
    // Separate task, not folded into the sync above: the two have different
    // cadences on purpose (catalogue drift is hourly, rates are not) and
    // different blast radii — this one can only rewrite figures on rows that
    // already exist. See cron/earn-metrics-refresh.ts.
    tasks.push(
      schedule(EARN_METRICS_REFRESH_CRON, () => {
        if (stopping) {
          return;
        }
        runEarnMetricsRefresh({
          env: deps.env,
          bg: deps.bg,
          observability: deps.observability,
        });
      })
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
    schedule(WORKFLOW_SECRET_RETIREMENTS_CRON, () => {
      if (stopping) {
        return;
      }
      runWorkflowSecretRetirements({
        env: deps.env,
        bg: deps.bg,
        observability: deps.observability,
      });
    })
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
