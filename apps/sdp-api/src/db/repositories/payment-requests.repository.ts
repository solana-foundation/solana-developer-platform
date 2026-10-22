import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { PaymentRequestLifecycleEvent, PaymentRequestStatus } from "@sdp/types/payments";
import { generateKeyPairSigner } from "@solana/kit";
import { customAlphabet } from "nanoid";

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

export interface PaymentRequestRow {
  id: string;
  public_token: string;
  organization_id: string;
  project_id: string;
  custody_wallet_id: string | null;
  wallet_id: string;
  destination_address: string;
  token: string;
  amount: string;
  reference: string;
  status: PaymentRequestStatus;
  expires_at: string | null;
  fulfilled_by_transfer_id: string | null;
  canceled_by: string | null;
  lifecycle: PaymentRequestLifecycleEvent[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  paid_late: boolean;
}

export interface CreatePaymentRequestInput {
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  walletId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  expiresAt: string | null;
  createdBy: string | null;
}

export interface MarkPaymentRequestInput {
  requestId: string;
  organizationId: string;
  projectId: string;
  status: Exclude<PaymentRequestStatus, "awaiting_payment">;
  fulfilledByTransferId: string | null;
  canceledBy: string | null;
  paidLate: boolean;
}

export interface MarkExpiredPaymentRequestPaidInput {
  requestId: string;
  organizationId: string;
  projectId: string;
  fulfilledByTransferId: string;
  paidLate: boolean;
}

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
  claimSponsoredTransactionWindow(params: {
    requestId: string;
    account: string;
    unsignedTransaction: string;
    lastValidBlockHeight: bigint;
    currentBlockHeight: bigint;
  }): Promise<boolean>;
  getSponsoredTransactionClaim(requestId: string): Promise<SponsoredTransactionClaim | null>;
  storeSponsoredTransactionSignature(params: {
    requestId: string;
    account: string;
    unsignedTransaction: string;
    signedTransaction: string;
  }): Promise<boolean>;
  listPaymentRequests(params: ListPaymentRequestsInput): Promise<ListPaymentRequestsResult>;
  listHotPaymentRequests(params: {
    environment: SdpEnvironment;
    minLastValidBlockHeight: bigint;
    limit: number;
  }): Promise<PaymentRequestRow[]>;
  listPaymentRequestsDueForCheck(params: {
    environment: SdpEnvironment;
    recentCheckedBefore: string;
    agedCheckedBefore: string;
    agedCreatedBefore: string;
    limit: number;
  }): Promise<PaymentRequestRow[]>;
  listLapsedPaymentRequests(params: {
    environment: SdpEnvironment;
    checkedBefore: string;
    liveClaimMinLastValidBlockHeight: bigint;
    limit: number;
  }): Promise<PaymentRequestRow[]>;
  listExpiredPaymentRequestsForLateCheck(params: {
    environment: SdpEnvironment;
    expiredSince: string;
    checkedBefore: string;
    limit: number;
  }): Promise<PaymentRequestRow[]>;
  markPaymentRequestsChecked(requestIds: readonly string[]): Promise<void>;
  markExpiredPaymentRequestPaid(
    input: MarkExpiredPaymentRequestPaidInput
  ): Promise<PaymentRequestRow | null>;
  countStaleAwaitingPaymentRequests(params: {
    environment: SdpEnvironment;
    checkedBefore: string;
  }): Promise<number>;
  countStaleLateWatchPaymentRequests(params: {
    environment: SdpEnvironment;
    expiredSince: string;
    checkedBefore: string;
  }): Promise<number>;
}
