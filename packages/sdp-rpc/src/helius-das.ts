import { SdpRpcError } from "./errors";
import { MANAGED_RPC_ENV_KEYS } from "./managed-rpc-env-keys";
import { currentClusterScope } from "./scope";

/**
 * Whether the open cluster scope's cluster has a Helius endpoint, the only provider that serves
 * the DAS methods (`searchAssets`, `getAssetBatch`).
 *
 * @returns True when the scope's cluster has its Helius managed endpoint configured.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function isHeliusDasConfigured(): boolean {
  return Boolean(process.env[MANAGED_RPC_ENV_KEYS[currentClusterScope().cluster].helius]);
}

/**
 * Send one Helius DAS JSON-RPC request on the open cluster scope's Helius endpoint. DAS methods
 * are Helius extensions, so they never go through the managed pool, whose other providers do not
 * serve them; the endpoint URL stays inside this package.
 *
 * @param init - The fetch init carrying the JSON-RPC request.
 * @returns The HTTP response.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no Helius endpoint.
 */
export function fetchHeliusDas(init: RequestInit): Promise<Response> {
  const { cluster } = currentClusterScope();
  const endpointUrl = process.env[MANAGED_RPC_ENV_KEYS[cluster].helius];
  if (!endpointUrl) {
    throw new SdpRpcError("RPC_NOT_CONFIGURED", `No Helius endpoint is configured for ${cluster}`, {
      cluster,
    });
  }
  return fetch(endpointUrl, init);
}
