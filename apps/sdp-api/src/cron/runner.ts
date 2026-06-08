/**
 * node-cron wrapper for the Node runtime. Schedules the same reconciliation
 * job that the Cloudflare `scheduled` handler triggers, going through the
 * shared `runPendingTransfersReconciliation` so observability and background
 * tracking are wired identically across runtimes.
 *
 * `DISABLE_CRON=true` skips registration entirely, leaving the process free
 * to run as one of many web replicas without firing the reconciliation N
 * times per minute. A distributed lock would let every replica schedule
 * safely; until that lands, single-replica + DISABLE_CRON elsewhere is the
 * agreed-upon strategy.
 */

import { type ScheduledTask, schedule } from "node-cron";
import {
  isRecurringPaymentCollectionEnabled,
  isRecurringPaymentsEnabled,
} from "@/lib/feature-flags";
import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";
import { PENDING_TRANSFERS_CRON, runPendingTransfersReconciliation } from "./pending-transfers";
import {
  RECURRING_PAYMENTS_COLLECTION_CRON,
  runRecurringPaymentsCollection,
} from "./recurring-payments";

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
    return false;
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

  const pendingTransfersTask: ScheduledTask = schedule(PENDING_TRANSFERS_CRON, () => {
    if (stopping) {
      return;
    }
    runPendingTransfersReconciliation({
      env: deps.env,
      bg: deps.bg,
      observability: deps.observability,
    });
  });
  const tasks: ScheduledTask[] = [pendingTransfersTask];

  if (isRecurringPaymentsEnabled(deps.env) && isRecurringPaymentCollectionEnabled(deps.env)) {
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

  return {
    async stop() {
      stopping = true;
      await Promise.all(tasks.map((task) => Promise.resolve(task.stop())));
    },
  };
}
