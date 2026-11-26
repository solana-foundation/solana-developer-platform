import type { DfnsApiClient } from "./client";

// ═══════════════════════════════════════════════════════════════════════════
// DFNS Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainDfnsConfig {
  /** DFNS API client configured with org credentials */
  client: DfnsApiClient;

  /** Optional delay in ms between concurrent signing requests (default: 0) */
  requestDelayMs?: number;

  /**
   * Default wallet identifier. Used when the caller doesn't specify which wallet
   * to use.
   *
   * For DFNS, SDP stores wallet IDs as `dfns_<walletId>` in the database.
   */
  defaultWalletId?: string;
}
