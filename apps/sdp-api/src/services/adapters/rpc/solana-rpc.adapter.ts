/**
 * Solana RPC Adapter
 *
 * Implements RpcPort using @solana/kit RPC client.
 */

import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Commitment,
  createSolanaRpc,
  type Signature,
} from "@solana/kit";
import { getSolanaConfig } from "@/lib/solana";
import type {
  AccountInfo,
  BlockhashWithExpiry,
  ConfirmTransactionOptions,
  RpcPort,
  SendTransactionOptions,
  SimulateTransactionOptions,
  SimulationResult,
  TransactionConfirmation,
} from "@/services/ports";
import { RpcError } from "@/services/ports";
import type { Env } from "@/types/env";

// Type for RPC client
type SolanaRpc = ReturnType<typeof createSolanaRpc>;

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class SolanaRpcAdapter implements RpcPort {
  private rpc: SolanaRpc;

  constructor(env: Env) {
    const config = getSolanaConfig(env);
    this.rpc = createSolanaRpc(config.rpcUrl);
  }

  /**
   * Get a recent blockhash for transaction construction
   */
  async getRecentBlockhash(commitment: Commitment = "confirmed"): Promise<BlockhashWithExpiry> {
    try {
      const response = await this.rpc.getLatestBlockhash({ commitment }).send();

      return {
        blockhash: response.value.blockhash,
        lastValidBlockHeight: response.value.lastValidBlockHeight,
      };
    } catch (error) {
      throw new RpcError(
        `Failed to get blockhash: ${error instanceof Error ? error.message : "Unknown error"}`,
        "CONNECTION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if a blockhash is still valid
   */
  async isBlockhashValid(
    blockhash: Blockhash,
    commitment: Commitment = "confirmed"
  ): Promise<boolean> {
    try {
      const response = await this.rpc.isBlockhashValid(blockhash, { commitment }).send();
      return response.value;
    } catch (error) {
      throw new RpcError(
        `Failed to check blockhash validity: ${error instanceof Error ? error.message : "Unknown error"}`,
        "CONNECTION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Send a signed transaction to the network
   */
  async sendTransaction(
    transaction: Uint8Array,
    options?: SendTransactionOptions
  ): Promise<Signature> {
    try {
      const encodedTx = encodeBase64(transaction) as Base64EncodedWireTransaction;

      const signature = await this.rpc
        .sendTransaction(encodedTx, {
          skipPreflight: options?.skipPreflight ?? false,
          maxRetries: options?.maxRetries,
        })
        .send();

      return signature;
    } catch (error) {
      throw new RpcError(
        `Failed to send transaction: ${error instanceof Error ? error.message : "Unknown error"}`,
        "TRANSACTION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Confirm a transaction has reached the desired commitment level
   */
  async confirmTransaction(
    signature: Signature,
    options?: ConfirmTransactionOptions
  ): Promise<TransactionConfirmation> {
    const commitment = options?.commitment ?? "confirmed";
    const timeoutMs = options?.timeoutMs ?? 60000;
    const startTime = Date.now();

    try {
      while (Date.now() - startTime < timeoutMs) {
        const status = await this.rpc.getSignatureStatuses([signature]).send();
        const result = status.value[0];

        if (result) {
          const isConfirmed =
            result.confirmationStatus === commitment ||
            (commitment === "confirmed" && result.confirmationStatus === "finalized") ||
            result.confirmationStatus === "finalized";

          if (isConfirmed || result.err) {
            return {
              signature,
              slot: result.slot,
              confirmationStatus: result.confirmationStatus ?? commitment,
              err: result.err,
            };
          }
        }

        // Wait before polling again
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      throw new RpcError(
        `Transaction ${signature} confirmation timed out after ${timeoutMs}ms`,
        "TIMEOUT"
      );
    } catch (error) {
      if (error instanceof RpcError) {
        throw error;
      }

      throw new RpcError(
        `Failed to confirm transaction: ${error instanceof Error ? error.message : "Unknown error"}`,
        "CONNECTION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Simulate a transaction without submitting
   */
  async simulateTransaction(
    transaction: Uint8Array,
    options?: SimulateTransactionOptions
  ): Promise<SimulationResult> {
    try {
      const encodedTx = encodeBase64(transaction) as Base64EncodedWireTransaction;

      const response = await this.rpc
        .simulateTransaction(encodedTx, {
          encoding: "base64" as const,
          commitment: options?.commitment ?? "confirmed",
          sigVerify: false as const,
        })
        .send();

      const result = response.value;

      return {
        success: result.err === null,
        logs: result.logs ?? [],
        unitsConsumed: result.unitsConsumed ?? null,
        error: result.err ? JSON.stringify(result.err) : null,
      };
    } catch (error) {
      throw new RpcError(
        `Failed to simulate transaction: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SIMULATION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get account info for an address
   */
  async getAccountInfo(
    address: Address,
    commitment: Commitment = "confirmed"
  ): Promise<AccountInfo | null> {
    try {
      const response = await this.rpc
        .getAccountInfo(address, {
          encoding: "base64",
          commitment,
        })
        .send();

      if (!response.value) {
        return null;
      }

      return {
        data: response.value.data as [string, "base64"],
        executable: response.value.executable,
        lamports: response.value.lamports,
        owner: response.value.owner,
        rentEpoch: 0n, // Not returned by newer RPC versions
      };
    } catch (error) {
      throw new RpcError(
        `Failed to get account info: ${error instanceof Error ? error.message : "Unknown error"}`,
        "CONNECTION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if an account exists
   */
  async accountExists(address: Address, commitment: Commitment = "confirmed"): Promise<boolean> {
    const info = await this.getAccountInfo(address, commitment);
    return info !== null;
  }

  /**
   * Get minimum rent-exempt balance for an account of given size
   */
  async getMinimumBalanceForRentExemption(dataSize: number): Promise<bigint> {
    try {
      const response = await this.rpc.getMinimumBalanceForRentExemption(BigInt(dataSize)).send();
      return response;
    } catch (error) {
      throw new RpcError(
        `Failed to get rent exemption: ${error instanceof Error ? error.message : "Unknown error"}`,
        "CONNECTION_FAILED",
        error instanceof Error ? error : undefined
      );
    }
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
