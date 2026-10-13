import { env } from "#env-impl";

/** One Kora service as the harness reaches it directly, outside any cluster scope. */
export interface IntegrationLaneKora {
  rpcUrlEnvKey: "KORA_RPC_URL_DEVNET" | "KORA_RPC_URL_MAINNET";
  rpcUrl: string | undefined;
  apiKey: string | undefined;
  identityTokenAudience: string | undefined;
}

/**
 * The Kora of the cluster this integration lane runs on. The lane cluster follows the same rule
 * `scripts/kora-surfpool/up.sh` writes the runtime env with: `SURFPOOL_CLUSTER`, devnet when unset
 * (the hosted devnet Kora lane and every devnet Surfpool lane).
 *
 * @returns The lane cluster's `KORA_*_<CLUSTER>` trio as configured, blanks read as unset.
 * @throws Error when `SURFPOOL_CLUSTER` names neither devnet nor mainnet-beta.
 */
export function getIntegrationLaneKora(): IntegrationLaneKora {
  const laneCluster = process.env.SURFPOOL_CLUSTER ?? "devnet";
  if (laneCluster === "devnet") {
    return {
      rpcUrlEnvKey: "KORA_RPC_URL_DEVNET",
      rpcUrl: env.KORA_RPC_URL_DEVNET || undefined,
      apiKey: env.KORA_API_KEY_DEVNET || undefined,
      identityTokenAudience: env.KORA_CLOUD_RUN_AUDIENCE_DEVNET || undefined,
    };
  }
  if (laneCluster === "mainnet-beta") {
    return {
      rpcUrlEnvKey: "KORA_RPC_URL_MAINNET",
      rpcUrl: env.KORA_RPC_URL_MAINNET || undefined,
      apiKey: env.KORA_API_KEY_MAINNET || undefined,
      identityTokenAudience: env.KORA_CLOUD_RUN_AUDIENCE_MAINNET || undefined,
    };
  }
  throw new Error(`SURFPOOL_CLUSTER must be devnet or mainnet-beta, got ${laneCluster}`);
}
