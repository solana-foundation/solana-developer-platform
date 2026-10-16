/**
 * Native Fee Payment Adapter
 *
 * First-class fee payment provider for self-hosted deployments that do not want
 * a third-party relayer. A locally-configured, funded keypair signs as the fee
 * payer and (for `signAndSend`) submits the transaction over direct RPC.
 *
 * Use KoraAdapter instead when you want gasless/relayed execution.
 */

import { isTransientRpcError } from "@sdp/rpc";
import * as solanaRpc from "@sdp/rpc/solana";
import { getBase58Codec } from "@solana/codecs";
import {
  type Address,
  createKeyPairSignerFromBytes,
  getTransactionDecoder,
  getTransactionEncoder,
  type KeyPairSigner,
  partiallySignTransaction,
  type Signature,
} from "@solana/kit";
import type { FeePaymentEnv, FeePaymentErrorCode, FeePaymentPort } from "./port";
import { FeePaymentError } from "./port";

const base58 = getBase58Codec();

// Transient gateway errors from the underlying RPC (e.g. Helius devnet) can resolve
// on a retry; blockhash expiry cannot, so we only retry the transient HTTP cases.
const MAX_SUBMIT_RETRIES = 3;

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Native fee payment adapter using direct SOL payment over RPC.
 *
 * This adapter requires:
 * 1. A funded keypair (FEE_PAYER_PRIVATE_KEY or CUSTODY_PRIVATE_KEY env var)
 * 2. Direct RPC access for transaction submission (from the standard Solana config)
 */
export class NativeAdapter implements FeePaymentPort {
  readonly providerId = "native";

  private env: FeePaymentEnv;
  private signer: KeyPairSigner | null = null;

  constructor(env: FeePaymentEnv) {
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
   * Sign a transaction as fee payer without sending.
   * Adds the fee payer signature to the (already source-signed) transaction and
   * returns the re-serialized bytes for the caller to submit.
   */
  async signAsFeePayer(transaction: Uint8Array): Promise<Uint8Array> {
    const signedTransaction = await this.signTransactionAsFeePayer(transaction);
    return new Uint8Array(getTransactionEncoder().encode(signedTransaction));
  }

  /**
   * Sign a transaction as fee payer and submit it over direct RPC.
   * This is the primary method for non-relayed transaction submission.
   */
  async signAndSend(transaction: Uint8Array): Promise<Signature> {
    const signedTransaction = await this.signTransactionAsFeePayer(transaction);
    const signedBytes = new Uint8Array(getTransactionEncoder().encode(signedTransaction));
    return this.submitWithRetry(solanaRpc.createRpc(this.env), signedBytes);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Decode the serialized transaction and add the fee payer signature in its
   * correct slot. `partiallySignTransaction` matches the keypair's address to the
   * transaction's signer accounts, preserving any existing (source) signatures.
   */
  private async signTransactionAsFeePayer(transaction: Uint8Array) {
    const signer = await this.getSigner();

    try {
      const decoded = getTransactionDecoder().decode(transaction);
      return await partiallySignTransaction([signer.keyPair], decoded);
    } catch (error) {
      throw wrapError(error, "Failed to sign transaction as fee payer", "SIGNING_FAILED");
    }
  }

  /**
   * Submit the signed transaction over RPC, retrying transient gateway failures
   * with linear backoff. Recurses until the submission succeeds, hits a
   * non-retryable error, or exhausts MAX_SUBMIT_RETRIES.
   */
  private async submitWithRetry(
    rpc: ReturnType<typeof solanaRpc.createRpc>,
    signedBytes: Uint8Array,
    attempt: number = 1
  ): Promise<Signature> {
    try {
      return await solanaRpc.sendTransaction(rpc, signedBytes);
    } catch (error) {
      if (attempt >= MAX_SUBMIT_RETRIES || !isTransientRpcError(error)) {
        throw wrapError(error, "Failed to submit transaction", "SUBMISSION_FAILED");
      }

      await sleep((attempt + 1) * 500);
      return this.submitWithRetry(rpc, signedBytes, attempt + 1);
    }
  }

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

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function wrapError(error: unknown, message: string, code: FeePaymentErrorCode): FeePaymentError {
  // Preserve already-classified errors (e.g. PROVIDER_NOT_AVAILABLE from getSigner).
  if (error instanceof FeePaymentError) {
    return error;
  }

  return new FeePaymentError(
    `${message}: ${error instanceof Error ? error.message : "Unknown error"}`,
    code,
    error instanceof Error ? error : undefined
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
