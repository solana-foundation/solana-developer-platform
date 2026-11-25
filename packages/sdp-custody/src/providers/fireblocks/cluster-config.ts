import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export const FIREBLOCKS_BY_CLUSTER = {
  devnet: { origin: "https://api.fireblocks.io", nativeAsset: "SOL_TEST" },
  "mainnet-beta": { origin: "https://api.fireblocks.io", nativeAsset: "SOL" },
} as const satisfies Record<SolanaCluster, { origin: string; nativeAsset: string }>;

/** Whether a recorded Fireblocks asset is the cluster's native asset. */
export function isFireblocksNativeAsset(cluster: SolanaCluster, assetId: string): boolean {
  return assetId === FIREBLOCKS_BY_CLUSTER[cluster].nativeAsset;
}
