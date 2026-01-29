/**
 * Kora Fee Payment Adapter
 *
 * Implements FeePaymentPort for gasless transactions using Kora.
 * The platform sponsors all transaction fees via Kora's fee payer.
 */

import type { FeePaymentPort } from "@/services/ports";
import { FeePaymentError } from "@/services/ports";
import {
  type Address,
  type Signature,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import { KoraClient, KoraClientError } from "./client";
import type { KoraAdapterConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KoraAdapter implements FeePaymentPort {
  readonly providerId = "kora";

  private client: KoraClient;
  private cachedFeePayer: Address | null = null;

  constructor(config: KoraAdapterConfig) {
    this.client = new KoraClient(config);
  }

  /**
   * Get the platform's fee payer address (Kora's signer).
   * Cached after first call.
   */
  async getFeePayer(): Promise<Address> {
    if (this.cachedFeePayer) {
      return this.cachedFeePayer;
    }

    try {
      const { signer_address } = await this.client.getPayerSigner();
      this.cachedFeePayer = signer_address as Address;
      return this.cachedFeePayer;
    } catch (error) {
      throw this.wrapError(error, "Failed to get fee payer address");
    }
  }

  /**
   * Sign a transaction with Kora's fee payer key without sending.
   * Returns the transaction bytes with the fee payer signature added.
   */
  async signAsFeePayer(transaction: Uint8Array): Promise<Uint8Array> {
    try {
      const base64Tx = encodeBase64(transaction);

      const { signedTransaction } = await this.client.signTransaction({
        transaction: base64Tx,
      });

      return decodeBase64(signedTransaction);
    } catch (error) {
      throw this.wrapError(error, "Failed to sign transaction as fee payer");
    }
  }

  /**
   * Sign a transaction with Kora's fee payer and submit to Solana.
   * This is the primary method for gasless transaction submission.
   */
  async signAndSend(transaction: Uint8Array): Promise<Signature> {
    try {
      const base64Tx = encodeBase64(transaction);

      const { signed_transaction } = await this.client.signAndSendTransaction({
        transaction: base64Tx,
      });

      // Decode the signed transaction using @solana/kit's decoder
      const signedTxBytes = decodeBase64(signed_transaction);
      const decodedTx = getTransactionDecoder().decode(signedTxBytes);

      // Extract the signature (first signer's signature = transaction ID)
      const signature = getSignatureFromTransaction(decodedTx);

      return signature;
    } catch (error) {
      throw this.wrapError(error, "Failed to sign and send transaction");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Optional Extended Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Estimate the fee for a transaction (optional capability)
   */
  async estimateFee(transaction: Uint8Array): Promise<bigint> {
    try {
      const base64Tx = encodeBase64(transaction);

      const { feeLamports } = await this.client.estimateTransactionFee({
        transaction: base64Tx,
      });

      return BigInt(feeLamports);
    } catch (error) {
      throw this.wrapError(error, "Failed to estimate transaction fee");
    }
  }

  /**
   * Get supported fee payment tokens (optional capability)
   */
  async getSupportedTokens(): Promise<Address[]> {
    try {
      const { tokens } = await this.client.getSupportedTokens();
      return tokens.map((t) => t.mint as Address);
    } catch (error) {
      throw this.wrapError(error, "Failed to get supported tokens");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private wrapError(error: unknown, message: string): FeePaymentError {
    if (error instanceof KoraClientError) {
      return new FeePaymentError(
        `${message}: ${error.message}`,
        mapKoraErrorCode(error.code),
        error
      );
    }

    return new FeePaymentError(
      `${message}: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function mapKoraErrorCode(
  code: import("./client").KoraErrorCode
): import("@/services/ports").FeePaymentErrorCode {
  switch (code) {
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "INSUFFICIENT_BALANCE":
      return "INSUFFICIENT_BALANCE";
    case "VALIDATION_FAILED":
    case "INVALID_REQUEST":
      return "SIGNING_FAILED";
    case "TRANSACTION_FAILED":
      return "SUBMISSION_FAILED";
    default:
      return "NETWORK_ERROR";
  }
}
