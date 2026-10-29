import { providerNotConfigured, type SdpEarnError } from "@sdp/earn/errors";
import { SdpRpcError } from "@sdp/rpc/errors";
// biome-ignore-start lint/style/noRestrictedImports: Earn's provider packages take endpoint URLs until they take clients (HOO-1881)
import { earnClusterEndpointUrls, proveEarnClusterEndpoint } from "@sdp/rpc/factory";
// biome-ignore-end lint/style/noRestrictedImports: the URL helpers' one importer ends here
import { GENESIS_HASH_BY_CLUSTER, type SolanaCluster } from "@sdp/types/well-known-tokens";

/**
 * Earn's endpoint URLs for its provider packages. Every other Earn read and send goes through
 * `createClusterRpc()` in the open cluster scope: the project's for a request, the registration's
 * for a cron, the lane's for the catalogue sync.
 * Provider packages still build their own transports from a URL and name the cluster their plan
 * targets (HOO-1881), so these helpers hand them the scope's pool URLs and refuse a provider that
 * asks for the other cluster (`CLUSTER_SCOPE_CONFLICT`). Nothing resolves an endpoint from
 * `SOLANA_RPC_URL`, `SOLANA_<CLUSTER>_RPC_URL` or `SOLANA_NETWORK`, and a cluster without a pool
 * fails closed.
 */

/**
 * The managed endpoints a provider operation pins, one per attempt, in failover order. Provider
 * packages build their own transports from these URLs, so each must pass `assertClusterEndpoint`
 * first. Empty when the scope's cluster has no managed pool (raise `earnPoolNotConfigured`); never
 * another cluster's endpoints.
 *
 * @param cluster - The cluster the provider asked for; it must be the scope's.
 * @returns The pool's endpoint URLs, possibly none.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope, `CLUSTER_SCOPE_CONFLICT` when
 *   the scope serves the other cluster.
 */
export function earnProviderEndpointUrls(cluster: SolanaCluster): readonly string[] {
  return earnClusterEndpointUrls(cluster);
}

function clusterEnvSuffix(cluster: SolanaCluster): string {
  return cluster === "devnet" ? "DEVNET" : "MAINNET";
}

/**
 * The refusal for a provider operation on a cluster whose managed pool has no endpoint.
 *
 * @param cluster - The cluster the operation runs on.
 * @returns A `PROVIDER_NOT_CONFIGURED` error naming the pool keys to set.
 */
export function earnPoolNotConfigured(cluster: SolanaCluster): SdpEarnError {
  return providerNotConfigured(
    `No Solana RPC endpoint is configured for ${cluster}. Configure its managed pool ` +
      `(SOLANA_RPC_<PROVIDER>_${clusterEnvSuffix(cluster)}_API_KEY_URL).`
  );
}

/**
 * Refuse to build against an endpoint that has not proved it serves `cluster`.
 *
 * A cluster mismatch does not surface as an error on its own: Kamino's mainnet kvault program id
 * also resolves on devnet with no accounts under it, so the failure mode is "this vault does not
 * exist", or a transaction built for the wrong deployment. Called before every provider build and
 * position read. The proof shares the managed pool's genesis cache, so an endpoint the pool proved
 * in the last 30 s costs no probe here.
 *
 * @param cluster - The cluster the endpoint must serve.
 * @param rpcUrl - One of `earnProviderEndpointUrls(cluster)`.
 * @throws SdpEarnError `PROVIDER_NOT_CONFIGURED` when the probe fails or the endpoint serves
 * another cluster. A failed probe keeps its error as the cause, so the provider failover can
 * tell a transient one (node unhealthy, timeout) and try the next endpoint; a cluster mismatch
 * carries none and stops it.
 */
export async function assertClusterEndpoint(cluster: SolanaCluster, rpcUrl: string): Promise<void> {
  try {
    await proveEarnClusterEndpoint(cluster, rpcUrl);
  } catch (cause) {
    if (cause instanceof SdpRpcError && cause.code === "RPC_CLUSTER_MISMATCH") {
      throw providerNotConfigured(
        `The RPC endpoint configured for ${cluster} reports genesis ` +
          `${String(cause.details?.genesisHash)}, not ${GENESIS_HASH_BY_CLUSTER[cluster]}. ` +
          "Building against it would address the wrong chain, so SDP refuses. Point " +
          `SOLANA_RPC_<PROVIDER>_${clusterEnvSuffix(cluster)}_API_KEY_URL at a ${cluster} endpoint.`
      );
    }
    throw providerNotConfigured(
      `Could not verify that the configured ${cluster} RPC endpoint serves ${cluster}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}
