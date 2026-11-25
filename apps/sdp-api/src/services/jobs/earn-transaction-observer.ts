import type { SdpEnvironment } from "@sdp/types/api-keys";
import { logCronRun } from "@/cron/run-event";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import type { BackgroundRunner } from "@/runtime/background";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import type { Env } from "@/types/env";
import { observeEarnTransactions } from "./observe-earn-transactions";

interface EnvironmentLane {
  tasks: Set<Promise<void>>;
  timer: ReturnType<typeof setTimeout> | null;
  notified: boolean;
  saturatedRetry: boolean;
}

/** Notifications wake bounded, competing batches; a slow pass leaves room for fresh work. */
export function startEarnTransactionObserver(
  env: Env,
  bg: BackgroundRunner,
  environments: readonly SdpEnvironment[]
): { wake(environment: SdpEnvironment): void; stop(): Promise<void> } {
  const lanes = new Map<SdpEnvironment, EnvironmentLane>(
    environments.map((environment) => [
      environment,
      { tasks: new Set(), timer: null, notified: false, saturatedRetry: false },
    ])
  );
  let stopped = false;

  function wake(environment: SdpEnvironment): void {
    const lane = lanes.get(environment);
    if (stopped || bg.draining || lane === undefined) return;
    if (lane.timer !== null) {
      clearTimeout(lane.timer);
      lane.timer = null;
    }
    if (lane.tasks.size >= 2) {
      lane.notified = true;
      return;
    }
    lane.notified = false;
    let delay: number | null = null;
    const startedAt = Date.now();
    const run = async () => {
      try {
        const result = await runWithSystemDatabaseIdentity("cron:earn-transaction-observer", () =>
          runInEnvironmentClusterScope(environment, () => observeEarnTransactions(env))
        );
        if (result.claimed > 0 || result.saturated) {
          lane.saturatedRetry = result.saturated;
          delay = result.saturated ? 0 : 250;
        } else if (lane.saturatedRetry) {
          // A drained page can be empty only because its pending rows are due in 250ms.
          lane.saturatedRetry = false;
          delay = 250;
        }
      } catch (error) {
        logCronRun(
          { cron: "reconcile-earn-vault-movements", environment },
          {
            status: "error",
            durationMs: Date.now() - startedAt,
            cause: error,
          }
        );
        delay = 2_000;
      }
    };
    const task = run().finally(() => {
      lane.tasks.delete(task);
      const nextDelay = lane.notified ? 0 : delay;
      if (!stopped && !bg.draining && nextDelay !== null) {
        if (lane.timer !== null) clearTimeout(lane.timer);
        lane.timer = setTimeout(() => wake(environment), nextDelay);
        lane.timer.unref();
      }
    });
    lane.tasks.add(task);
    bg.run(task);
  }

  return {
    wake,
    async stop() {
      stopped = true;
      for (const lane of lanes.values()) if (lane.timer !== null) clearTimeout(lane.timer);
      await Promise.all([...lanes.values()].flatMap((lane) => [...lane.tasks]));
    },
  };
}
