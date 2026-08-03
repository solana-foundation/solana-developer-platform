/**
 * Instance mint resolution.
 *
 * The persisted `PrivateChannelInstance` stores no explicit cluster or mint, so
 * both are derived: cluster from the chain RPC URL, and the default mint from the
 * well-known USDC for that cluster (USDC is the only whitelisted mint on the
 * sandbox instance today). Shared by the balance read and the deposit flow.
 */

import type { SolanaCluster } from "@sdp/types";
import { WELL_KNOWN_TOKENS } from "@sdp/types";

/**
 * Infer the Solana cluster from the instance's chain RPC URL. The sandbox is
 * devnet, so an unrecognized URL is treated as devnet.
 */
export function inferCluster(chainRpcUrl: string): SolanaCluster {
  return /mainnet/i.test(chainRpcUrl) ? "mainnet-beta" : "devnet";
}

type ClusterMint = { address: string; decimals: number };

/** The default channel mint for a cluster: its well-known USDC mint. */
export function defaultChannelMint(cluster: SolanaCluster): string {
  const mint = (WELL_KNOWN_TOKENS.USDC.mints as Partial<Record<SolanaCluster, ClusterMint>>)[
    cluster
  ];
  if (!mint) {
    throw new Error(`No known USDC mint for cluster ${cluster}`);
  }
  return mint.address;
}

/** Decimals for a well-known mint on this cluster, when recognized. */
export function knownMintDecimals(mint: string, cluster: SolanaCluster): number | undefined {
  for (const token of Object.values(WELL_KNOWN_TOKENS)) {
    // Not every well-known token is deployed on every cluster (some carry only
    // a mainnet mint), so index the mint map defensively.
    const clusterMint = (token.mints as Partial<Record<SolanaCluster, ClusterMint>>)[cluster];
    if (clusterMint?.address === mint) {
      return clusterMint.decimals;
    }
  }
  return undefined;
}
