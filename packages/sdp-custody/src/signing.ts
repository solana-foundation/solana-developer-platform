/**
 * Signing Port
 *
 * Interfaces for custody providers that expose Solana transaction signers.
 */

import type { Address, TransactionSigner } from "@solana/kit";

/** Common custody provider operations. */
export interface SigningPort {
  /** Unique identifier for this provider type. */
  readonly providerId: string;

  /** Get the public key for a signing wallet. */
  getPublicKey(walletId?: string): Promise<Address>;
}

/** Custody providers that support full transaction signing through @solana/kit. */
export interface FullSigningPort extends SigningPort {
  getTransactionSigner(walletId?: string, walletPublicKey?: Address): Promise<TransactionSigner>;
}

export function isFullSigningPort(port: SigningPort): port is FullSigningPort {
  return typeof (port as Partial<FullSigningPort>).getTransactionSigner === "function";
}

/** Base error for signing operations. */
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
  | "NOT_FOUND"
  | "CONFLICT"
  | "PROVIDER_CREDENTIAL_INVALID";
