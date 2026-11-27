import type { SolanaCluster } from "@sdp/types/well-known-tokens";

/** Chain runtime for one operation: a genesis-proven endpoint and its cluster. */
export interface OndoRuntime {
  cluster: SolanaCluster;
  rpcUrl: string;
}
