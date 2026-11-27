import type { SdpEnvironment } from "@sdp/types/api-keys";
import { logEvent } from "@/runtime/money-path-events";

/** One summary per minute and environment, independent of a worker's pending promises. */
export function startEarnWorkerTelemetry(
  worker: "operations" | "observer",
  environments: readonly SdpEnvironment[],
  state: (environment: SdpEnvironment) => { active: number; listener_connected?: boolean }
) {
  const counters = new Map(
    environments.map((environment) => [
      environment,
      { completed: 0, errors: 0, lastCompleted: Date.now(), pickups: 0, pickupMaxMs: 0 },
    ])
  );
  const timer = setInterval(() => {
    for (const [environment, counter] of counters) {
      logEvent("info", {
        event: "sdp_api_earn_worker_health",
        worker,
        environment,
        ...state(environment),
        completed: counter.completed,
        errors: counter.errors,
        last_completed_age_seconds: Math.max(0, (Date.now() - counter.lastCompleted) / 1_000),
        pickups: counter.pickups,
        pickup_delay_max_ms: counter.pickupMaxMs,
      });
      counter.completed = 0;
      counter.errors = 0;
      counter.pickups = 0;
      counter.pickupMaxMs = 0;
    }
  }, 60_000);
  timer.unref();
  return {
    completed(environment: SdpEnvironment) {
      const counter = counters.get(environment);
      if (counter === undefined) return;
      counter.completed += 1;
      counter.lastCompleted = Date.now();
    },
    failed(environment: SdpEnvironment) {
      const counter = counters.get(environment);
      if (counter !== undefined) counter.errors += 1;
    },
    pickedUp(environment: SdpEnvironment, requestedAt: string) {
      const counter = counters.get(environment);
      if (counter === undefined) return;
      counter.pickups += 1;
      counter.pickupMaxMs = Math.max(counter.pickupMaxMs, Date.now() - Date.parse(requestedAt), 0);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
