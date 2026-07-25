import type { SolanaCluster } from "@sdp/types";

const EXPLORER_ORIGIN = "https://explorer.solana.com";

/**
 * Solana Explorer treats mainnet-beta as the default and every other cluster as a
 * `?cluster=` query. Matching that convention keeps mainnet links clean and devnet
 * links correct. Centralised here because the same href was previously rebuilt in
 * several components, some hardcoded to devnet — wrong on production projects.
 */
function clusterQuery(cluster: SolanaCluster): string {
  return cluster === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(cluster)}`;
}

export function explorerTxUrl(signature: string, cluster: SolanaCluster): string {
  return `${EXPLORER_ORIGIN}/tx/${encodeURIComponent(signature)}${clusterQuery(cluster)}`;
}

export function explorerAddressUrl(address: string, cluster: SolanaCluster): string {
  return `${EXPLORER_ORIGIN}/address/${encodeURIComponent(address)}${clusterQuery(cluster)}`;
}
