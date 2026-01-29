/**
 * Fireblocks Types
 *
 * Response shapes and configuration types for the Fireblocks adapter.
 */

// ═══════════════════════════════════════════════════════════════════════════
// API Response Types
// ═══════════════════════════════════════════════════════════════════════════

export interface FireblocksSignedMessage {
  content?: string;
  signature?: unknown;
  publicKey?: string;
}

export interface FireblocksTransaction {
  id: string;
  status: string;
  subStatus?: string;
  signedMessages?: FireblocksSignedMessage[];
}

export interface FireblocksAddress {
  address: string;
  publicKey?: string;
  addressId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for the Fireblocks adapter
 */
export interface FireblocksAdapterConfig {
  /** Fireblocks API key */
  apiKey: string;

  /** Fireblocks API secret (PEM format) */
  apiSecretPem: string;

  /** Fireblocks vault account ID */
  vaultAccountId: string;

  /** Fireblocks asset ID (SOL or SOL_TEST) */
  assetId: string;

  /** Default wallet/address ID for single-wallet operations */
  defaultWalletId?: string;

  /** Fireblocks API base URL (optional, defaults to production) */
  apiBaseUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Status Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Transaction statuses that indicate pending approval */
export const FIREBLOCKS_PENDING_STATUSES = new Set([
  "SUBMITTED",
  "PENDING_AUTHORIZATION",
  "PENDING_SIGNATURE",
  "QUEUED",
  "PENDING_AML_SCREENING",
]);

/** Transaction statuses that indicate rejection */
export const FIREBLOCKS_REJECTED_STATUSES = new Set(["BLOCKED", "CANCELLED", "REJECTED", "DENIED"]);
