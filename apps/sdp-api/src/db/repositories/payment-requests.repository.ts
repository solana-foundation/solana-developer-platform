import type { AssetRef } from "@sdp/solana/asset-ref";
import type { BaseUnits } from "@sdp/solana/token-amount";
import type {
  FinalPaymentRequestTransactionOutcome,
  PaymentRequestLifecycleEvent,
  PaymentRequestStatus,
  PaymentRequestTransactionOutcome,
} from "@sdp/types/payments";
import { generateKeyPairSigner, type Signature } from "@solana/kit";
import { customAlphabet } from "nanoid";
import type { RecordedLegQuote } from "./token-movement-legs.repository";

// URL-safe, dash-only alphabet (nanoid's default also includes "_").
// biome-ignore lint/security/noSecrets: token alphabet constant, not a secret.
const PUBLIC_TOKEN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-";
const generatePublicToken = customAlphabet(PUBLIC_TOKEN_ALPHABET, 16);

export function generatePaymentRequestId(): string {
  return `preq_${crypto.randomUUID()}`;
}

export function generatePaymentRequestPublicToken(): string {
  return generatePublicToken();
}

export async function generatePaymentRequestReference(): Promise<string> {
  return (await generateKeyPairSigner()).address;
}

/**
 * What a request's payment must deliver (ADR 0012, migration 0162): the credit
 * in base units, with the asset and the decimals its terms had at creation.
 */
export type PaymentRequestExpectation = Readonly<{
  asset: AssetRef;
  decimals: number;
  credit: BaseUnits;
}>;

export interface PaymentRequestRow {
  id: string;
  public_token: string;
  organization_id: string;
  project_id: string | null;
  custody_wallet_id: string | null;
  wallet_id: string;
  destination_address: string;
  token: string;
  amount: string;
  /** Null for a request recorded before expectations. */
  expectation: PaymentRequestExpectation | null;
  reference: string;
  status: PaymentRequestStatus;
  expires_at: string | null;
  fulfilled_by_transfer_id: string | null;
  canceled_by: string | null;
  lifecycle: PaymentRequestLifecycleEvent[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentRequestInput {
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  walletId: string;
  destinationAddress: string;
  token: string;
  /** The expectation's credit in token units. */
  amount: string;
  expectation: PaymentRequestExpectation;
  expiresAt: string | null;
  createdBy: string | null;
}

/**
 * A transition that settles no payment. Paying a request goes through
 * `markPaymentRequestPaid`, which checks the transaction that paid it.
 */
export interface MarkPaymentRequestInput {
  requestId: string;
  organizationId: string;
  projectId: string;
  status: Exclude<PaymentRequestStatus, "awaiting_payment" | "paid">;
  fulfilledByTransferId: string | null;
  canceledBy: string | null;
}

/**
 * A sponsored transaction /pay issued for a request, in one claim window, with
 * the quote it moves. Its signature is null until SDP signs it.
 */
export interface PaymentRequestTransaction {
  id: string;
  paymentRequestId: string;
  organizationId: string;
  projectId: string;
  payer: string;
  lastValidBlockHeight: bigint;
  signature: Signature | null;
  quote: RecordedLegQuote;
  outcome: PaymentRequestTransactionOutcome;
  createdAt: string;
}

/** An issued transaction whose signature is saved: one settlement reads. */
export type SignedPaymentRequestTransaction = PaymentRequestTransaction & {
  signature: Signature;
};

export interface ListPaymentRequestsInput {
  organizationId: string;
  projectId: string;
  status?: PaymentRequestStatus;
  limit: number;
  offset: number;
}

export interface ListPaymentRequestsResult {
  rows: PaymentRequestRow[];
  total: number;
}

export interface SponsoredTransactionClaim {
  account: string;
  unsignedTransaction: string;
  signedTransaction: string | null;
  lastValidBlockHeight: bigint;
  /**
   * The issued transaction the claim records, or null for a claim the
   * previous revision made, which has none.
   */
  issued: PaymentRequestTransaction | null;
}

export interface PaymentRequestsRepository {
  createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestRow>;
  markPaymentRequest(input: MarkPaymentRequestInput): Promise<PaymentRequestRow | null>;
  getPaymentRequestById(params: {
    requestId: string;
    organizationId: string;
    projectId: string;
  }): Promise<PaymentRequestRow | null>;
  getPaymentRequestByPublicToken(publicToken: string): Promise<PaymentRequestRow | null>;
  /**
   * Claims the request's sponsored transaction window and records the
   * transaction it issues, with its quote, in one transaction. The claim needs
   * the request open (awaiting payment and unexpired), no live window, and
   * no signed window still open: one that may have landed is settled first.
   */
  claimSponsoredTransactionWindow(params: {
    requestId: string;
    account: string;
    unsignedTransaction: string;
    lastValidBlockHeight: bigint;
    currentBlockHeight: bigint;
    quote: RecordedLegQuote;
  }): Promise<boolean>;
  getSponsoredTransactionClaim(requestId: string): Promise<SponsoredTransactionClaim | null>;
  /**
   * Saves the sponsor-signed bytes on the claim and the signature on its
   * issued transaction, in one transaction; false when the claim moved on.
   */
  storeSponsoredTransactionSignature(params: {
    requestId: string;
    account: string;
    unsignedTransaction: string;
    signedTransaction: string;
    signature: Signature;
  }): Promise<boolean>;
  /** The request's issued transactions that are signed and still open, oldest first. */
  listOpenPaymentRequestTransactions(params: {
    requestId: string;
    organizationId: string;
    projectId: string;
  }): Promise<SignedPaymentRequestTransaction[]>;
  /**
   * Writes final outcomes of one request's open issued transactions; an
   * outcome already final is kept, and another request's window is untouched.
   */
  closePaymentRequestTransactions(params: {
    requestId: string;
    organizationId: string;
    projectId: string;
    outcomes: readonly {
      signature: Signature;
      outcome: FinalPaymentRequestTransactionOutcome;
      landedSlot: bigint | null;
    }[];
  }): Promise<void>;
  /**
   * Settles an awaiting request as paid by one of its issued transactions:
   * the request must still be open for it, its expiry after the time the
   * transaction was issued (SOLA9-757).
   *
   * @returns The paid row, or null when the compare-and-set matched no row.
   */
  markPaymentRequestPaid(params: {
    requestId: string;
    organizationId: string;
    projectId: string;
    fulfilledByTransferId: string;
    issuedAt: string;
  }): Promise<PaymentRequestRow | null>;
  /** Locks the request row for a settlement, in the caller's transaction. */
  lockPaymentRequest(params: {
    requestId: string;
    organizationId: string;
    projectId: string;
  }): Promise<PaymentRequestRow | null>;
  listPaymentRequests(params: ListPaymentRequestsInput): Promise<ListPaymentRequestsResult>;
}
