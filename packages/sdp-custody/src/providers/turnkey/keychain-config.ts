// ═══════════════════════════════════════════════════════════════════════════
// Turnkey Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainTurnkeyConfig {
  /** Turnkey API public key (compressed P-256 public key, hex) */
  apiPublicKey: string;

  /** Turnkey API private key (P-256 private key, hex) */
  apiPrivateKey: string;

  /** Turnkey organization ID */
  organizationId: string;

  /** Optional delay in ms between concurrent signing requests (default: 0) */
  requestDelayMs?: number;

  /**
   * Default wallet identifier. Used when the caller doesn't specify which wallet
   * to use (single-wallet mode / legacy env fallback).
   *
   * For Turnkey, SDP stores wallet IDs as `turnkey_<privateKeyId>` in the database.
   */
  defaultWalletId?: string;

  /** Public key for the default wallet */
  defaultWalletPublicKey?: string;
}
