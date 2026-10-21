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
  project_id: string | null;
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
  last_checked_at: string | null;
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
   * The open requests one environment's reconciler checks next, least recently checked first,
   * a never-checked one queued by its creation time: awaiting payment with a custody wallet,
   * and either unexpired or not yet checked `finalCheckAfterMs` past expiry.
   * System-only: it reads across tenants.
   */
  listPaymentRequestsToReconcile(params: {
    environment: SdpEnvironment;
    finalCheckAfterMs: number;
    limit: number;
  }): Promise<PaymentRequestRow[]>;
  /**
   * Stamp `last_checked_at` on requests the reconciler has just tried, so the next run takes the
   * ones behind them. System-only.
   */
  markPaymentRequestsChecked(requestIds: readonly string[]): Promise<void>;
  listPaymentRequests(params: ListPaymentRequestsInput): Promise<ListPaymentRequestsResult>;
}
