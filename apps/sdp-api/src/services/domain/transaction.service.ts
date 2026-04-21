/**
 * Transaction Service
 *
 * Domain service for building and submitting Solana transactions.
 * Orchestrates the gasless model with Kora as fee payer.
 *
 * Flow for gasless transactions:
 * 1. Build transaction with Kora as fee payer
 * 2. Custody provider (Fireblocks) signs for authority operations
 * 3. Kora signs as fee payer and submits
 */

import type { Address, Blockhash, Instruction, Signature } from "@solana/kit";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { FeePaymentPort, RpcPort, SigningPort } from "@/services/ports";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Built transaction ready for signing
 */
export interface BuiltTransaction {
  /** Compiled transaction bytes */
  compiled: Uint8Array;
  /** Blockhash used */
  blockhash: Blockhash;
  /** Last valid block height */
  lastValidBlockHeight: bigint;
  /** Fee payer address (Kora) */
  feePayer: Address;
  /** Addresses that need to sign (besides fee payer) */
  requiredSigners: Address[];
}

/**
 * Result of sign and send operation
 */
export interface SignAndSendResult {
  /** Whether the operation is pending async approval */
  pending: boolean;
  /** Transaction signature if completed */
  signature?: Signature;
  /** Request ID for async signing (Fireblocks) */
  requestId?: string;
}

/**
 * Prepared transaction for client-side signing
 */
export interface PreparedTransaction {
  /** Base64-encoded serialized transaction */
  serialized: string;
  /** Blockhash used */
  blockhash: string;
  /** Last valid block height as string (for JSON) */
  lastValidBlockHeight: string;
  /** Fee payer address */
  feePayer: Address;
}

/**
 * Parameters for building a transaction
 */
