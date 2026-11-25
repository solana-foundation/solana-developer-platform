import { custodyClusterConfig } from "#/cluster-config";

/** Whether a recorded Fireblocks asset is the cluster's native asset. */
export function isFireblocksNativeAsset(assetId: string): boolean {
  return assetId === custodyClusterConfig().fireblocks.nativeAsset;
}
