/**
 * Solana Services
 *
 * Re-exports all Solana-related services for convenient importing.
 */

// RPC client and utilities
export {
  createRpc,
  createRpcSubscriptions,
  getRecentBlockhash,
  isBlockhashValid,
  sendTransaction,
  sendAndConfirmTransaction,
  confirmTransaction,
  simulateTransaction,
  getAccountInfo,
  accountExists,
  getMinimumBalanceForRentExemption,
  type BlockhashWithExpiry,
  type TransactionConfirmation,
  type SimulationResult,
} from "./rpc";

// Signer service
export {
  type KeyPairSigner,
  createSigner,
  createSignerFromBase58,
  signerControlsAddress,
  getSignerAddress,
} from "./signer";

// Token-2022 operations
export {
  Token2022Service,
  type CreateMintOptions,
  type CreateMintResult,
  type PreparedTransaction,
  type MintToOptions,
  type MintToResult,
  type BurnOptions,
  type BurnResult,
  type FreezeOptions,
  type FreezeResult,
} from "./token-2022";

// Service factory (wires up Kora integration when configured)
export { createToken2022Service } from "./factory";
