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
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import type { FeePaymentPort } from "@/services/ports";
import { FeePaymentError } from "@/services/ports";
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
  async signAsFeePayer(_transaction: Uint8Array): Promise<Uint8Array> {
    // The native adapter cannot easily sign an already-serialized transaction
    // because the signature needs to be inserted at the correct position.
    // This is a limitation - use KoraAdapter for proper gasless transactions.
    throw new FeePaymentError(
      "NativeAdapter.signAsFeePayer not supported - use KoraAdapter for gasless transactions",
      "SIGNING_FAILED"
    );
  }

  /**
   * Sign and send a transaction.
   * Note: This adapter cannot implement this without RPC access.
   */
  async signAndSend(_transaction: Uint8Array): Promise<Signature> {
    // The native adapter would need RPC access to send transactions.
    // This breaks the port abstraction, so we don't support it here.
    throw new FeePaymentError(
      "NativeAdapter.signAndSend not supported - use KoraAdapter for gasless transactions",
      "SUBMISSION_FAILED"
    );
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
