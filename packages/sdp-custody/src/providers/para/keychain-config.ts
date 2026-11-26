// ═══════════════════════════════════════════════════════════════════════════
// Para Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainParaConfig {
  /** Para API key (X-API-Key) */
  apiKey: string;

  /** Optional delay in ms between concurrent signing requests (default: 0) */
  requestDelayMs?: number;

  /**
   * Default wallet identifier. Used when the caller doesn't specify which wallet
   * to use (single-wallet mode / legacy env fallback).
   *
   * For Para, SDP stores wallet IDs as `para_<walletId>` in the database.
   */
  defaultWalletId?: string;
}
