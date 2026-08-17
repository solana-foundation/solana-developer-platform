import { supportsVaultDirect } from "@sdp/earn/capabilities";
import { providerNotConfigured } from "@sdp/earn/errors";
import type { EarnVaultDirectProvider, EarnVaultProvider } from "@sdp/earn/types";
import { assertNotPortfolioProvider, KaminoVaultDirectClient } from "@sdp/kamino";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  GENESIS_HASH_BY_CLUSTER,
  type SdpEnvironment,
  type SolanaCluster,
} from "@sdp/types";
import type { Env } from "@/types/env";
import { type VaultDeadline, withVaultDeadline } from "./vault-deadline";

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
 * Briefly memoised genesis observations, keyed by `cluster\nurl`.
 *
 * The genesis hash returned by one backend is immutable, but a URL is not: DNS,
 * a load balancer, or deployment configuration can repoint the same string at a
 * different cluster. Cache only a short burst so concurrent/page fan-out stays
 * affordable without turning one old observation into a process-lifetime funds
 * authorization.
 *
 * A rejected RPC call is NOT an observation. Timeouts, 429s and network failures
 * are evicted immediately; successful matches and mismatches share the same
 * short TTL.
 */
export const CLUSTER_ENDPOINT_PROOF_TTL_MS = 30_000;

interface ClusterEndpointProof {
  promise: Promise<string>;
  /** Null while the shared probe is still in flight. */
  expiresAt: number | null;
}

const clusterProofs = new Map<string, ClusterEndpointProof>();

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
 * Called before every build and every position read. Concurrent calls coalesce,
 * and a later call re-proves the URL after the short trust window expires.
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
  let proof = clusterProofs.get(key);
  if (proof && proof.expiresAt !== null && proof.expiresAt <= Date.now()) {
    clusterProofs.delete(key);
    proof = undefined;
  }
  if (!proof) {
    proof = {
      promise: withVaultDeadline(
        getGenesisHash(env, rpcUrl),
        `Verifying the ${cluster} RPC endpoint`
      ),
      expiresAt: null,
    };
    clusterProofs.set(key, proof);
  }

  let observed: string;
  try {
    observed = await proof.promise;
    if (clusterProofs.get(key) === proof && proof.expiresAt === null) {
      proof.expiresAt = Date.now() + CLUSTER_ENDPOINT_PROOF_TTL_MS;
    }
  } catch (cause) {
    // Delete only if this is still the promise stored for the key. Concurrent
    // callers may all observe the same rejection; none may delete a newer probe
    // started after this one failed.
    if (clusterProofs.get(key) === proof) clusterProofs.delete(key);
    throw providerNotConfigured(
      `Could not verify that the configured ${cluster} RPC endpoint serves ${cluster}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  const expected = GENESIS_HASH_BY_CLUSTER[cluster];
  if (observed !== expected) {
    throw providerNotConfigured(
      `The RPC endpoint configured for ${cluster} reports genesis ${observed}, not ${expected}. ` +
        "Building against it would address the wrong chain — refusing. Set " +
        `SOLANA_${cluster === "devnet" ? "DEVNET" : "MAINNET"}_RPC_URL to a ${cluster} endpoint.`
    );
  }
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
export function resolveEarnExecutionClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultProvider | null {
  if (provider === "kamino") {
    // Construction remains synchronous and I/O-free. The client awaits this
    // resolver only when a chain method is invoked, so an idempotent replay can
    // return from durable state during an RPC outage.
    const client = new KaminoVaultDirectClient(
      async (_ctx, cluster) => {
        const rpcUrl = resolveClusterRpcUrl(env, cluster);
        await deadline.run(`Verifying the ${cluster} RPC endpoint`, () =>
          assertClusterEndpoint(env, cluster, rpcUrl)
        );
        return rpcUrl;
      },
      (label, operation) => deadline.run(label, operation)
    );
    assertNotPortfolioProvider(client);
    return client;
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
