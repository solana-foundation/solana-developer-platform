/**
 * Ports Module
 *
 * Exports all port interfaces for the hexagonal architecture.
 * Ports define the boundaries between domain and infrastructure.
 */

// Signing port - custody provider abstraction
export type {
  SigningPort,
  SignRequest,
  SignResult,
  SignResultStatus,
  SignStatus,
  SigningMetadata,
  GeneratedKeypair,
  SigningErrorCode,
} from "./signing.port";
export { SigningError } from "./signing.port";

// Fee payment port - gasless transaction sponsorship
export type {
  FeePaymentPort,
  ExtendedFeePaymentPort,
  FeePaymentErrorCode,
} from "./fee-payment.port";
export { FeePaymentError } from "./fee-payment.port";

// RPC port - Solana blockchain interaction
export type {
  RpcPort,
  BlockhashWithExpiry,
  SendTransactionOptions,
  ConfirmTransactionOptions,
  SimulateTransactionOptions,
  TransactionConfirmation,
  SimulationResult,
  AccountInfo,
  RpcErrorCode,
} from "./rpc.port";
export { RpcError } from "./rpc.port";
