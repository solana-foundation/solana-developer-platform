/**
 * Custody Provider Types
 *
 * Defines the interface for custody providers that handle transaction signing.
 * Supports both synchronous (local keypair) and asynchronous (MPC/institutional)
 * signing workflows.
 */

import type { Address } from "@solana/kit";

// ═══════════════════════════════════════════════════════════════════════════
// Core Provider Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Interface for custody providers that handle transaction signing.
 *
 * Implementations:
 * - LocalKeypairProvider: Sync signing using env var keypair (development)
 * - FireblocksProvider: Async MPC signing with approval workflows
 * - DfnsProvider: Programmable wallets with policy engine
 * - TurnkeyProvider: Infrastructure wallets
 */
export interface CustodyProvider {
  /** Unique identifier for this provider type */
  readonly providerId: string;

  /**
   * Get the public key for a signing wallet.
   * @param walletId Optional wallet identifier for multi-wallet providers
   */
  getPublicKey(walletId?: string): Promise<Address>;

  /**
   * Sign a transaction.
   * May complete immediately (sync providers) or return a pending status
   * for async approval workflows.
   */
  sign(request: SignRequest): Promise<SignResponse>;

  /**
   * Whether this provider requires async approval workflows.
   * If true, callers should handle pending_approval responses.
   */
  requiresApproval(): boolean;

  /**
   * Poll for approval status (for async providers).
   * Only implemented by providers where requiresApproval() returns true.
   */
  getSignatureStatus?(requestId: string): Promise<SignatureStatus>;

  /**
   * Generate a new keypair in custody.
   * Used for creating new mint accounts where the keypair must be in custody.
   * Not all providers support this - throws if unsupported.
   */
  generateKeypair?(): Promise<GeneratedKeypair>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Request/Response Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Request to sign a transaction
 */
export interface SignRequest {
  /** Base64-encoded transaction message (unsigned) */
  transactionMessage: string;

  /** Signers required for this transaction */
  signers: SignerInfo[];

  /** Optional metadata for audit and policy evaluation */
  metadata?: SigningMetadata;
}

/**
 * Information about a required signer
 */
export interface SignerInfo {
  /** Wallet identifier in the custody provider (optional for single-wallet providers) */
  walletId?: string;

  /** Public key that must sign */
  publicKey: Address;
}

/**
 * Metadata about the signing operation for audit and policy evaluation
 */
export interface SigningMetadata {
  /** Type of operation being performed */
  operationType: "deploy" | "mint" | "burn" | "freeze" | "unfreeze" | "transfer";

  /** Token ID if applicable */
  tokenId?: string;

  /** Amount if applicable (as string for large numbers) */
  amount?: string;

  /** Destination address if applicable */
  destination?: string;

  /** Additional custom metadata */
  [key: string]: unknown;
}

/**
 * Response from a sign request
 */
export interface SignResponse {
  /** Status of the signing operation */
  status: "completed" | "pending_approval" | "rejected" | "failed";

  /** Signatures if completed (one per required signer) */
  signatures?: SignatureInfo[];

  /** Request ID for async polling (if pending_approval) */
  signatureRequestId?: string;

  /** Error message if rejected or failed */
  error?: string;
}

/**
 * A signature from a specific public key
 */
export interface SignatureInfo {
  /** Public key that produced the signature */
  publicKey: Address;

  /** Base58-encoded signature */
  signature: string;
}

/**
 * Status of an async signing request
 */
export type SignatureStatus =
  | { status: "pending"; approvals?: number; required?: number }
  | { status: "completed"; signatures: SignatureInfo[] }
  | { status: "rejected"; reason: string }
  | { status: "failed"; error: string };

/**
 * Result of generating a new keypair
 */
export interface GeneratedKeypair {
  /** Wallet identifier in the custody provider */
  walletId: string;

  /** Public key of the generated keypair */
  publicKey: Address;
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Types
// ═══════════════════════════════════════════════════════════════════════════

/** Supported custody provider types */
export type CustodyProviderType = "local" | "fireblocks" | "dfns" | "turnkey";

/**
 * Base configuration for all custody providers
 */
export interface CustodyConfigBase {
  /** Provider type */
  provider: CustodyProviderType;

  /** Default wallet ID for operations */
  defaultWalletId?: string;
}

/**
 * Configuration for local keypair provider
 */
export interface LocalCustodyConfig extends CustodyConfigBase {
  provider: "local";
  // No additional config needed - uses CUSTODY_PRIVATE_KEY env var
}

/**
 * Configuration for Fireblocks provider (placeholder for future implementation)
 */
export interface FireblocksCustodyConfig extends CustodyConfigBase {
  provider: "fireblocks";

  /** Fireblocks API key */
  apiKey: string;

  /** Fireblocks API secret (encrypted in storage) */
  apiSecretEncrypted: string;

  /** Fireblocks vault account ID */
  vaultAccountId: string;

  /** Fireblocks asset ID for Solana (e.g., SOL or SOL_TEST) */
  assetId: string;

  /** Optional Fireblocks base URL (sandbox or region-specific) */
  apiBaseUrl?: string;
}

/**
 * Configuration for Dfns provider (placeholder for future implementation)
 */
export interface DfnsCustodyConfig extends CustodyConfigBase {
  provider: "dfns";

  /** Dfns app ID */
  appId: string;

  /** Dfns auth token (encrypted in storage) */
  authTokenEncrypted: string;

  /** Dfns organization ID */
  orgId: string;
}

/**
 * Configuration for Turnkey provider (placeholder for future implementation)
 */
export interface TurnkeyCustodyConfig extends CustodyConfigBase {
  provider: "turnkey";

  /** Turnkey organization ID */
  organizationId: string;

  /** Turnkey API key */
  apiKey: string;

  /** Turnkey private key (encrypted in storage) */
  privateKeyEncrypted: string;
}

/**
 * Union of all custody configurations
 */
export type CustodyConfiguration =
  | LocalCustodyConfig
  | FireblocksCustodyConfig
  | DfnsCustodyConfig
  | TurnkeyCustodyConfig;

// ═══════════════════════════════════════════════════════════════════════════
// Database Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Custody configuration as stored in the database
 */
export interface CustodyConfigRecord {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: CustodyProviderType;
  config: string; // Encrypted JSON
  defaultWalletId: string | null;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

/**
 * Signing request as stored in the database (for async tracking)
 */
export interface SigningRequestRecord {
  id: string;
  organizationId: string;
  custodyConfigId: string;
  tokenTransactionId: string | null;
  externalRequestId: string | null;
  status: "pending" | "completed" | "rejected" | "failed";
  transactionMessage: string;
  signatures: string | null; // JSON array
  metadata: string | null; // JSON
  createdAt: string;
  completedAt: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of a custody sign operation through the CustodyService
 */
export interface CustodySignResult {
  /** Whether signing completed immediately */
  completed: boolean;

  /** Signed transaction if completed (base64 encoded) */
  signedTransaction?: string;

  /** Signing request ID if pending approval */
  signingRequestId?: string;

  /** Status details */
  status: SignResponse["status"];

  /** Error message if failed */
  error?: string;
}
