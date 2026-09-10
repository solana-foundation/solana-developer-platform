import { resolveDefaultCluster } from "@sdp/rpc";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types";
import { getDb } from "@/db";
import { KORA_FEE_SPONSORSHIP_CLUSTERS } from "@/lib/feature-flags";
import { projectEnvironment } from "@/services/project.service";
import type { Env } from "@/types/env";

const MANAGED_PROVIDER_KEYS = [
  "SOLANA_RPC_DEFAULT_PROVIDER",
  "SOLANA_RPC_TRITON_URL",
  "SOLANA_RPC_TRITON_API_KEY",
  "SOLANA_RPC_HELIUS_URL",
  "SOLANA_RPC_HELIUS_API_KEY",
  "SOLANA_RPC_ALCHEMY_URL",
  "SOLANA_RPC_ALCHEMY_API_KEY",
  "SOLANA_RPC_QUICKNODE_URL",
  "SOLANA_RPC_QUICKNODE_API_KEY",
  "SOLANA_RPC_VALIDATIONCLOUD_URL",
  "SOLANA_RPC_VALIDATIONCLOUD_API_KEY",
  "SOLANA_RPC_NODIT_URL",
  "SOLANA_RPC_NODIT_API_KEY",
] as const satisfies readonly (keyof Env)[];

function unsetManagedProviders(env: Env): void {
  for (const key of MANAGED_PROVIDER_KEYS) {
    delete env[key];
  }
}

/**
 * Return an environment whose cluster-dependent configuration is scoped to one Solana cluster.
 * The returned env is the env for `cluster`: every cluster-dependent reader (`createRpc`,
 * `getSolanaConfig`, well-known mints, Kora gates, sponsorship network) is correct for that
 * cluster by construction.
 *
 * @param env - Deployment environment to copy and scope.
 * @param cluster - Solana cluster that the returned environment must describe.
 * @returns A shallow copy with cluster-specific RPC and Kora configuration.
 */
export function scopeEnvToCluster(env: Env, cluster: SolanaCluster): Env {
  const scoped = { ...env, SOLANA_NETWORK: cluster };
  const override = cluster === "devnet" ? env.SOLANA_DEVNET_RPC_URL : env.SOLANA_MAINNET_RPC_URL;

  if (override !== undefined) {
    scoped.SOLANA_RPC_URL = override;
    unsetManagedProviders(scoped);
  } else if (cluster !== resolveDefaultCluster(env)) {
    delete scoped.SOLANA_RPC_URL;
    unsetManagedProviders(scoped);
  }

  if (!KORA_FEE_SPONSORSHIP_CLUSTERS.includes(cluster)) {
    delete scoped.KORA_RPC_URL;
  }

  return scoped;
}

/**
 * Create a per-run resolver that memoizes each project's cluster-scoped environment.
 *
 * @param env - Deployment environment used for project lookup and cluster scoping.
 * @returns A resolver that returns the scoped environment for a project ID.
 */
export function createProjectEnvResolver(env: Env): (projectId: string) => Promise<Env> {
  const scopedEnvs = new Map<string, Env>();
  return async (projectId: string): Promise<Env> => {
    const existing = scopedEnvs.get(projectId);
    if (existing !== undefined) return existing;
    const environment = await projectEnvironment(getDb(env), projectId);
    const scoped = scopeEnvToCluster(env, CLUSTER_BY_SDP_ENVIRONMENT[environment]);
    scopedEnvs.set(projectId, scoped);
    return scoped;
  };
}
