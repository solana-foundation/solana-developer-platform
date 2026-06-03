/**
 * Keychain Adapter Configuration Types
 *
 * Configuration types for Solana Keychain signing backends.
 * These map to the underlying @solana/keychain-* package configs.
 */
import type { DfnsApiClient } from "@/services/dfns/client";

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

  /** API base URL (default: "https://api.privy.io/v1") */
  apiBaseUrl?: string;

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

// ═══════════════════════════════════════════════════════════════════════════
// Para Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface KeychainParaConfig {
  /** Para API key (X-API-Key) */
  apiKey: string;

  /** API base URL (default: "https://api.getpara.com") */
  apiBaseUrl?: string;

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

  /** API base URL (default: "https://api.turnkey.com") */
  apiBaseUrl?: string;

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
