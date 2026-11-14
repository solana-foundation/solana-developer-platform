import type { FireblocksSignerConfig } from "@solana/keychain-fireblocks";

/** Persistence hooks contain proposal identifiers only, never signing credentials. */
export type FireblocksProposalTracking = Pick<
  FireblocksSignerConfig,
  "createExternalTxId" | "onSigningStatus" | "onSigningCleanup" | "onSigningFailure"
>;
