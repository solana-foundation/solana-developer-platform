import { runInClusterScope } from "@sdp/rpc/scope";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";

/**
 * Run chain-touching job work for one environment, inside that environment's cluster scope
 * (ADR 0007, Jobs). The Worker opens one per registration of a `cluster` Cron Definition, so
 * the work selects only that environment's rows and reads the chain through
 * `createClusterRpc()`; the global catalogue sync opens one per lane fetch.
 *
 * @param environment - The environment whose cluster the work runs on.
 * @param work - The job work, reading the open scope through `currentClusterScope()`.
 * @returns What the work resolves to; a scope conflict rejects instead of throwing.
 */
export async function runInEnvironmentClusterScope<TResult>(
  environment: SdpEnvironment,
  work: () => Promise<TResult>
): Promise<TResult> {
  return runInClusterScope({ projectId: null, environment }, work);
}

/**
 * Run one chain-touching job once per environment, each run inside that environment's cluster
 * scope. Every run settles before failures are rethrown, a scope conflict included: one
 * propagates unchanged, several collapse into an AggregateError.
 *
 * @param work - The job work, reading the open scope through `currentClusterScope()`.
 * @returns Resolves once every environment's run has succeeded.
 */
export async function runInEachClusterScope(work: () => Promise<void>): Promise<void> {
  const outcomes = await Promise.allSettled(
    SDP_ENVIRONMENTS.map((environment) => runInEnvironmentClusterScope(environment, work))
  );
  const reasons = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
    .map((outcome) => outcome.reason);
  if (reasons.length === 1) throw reasons[0];
  if (reasons.length > 1) throw new AggregateError(reasons, "per-cluster job runs failed");
}
