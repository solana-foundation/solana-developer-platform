import type { SdpEnvironment } from "@sdp/types/api-keys";
import { logCronRun } from "@/cron/run-event";
import type { BackgroundRunner } from "@/runtime/background";
import { startEarnWorkerTelemetry } from "./earn-worker-telemetry";
import type { observeEarnTransactions } from "./observe-earn-transactions";

interface EnvironmentLane {
  tasks: Set<Promise<void>>;
  timer: ReturnType<typeof setTimeout> | null;
  notified: boolean;
  saturatedRetry: boolean;
}

/** Notifications wake bounded, competing batches; a slow pass leaves room for fresh work. */
export function startEarnTransactionObserver(
  bg: BackgroundRunner,
  environments: readonly SdpEnvironment[],
  observe: (environment: SdpEnvironment) => ReturnType<typeof observeEarnTransactions>
): { wake(environment: SdpEnvironment): void; stop(): Promise<void> } {
  const lanes = new Map<SdpEnvironment, EnvironmentLane>(
    environments.map((environment) => [
      environment,
      { tasks: new Set(), timer: null, notified: false, saturatedRetry: false },
    ])
  );
  let stopped = false;
  const telemetry = startEarnWorkerTelemetry("observer", environments, (environment) => ({
    active: lanes.get(environment)?.tasks.size ?? 0,
  }));

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
        const result = await observe(environment);
        telemetry.completed(environment);
        if (result.claimed > 0 || result.saturated) {
          lane.saturatedRetry = result.saturated;
          delay = result.saturated ? 0 : 250;
        } else if (lane.saturatedRetry) {
          // A drained page can be empty only because its pending rows are due in 250ms.
          lane.saturatedRetry = false;
          delay = 250;
        }
      } catch (error) {
        telemetry.failed(environment);
        logCronRun(
          { cron: "earn-transaction-observer", environment, worker: "observer" },
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
      telemetry.stop();
      for (const lane of lanes.values()) if (lane.timer !== null) clearTimeout(lane.timer);
      await Promise.all([...lanes.values()].flatMap((lane) => [...lane.tasks]));
    },
  };
}
