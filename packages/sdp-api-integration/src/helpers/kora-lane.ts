import { SdpRpcError } from "@sdp/rpc";
import { createClusterJsonRpcFetch, createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { SDP_ENVIRONMENT_BY_CLUSTER, type SolanaCluster } from "@sdp/types";
import { env } from "#env-impl";

/** One Kora service as the harness reaches it directly, outside any cluster scope. */
export interface IntegrationLaneKora {
  rpcUrlEnvKey: "KORA_RPC_URL_DEVNET" | "KORA_RPC_URL_MAINNET";
  rpcUrl: string | undefined;
  apiKey: string | undefined;
  identityTokenAudience: string | undefined;
}

/**
 * The cluster this integration lane runs on, by the same rule `scripts/kora-surfpool/up.sh` writes
 * the runtime env with: `SURFPOOL_CLUSTER`, devnet when unset (the hosted devnet Kora lane and
 * every devnet Surfpool lane).
 *
 * @returns The lane cluster.
 * @throws Error when `SURFPOOL_CLUSTER` names neither devnet nor mainnet-beta.
 */
export function getIntegrationLaneCluster(): SolanaCluster {
  const laneCluster = process.env.SURFPOOL_CLUSTER ?? "devnet";
  if (laneCluster === "devnet" || laneCluster === "mainnet-beta") return laneCluster;
  throw new Error(`SURFPOOL_CLUSTER must be devnet or mainnet-beta, got ${laneCluster}`);
}

/**
 * The lane cluster's managed-pool client, built in that cluster's scope the way a Project of the
 * lane's environment reads the chain. The harness reaches the chain only through it.
 *
 * @returns The lane client, or `null` when the lane cluster has no managed pool endpoint
 *   (`SOLANA_RPC_<PROVIDER>_<CLUSTER>_API_KEY_URL`) configured.
 */
export function getIntegrationLaneRpc(): SolanaRpc | null {
  const environment = SDP_ENVIRONMENT_BY_CLUSTER[getIntegrationLaneCluster()];
  try {
    return runInClusterScope({ projectId: null, environment }, () => createClusterRpc());
  } catch (error) {
    if (error instanceof SdpRpcError && error.code === "RPC_NOT_CONFIGURED") return null;
    throw error;
  }
}

/**
 * The env key pattern of the lane cluster's managed pool, for a missing-config message.
 *
 * @returns E.g. `SOLANA_RPC_<PROVIDER>_DEVNET_API_KEY_URL`.
 */
export function laneRpcPoolEnvKeyPattern(): string {
  const clusterSuffix = getIntegrationLaneCluster() === "devnet" ? "DEVNET" : "MAINNET";
  return `SOLANA_RPC_<PROVIDER>_${clusterSuffix}_API_KEY_URL`;
}

/**
 * The lane cluster's managed-pool client for a suite that only runs once the lane is configured.
 *
 * @returns The lane client.
 * @throws Error when the lane cluster has no managed pool endpoint configured.
 */
export function requireIntegrationLaneRpc(): SolanaRpc {
  const laneRpc = getIntegrationLaneRpc();
  if (laneRpc === null) {
    throw new Error(`${laneRpcPoolEnvKeyPattern()} is required for this suite`);
  }
  return laneRpc;
}

/** How long one raw lane JSON-RPC call may take, failover hops included. */
const LANE_JSON_RPC_TIMEOUT_MS = 30_000;

/**
 * Send one JSON-RPC call to the lane cluster through the door's managed pool, over
 * `createClusterJsonRpcFetch`, for methods the door's client does not type: `requestAirdrop`
 * (kit types it only on test-cluster clients) and Surfpool's `surfnet_*` cheatcodes.
 *
 * @param method - The JSON-RPC method.
 * @param params - The positional params.
 * @returns The response's `result`.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the lane cluster has no managed pool endpoint.
 * @throws Error when the endpoint answers with a JSON-RPC error.
 */
export async function sendIntegrationLaneJsonRpc(
  method: string,
  params: readonly unknown[]
): Promise<unknown> {
  const environment = SDP_ENVIRONMENT_BY_CLUSTER[getIntegrationLaneCluster()];
  const laneJsonRpcFetch = runInClusterScope({ projectId: null, environment }, () =>
    createClusterJsonRpcFetch({ timeoutMs: LANE_JSON_RPC_TIMEOUT_MS })
  );
  const response = await laneJsonRpcFetch("", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`${method} answered with a non-object JSON-RPC response`);
  }
  if ("error" in payload) {
    throw new Error(`${method} failed: ${JSON.stringify(payload.error)}`);
  }
  if (!("result" in payload)) {
    throw new Error(`${method} answered without a result`);
  }
  return payload.result;
}

/**
 * Request a faucet airdrop on the lane cluster through the door's managed pool.
 *
 * @param walletAddress - The airdrop destination.
 * @param lamports - The amount to request.
 * @returns Resolves once the faucet accepted the request.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the lane cluster has no managed pool endpoint.
 * @throws Error when the faucet answers with a JSON-RPC error.
 */
export async function requestIntegrationLaneAirdrop(
  walletAddress: string,
  lamports: number
): Promise<void> {
  await sendIntegrationLaneJsonRpc("requestAirdrop", [walletAddress, lamports]);
}

/**
 * The Kora of the cluster this integration lane runs on (`getIntegrationLaneCluster`).
 *
 * @returns The lane cluster's `KORA_*_<CLUSTER>` trio as configured, blanks read as unset.
 * @throws Error when `SURFPOOL_CLUSTER` names neither devnet nor mainnet-beta.
 */
export function getIntegrationLaneKora(): IntegrationLaneKora {
  if (getIntegrationLaneCluster() === "devnet") {
    return {
      rpcUrlEnvKey: "KORA_RPC_URL_DEVNET",
      rpcUrl: env.KORA_RPC_URL_DEVNET || undefined,
      apiKey: env.KORA_API_KEY_DEVNET || undefined,
      identityTokenAudience: env.KORA_CLOUD_RUN_AUDIENCE_DEVNET || undefined,
    };
  }
  return {
    rpcUrlEnvKey: "KORA_RPC_URL_MAINNET",
    rpcUrl: env.KORA_RPC_URL_MAINNET || undefined,
    apiKey: env.KORA_API_KEY_MAINNET || undefined,
    identityTokenAudience: env.KORA_CLOUD_RUN_AUDIENCE_MAINNET || undefined,
  };
}

/** The lane Kora once its URL is known to be configured. */
export interface ConfiguredIntegrationLaneKora extends IntegrationLaneKora {
  rpcUrl: string;
}

/**
 * The lane Kora for a suite that only runs once it is configured.
 *
 * @returns The lane cluster's Kora with its URL present.
 * @throws Error when the lane cluster's `KORA_RPC_URL_<CLUSTER>` is unset.
 */
export function requireIntegrationLaneKora(): ConfiguredIntegrationLaneKora {
  const laneKora = getIntegrationLaneKora();
  const { rpcUrl } = laneKora;
  if (!rpcUrl) {
    throw new Error(`${laneKora.rpcUrlEnvKey} is required for this Kora suite`);
  }
  return { ...laneKora, rpcUrl };
}
