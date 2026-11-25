import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { CUSTODY_CLUSTER_CONFIG } from "#/cluster-config";

/** Whether a recorded Fireblocks asset is the cluster's native asset. */
export function isFireblocksNativeAsset(cluster: SolanaCluster, assetId: string): boolean {
  return assetId === CUSTODY_CLUSTER_CONFIG[cluster].fireblocks.nativeAsset;
}
