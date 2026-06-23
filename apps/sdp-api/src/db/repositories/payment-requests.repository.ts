import type { PaymentRequestLifecycleEvent, PaymentRequestStatus } from "@sdp/types";

export function generatePaymentRequestId(): string {
  return `preq_${crypto.randomUUID()}`;
}

export interface PaymentRequestRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  counterparty_id: string | null;
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
}

export interface CreatePaymentRequestInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string | null;
  walletId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  reference: string;
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
  listPaymentRequests(params: ListPaymentRequestsInput): Promise<ListPaymentRequestsResult>;
}
