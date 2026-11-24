// ═══════════════════════════════════════════════════════════════════════════
// Utila Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainUtilaConfig {
  /** Utila service account email */
  serviceAccountEmail: string;

  /** RSA private key in PEM format for Utila service account JWT signing */
  serviceAccountPrivateKeyPem: string;

  /** Utila vault ID */
  vaultId: string;

  /** Utila Solana network resource (for example, "networks/solana-devnet") */
  network: string;

  /** API base URL (default: "https://api.utila.io") */
  apiBaseUrl?: string;

  /** Polling interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;

  /** Maximum polling attempts (default: 60) */
  maxPollAttempts?: number;

  /** Optional automated Utila designated signer resource IDs */
  designatedSigners?: readonly string[];

  /**
   * Default wallet identifier. Used when the caller doesn't specify which wallet
   * to use.
   *
   * For Utila, SDP stores wallet IDs as `utila_<walletId>` in the database.
   */
  defaultWalletId?: string;
}
