/**
 * Custody Provider Types
 *
 * Shared types for custody provider integration in SDP.
 * These types are used by both the API and SDK clients.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Provider Types
// ═══════════════════════════════════════════════════════════════════════════

/** Supported custody provider types */
export type CustodyProviderType = "local" | "fireblocks" | "dfns" | "turnkey";

/** Status of a custody configuration */
export type CustodyConfigStatus = "active" | "inactive";

// ═══════════════════════════════════════════════════════════════════════════
// Signing Types
// ═══════════════════════════════════════════════════════════════════════════

/** Status of a signing request */
export type SigningStatus = "pending" | "completed" | "rejected" | "failed";

/** A signature from a specific public key */
export interface SignatureInfo {
  /** Public key that produced the signature */
  publicKey: string;

  /** Base58-encoded signature */
  signature: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// API Request/Response Types
// ═══════════════════════════════════════════════════════════════════════════

/** Request to submit an externally signed transaction */
export interface SubmitTransactionRequest {
  /** Base64-encoded signed transaction */
  transaction: string;

  /** Optional transaction ID to link to an existing record */
  transactionId?: string;

  /** Submission options */
  options?: {
    /** Skip preflight simulation */
    skipPreflight?: boolean;

    /** Commitment level for confirmation */
    commitment?: "processed" | "confirmed" | "finalized";
  };
}

/** Response from submitting a transaction */
export interface SubmitTransactionResponse {
  /** Transaction signature (base58) */
  signature: string;

  /** Confirmation status */
  status: "processed" | "confirmed" | "finalized" | "failed";

  /** Slot where transaction was confirmed */
  slot?: number;

  /** Error message if failed */
  error?: string;
}

/** Request to sign a transaction via custody provider */
export interface CustodySignRequest {
  /** Base64-encoded unsigned transaction */
  transaction: string;

  /** Optional wallet ID for multi-wallet providers */
  walletId?: string;

  /** Operation metadata for audit */
  metadata?: {
    operationType?: string;
    tokenId?: string;
    amount?: string;
    destination?: string;
  };
}

/** Response from signing a transaction via custody (sync completion) */
export interface CustodySignSyncResponse {
  /** Base64-encoded signed transaction */
  signedTransaction: string;

  /** Signing status */
  status: "completed";
}

/** Response from signing a transaction via custody (async pending) */
export interface CustodySignAsyncResponse {
  /** Signing request ID for polling */
  signingRequestId: string;

  /** Signing status */
  status: "pending_approval";
}

/** Combined custody sign transaction response */
export type CustodySignResponse = CustodySignSyncResponse | CustodySignAsyncResponse;

/** Request to get signing status */
export interface GetSigningStatusRequest {
  /** Signing request ID */
  requestId: string;
}

/** Response with signing status */
export interface GetSigningStatusResponse {
  /** Current status */
  status: SigningStatus;

  /** Number of approvals received (for multi-sig) */
  approvals?: number;

  /** Number of approvals required */
  required?: number;

  /** Signatures if completed */
  signatures?: SignatureInfo[];

  /** Rejection reason if rejected */
  reason?: string;

  /** Error message if failed */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Custody Configuration Types (Admin)
// ═══════════════════════════════════════════════════════════════════════════

/** Custody configuration (without sensitive details) */
export interface CustodyConfig {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: CustodyProviderType;
  defaultWalletId: string | null;
  status: CustodyConfigStatus;
  createdAt: string;
  updatedAt: string;
}

/** Response containing custody configuration */
export interface CustodyConfigResponse {
  config: CustodyConfig;
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Response Extensions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extended transaction response for async signing scenarios.
 * When a custody provider requires approval, execute endpoints return this
 * instead of a confirmed transaction.
 */
export interface AsyncSigningTransactionResponse {
  /** Transaction record */
  transaction: {
    id: string;
    status: "pending_signature";
  };

  /** Signing request details */
  signing: {
    requestId: string;
    status: "pending_approval";
    provider: CustodyProviderType;
  };
}

/**
 * Type guard to check if a response is async signing
 */
export function isAsyncSigningResponse(
  response: unknown
): response is AsyncSigningTransactionResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "signing" in response &&
    typeof (response as AsyncSigningTransactionResponse).signing === "object" &&
    (response as AsyncSigningTransactionResponse).signing?.status === "pending_approval"
  );
}
