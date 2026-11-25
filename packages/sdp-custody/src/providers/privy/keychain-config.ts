// ═══════════════════════════════════════════════════════════════════════════
// Privy Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainPrivyConfig {
  /** Privy application ID */
  appId: string;

  /** Privy application secret */
  appSecret: string;

  /** Optional delay in ms between concurrent signing requests (default: 0) */
  requestDelayMs?: number;

  /**
   * Default wallet identifier. Used when the caller doesn't specify which wallet
   * to use (single-wallet mode / legacy env fallback).
   *
   * For Privy, SDP stores wallet IDs as `privy_<id>` in the database.
   */
  defaultWalletId?: string;
}
