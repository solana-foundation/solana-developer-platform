import type { SdpEnvironment } from "@sdp/types/api-keys";
import { logCronRun } from "@/cron/run-event";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { listenForOperationNotifications } from "@/db/operation-notifications";
import type { BackgroundRunner } from "@/runtime/background";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import { getLogger, runWithLogContext } from "@/runtime/logger";
import { createOperationObservationRpc } from "@/services/earn/operation-observation-rpc";
import { createOperationsService } from "@/services/operations.service";
import type { Env } from "@/types/env";
import { recoverOperationClaim } from "./reconcile-operations";

const OPERATION_WORKER_CONCURRENCY = 4;
const OBSERVATION_WINDOW_MS = 25;

interface EnvironmentConsumer {
  generation: number;
  tasks: Set<Promise<void>>;
  observations?: { expiresAt: number; rpc: ReturnType<typeof createOperationObservationRpc> };
}

/** Batch concurrent claims without retaining a continuous worker's old height snapshots. */
function observationBatch(consumer: EnvironmentConsumer) {
  const now = Date.now();
  if (consumer.observations === undefined || consumer.observations.expiresAt <= now) {
    consumer.observations = {
      expiresAt: now + OBSERVATION_WINDOW_MS,
      rpc: createOperationObservationRpc(),
    };
  }
  return consumer.observations.rpc;
}

/** The same pool is woken by commit notifications, startup/reconnect and scheduled recovery. */
export interface OperationWorker {
  wake(environment: SdpEnvironment): void;
  stop(): Promise<void>;
}

/**
 * Continuously drain the database outbox with bounded competing consumers. A slow signer owns
 * one slot; free slots accept fresh notifications without waiting for that signer or a cron run.
 */
export function startOperationWorker(
  env: Env,
  bg: BackgroundRunner,
  environments: readonly SdpEnvironment[],
  options: { wakeObserver?: (environment: SdpEnvironment) => void } = {}
): OperationWorker {
  let stopping = false;
  const consumers = new Map<SdpEnvironment, EnvironmentConsumer>(
    environments.map((environment) => [environment, { generation: 0, tasks: new Set() }])
  );

  async function consume(
    environment: SdpEnvironment,
    consumer: EnvironmentConsumer,
    observation: { generation: number }
  ): Promise<void> {
    await runWithLogContext({ cron: "reconcile-operations" }, () =>
      runWithSystemDatabaseIdentity("cron:reconcile-operations", () =>
        runInEnvironmentClusterScope(environment, async () => {
          const service = createOperationsService(env);
          while (!stopping) {
            const generation = consumer.generation;
            observation.generation = generation;
            const next = await service.repository.claimNextRecovery(environment);
            if (next === null) {
              // A commit hint arriving during the empty claim must get another scan.
              if (generation !== consumer.generation) continue;
              return;
            }
            if (stopping) {
              await service.repository.release(next.scope, next.claim);
              return;
            }
            const startedAt = Date.now();
            const advanced = await recoverOperationClaim(
              env,
              next.scope,
              next.claim,
              observationBatch(consumer)
            );
            if (!advanced) {
              logCronRun(
                { cron: "reconcile-operations", environment },
                {
                  status: "error",
                  durationMs: Date.now() - startedAt,
                  cause: new Error(
                    "An accepted operation could not advance; recovery remains scheduled"
                  ),
                }
              );
            }
          }
        })
      )
    );
  }

  function startFreeConsumers(environment: SdpEnvironment, consumer: EnvironmentConsumer): void {
    if (stopping || bg.draining) return;
    while (consumer.tasks.size < OPERATION_WORKER_CONCURRENCY) {
      const observation = { generation: consumer.generation };
      const startedAt = Date.now();
      const task = consume(environment, consumer, observation)
        .catch((error) => {
          observation.generation = consumer.generation;
          logCronRun(
            { cron: "reconcile-operations", environment },
            { status: "error", durationMs: Date.now() - startedAt, cause: error }
          );
        })
        .finally(() => {
          consumer.tasks.delete(task);
          // Close the race between an empty claim returning and this slot being freed.
          if (observation.generation !== consumer.generation)
            startFreeConsumers(environment, consumer);
        });
      consumer.tasks.add(task);
      bg.run(task);
    }
  }

  function wake(environment: SdpEnvironment): void {
    const consumer = consumers.get(environment);
    if (stopping || consumer === undefined || bg.draining) return;
    options.wakeObserver?.(environment);
    consumer.generation += 1;
    startFreeConsumers(environment, consumer);
  }

  const listener = listenForOperationNotifications(env, {
    wake,
    connected: () => {
      for (const environment of environments) wake(environment);
    },
    failed: (error) => {
      getLogger().error(
        { error },
        "Operation notifications unavailable; scheduled recovery remains active"
      );
    },
    track: (work) => bg.run(work),
  });

  return {
    wake,
    async stop() {
      stopping = true;
      await listener.stop();
      await Promise.allSettled([...consumers.values()].flatMap((consumer) => [...consumer.tasks]));
    },
  };
}
