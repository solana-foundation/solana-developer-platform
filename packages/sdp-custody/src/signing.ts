/**
 * Signing Port
 *
 * Interface for custody providers that handle transaction signing.
 * This is a "driven" port - the domain calls out to adapters that implement this interface.
 *
 * All signing uses @solana/keychain as the signing module.
 *
 * Implementations:
 * - KeychainFireblocksAdapter: Fireblocks MPC custody (production)
 * - KeychainPrivyAdapter: Privy hosted wallets (production)
 * - KeychainMemoryAdapter: Sync signing from CUSTODY_PRIVATE_KEY env (SIGNING_PROVIDER=local)
 */

import type { Address, TransactionSigner } from "@solana/kit";

// ═══════════════════════════════════════════════════════════════════════════
// Port Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Port interface for signing operations.
 * Adapters implement this to provide custody/signing functionality.
 */
export interface SigningPort {
  /** Unique identifier for this provider type */
  readonly providerId: string;

  /**
   * Get the public key for a signing wallet.
   * @param walletId Optional wallet identifier for multi-wallet providers
   */
  getPublicKey(walletId?: string): Promise<Address>;

  /**
   * Sign a transaction message.
   * May complete immediately (sync providers) or return a pending status
   * for async approval workflows.
   */
  sign(request: SignRequest): Promise<SignResult>;

  /**
   * Whether this provider requires async approval workflows.
   * If true, callers should handle 'pending' responses and poll for status.
   */
  requiresApproval(): boolean;

  /**
   * Poll for async signing status.
   * Only implemented by providers where requiresApproval() returns true.
   */
  getSignStatus?(requestId: string): Promise<SignStatus>;

  /**
   * Generate a new keypair in custody.
   * Used for creating new mint accounts where the keypair must be in custody.
   * Not all providers support this - throws if unsupported.
   */
  generateKeypair?(): Promise<GeneratedKeypair>;
}

/**
 * Common interface for custody providers that support full transaction signing.
 */
export interface FullSigningPort extends SigningPort {
  /**
   * Get an @solana/kit transaction signer for a wallet.
   */
  getTransactionSigner(walletId?: string, walletPublicKey?: Address): Promise<TransactionSigner>;
}

export function isFullSigningPort(port: SigningPort): port is FullSigningPort {
  return typeof (port as Partial<FullSigningPort>).getTransactionSigner === "function";
}

// ═══════════════════════════════════════════════════════════════════════════
// Request/Response Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Request to sign a transaction message
 */
export interface SignRequest {
  /** Transaction message bytes (unsigned, serialized) */
  message: Uint8Array;

  /** Addresses that must sign this transaction */
  signers: Address[];

  /** Optional metadata for audit and policy evaluation */
  metadata?: SigningMetadata;
}

/**
 * Metadata about the signing operation for audit and policy evaluation
 */
export interface SigningMetadata {
  /** Type of operation being performed */
  operationType?: "deploy" | "mint" | "burn" | "freeze" | "thaw" | "transfer";

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
 * Result of a signing operation
 */
export interface SignResult {
  /** Status of the signing operation */
  status: SignResultStatus;

  /** Signatures if completed (address → signature bytes) */
  signatures?: Map<Address, Uint8Array>;

  /** Request ID for async polling (if status is 'pending') */
  requestId?: string;

  /** Error message if rejected or failed */
  error?: string;
}

export type SignResultStatus = "completed" | "pending" | "rejected" | "failed";

/**
 * Status when polling for async signing completion
 */
export type SignStatus =
  | { status: "pending"; approvals?: number; required?: number }
  | { status: "completed"; signatures: Map<Address, Uint8Array> }
  | { status: "rejected"; reason: string }
  | { status: "failed"; error: string };

/**
 * Result of generating a new keypair in custody
 */
export interface GeneratedKeypair {
  /** Wallet identifier in the custody provider */
  walletId: string;

  /** Public key of the generated keypair */
  publicKey: Address;
}

// ═══════════════════════════════════════════════════════════════════════════
// Error Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Base error for signing operations
 */
export class SigningError extends Error {
  constructor(
    message: string,
    public readonly code: SigningErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "SigningError";
  }
}

export type SigningErrorCode =
  | "PROVIDER_NOT_CONFIGURED"
  | "WALLET_NOT_FOUND"
  | "SIGNING_FAILED"
  | "APPROVAL_TIMEOUT"
  | "APPROVAL_REJECTED"
  | "INVALID_REQUEST"
  | "NETWORK_ERROR"
  | "ALREADY_INITIALIZED"
  | "NOT_FOUND";
