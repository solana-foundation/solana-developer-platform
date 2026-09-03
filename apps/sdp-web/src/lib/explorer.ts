import type { SolanaCluster } from "@sdp/types";

const EXPLORER_ORIGIN = "https://explorer.solana.com";

/**
 * An RPC endpoint the explorer should be pointed at instead of a named cluster.
 *
 * A project's cluster says which network it BELONGS to. It does not say where
 * its transactions can actually be read, and against a local validator or a
 * devnet fork those are different answers: the account exists on the fork and
 * has never existed on devnet, so a `?cluster=devnet` link opens an explorer
 * page for something that is not there. To anyone checking their own trade that
 * is indistinguishable from the transaction having failed.
 *
 * Read as a literal member expression because Next only inlines a
 * `NEXT_PUBLIC_*` value at build time when it can see the whole name.
 *
 * Deliberately NOT derived from the API's own `SOLANA_RPC_URL`. Provider
 * endpoints carry an API key in the query string, and copying one into a public
 * href would publish that credential on every page that links a signature. This
 * is a separate variable precisely so setting it is a decision.
 */
function customExplorerRpcUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_SOLANA_EXPLORER_RPC_URL?.trim();
  if (!configured) {
    return null;
  }
  // A malformed value would otherwise produce a link that fails silently in the
  // explorer rather than here, where it is at least ignorable.
  try {
    return new URL(configured).toString();
  } catch {
    return null;
  }
}

/**
 * Solana Explorer treats mainnet-beta as the default and every other cluster as a
 * `?cluster=` query. Matching that convention keeps mainnet links clean and devnet
 * links correct. Centralised here because the same href was previously rebuilt in
 * several components, some hardcoded to devnet — wrong on production projects.
 */
function clusterQuery(cluster: SolanaCluster): string {
  const custom = customExplorerRpcUrl();
  if (custom) {
    return `?cluster=custom&customUrl=${encodeURIComponent(custom)}`;
  }
  return cluster === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(cluster)}`;
}

export function explorerTxUrl(signature: string, cluster: SolanaCluster): string {
  return `${EXPLORER_ORIGIN}/tx/${encodeURIComponent(signature)}${clusterQuery(cluster)}`;
}

export function explorerAddressUrl(address: string, cluster: SolanaCluster): string {
  return `${EXPLORER_ORIGIN}/address/${encodeURIComponent(address)}${clusterQuery(cluster)}`;
}
