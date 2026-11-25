// ═══════════════════════════════════════════════════════════════════════════
// Coinbase CDP Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainCoinbaseConfig {
  /** Coinbase CDP API key identifier */
  apiKeyId: string;

  /** Coinbase CDP API key secret (PEM or base64 key material, per CDP auth mode) */
  apiKeySecret: string;

  /** Coinbase CDP wallet secret (base64 PKCS#8 DER) for X-Wallet-Auth */
  walletSecret: string;

  /** API base URL (default: "https://api.cdp.coinbase.com/platform") */
  apiBaseUrl?: string;

  /** Optional delay in ms between concurrent signing requests (default: 0) */
  requestDelayMs?: number;

  /**
   * Default wallet identifier. Used when the caller doesn't specify which wallet
   * to use (single-wallet mode / legacy env fallback).
   *
   * For Coinbase CDP, SDP stores wallet IDs as `cdp_<address>` in the database.
   */
  defaultWalletId?: string;
}
