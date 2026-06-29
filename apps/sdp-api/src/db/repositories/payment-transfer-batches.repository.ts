import type { PaymentTransferBatchRecipientStatus, PaymentTransferBatchStatus } from "@sdp/types";

export function generatePaymentTransferBatchId(): string {
  return `xbatch_${crypto.randomUUID()}`;
}

export function generatePaymentTransferRecipientId(): string {
  return `xrec_${crypto.randomUUID()}`;
}

export interface PaymentTransferBatchRow {
  id: string;
  organization_id: string;
  project_id: string;
  external_id: string | null;
  source_wallet_id: string;
  source_address: string;
  token: string;
  status: PaymentTransferBatchStatus;
  total_amount: string | null;
  recipient_count: number;
  transaction_count: number;
  options: Record<string, unknown>;
  error: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentTransferRecipientRow {
  id: string;
  batch_id: string;
  organization_id: string;
  project_id: string;
  transfer_id: string | null;
  external_id: string | null;
  counterparty_id: string;
  counterparty_account_id: string;
  destination_address: string;
  amount: string;
  status: PaymentTransferBatchRecipientStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentTransferBatchInput {
  organizationId: string;
  projectId: string;
  externalId?: string | null;
  sourceWalletId: string;
  sourceAddress: string;
  token: string;
  status?: PaymentTransferBatchStatus;
  totalAmount?: string | null;
  recipientCount?: number;
  transactionCount?: number;
  options?: Record<string, unknown>;
  error?: string | null;
  initiatedByKeyId?: string | null;
}

export interface UpsertPaymentTransferBatchInput extends CreatePaymentTransferBatchInput {
  batchId?: string;
}

export interface UpdatePaymentTransferBatchInput {
  batchId: string;
  organizationId: string;
  projectId: string;
  externalId?: string | null;
  sourceWalletId?: string;
  sourceAddress?: string;
  token?: string;
  status?: PaymentTransferBatchStatus;
  totalAmount?: string | null;
  recipientCount?: number;
  transactionCount?: number;
  options?: Record<string, unknown>;
  error?: string | null;
  initiatedByKeyId?: string | null;
}

export interface GetPaymentTransferBatchInput {
  batchId: string;
  organizationId: string;
  projectId: string;
}

export type DeletePaymentTransferBatchInput = GetPaymentTransferBatchInput;

export interface ListPaymentTransferBatchesInput {
  organizationId: string;
  projectId: string;
  walletId?: string;
  walletIds?: string[];
  token?: string;
  status?: PaymentTransferBatchStatus;
  externalId?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
  limit: number;
  offset: number;
}

export interface ListPaymentTransferBatchesResult {
  rows: PaymentTransferBatchRow[];
  total: number;
}

export interface CreatePaymentTransferRecipientInput {
  batchId: string;
  organizationId: string;
  projectId: string;
  transferId?: string | null;
  externalId?: string | null;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: string;
  amount: string;
  status?: PaymentTransferBatchRecipientStatus;
  error?: string | null;
}

export interface UpsertPaymentTransferRecipientInput extends CreatePaymentTransferRecipientInput {
  recipientId?: string;
}

export interface UpdatePaymentTransferRecipientInput {
  recipientId: string;
  organizationId: string;
  projectId: string;
  batchId?: string;
  transferId?: string | null;
  externalId?: string | null;
  counterpartyId?: string;
  counterpartyAccountId?: string;
  destinationAddress?: string;
  amount?: string;
  status?: PaymentTransferBatchRecipientStatus;
  error?: string | null;
}

export interface GetPaymentTransferRecipientInput {
  recipientId: string;
  organizationId: string;
  projectId: string;
}

export type DeletePaymentTransferRecipientInput = GetPaymentTransferRecipientInput;

export interface ListPaymentTransferRecipientsInput {
  batchId: string;
  organizationId: string;
  projectId: string;
  transferId?: string;
  status?: PaymentTransferBatchRecipientStatus;
  limit: number;
  offset: number;
}

export interface ListPaymentTransferRecipientsResult {
  rows: PaymentTransferRecipientRow[];
  total: number;
}

export interface UpdatePaymentTransferRecipientsStatusInput {
  recipientIds: string[];
  organizationId: string;
  projectId: string;
  transferId: string | null;
  status: PaymentTransferBatchRecipientStatus;
  error: string | null;
}

export interface PaymentTransferBatchesRepository {
  createTransferBatch(input: CreatePaymentTransferBatchInput): Promise<PaymentTransferBatchRow>;
  upsertTransferBatch(input: UpsertPaymentTransferBatchInput): Promise<PaymentTransferBatchRow>;
  updateTransferBatch(
    input: UpdatePaymentTransferBatchInput
  ): Promise<PaymentTransferBatchRow | null>;
  deleteTransferBatch(
    input: DeletePaymentTransferBatchInput
  ): Promise<PaymentTransferBatchRow | null>;
  getTransferBatchById(
    input: GetPaymentTransferBatchInput
  ): Promise<PaymentTransferBatchRow | null>;
  listTransferBatches(
    input: ListPaymentTransferBatchesInput
  ): Promise<ListPaymentTransferBatchesResult>;

  createTransferRecipient(
    input: CreatePaymentTransferRecipientInput
  ): Promise<PaymentTransferRecipientRow>;
  createTransferRecipients(
    inputs: CreatePaymentTransferRecipientInput[]
  ): Promise<PaymentTransferRecipientRow[]>;
  upsertTransferRecipient(
    input: UpsertPaymentTransferRecipientInput
  ): Promise<PaymentTransferRecipientRow>;
  updateTransferRecipient(
    input: UpdatePaymentTransferRecipientInput
  ): Promise<PaymentTransferRecipientRow | null>;
  updateTransferRecipientsStatus(
    input: UpdatePaymentTransferRecipientsStatusInput
  ): Promise<PaymentTransferRecipientRow[]>;
  deleteTransferRecipient(
    input: DeletePaymentTransferRecipientInput
  ): Promise<PaymentTransferRecipientRow | null>;
  getTransferRecipientById(
    input: GetPaymentTransferRecipientInput
  ): Promise<PaymentTransferRecipientRow | null>;
  listTransferRecipientsByBatch(
    input: ListPaymentTransferRecipientsInput
  ): Promise<ListPaymentTransferRecipientsResult>;
}
