/**
 * Ports Module
 *
 * Exports all port interfaces for the hexagonal architecture.
 * Ports define the boundaries between domain and infrastructure.
 */

// Fee payment port - gasless transaction sponsorship
export type {
  ExtendedFeePaymentPort,
  FeePaymentErrorCode,
  FeePaymentPort,
} from "./fee-payment.port";
export { FeePaymentError } from "./fee-payment.port";
// RPC port - Solana blockchain interaction
export type {
  AccountInfo,
  BlockhashWithExpiry,
  ConfirmTransactionOptions,
  RpcErrorCode,
  RpcPort,
  SendTransactionOptions,
  SimulateTransactionOptions,
  SimulationResult,
  TransactionConfirmation,
} from "./rpc.port";
export { RpcError } from "./rpc.port";
// Signing port - custody provider abstraction
export type {
  FullSigningPort,
  GeneratedKeypair,
  SigningErrorCode,
  SigningMetadata,
  SigningPort,
  SignRequest,
  SignResult,
  SignResultStatus,
  SignStatus,
} from "./signing.port";
export { isFullSigningPort, SigningError } from "./signing.port";
