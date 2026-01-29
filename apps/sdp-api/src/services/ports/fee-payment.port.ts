/**
 * Fee Payment Port
 *
 * Interface for gasless transaction fee payment.
 * The platform sponsors all transaction fees via this port.
 * Users never pay fees directly - fully gasless model.
 *
 * Implementations:
 * - KoraAdapter: Uses Kora/Solana Foundation relay for sponsored fees
 * - NativeAdapter: Direct SOL fee payment (fallback/testing)
 */

import type { Address, Signature } from "@solana/kit";

// ═══════════════════════════════════════════════════════════════════════════
// Port Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Port interface for fee payment operations.
 * Adapters implement this to provide gasless transaction sponsorship.
 */
export interface FeePaymentPort {
  /** Unique identifier for this fee payment provider */
  readonly providerId: string;

  /**
   * Get the platform's fee payer address.
   * This is the address that will pay transaction fees (Kora's signer).
   */
  getFeePayer(): Promise<Address>;

  /**
   * Sign a transaction with the fee payer key without sending.
   * Returns the transaction bytes with the fee payer signature added.
   *
   * @param transaction Serialized transaction (unsigned or partially signed)
   * @returns Transaction bytes with fee payer signature
   */
  signAsFeePayer(transaction: Uint8Array): Promise<Uint8Array>;

  /**
   * Sign a transaction with the fee payer and submit to Solana.
   * This is the primary method for gasless transaction submission.
   *
   * @param transaction Serialized transaction (unsigned or partially signed)
   * @returns Transaction signature
   */
  signAndSend(transaction: Uint8Array): Promise<Signature>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extended Interface (Optional Capabilities)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extended fee payment port with additional capabilities.
 * Some providers may support fee estimation and token-based fee payment.
 */
export interface ExtendedFeePaymentPort extends FeePaymentPort {
  /**
   * Estimate the fee for a transaction.
   * Returns fee in lamports.
   */
  estimateFee?(transaction: Uint8Array): Promise<bigint>;

  /**
   * Get supported fee payment tokens (if provider supports non-SOL fees).
   * Returns list of SPL token mints that can be used to pay fees.
   */
  getSupportedTokens?(): Promise<Address[]>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Error Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Base error for fee payment operations
 */
export class FeePaymentError extends Error {
  constructor(
    message: string,
    public readonly code: FeePaymentErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "FeePaymentError";
  }
}

export type FeePaymentErrorCode =
  | "PROVIDER_NOT_AVAILABLE"
  | "INSUFFICIENT_BALANCE"
  | "TRANSACTION_TOO_LARGE"
  | "SIGNING_FAILED"
  | "SUBMISSION_FAILED"
  | "NETWORK_ERROR"
  | "RATE_LIMITED";
