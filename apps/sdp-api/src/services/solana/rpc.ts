/**
 * Solana RPC Service
 *
 * Provides RPC client creation and transaction submission utilities
 * using the modern @solana/kit.
 */

import { getSolanaConfig } from "@/lib/solana";
import type { Env } from "@/types/env";
import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Commitment,
  type Signature,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from "@solana/kit";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface BlockhashWithExpiry {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

export interface TransactionConfirmation {
  signature: Signature;
  slot: bigint;
  confirmationStatus: Commitment;
  err: unknown | null;
}

export interface SimulationResult {
  success: boolean;
  logs: string[];
  unitsConsumed: bigint | null;
  error: string | null;
}

// Type for RPC client
type SolanaRpc = ReturnType<typeof createSolanaRpc>;

// ═══════════════════════════════════════════════════════════════════════════
// RPC Client Factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a configured Solana RPC client from environment
 */
export function createRpc(env: Env): SolanaRpc {
  const config = getSolanaConfig(env);
  return createSolanaRpc(config.rpcUrl);
}

/**
 * Create RPC subscriptions client for real-time updates
 */
export function createRpcSubscriptions(env: Env) {
  const config = getSolanaConfig(env);
  // Convert HTTP URL to WebSocket URL
  const wsUrl = config.rpcUrl.replace("https://", "wss://").replace("http://", "ws://");

  return createSolanaRpcSubscriptions(wsUrl);
}

// ═══════════════════════════════════════════════════════════════════════════
// Blockhash Operations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a recent blockhash for transaction construction
 */
export async function getRecentBlockhash(
  rpc: SolanaRpc,
  commitment: Commitment = "confirmed"
): Promise<BlockhashWithExpiry> {
  const response = await rpc.getLatestBlockhash({ commitment }).send();

  return {
    blockhash: response.value.blockhash,
    lastValidBlockHeight: response.value.lastValidBlockHeight,
  };
}

/**
 * Check if a blockhash is still valid
 */
export async function isBlockhashValid(
  rpc: SolanaRpc,
  blockhash: Blockhash,
  commitment: Commitment = "confirmed"
): Promise<boolean> {
  const response = await rpc.isBlockhashValid(blockhash, { commitment }).send();

  return response.value;
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Submission
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send a signed transaction and return the signature
 */
export async function sendTransaction(
  rpc: SolanaRpc,
  signedTransaction: Uint8Array,
  options?: {
    skipPreflight?: boolean;
    maxRetries?: bigint;
  }
): Promise<Signature> {
  const encodedTx = Buffer.from(signedTransaction).toString(
    "base64"
  ) as Base64EncodedWireTransaction;

  const signature = await rpc
    .sendTransaction(encodedTx, {
      skipPreflight: options?.skipPreflight ?? false,
      maxRetries: options?.maxRetries,
    })
    .send();

  return signature;
}

/**
 * Send a signed transaction and wait for confirmation
 */
export async function sendAndConfirmTransaction(
  rpc: SolanaRpc,
  signedTransaction: Uint8Array,
  options?: {
    commitment?: Commitment;
    skipPreflight?: boolean;
    maxRetries?: bigint;
    timeoutMs?: number;
  }
): Promise<TransactionConfirmation> {
  const commitment = options?.commitment ?? "confirmed";
  const timeoutMs = options?.timeoutMs ?? 60000;

  // Send the transaction
  const signature = await sendTransaction(rpc, signedTransaction, {
    skipPreflight: options?.skipPreflight,
    maxRetries: options?.maxRetries,
  });

  // Poll for confirmation
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await rpc.getSignatureStatuses([signature]).send();

    const result = status.value[0];

    if (result) {
      // Check if confirmed to required level
      const isConfirmed =
        result.confirmationStatus === commitment ||
        (commitment === "confirmed" && result.confirmationStatus === "finalized") ||
        result.confirmationStatus === "finalized";

      if (isConfirmed) {
        return {
          signature,
          slot: result.slot,
          confirmationStatus: result.confirmationStatus ?? commitment,
          err: result.err,
        };
      }

      // Check for error
      if (result.err) {
        return {
          signature,
          slot: result.slot,
          confirmationStatus: result.confirmationStatus ?? "processed",
          err: result.err,
        };
      }
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Transaction ${signature} confirmation timed out after ${timeoutMs}ms`);
}

/**
 * Confirm an already-sent transaction
 */
export async function confirmTransaction(
  rpc: SolanaRpc,
  signature: Signature,
  options?: {
    commitment?: Commitment;
    timeoutMs?: number;
  }
): Promise<TransactionConfirmation> {
  const commitment = options?.commitment ?? "confirmed";
  const timeoutMs = options?.timeoutMs ?? 60000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await rpc.getSignatureStatuses([signature]).send();

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

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Transaction ${signature} confirmation timed out`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Simulation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simulate a transaction without submitting
 */
export async function simulateTransaction(
  rpc: SolanaRpc,
  transaction: Uint8Array,
  options?: {
    commitment?: Commitment;
  }
): Promise<SimulationResult> {
  const encodedTx = Buffer.from(transaction).toString("base64") as Base64EncodedWireTransaction;

  const response = await rpc
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
}

// ═══════════════════════════════════════════════════════════════════════════
// Account Operations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get account info for an address
 */
export async function getAccountInfo(
  rpc: SolanaRpc,
  address: Address,
  commitment: Commitment = "confirmed"
) {
  const response = await rpc
    .getAccountInfo(address, {
      encoding: "base64",
      commitment,
    })
    .send();

  return response.value;
}

/**
 * Check if an account exists
 */
export async function accountExists(
  rpc: SolanaRpc,
  address: Address,
  commitment: Commitment = "confirmed"
): Promise<boolean> {
  const info = await getAccountInfo(rpc, address, commitment);
  return info !== null;
}

/**
 * Get minimum rent-exempt balance for an account of given size
 */
export async function getMinimumBalanceForRentExemption(
  rpc: SolanaRpc,
  dataSize: number
): Promise<bigint> {
  const response = await rpc.getMinimumBalanceForRentExemption(BigInt(dataSize)).send();

  return response;
}

// Re-export types
export type { SolanaRpc, Commitment, Signature, Blockhash };
