/**
 * Fee Payment Port
 *
 * Interface for gasless transaction fee payment.
 * The platform sponsors all transaction fees via this port.
 * Users never pay fees directly - fully gasless model.
 *
 * Kora (`KoraAdapter`) is the only implementation.
 */

import type { Address } from "@solana/kit";

// ═══════════════════════════════════════════════════════════════════════════
// Environment
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Structural env surface the fee payment adapters read. The API app's
 * doppler-injected `Env` satisfies this shape; the package never reads
 * `process.env` directly.
 */
export interface FeePaymentEnv {
  KORA_TIMEOUT_MS?: string;
  /**
   * One Kora per cluster, named `KORA_<CLUSTER>_*` identically in Doppler, the
   * API and the Kora service; see `resolveKoraEndpoint`. `KORA_<CLUSTER>_URL`
   * is the Kora endpoint the API calls; `KORA_<CLUSTER>_RPC_URL` is the Solana
   * RPC that Kora itself talks to, which `@sdp/rpc`'s `createKoraUpstreamRpc`
   * reads for the Fee Payer's own chain reads.
   */
  KORA_DEVNET_URL?: string;
  KORA_DEVNET_RPC_URL?: string;
  KORA_DEVNET_API_KEY?: string;
  KORA_DEVNET_CLOUD_RUN_AUDIENCE?: string;
  KORA_MAINNET_URL?: string;
  KORA_MAINNET_RPC_URL?: string;
  KORA_MAINNET_API_KEY?: string;
  KORA_MAINNET_CLOUD_RUN_AUDIENCE?: string;
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

  /** Conservative provider-side lamport outflow ceiling used for admission. */
  getSponsorshipConfiguration(): Promise<SponsorshipProviderConfiguration>;
}

export interface SponsorshipProviderConfiguration {
  signerAddress: Address;
  maxAllowedLamports: bigint;
  feePayerMayTransferLamports: boolean;
  /** Raw authority policy used to pin security-relevant provider configuration. */
  feePayerPolicy: unknown;
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
  /**
   * The provider answered with a structured refusal of these exact bytes
   * (policy, allowlist, malformed transaction). It proves nothing was signed
   * or sent, and a retry of the same transaction cannot succeed.
   */
  | "PROVIDER_REJECTED"
  /** Signing threw without a structured verdict; the outcome may be ambiguous. */
  | "SIGNING_FAILED"
  | "SUBMISSION_FAILED"
  | "NETWORK_ERROR"
  | "RATE_LIMITED";
