/**
 * Transaction Types for Solana Developer Platform
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO TRANSACTION MODES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The API supports two modes for transaction execution:
 *
 * 1. PREPARE MODE (`/prepare` endpoints)
 *    - Returns an unsigned serialized transaction (like Solana Actions/Blinks)
 *    - Client is responsible for signing with their wallet
 *    - Client submits the signed transaction
 *    - Use case: Wallet adapter integrations, user-controlled signing
 *
 *    Example flow:
 *    ```typescript
 *    // Server returns unsigned tx
 *    const { transaction } = await sdp.transfers.prepare({ from, to, amount });
 *
 *    // Client signs with wallet adapter
 *    const signed = await wallet.signTransaction(transaction);
 *
 *    // Client submits
 *    const sig = await connection.sendRawTransaction(signed.serialize());
 *    ```
 *
 * 2. EXECUTE MODE (default endpoints, no suffix)
 *    - Server signs using custody provider (Fireblocks, Dfns, etc.)
 *    - Server submits the transaction
 *    - Returns transaction signature and status
 *    - Use case: Server-side automation, treasury operations
 *
 *    Example flow:
 *    ```typescript
 *    // Server signs and submits
 *    const { transaction } = await sdp.transfers.execute({ from, to, amount });
 *    console.log(transaction.signature); // Solana tx signature
 *    ```
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ENDPOINT PATTERNS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Payments:
 *   POST /payments/transfers/prepare  → Returns unsigned tx
 *   POST /payments/transfers          → Signs & submits via custody
 *
 * Token Issuance:
 *   POST /issuance/tokens/{id}/mint/prepare  → Returns unsigned tx
 *   POST /issuance/tokens/{id}/mint          → Signs & submits
 *
 * Transaction Lifecycle (low-level):
 *   POST /transactions/prepare   → Build unsigned tx from intent
 *   POST /transactions/simulate  → Simulate any transaction
 *   POST /transactions/sign      → Sign with custody (return signed tx)
 *   POST /transactions/send      → Sign + send with custody
 *   GET  /transactions/{sig}     → Get status
 */

// ═══════════════════════════════════════════════════════════════════════════
// Common Types
// ═══════════════════════════════════════════════════════════════════════════

export type TransactionStatus =
  | "pending"
  | "processing"
  | "confirmed"
  | "finalized"
  | "failed"
  | "expired";

export type TransactionType =
  | "transfer"
  | "token_mint"
  | "token_burn"
  | "token_transfer"
  | "token_create"
  | "stake"
  | "unstake"
  | "swap"
  | "custom";

export type Commitment = "processed" | "confirmed" | "finalized";

export type PriorityFee = "none" | "low" | "medium" | "high" | number;

export interface TransactionIntent {
  type: TransactionType;
  params: Record<string, unknown>;
}

export interface TransactionError {
  code: string;
  message: string;
  logs?: string[];
}

/**
 * Stored transaction record
 */