export interface BuildTransactionParams {
  /** Instructions to include */
  instructions: Instruction[];
  /** Additional signers required (e.g., mint authority) */
  signers?: Address[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Domain service for transaction building and submission.
 * Uses ports for RPC, signing, and fee payment.
 */
export class TransactionService {
  constructor(
    private rpc: RpcPort,
    private signing: SigningPort,
    private feePayment: FeePaymentPort
  ) {}

  /**
   * Build a transaction with Kora as fee payer (gasless model).
   * All transactions are sponsored by the platform.
   */
  async buildTransaction(params: BuildTransactionParams): Promise<BuiltTransaction> {
    const { blockhash, lastValidBlockHeight } = await this.rpc.getRecentBlockhash();

    // Kora is always the fee payer (gasless model)
    const feePayer = await this.feePayment.getFeePayer();

    // Build transaction message
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions(params.instructions, m)
    );

    // Compile to wire format and convert to bytes
    const compiled = compileTransaction(message);
    const base64Tx = getBase64EncodedWireTransaction(compiled);
    const txBytes = decodeBase64(base64Tx);

    return {
      compiled: txBytes,
      blockhash,
      lastValidBlockHeight,
      feePayer,
      requiredSigners: params.signers ?? [],
    };
  }

  /**
   * Sign a transaction with custody provider and submit via Kora.
   *
   * Two-step signing flow:
   * 1. If requiredSigners exist, get custody signatures (Fireblocks)
   * 2. Kora signs as fee payer and submits to Solana
   */
  async signAndSend(transaction: BuiltTransaction): Promise<SignAndSendResult> {
    let signedTx = transaction.compiled;

    // Step 1: Get custody signature(s) if needed
    if (transaction.requiredSigners.length > 0) {
      const custodyResult = await this.signing.sign({
        message: transaction.compiled,
        signers: transaction.requiredSigners,
      });

      if (custodyResult.status === "pending") {
        // Async signing (Fireblocks approval required)
        return {
          pending: true,
          requestId: custodyResult.requestId,
        };
      }

      if (custodyResult.status !== "completed" || !custodyResult.signatures) {
        throw new TransactionError(
          `Signing failed: ${custodyResult.error ?? custodyResult.status}`,
          "SIGNING_FAILED"
        );
      }

      // Apply custody signatures to the transaction
      signedTx = applySignatures(transaction.compiled, custodyResult.signatures);
    }

    // Step 2: Kora signs as fee payer and submits
    const signature = await this.feePayment.signAndSend(signedTx);

    return {
      pending: false,
      signature,
    };
  }

  /**
   * Resume a pending async signing operation.
   * Used when Fireblocks approval is granted.
   */
  async resumePendingSign(
    transaction: BuiltTransaction,
    requestId: string
  ): Promise<SignAndSendResult> {
    // Check signing status
    if (!this.signing.getSignStatus) {
      throw new TransactionError(
        "Signing provider does not support async status polling",
        "INVALID_OPERATION"
      );
    }

    const status = await this.signing.getSignStatus(requestId);

    if (status.status === "pending") {
      return { pending: true, requestId };
    }

    if (status.status === "rejected") {
      throw new TransactionError(`Signing rejected: ${status.reason}`, "SIGNING_REJECTED");
    }

    if (status.status === "failed") {
      throw new TransactionError(`Signing failed: ${status.error}`, "SIGNING_FAILED");
    }

    // status.status === "completed"
    const signedTx = applySignatures(transaction.compiled, status.signatures);

    // Submit via Kora
    const signature = await this.feePayment.signAndSend(signedTx);

    return {
      pending: false,
      signature,
    };
  }

  /**
   * Prepare an unsigned transaction for client signing (prepare mode).
   * Returns serialized tx that client can sign and submit via Kora.
   */
  async prepareTransaction(params: BuildTransactionParams): Promise<PreparedTransaction> {
    const built = await this.buildTransaction(params);

    return {
      serialized: encodeBase64(built.compiled),
      blockhash: built.blockhash as string,
      lastValidBlockHeight: built.lastValidBlockHeight.toString(),
      feePayer: built.feePayer,
    };
  }

  /**
   * Submit a client-signed transaction via Kora.
   * Used in prepare mode after client signs the transaction.
   */
  async submitTransaction(signedTransaction: Uint8Array): Promise<Signature> {
    return this.feePayment.signAndSend(signedTransaction);
  }

  /**
   * Simulate a transaction without submitting.
   */
  async simulateTransaction(
    transaction: BuiltTransaction
  ): Promise<{ success: boolean; logs: string[]; error: string | null }> {
    const result = await this.rpc.simulateTransaction(transaction.compiled);

    return {
      success: result.success,
      logs: result.logs,
      error: result.error,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════

export type TransactionErrorCode =
  | "BUILD_FAILED"
  | "SIGNING_FAILED"
  | "SIGNING_REJECTED"
  | "SUBMISSION_FAILED"
  | "SIMULATION_FAILED"
  | "INVALID_OPERATION";

export class TransactionError extends Error {
  constructor(
    message: string,
    public readonly code: TransactionErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "TransactionError";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply signatures to a compiled transaction.
 *
 * Note: This is a simplified implementation. In practice, you'd need to
 * parse the transaction, find the signature slots, and insert signatures
 * at the correct positions based on the signers' public keys.
 */
function applySignatures(
  transaction: Uint8Array,
  signatures: Map<Address, Uint8Array>
): Uint8Array {
  // For now, return the transaction as-is since Kora will handle the final assembly
  // TODO: Implement proper signature insertion when needed for multi-signer flows
  //
  // The compiled transaction format is:
  // - 1 byte: number of signatures
  // - 64 bytes * num_signatures: signature slots
  // - remaining: serialized message
  //
  // Each signature slot corresponds to a signer in the message's account keys.
  // We need to match the public key to find the correct slot.

  if (signatures.size === 0) {
    return transaction;
  }

  // Create a copy of the transaction to modify
  const result = new Uint8Array(transaction);

  // Number of signature slots
  const _numSignatures = result[0];

  // We can't easily insert signatures without knowing the account key order
  // For the gasless model, we rely on:
  // 1. Custody provider returning a fully signed message for their signers
  // 2. Kora adding the fee payer signature during signAndSend
  //
  // This function is a placeholder for when we need proper multi-signer support.

  return result;
}

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
