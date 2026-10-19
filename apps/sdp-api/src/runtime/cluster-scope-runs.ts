import { runInClusterScope } from "@sdp/rpc/scope";
import { SDP_ENVIRONMENTS } from "@sdp/types/api-keys";

/**
 * Run one chain-touching job once per environment, each run inside that environment's cluster
 * scope (ADR 0007, Jobs). The work selects only its environment's rows and reads the chain through
 * `createClusterRpc()`, so a Production row is never read on devnet, and one cluster's failure
 * leaves the other cluster's run intact. Every run settles before failures are rethrown, a scope
 * conflict included: one propagates unchanged, several collapse into an AggregateError.
 *
 * @param work - The job work, reading the open scope through `currentClusterScope()`.
 * @returns Resolves once every environment's run has succeeded.
 */
export async function runInEachClusterScope(work: () => Promise<void>): Promise<void> {
  const outcomes = await Promise.allSettled(
    SDP_ENVIRONMENTS.map(async (environment) =>
      runInClusterScope({ projectId: null, environment }, work)
    )
  );
  const reasons = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
    .map((outcome) => outcome.reason);
  if (reasons.length === 1) throw reasons[0];
  if (reasons.length > 1) throw new AggregateError(reasons, "per-cluster job runs failed");
}
