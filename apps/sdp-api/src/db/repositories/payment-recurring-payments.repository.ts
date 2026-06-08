import type { PaymentRecurringPaymentStatus } from "@sdp/types";

export interface PaymentRecurringPaymentRow {
  id: string;
  organization_id: string;
  project_id: string;
  source_wallet_id: string;
  source_address: string;
  counterparty_id: string;
  counterparty_account_id: string;
  destination_address: string;
  destination_token_account: string | null;
  token: string;
  amount: string;
  period_hours: number;
  first_collection_at: string | null;
  next_collection_due_at: string | null;
  plan_id: string | null;
  subscription_id: string | null;
  plan_pda: string | null;
  plan_created_at: string | null;
  plan_creation_signature: string | null;
  subscription_pda: string | null;
  subscription_authority_address: string | null;
  authorization_signature: string | null;
  status: PaymentRecurringPaymentStatus;
  metadata_uri: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentRecurringPaymentInput {
  id: string;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
  sourceAddress: string;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt: string | null;
  metadataUri: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListPaymentRecurringPaymentsInput {
  organizationId: string;
  projectId: string;
  sourceWalletIds?: string[];
  status?: PaymentRecurringPaymentStatus;
  counterpartyId?: string;
  limit: number;
  offset: number;
}

export interface ListPaymentRecurringPaymentsResult {
  rows: PaymentRecurringPaymentRow[];
  total: number;
}

export interface PaymentRecurringPaymentsRepository {
  createRecurringPayment(
    input: CreatePaymentRecurringPaymentInput
  ): Promise<PaymentRecurringPaymentRow | null>;
  getRecurringPaymentById(params: {
    recurringPaymentId: string;
    organizationId: string;
    projectId: string;
    sourceWalletIds?: string[];
  }): Promise<PaymentRecurringPaymentRow | null>;
  listRecurringPayments(
    params: ListPaymentRecurringPaymentsInput
  ): Promise<ListPaymentRecurringPaymentsResult>;
}
