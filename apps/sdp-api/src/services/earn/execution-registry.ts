import { supportsVaultDirect } from "@sdp/earn/capabilities";
import type { EarnVaultDirectProvider, EarnVaultProvider } from "@sdp/earn/types";
import { KaminoVaultDirectClient } from "@sdp/kamino";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SdpEnvironment, type SolanaCluster } from "@sdp/types";
import type { Env } from "@/types/env";

/**
 * Which providers this deployment can EXECUTE for, as opposed to merely
 * catalogue.
 *
 * `EARN_PROVIDER_CLIENTS` in `@sdp/earn` stays the catalogue registry — it is
 * what the hourly sync resolves through, and it must remain free of chain SDKs
 * so that cron keeps its small dependency surface. This overlay is consulted
 * only by routes that move money, and it is the ONE place a provider id is
 * mapped to an executing client. Everything downstream narrows with
 * `supportsVaultDirect`, never an id check.
 */

/**
 * The RPC endpoint used to build instructions for `cluster`.
 *
 * Deliberately reads the EXISTING `SOLANA_RPC_URL` and introduces no new env
 * key — a new one would have to be registered in `env.d.ts`, `turbo.json` and
 * `secret-keys.mjs` together, and the env-configurator drift test enforces that
 * they agree.
 *
 * The known limitation, stated rather than hidden: `SOLANA_RPC_URL` is a
 * PROCESS-level value while the cluster is PER-REQUEST, so one process can only
 * serve the cluster its endpoint points at. A production deployment (mainnet
 * endpoint) therefore cannot build devnet instructions for a sandbox project.
 * That fails LOUDLY rather than silently: `listKaminoDevnetVaults` proves the
 * chain by genesis hash before returning anything, so a mismatch is a refusal,
 * never a confidently wrong result. Serving both clusters from one process is a
 * follow-up that owes the full env registration.
 */
export function resolveClusterRpcUrl(env: Env, _cluster: SolanaCluster): string {
  const url = env.SOLANA_RPC_URL;
  return typeof url === "string" ? url.trim() : "";
}

export function earnClusterFor(environment: SdpEnvironment): SolanaCluster {
  return CLUSTER_BY_SDP_ENVIRONMENT[environment];
}

/**
 * Build the executing client for a provider, or `null` when this deployment has
 * none. Fail-closed: an unrecognized provider id answers null rather than
 * throwing, so a row written by a newer deploy degrades to "cannot execute"
 * instead of 500ing a read that happens to touch it.
 */
export function resolveEarnExecutionClient(env: Env, provider: string): EarnVaultProvider | null {
  if (provider === "kamino") {
    return new KaminoVaultDirectClient((cluster) => resolveClusterRpcUrl(env, cluster));
  }
  return null;
}

/** The executing client narrowed to the vault-direct capability, or null. */
export function resolveVaultDirectClient(
  env: Env,
  provider: string
): EarnVaultDirectProvider | null {
  const client = resolveEarnExecutionClient(env, provider);
  if (!client) return null;
  return supportsVaultDirect(client) ? client : null;
}
