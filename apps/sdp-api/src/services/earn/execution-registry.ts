import { supportsVaultDirect, supportsVaultWithdraw } from "@sdp/earn/capabilities";
import type {
  EarnRuntimeContext,
  EarnVaultDirectProvider,
  EarnVaultProvider,
  EarnVaultWithdrawProvider,
} from "@sdp/earn/types";
import {
  assertJupiterLendNotPortfolioProvider,
  JupiterLendVaultDirectClient,
} from "@sdp/jupiter-lend";
import { assertNotPortfolioProvider, KaminoVaultDirectClient } from "@sdp/kamino";
import { getSolanaConfig } from "@sdp/rpc";
import * as solanaRpc from "@sdp/rpc/solana";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SdpEnvironment, type SolanaCluster } from "@sdp/types";
import {
  assertNotPortfolioProvider as assertVedaNotPortfolioProvider,
  VedaVaultDirectClient,
} from "@sdp/veda";
import { scopeEnvToCluster } from "@/lib/cluster-env";
import { instrumentVendorPort } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import type { VaultDeadline } from "./vault-deadline";

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
 * Per-cluster by construction, because one API process serves BOTH — a sandbox
 * project is devnet and a production project is mainnet-beta, and the same
 * deployment answers requests for each. Reading one process-level
 * `SOLANA_RPC_URL` for both meant whichever chain that endpoint served, the
 * other environment silently built and read against the wrong one.
 *
 * `SOLANA_DEVNET_RPC_URL` / `SOLANA_MAINNET_RPC_URL` are optional overrides.
 * The configured cluster may fall back through the canonical default resolver,
 * preserving managed-provider selection and API-key expansion; the other
 * cluster requires an explicit override. Mainnet clients prove the selected
 * endpoint's genesis inside `createRpc` before their first request.
 */
export function resolveClusterRpcUrl(env: Env, cluster: SolanaCluster): string {
  return getSolanaConfig(scopeEnvToCluster(env, cluster)).rpcUrl;
}

/**
 * The cluster RPC URL for `cluster`, proven to serve that cluster before it is
 * handed to a provider SDK that builds its own transport.
 *
 * @param env - Deployment environment.
 * @param cluster - Cluster the URL must serve.
 * @returns The proven RPC URL.
 */
export async function resolveProvenClusterRpcUrl(
  env: Env,
  cluster: SolanaCluster
): Promise<string> {
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  const scoped = scopeEnvToCluster(env, cluster);
  await solanaRpc.assertClusterEndpoint(scoped, rpcUrl, solanaRpc.createRpc(scoped, { rpcUrl }));
  return rpcUrl;
}

/**
 * Earn's RPC client for `cluster`: pinned to the cluster URL and proven to serve
 * that cluster on every cluster, not just mainnet, because Earn provider program
 * ids resolve on either chain without error.
 *
 * @param env - Deployment environment.
 * @param cluster - Cluster the client must serve.
 * @param requestTimeoutMs - Optional per-request transport deadline.
 * @returns A proven, cluster-pinned RPC client.
 */
export async function createProvenClusterRpc(
  env: Env,
  cluster: SolanaCluster,
  requestTimeoutMs?: number
): Promise<solanaRpc.SolanaRpc> {
  const scoped = scopeEnvToCluster(env, cluster);
  const rpcUrl = getSolanaConfig(scoped).rpcUrl;
  const rpc = solanaRpc.createRpc(
    scoped,
    requestTimeoutMs === undefined ? { rpcUrl } : { rpcUrl, requestTimeoutMs }
  );
  await solanaRpc.assertClusterEndpoint(scoped, rpcUrl, rpc);
  return rpc;
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
export function resolveEarnExecutionClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultProvider | null {
  // Construction stays synchronous and I/O-free for every branch. The clients
  // await this resolver only when a chain method is invoked, so an idempotent
  // replay can return from durable state during an RPC outage.
  const provenRpcUrl = (_ctx: EarnRuntimeContext, cluster: SolanaCluster) =>
    resolveProvenClusterRpcUrl(env, cluster);
  const runOperation = <T>(label: string, operation: (assertActive: () => void) => Promise<T>) =>
    deadline.run(label, () => operation(() => deadline.assertActive(label)));

  if (provider === "kamino") {
    const client = new KaminoVaultDirectClient(provenRpcUrl, runOperation);
    assertNotPortfolioProvider(client);
    return instrumentVendorPort("kamino", client);
  }
  if (provider === "jupiter_lend") {
    const client = new JupiterLendVaultDirectClient(provenRpcUrl, runOperation);
    assertJupiterLendNotPortfolioProvider(client);
    return instrumentVendorPort("jupiter_lend", client);
  }
  if (provider === "veda") {
    const client = new VedaVaultDirectClient(provenRpcUrl, runOperation);
    assertVedaNotPortfolioProvider(client);
    return instrumentVendorPort("veda", client);
  }
  return null;
}

/** The executing client narrowed to the vault-direct capability, or null. */
export function resolveVaultDirectClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultDirectProvider | null {
  const client = resolveEarnExecutionClient(env, provider, deadline);
  if (!client) return null;
  return supportsVaultDirect(client) ? client : null;
}

/**
 * The executing client narrowed to the vault-WITHDRAW capability, or null.
 *
 * Null means "SDP cannot build this provider's exit" (501 at the route) — a
 * statement about our plumbing, never a permission gate: ADR 0002 forbids
 * money-out inheriting any money-in gate, and this narrows on capability alone.
 */
export function resolveVaultWithdrawClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultWithdrawProvider | null {
  const client = resolveEarnExecutionClient(env, provider, deadline);
  if (!client) return null;
  return supportsVaultWithdraw(client) ? client : null;
}
