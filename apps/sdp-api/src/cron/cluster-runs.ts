import { runInClusterScope } from "@sdp/rpc/scope";
import { SDP_ENVIRONMENTS } from "@sdp/types";
import { describeError, logEvent } from "@/runtime/money-path-events";

/**
 * Run a chain-touching job once per environment, each run inside that environment's cluster
 * scope with no project, so the job reads the cluster from the scope and selects only its own
 * environment's rows. The runs are concurrent and independent: a provider outage on one cluster
 * never stalls or skips the other. Job bodies never open a scope; the one exception is the Earn
 * catalogue crons (`earn-catalogue-sync.ts`, `earn-metrics-refresh.ts`), which span both
 * clusters in one pass and open each environment's scope in turn around its chain reads.
 *
 * @param job - The job's name, carried on the per-cluster failure event.
 * @param work - The job body; it runs once per environment.
 * @returns Resolves when every environment's run has settled.
 * @throws The failing run's error when one run fails; an `AggregateError` when both do.
 */
export async function runPerCluster(job: string, work: () => Promise<void>): Promise<void> {
  const outcomes = await Promise.allSettled(
    SDP_ENVIRONMENTS.map(async (environment) => {
      try {
        await runInClusterScope({ projectId: null, environment }, work);
      } catch (error) {
        logEvent("error", {
          event: "sdp_api_cluster_job_run_failed",
          job,
          environment,
          ...describeError(error),
        });
        throw error;
      }
    })
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${job} failed on more than one cluster`);
  }
}
