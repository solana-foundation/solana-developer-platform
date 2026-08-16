import { supportsVaultDirect } from "@sdp/earn/capabilities";
import { providerNotConfigured } from "@sdp/earn/errors";
import type { EarnVaultDirectProvider, EarnVaultProvider } from "@sdp/earn/types";
import { KaminoVaultDirectClient } from "@sdp/kamino";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  GENESIS_HASH_BY_CLUSTER,
  type SdpEnvironment,
  type SolanaCluster,
} from "@sdp/types";
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
 * Per-cluster by construction, because one API process serves BOTH — a sandbox
 * project is devnet and a production project is mainnet-beta, and the same
 * deployment answers requests for each. Reading one process-level
 * `SOLANA_RPC_URL` for both meant whichever chain that endpoint served, the
 * other environment silently built and read against the wrong one.
 *
 * `SOLANA_DEVNET_RPC_URL` / `SOLANA_MAINNET_RPC_URL` are optional overrides;
 * `SOLANA_RPC_URL` stays the fallback so an existing single-cluster deployment
 * keeps working unchanged. What makes the fallback SAFE rather than the same
 * bug with more steps is `assertClusterEndpoint` below: the endpoint has to
 * prove which chain it serves before anything is built against it.
 */
export function resolveClusterRpcUrl(env: Env, cluster: SolanaCluster): string {
  const perCluster = cluster === "devnet" ? env.SOLANA_DEVNET_RPC_URL : env.SOLANA_MAINNET_RPC_URL;
  const url = perCluster ?? env.SOLANA_RPC_URL;
  return typeof url === "string" ? url.trim() : "";
}

/**
 * Memoised verdicts, keyed by `cluster\nurl`.
 *
 * The genesis hash of an endpoint is immutable for the life of that endpoint,
 * so this is a cache of a constant rather than of a reading — but it is also
 * what keeps the assertion affordable: without it every deposit and every
 * position page would pay an extra round trip.
 *
 * Failures are cached too, deliberately. A misconfigured endpoint is a
 * deployment fact, not a transient one, and re-probing it on every request
 * turns one configuration error into sustained load against someone else's RPC.
 */
const clusterProofs = new Map<string, Promise<void>>();

/**
 * Refuse to build against an endpoint that has not proved it serves `cluster`.
 *
 * This is the check the execution path was missing. The catalogue path already
 * had it — `listKaminoDevnetVaults` verifies genesis before returning anything —
 * but the money path trusted its URL, and a cluster mismatch does NOT surface as
 * an error: Kamino's mainnet kvault program id also resolves on devnet with no
 * accounts under it, so the failure mode is "this vault does not exist", or a
 * transaction built for the wrong deployment.
 *
 * Called before every build and every position read. Cheap after the first hit,
 * and the first hit is the one that matters.
 */
export async function assertClusterEndpoint(
  env: Env,
  cluster: SolanaCluster,
  rpcUrl: string
): Promise<void> {
  if (rpcUrl === "") {
    throw providerNotConfigured(
      `No Solana RPC endpoint is configured for ${cluster}. Set SOLANA_${
        cluster === "devnet" ? "DEVNET" : "MAINNET"
      }_RPC_URL, or point SOLANA_RPC_URL at a ${cluster} endpoint.`
    );
  }

  const key = `${cluster}\n${rpcUrl}`;
  const existing = clusterProofs.get(key);
  if (existing) return await existing;

  const proof = (async () => {
    const expected = GENESIS_HASH_BY_CLUSTER[cluster];
    let observed: string;
    try {
      observed = await getGenesisHash(env, rpcUrl);
    } catch (cause) {
      throw providerNotConfigured(
        `Could not verify that the configured ${cluster} RPC endpoint serves ${cluster}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    if (observed !== expected) {
      throw providerNotConfigured(
        `The RPC endpoint configured for ${cluster} reports genesis ${observed}, not ${expected}. ` +
          "Building against it would address the wrong chain — refusing. Set " +
          `SOLANA_${cluster === "devnet" ? "DEVNET" : "MAINNET"}_RPC_URL to a ${cluster} endpoint.`
      );
    }
  })();

  clusterProofs.set(key, proof);
  return await proof;
}

async function getGenesisHash(env: Env, rpcUrl: string): Promise<string> {
  const rpc = solanaRpc.createRpc(env, { rpcUrl });
  return String(await rpc.getGenesisHash().send());
}

/** Test seam: forget cached genesis verdicts. */
export function resetClusterEndpointProofs(): void {
  clusterProofs.clear();
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
