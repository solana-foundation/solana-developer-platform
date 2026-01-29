/**
 * RPC Port
 *
 * Interface for Solana RPC operations.
 * Abstracts the underlying RPC client implementation.
 *
 * Implementations:
 * - SolanaRpcAdapter: Uses @solana/kit RPC client
 */

import type { Address, Blockhash, Commitment, Signature } from "@solana/kit";

// ═══════════════════════════════════════════════════════════════════════════
// Port Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Port interface for Solana RPC operations.
 * Adapters implement this to provide blockchain interaction.
 */
export interface RpcPort {
  /**
   * Get a recent blockhash for transaction construction.
   */
  getRecentBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiry>;

  /**
   * Check if a blockhash is still valid.
   */
  isBlockhashValid(blockhash: Blockhash, commitment?: Commitment): Promise<boolean>;

  /**
   * Send a signed transaction to the network.
   */
  sendTransaction(transaction: Uint8Array, options?: SendTransactionOptions): Promise<Signature>;

  /**
   * Confirm a transaction has reached the desired commitment level.
   */
  confirmTransaction(
    signature: Signature,
    options?: ConfirmTransactionOptions
  ): Promise<TransactionConfirmation>;

  /**
   * Simulate a transaction without submitting.
   */
  simulateTransaction(
    transaction: Uint8Array,
    options?: SimulateTransactionOptions
  ): Promise<SimulationResult>;

  /**
   * Get account info for an address.
   */
  getAccountInfo(address: Address, commitment?: Commitment): Promise<AccountInfo | null>;

  /**
   * Check if an account exists.
   */
  accountExists(address: Address, commitment?: Commitment): Promise<boolean>;

  /**
   * Get minimum rent-exempt balance for an account of given size.
   */
  getMinimumBalanceForRentExemption(dataSize: number): Promise<bigint>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Blockhash with expiry information
 */
export interface BlockhashWithExpiry {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

/**
 * Options for sending transactions
 */
export interface SendTransactionOptions {
  skipPreflight?: boolean;
  maxRetries?: bigint;
}

/**
 * Options for confirming transactions
 */
export interface ConfirmTransactionOptions {
  commitment?: Commitment;
  timeoutMs?: number;
}

/**
 * Options for simulating transactions
 */
export interface SimulateTransactionOptions {
  commitment?: Commitment;
}

/**
 * Result of transaction confirmation
 */
export interface TransactionConfirmation {
  signature: Signature;
  slot: bigint;
  confirmationStatus: Commitment;
  err: unknown | null;
}

/**
 * Result of transaction simulation
 */
export interface SimulationResult {
  success: boolean;
  logs: string[];
  unitsConsumed: bigint | null;
  error: string | null;
}

/**
 * Account information
 */
export interface AccountInfo {
  /** Account data (base64 encoded) */
  data: [string, "base64"];
  /** Whether account is executable */
  executable: boolean;
  /** Lamports in account */
  lamports: bigint;
  /** Owner program address */
  owner: Address;
  /** Rent epoch */
  rentEpoch: bigint;
}

// ═══════════════════════════════════════════════════════════════════════════
// Error Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Base error for RPC operations
 */
export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code: RpcErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type RpcErrorCode =
  | "CONNECTION_FAILED"
  | "TIMEOUT"
  | "TRANSACTION_FAILED"
  | "SIMULATION_FAILED"
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_BLOCKHASH"
  | "RATE_LIMITED";
