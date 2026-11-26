import { runInClusterScope } from "@sdp/rpc/scope";
import { SDP_ENVIRONMENT_BY_CLUSTER, type SolanaCluster } from "@sdp/types/well-known-tokens";

/** Run `operation` in the cluster scope a request on `cluster` opens, as provider calls need. */
export function inClusterScope<TResult>(cluster: SolanaCluster, operation: () => TResult): TResult {
  return runInClusterScope(
    { projectId: null, environment: SDP_ENVIRONMENT_BY_CLUSTER[cluster] },
    operation
  );
}
