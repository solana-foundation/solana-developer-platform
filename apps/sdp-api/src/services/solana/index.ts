/**
 * Solana Services
 *
 * Re-exports all Solana-related services for convenient importing.
 */

// Service factory (wires up Kora integration when configured)
export { createToken2022Service } from "./factory";
// RPC client and utilities
export {
  accountExists,
  type BlockhashWithExpiry,
  confirmTransaction,
  createRpc,
  createRpcSubscriptions,
  getAccountInfo,
  getMinimumBalanceForRentExemption,
  getRecentBlockhash,
  isBlockhashValid,
  type SimulationResult,
  sendAndConfirmTransaction,
  sendTransaction,
  simulateTransaction,
  type TransactionConfirmation,
} from "./rpc";
// Signer service
export {
  createOrgSigner,
  createSigner,
  createSignerFromBase58,
  getSignerAddress,
  type KeyPairSigner,
  signerControlsAddress,
} from "./signer";
// Solana Pay primitives (link encoding + reference reconciliation)
export {
  encodeSolanaPayURL,
  findReference,
  type SolanaPayTransferRequest,
  type TransferValidation,
  type ValidateTransferParams,
  validateTransfer,
} from "./solana-pay";
// Token-2022 operations
export {
  type BurnOptions,
  type BurnResult,
  type CreateMintOptions,
  type CreateMintResult,
  type FreezeOptions,
  type FreezeResult,
  type MintToOptions,
  type MintToResult,
  type PreparedTransaction,
  Token2022Service,
} from "./token-2022";
