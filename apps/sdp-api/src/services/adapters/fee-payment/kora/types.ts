/**
 * Kora Types
 *
 * Types for the Kora fee payment JSON-RPC API.
 * Based on Solana Foundation's Kora relayer specification.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for the Kora adapter
 */
export interface KoraAdapterConfig {
  /** Kora JSON-RPC endpoint URL */
  rpcUrl: string;

  /** Optional API key for authentication */
  apiKey?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON-RPC Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * JSON-RPC 2.0 request format
 */
export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params: T;
}

/**
 * JSON-RPC 2.0 success response
 */
export interface JsonRpcSuccessResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}

/**
 * JSON-RPC 2.0 error response
 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<T> = JsonRpcSuccessResponse<T> | JsonRpcErrorResponse;

// ═══════════════════════════════════════════════════════════════════════════
// Kora API Response Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Response from getConfig
 */
export interface KoraConfig {
  fee_payer: string;
  validation_config: {
    max_allowed_lamports: number;
    max_signatures: number;
    allowed_programs: string[];
    allowed_tokens: string[];
    allowed_spl_paid_tokens: string[];
  };
}

/**
 * Response from getPayerSigner
 * Note: Kora API returns snake_case field names
 */
export interface KoraPayerSignerResponse {
  signer_address: string;
  payment_address?: string;
}

/**
 * Response from getSupportedTokens
 */
export interface KoraSupportedTokensResponse {
  tokens: KoraSupportedToken[];
}

export interface KoraSupportedToken {
  mint: string;
  symbol?: string;
  decimals: number;
}

/**
 * Response from getBlockhash
 */
export interface KoraBlockhashResponse {
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Parameters for estimateTransactionFee
 */
export interface KoraEstimateFeeParams {
  transaction: string; // Base64-encoded transaction
  paymentToken?: string; // Optional SPL token mint for fee payment
}

/**
 * Response from estimateTransactionFee
 */
export interface KoraEstimateFeeResponse {
  feeLamports: number;
  feeTokenAmount?: string;
  feeTokenMint?: string;
}

/**
 * Parameters for signTransaction
 */
export interface KoraSignTransactionParams {
  transaction: string; // Base64-encoded transaction
}

/**
 * Response from signTransaction
 */
export interface KoraSignTransactionResponse {
  signedTransaction: string; // Base64-encoded signed transaction
}

/**
 * Parameters for signAndSendTransaction
 */
export interface KoraSignAndSendTransactionParams {
  transaction: string; // Base64-encoded transaction
  skipPreflight?: boolean;
  maxRetries?: number;
}

/**
 * Response from signAndSendTransaction
 * Note: Kora returns the signed transaction, not a direct signature.
 * The signature must be extracted from the transaction bytes.
 */
export interface KoraSignAndSendTransactionResponse {
  signed_transaction: string; // Base64-encoded signed transaction
  signer_pubkey: string; // Fee payer's public key
}

/**
 * Parameters for getPaymentInstruction
 */
export interface KoraPaymentInstructionParams {
  feeLamports: number;
  paymentToken?: string;
  payer: string;
}

/**
 * Response from getPaymentInstruction
 */
export interface KoraPaymentInstructionResponse {
  instruction: {
    programId: string;
    keys: Array<{
      pubkey: string;
      isSigner: boolean;
      isWritable: boolean;
    }>;
    data: string; // Base64-encoded instruction data
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Error Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Kora-specific error codes
 */
export const KORA_ERROR_CODES = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Kora-specific
  VALIDATION_FAILED: -32000,
  RATE_LIMITED: -32001,
  INSUFFICIENT_BALANCE: -32002,
  TRANSACTION_FAILED: -32003,
} as const;