export interface TransactionRecord {
  id: string; // tx_xxxxxxxxxxxx
  organizationId: string;
  signature: string | null; // Solana tx signature (null if not yet submitted)
  type: TransactionType;
  status: TransactionStatus;
  serializedTransaction: string | null; // Base64 encoded
  intent: TransactionIntent | null;
  simulationResult: SimulationResult | null;
  error: TransactionError | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  finalizedAt: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Simulation
// ═══════════════════════════════════════════════════════════════════════════

export interface SimulationResult {
  success: boolean;
  unitsConsumed: number;
  fee: number; // In lamports
  logs: string[];
  returnData: string | null;
  accountChanges: AccountChange[];
  error: string | null;
}

export interface AccountChange {
  address: string;
  before: {
    lamports: number;
    owner: string;
    data: string; // Base64
  } | null;
  after: {
    lamports: number;
    owner: string;
    data: string;
  } | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unsigned Transaction Response (shared by all /prepare endpoints)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Response format for all /prepare endpoints
 * Contains everything needed for client-side signing
 */
export interface UnsignedTransactionResponse {
  transaction: {
    /** Base64 encoded unsigned transaction (versioned) */
    serialized: string;
    /** Base64 encoded transaction message (for inspection/verification) */
    message: string;
    /** Recent blockhash used */
    recentBlockhash: string;
    /** Block height after which tx is invalid */
    lastValidBlockHeight: number;
  };
  /** Simulation result (if requested) */
  simulation?: SimulationResult;
  /** Estimated fee in lamports */
  estimatedFee: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Transfer Types (POST /payments/transfers)
// ═══════════════════════════════════════════════════════════════════════════

export interface TransferIntent {
  /** Source wallet address */
  from: string;
  /** Destination address */
  to: string;
  /** Amount in base units (lamports for SOL, smallest unit for tokens) */
  amount: string;
  /** Token mint address (omit for native SOL) */
  mint?: string;
  /** Optional memo to include in transaction */
  memo?: string;
  /** Optional reference key for tracking (like Solana Pay) */
  reference?: string;
}

/**
 * POST /payments/transfers/prepare
 * Returns unsigned transaction for client signing
 */
export interface PrepareTransferRequest {
  transfer: TransferIntent;
  options?: {
    /** Priority fee level or exact microlamports per CU */
    priorityFee?: PriorityFee;
    /** Include simulation result in response (default: true) */
    simulate?: boolean;
  };
}

export interface PrepareTransferResponse extends UnsignedTransactionResponse {
  meta: {
    type: "transfer";
    from: string;
    to: string;
    amount: string;
    mint: string | null;
  };
}

/**
 * POST /payments/transfers
 * Server signs and submits via custody provider
 */
export interface ExecuteTransferRequest {
  transfer: TransferIntent;
  options?: {
    priorityFee?: PriorityFee;
    /** Skip preflight simulation (default: false) */
    skipPreflight?: boolean;
    /** Max retry attempts (default: 3) */
    maxRetries?: number;
    /** Confirmation level to wait for (default: confirmed) */
    commitment?: Commitment;
  };
}

export interface ExecuteTransferResponse {
  transaction: {
    /** Internal transaction ID */
    id: string;
    /** Solana transaction signature */
    signature: string;
    /** Current status */
    status: TransactionStatus;
  };
  meta: {
    type: "transfer";
    from: string;
    to: string;
    amount: string;
    mint: string | null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Mint Types (POST /issuance/tokens/{id}/mint)
// ═══════════════════════════════════════════════════════════════════════════

export interface MintIntent {
  /** Token ID (internal) or mint address */
  tokenId: string;
  /** Destination address to receive minted tokens */
  destination: string;
  /** Amount to mint in base units */
  amount: string;
  /** Optional memo */
  memo?: string;
}

/**
 * POST /issuance/tokens/{id}/mint/prepare
 * Returns unsigned mint transaction for client signing
 */
export interface PrepareMintRequest {
  mint: Omit<MintIntent, "tokenId">; // tokenId comes from URL param
  options?: {
    priorityFee?: PriorityFee;
    simulate?: boolean;
  };
}

export interface PrepareMintResponse extends UnsignedTransactionResponse {
  meta: {
    type: "token_mint";
    tokenId: string;
    mint: string;
    destination: string;
    amount: string;
  };
}

/**
 * POST /issuance/tokens/{id}/mint
 * Server signs and submits mint transaction
 */
export interface ExecuteMintRequest {
  mint: Omit<MintIntent, "tokenId">;
  options?: {
    priorityFee?: PriorityFee;
    skipPreflight?: boolean;
    maxRetries?: number;
    commitment?: Commitment;
  };
}

export interface ExecuteMintResponse {
  transaction: {
    id: string;
    signature: string;
    status: TransactionStatus;
  };
  meta: {
    type: "token_mint";
    tokenId: string;
    mint: string;
    destination: string;
    amount: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Burn Types (POST /issuance/tokens/{id}/burn)
// ═══════════════════════════════════════════════════════════════════════════

export interface BurnIntent {
  tokenId: string;
  /** Source token account or owner address */
  source: string;
  /** Amount to burn in base units */
  amount: string;
  memo?: string;
}

export interface PrepareBurnRequest {
  burn: Omit<BurnIntent, "tokenId">;
  options?: {
    priorityFee?: PriorityFee;
    simulate?: boolean;
  };
}

export interface PrepareBurnResponse extends UnsignedTransactionResponse {
  meta: {
    type: "token_burn";
    tokenId: string;
    mint: string;
    source: string;
    amount: string;
  };
}

export interface ExecuteBurnRequest {
  burn: Omit<BurnIntent, "tokenId">;
  options?: {
    priorityFee?: PriorityFee;
    skipPreflight?: boolean;
    maxRetries?: number;
    commitment?: Commitment;
  };
}

export interface ExecuteBurnResponse {
  transaction: {
    id: string;
    signature: string;
    status: TransactionStatus;
  };
  meta: {
    type: "token_burn";
    tokenId: string;
    mint: string;
    source: string;
    amount: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Lifecycle API (Low-Level)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /transactions/prepare
 * Build an unsigned transaction from any intent
 */
export interface PrepareTransactionRequest {
  intent: TransactionIntent;
  /** Fee payer address (defaults to 'from' in intent params) */
  feePayer?: string;
  options?: {
    priorityFee?: PriorityFee;
    simulate?: boolean;
  };
}

export interface PrepareTransactionResponse extends UnsignedTransactionResponse {
  intent: TransactionIntent;
}

/**
 * POST /transactions/simulate
 * Simulate any transaction (signed or unsigned)
 */
export interface SimulateTransactionRequest {
  /** Base64 encoded transaction */
  transaction: string;
  options?: {
    /** Replace blockhash with current for simulation */
    replaceRecentBlockhash?: boolean;
    /** Specific accounts to return state for */
    accounts?: {
      addresses: string[];
      encoding?: "base64" | "jsonParsed";
    };
  };
}

export interface SimulateTransactionResponse {
  simulation: SimulationResult;
}

/**
 * POST /transactions/sign
 * Sign with custody provider (returns signed tx, doesn't send)
 * Useful for multi-sig or deferred submission
 */
export interface SignTransactionRequest {
  /** Base64 encoded unsigned transaction */
  transaction: string;
  /** Which custody wallets should sign (defaults to fee payer) */
  signers?: string[];
}

export interface SignTransactionResponse {
  transaction: {
    /** Base64 encoded signed transaction */
    serialized: string;
    /** Signatures added */
    signatures: Array<{
      address: string;
      signature: string; // Base58
    }>;
  };
}

/**
 * POST /transactions/send
 * Sign (if needed) and send transaction
 * This is the "fire and forget" custody flow
 */
export interface SendTransactionRequest {
  /** Base64 encoded transaction (signed or unsigned) */
  transaction: string;
  options?: {
    skipPreflight?: boolean;
    maxRetries?: number;
    commitment?: Commitment;
  };
}

export interface SendTransactionResponse {
  transaction: {
    /** Internal tracking ID */
    id: string;
    /** Solana transaction signature */
    signature: string;
    /** Current status */
    status: TransactionStatus;
    /** Slot transaction was processed in */
    slot?: number;
  };
}

/**
 * GET /transactions/{signature}
 * Get transaction status and details
 */
export interface GetTransactionResponse {
  transaction: {
    id: string | null; // null if not tracked by us
    signature: string;
    type: TransactionType | null;
    status: TransactionStatus;
    slot: number | null;
    blockTime: number | null;
    fee: number | null;
    error: TransactionError | null;
    meta: Record<string, unknown> | null;
  };
  confirmation: {
    commitment: Commitment | null;
    confirmations: number | null;
  } | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Webhook Event Types (for transaction status updates)
// ═══════════════════════════════════════════════════════════════════════════

export interface TransactionWebhookEvent {
  type: "transaction.confirmed" | "transaction.finalized" | "transaction.failed";
  data: {
    id: string;
    signature: string;
    transactionType: TransactionType;
    status: TransactionStatus;
    slot: number | null;
    error: TransactionError | null;
  };
  timestamp: string;
}
