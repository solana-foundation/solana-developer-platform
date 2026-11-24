import type { SolanaCluster } from "@sdp/types/well-known-tokens";

/** Chain runtime for one operation: a genesis-proven endpoint and its cluster. */
export interface OndoRuntime {
  cluster: SolanaCluster;
  rpcUrl: string;
}

/**
 * API-owned execution guard for one provider operation — the API injects its
 * absolute vault deadline without a dependency from this package back to the
 * application layer. Same shape as the Veda/Kamino runners.
 */
export type OndoVaultOperationRunner = <T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
) => Promise<T>;
