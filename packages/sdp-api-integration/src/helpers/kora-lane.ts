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

/** How long one lane faucet request may take, failover hops included. */
const LANE_AIRDROP_TIMEOUT_MS = 30_000;

/**
 * Request a faucet airdrop on the lane cluster through the door's managed pool. Sent as JSON-RPC
 * over `createClusterJsonRpcFetch` because kit types `requestAirdrop` only on test-cluster
 * clients, and the door's client type spans both clusters.
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
  const environment = SDP_ENVIRONMENT_BY_CLUSTER[getIntegrationLaneCluster()];
  const laneJsonRpcFetch = runInClusterScope({ projectId: null, environment }, () =>
    createClusterJsonRpcFetch({ timeoutMs: LANE_AIRDROP_TIMEOUT_MS })
  );
  const response = await laneJsonRpcFetch("", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "requestAirdrop",
      params: [walletAddress, lamports],
    }),
  });
  const payload: unknown = await response.json();
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    throw new Error(`requestAirdrop failed: ${JSON.stringify(payload.error)}`);
  }
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
