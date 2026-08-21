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

import type { RpcEnv } from "@sdp/rpc";
import type { Address, Signature } from "@solana/kit";

// ═══════════════════════════════════════════════════════════════════════════
// Environment
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Structural env surface the fee payment adapters read. The API app's
 * doppler-injected `Env` satisfies this shape; the package never reads
 * `process.env` directly.
 */
export interface FeePaymentEnv extends RpcEnv {
  FEE_PAYMENT_PROVIDER?: "kora" | "native";
  KORA_RPC_URL?: string;
  KORA_API_KEY?: string;
  KORA_CLOUD_RUN_AUDIENCE?: string;
  KORA_TIMEOUT_MS?: string;
  FEE_PAYER_PRIVATE_KEY?: string;
  CUSTODY_PRIVATE_KEY?: string;
}

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

  /** Conservative provider-side lamport outflow ceiling used for admission. */
  getSponsorshipConfiguration?(): Promise<SponsorshipProviderConfiguration>;
}

export interface SponsorshipProviderConfiguration {
  signerAddress: Address;
  maxAllowedLamports: bigint;
  feePayerMayTransferLamports: boolean;
  /** Raw authority policy used to pin security-relevant provider configuration. */
  feePayerPolicy: unknown;
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
  /**
   * True when an earlier attempt of the same call may have reached the
   * provider (lost response, dropped connection, timeout) — so this error,
   * whatever its code or text, cannot vouch that nothing was broadcast.
   * Consumers must treat the outcome as unknown instead of journaling a
   * terminal failure that invites a resend.
   */
  public readonly maybeBroadcast: boolean;

  /**
   * True when the throw site can prove the transaction never left the
   * process — the failure happened before any provider submission (admission,
   * preflight, configuration) — so a plain terminal failure is safe whatever
   * the code. The constructor enforces mutual exclusion: when maybeBroadcast
   * is set, preBroadcast is forced false (fail closed).
   */
  public readonly preBroadcast: boolean;

  constructor(
    message: string,
    public readonly code: FeePaymentErrorCode,
    public readonly cause?: Error,
    options?: { maybeBroadcast?: boolean; preBroadcast?: boolean }
  ) {
    super(message);
    this.name = "FeePaymentError";
    this.maybeBroadcast = options?.maybeBroadcast ?? false;
    this.preBroadcast = !this.maybeBroadcast && (options?.preBroadcast ?? false);
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
