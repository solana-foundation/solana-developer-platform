/**
 * Keychain Adapter Configuration Types
 *
 * Configuration types for Solana Keychain signing backends.
 * These map to the underlying @solana/keychain-* package configs.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Fireblocks Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainFireblocksConfig {
  /** Fireblocks API key */
  apiKey: string;

  /** RSA 4096 private key in PEM format for JWT signing */
  apiSecretPem: string;

  /** Fireblocks vault account ID */
  vaultAccountId: string;

  /** Asset ID (default: "SOL", use "SOL_TEST" for devnet) */
  assetId?: string;

  /** API base URL (default: "https://api.fireblocks.io") */
  apiBaseUrl?: string;

  /** Polling interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;

  /** Maximum polling attempts (default: 60) */
  maxPollAttempts?: number;

  /** Optional delay in ms between concurrent signing requests (default: 0) */
  requestDelayMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Privy Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainPrivyConfig {
  /** Privy application ID */
  appId: string;

  /** Privy application secret */
  appSecret: string;

  /** Privy wallet ID */
  walletId: string;

  /** API base URL (default: "https://api.privy.io/v1") */
  apiBaseUrl?: string;

  /** Optional delay in ms between concurrent signing requests (default: 0) */
  requestDelayMs?: number;
}
