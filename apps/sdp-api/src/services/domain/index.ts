/**
 * Domain Services Module
 *
 * Exports all domain services for the hexagonal architecture.
 * Domain services contain business logic and orchestrate ports.
 */

// Transaction service - builds and submits gasless transactions
export {
  TransactionService,
  TransactionError,
  type BuiltTransaction,
  type SignAndSendResult,
  type PreparedTransaction,
  type BuildTransactionParams,
  type TransactionErrorCode,
} from "./transaction.service";

// Signing service - manages custody providers and signing operations
export {
  SigningService,
  type SigningConfigStore,
  type SigningRequestStore,
  type SigningConfiguration,
  type SigningRequestRecord,
  type CreateSigningRequestParams,
} from "./signing.service";
