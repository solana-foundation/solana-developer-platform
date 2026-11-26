import type { FireblocksProposalTracking } from "./proposals";

// ═══════════════════════════════════════════════════════════════════════════
// Fireblocks Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainFireblocksConfig extends FireblocksProposalTracking {
  /** Fireblocks API key */
  apiKey: string;

  /** RSA 4096 private key in PEM format for JWT signing */
  apiSecretPem: string;

  /** Fireblocks vault account ID */
  vaultAccountId: string;

  /** Polling interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;

  /** Maximum polling attempts (default: 60) */
  maxPollAttempts?: number;

  /** Optional delay in ms between concurrent signing requests (default: 0) */
  requestDelayMs?: number;

  /** Propose transactions with sign-only PROGRAM_CALL; messages still use RAW. */
  useProgramCall?: boolean;
}
