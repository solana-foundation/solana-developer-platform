import type { OrganizationRpcProvider, SolanaCluster } from "@sdp/types";
import { type ManagedRpcEndpoint, managedRpcEndpoints } from "./factory";
import { currentClusterScope } from "./scope";
import type { KVStore } from "./types";

export { withHeliusApiKey } from "./config";

export interface ResolveRpcTargetInput {
  cache: KVStore;
}

export interface ResolvedRpcTarget {
  cluster: SolanaCluster;
  providerId: OrganizationRpcProvider;
  endpoint: string;
  /** The endpoint's `protocol//host` only: managed URLs carry their key in the path or query. */
  endpointLabel: string;
}

/**
 * The KV key of `cluster`'s round-robin cursor; each cluster rotates over its own pool.
 *
 * @param cluster - The cluster whose pool the cursor indexes.
 * @returns The cursor's KV key.
 */
function roundRobinCursorKey(cluster: SolanaCluster): string {
  return `rpc:relay:round-robin-cursor:${cluster}`;
}

/**
 * The open scope's cluster pool, rotated so the endpoint its round-robin cursor selects comes
 * first, advancing the cursor.
 *
 * @param cache - KV store holding the cursors.
 * @returns The scope's cluster and every endpoint of its pool, starting at the selected one.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no endpoint configured.
 */
async function rotateScopeClusterEndpoints(
  cache: KVStore
): Promise<{ cluster: SolanaCluster; endpoints: ManagedRpcEndpoint[] }> {
  const { cluster } = currentClusterScope();
  const endpoints = managedRpcEndpoints(cluster);
  if (endpoints.length === 1) {
    return { cluster, endpoints };
  }

  const cursorKey = roundRobinCursorKey(cluster);
  const rawCursor = await cache.get(cursorKey);
  const parsedCursor = rawCursor ? Number.parseInt(rawCursor, 10) : 0;
  const cursor = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const index = cursor % endpoints.length;

  await cache.put(cursorKey, String((index + 1) % endpoints.length));
  return { cluster, endpoints: [...endpoints.slice(index), ...endpoints.slice(0, index)] };
}

/**
 * The relay target for one managed endpoint, labelled without its credentials.
 *
 * @param cluster - The cluster the endpoint is configured for.
 * @param endpoint - A managed pool endpoint.
 * @returns The relay target for that endpoint.
 */
function toRelayTarget(cluster: SolanaCluster, endpoint: ManagedRpcEndpoint): ResolvedRpcTarget {
  const { protocol, host } = new URL(endpoint.endpointUrl);
  return {
    cluster,
    providerId: endpoint.providerId,
    endpoint: endpoint.endpointUrl,
    endpointLabel: `${protocol}//${host}`,
  };
}

/**
 * The managed endpoint the next relay request goes to, chosen round-robin across the open
 * scope's cluster pool.
 *
 * @param input - The KV store holding the round-robin cursors.
 * @param input.cache - KV store holding the round-robin cursors.
 * @returns The selected relay target.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no endpoint configured.
 */
export async function resolveRpcTarget(input: ResolveRpcTargetInput): Promise<ResolvedRpcTarget> {
  const { cluster, endpoints } = await rotateScopeClusterEndpoints(input.cache);
  return toRelayTarget(cluster, endpoints[0]);
}

/**
 * Every endpoint of the open scope's cluster pool in round-robin order, for callers that try
 * each in turn.
 *
 * @param input - The KV store holding the round-robin cursors.
 * @param input.cache - KV store holding the round-robin cursors.
 * @returns The relay targets, starting at the selected endpoint.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no endpoint configured.
 */
export async function resolveRoundRobinRpcTargets(
  input: ResolveRpcTargetInput
): Promise<ResolvedRpcTarget[]> {
  const { cluster, endpoints } = await rotateScopeClusterEndpoints(input.cache);
  return endpoints.map((endpoint) => toRelayTarget(cluster, endpoint));
}
