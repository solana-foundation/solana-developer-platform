import { runInClusterScope } from "@sdp/rpc/scope";
import { SDP_ENVIRONMENTS } from "@sdp/types";
import { describeError, logEvent } from "@/runtime/money-path-events";

/**
 * Run a chain-touching job once per environment, each run inside that environment's cluster
 * scope with no project, so the job reads the cluster from the scope and selects only its own
 * environment's rows. The runs are concurrent and independent: a provider outage on one cluster
 * never stalls or skips the other. This is the only place a job's cluster scope is opened; job
 * bodies never open one.
 *
 * @param job - The job's name, carried on the per-cluster failure event.
 * @param work - The job body; it runs once per environment.
 * @returns Resolves when every environment's run has settled.
 * @throws The failing run's error when one run fails; an `AggregateError` when both do.
 */
export async function runPerCluster(job: string, work: () => Promise<void>): Promise<void> {
  const outcomes = await Promise.allSettled(
    SDP_ENVIRONMENTS.map((environment) =>
      runInClusterScope({ projectId: null, environment }, work).catch((error: unknown) => {
        logEvent("error", {
          event: "sdp_api_cluster_job_run_failed",
          job,
          environment,
          ...describeError(error),
        });
        throw error;
      })
    )
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${job} failed on more than one cluster`);
  }
}
