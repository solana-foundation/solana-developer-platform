import type { SolanaCluster } from "@sdp/types/well-known-tokens";

/** Chain runtime for one operation: a genesis-proven endpoint and its cluster. */
export interface HastraRuntime {
  cluster: SolanaCluster;
  rpcUrl: string;
}

/** API-owned deadline boundary, shared in shape with the other vault clients. */
export type HastraVaultOperationRunner = <T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
) => Promise<T>;
