import { providerNotConfigured, type SdpEarnError } from "@sdp/earn/errors";
import { SdpRpcError } from "@sdp/rpc/errors";
// biome-ignore-start lint/style/noRestrictedImports: Earn's door names its cluster until Earn reads the cluster scope (HOO-1881)
import {
  createEarnClusterRpc,
  type EarnClusterRpcOptions,
  earnClusterEndpointUrls,
  proveEarnClusterEndpoint,
} from "@sdp/rpc/factory";
// biome-ignore-end lint/style/noRestrictedImports: the door's one importer ends here
import type { SolanaRpc } from "@sdp/rpc/solana";
import { GENESIS_HASH_BY_CLUSTER, type SolanaCluster } from "@sdp/types/well-known-tokens";

/**
 * Earn's only way to Solana. Every Earn read and send goes to the named cluster's managed pool,
 * the pool `createClusterRpc()` serves, and nothing resolves an endpoint from `SOLANA_RPC_URL`,
 * `SOLANA_<CLUSTER>_RPC_URL` or `SOLANA_NETWORK`: a deployment that serves both clusters by project
 * reaches mainnet for a production project, and a cluster without a pool fails closed instead of
 * reading the other one.
 *
 * Earn names the cluster (`earnClusterFor` of the project, strategy or row environment) because
 * anonymous Earn and the global Earn crons open no cluster scope yet (HOO-1881, HOO-2148). Inside
 * a scope, naming the other cluster throws `CLUSTER_SCOPE_CONFLICT`.
 */

/**
 * The managed pool client for `cluster`, for one-shot reads and every send: block heights,
 * signature statuses, history, blockhashes, lookup tables, simulation and broadcast. Per-request
 * failover and the pool's genesis guard apply; a send never fails over once it left SDP.
 *
 * @param cluster - The cluster the work runs on.
 * @param options - Pass `timeoutMs` to bound each request end to end.
 * @returns The memoized client for `cluster`.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when `cluster` has no managed endpoint.
 */
export function earnClusterRpc(cluster: SolanaCluster, options?: EarnClusterRpcOptions): SolanaRpc {
  return createEarnClusterRpc(cluster, options);
}

/**
 * The managed endpoints a provider operation pins, one per attempt, in failover order. Provider
 * packages build their own transports from these URLs, so each must pass `assertClusterEndpoint`
 * first. Empty when `cluster` has no managed pool (raise `earnPoolNotConfigured`); never another
 * cluster's endpoints.
 *
 * @param cluster - The cluster the operation runs on.
 * @returns The pool's endpoint URLs, possibly none.
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
