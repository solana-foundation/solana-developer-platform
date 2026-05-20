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
import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";
import { PENDING_TRANSFERS_CRON, runPendingTransfersReconciliation } from "./pending-transfers";

export interface CronDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export interface CronHandle {
  stop(): void | Promise<void>;
}

const TRUTHY_DISABLE_CRON: ReadonlySet<string> = new Set(["true", "1"]);

function isCronDisabled(env: Env): boolean {
  const raw = env.DISABLE_CRON?.trim().toLowerCase();
  return raw !== undefined && TRUTHY_DISABLE_CRON.has(raw);
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

  const task: ScheduledTask = schedule(PENDING_TRANSFERS_CRON, () => {
    if (stopping) {
      return;
    }
    runPendingTransfersReconciliation({
      env: deps.env,
      bg: deps.bg,
      observability: deps.observability,
    });
  });

  return {
    stop() {
      stopping = true;
      return task.stop();
    },
  };
}
