/**
 * Native Fee Payment Adapter
 *
 * Fallback adapter that uses direct SOL fee payment.
 * Used when Kora is not available or for testing.
 *
 * Requires a funded keypair to be configured as the fee payer.
 */

import { getBase58Codec } from "@solana/codecs";
import {
  type Address,
  createKeyPairSignerFromBytes,
  getTransactionDecoder,
  getTransactionEncoder,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { partiallySignTransactionWithSigners } from "@solana/signers";
import type { FeePaymentPort } from "@/services/ports";
import { FeePaymentError } from "@/services/ports";
import { createRpc, sendTransaction } from "@/services/solana/rpc";
import type { Env } from "@/types/env";

const base58 = getBase58Codec();

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Native fee payment adapter using direct SOL payment.
 *
 * This adapter requires:
 * 1. A funded keypair (FEE_PAYER_PRIVATE_KEY or CUSTODY_PRIVATE_KEY env var)
 * 2. Direct RPC access for transaction submission
 *
 * Use KoraAdapter for production gasless transactions.
 */
export class NativeAdapter implements FeePaymentPort {
  readonly providerId = "native";

  private env: Env;
  private signer: KeyPairSigner | null = null;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get the fee payer address.
   * Uses FEE_PAYER_PRIVATE_KEY if set, falls back to CUSTODY_PRIVATE_KEY.
   */
  async getFeePayer(): Promise<Address> {
    const signer = await this.getSigner();
    return signer.address;
  }

  /**
   * Sign a transaction as fee payer.
   * Note: This only adds the fee payer signature, does not send.
   */
  async signAsFeePayer(transaction: Uint8Array): Promise<Uint8Array> {
    try {
      const signer = await this.getSigner();
      const decoded = getTransactionDecoder().decode(transaction);
      const signed = await partiallySignTransactionWithSigners([signer], decoded);

      return new Uint8Array(getTransactionEncoder().encode(signed));
    } catch (error) {
      throw new FeePaymentError(
        "Failed to sign transaction as native fee payer",
        "SIGNING_FAILED",
        error as Error
      );
    }
  }

  /**
   * Sign and send a transaction.
   */
  async signAndSend(transaction: Uint8Array): Promise<Signature> {
    try {
      const signedTransaction = await this.signAsFeePayer(transaction);
      return await sendTransaction(createRpc(this.env), signedTransaction);
    } catch (error) {
      if (error instanceof FeePaymentError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new FeePaymentError(
        `Failed to submit transaction with native fee payer: ${errorMessage}`,
        "SUBMISSION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async getSigner(): Promise<KeyPairSigner> {
    if (this.signer) {
      return this.signer;
    }

    // Try FEE_PAYER_PRIVATE_KEY first, fall back to CUSTODY_PRIVATE_KEY
    const privateKey = this.env.FEE_PAYER_PRIVATE_KEY ?? this.env.CUSTODY_PRIVATE_KEY;

    if (!privateKey) {
      throw new FeePaymentError(
        "FEE_PAYER_PRIVATE_KEY or CUSTODY_PRIVATE_KEY not configured",
        "PROVIDER_NOT_AVAILABLE"
      );
    }

    const secretKey = base58.encode(privateKey);

    if (secretKey.length !== 64) {
      throw new FeePaymentError(
        `Invalid keypair length: expected 64 bytes, got ${secretKey.length}`,
        "PROVIDER_NOT_AVAILABLE"
      );
    }

    this.signer = await createKeyPairSignerFromBytes(secretKey);
    return this.signer;
  }
}
