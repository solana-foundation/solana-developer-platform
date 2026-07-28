import type {
  PaymentTransferBatchRecipientStatus,
  PaymentTransferBatchStatus,
  PaymentTransferStatus,
} from "@sdp/types";

/**
 * Rolls member statuses (chunk transfers or recipient rows) up into the parent
 * batch status. Any in-flight member keeps the batch processing; otherwise the
 * batch is confirmed, failed, or partially_failed by how many members settled.
 *
 * @param statuses - Statuses of every member of the batch.
 * @returns The batch status implied by its members.
 */
export function deriveTransferBatchStatus(
  statuses: ReadonlyArray<PaymentTransferStatus | PaymentTransferBatchRecipientStatus>
): PaymentTransferBatchStatus {
  if (statuses.some((status) => status === "pending" || status === "processing")) {
    return "processing";
  }
  const settled = statuses.filter(
    (status) => status === "confirmed" || status === "finalized"
  ).length;
  if (settled === statuses.length) {
    return "confirmed";
  }
  return settled === 0 ? "failed" : "partially_failed";
}

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
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
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
  idempotencyKey?: string | null;
  idempotencyFingerprint?: string | null;
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

export interface CreatePaymentTransferBatchWithRecipientsInput {
  batch: CreatePaymentTransferBatchInput;
  recipients: Omit<CreatePaymentTransferRecipientInput, "batchId">[];
}

export interface CreatePaymentTransferBatchWithRecipientsResult {
  batch: PaymentTransferBatchRow;
  recipients: PaymentTransferRecipientRow[];
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

export interface SettlePaymentTransferBatchInput {
  transferId: string;
  organizationId: string;
  projectId: string;
  transferStatus: "confirmed" | "finalized" | "failed";
  error: string | null;
  slot: number | null;
  updatedAt: string;
}

export interface RecomputeTransferBatchStatusInput {
  batchId: string;
  organizationId: string;
  projectId: string;
}

export interface PaymentTransferBatchesRepository {
  createTransferBatchWithRecipients(
    input: CreatePaymentTransferBatchWithRecipientsInput
  ): Promise<CreatePaymentTransferBatchWithRecipientsResult>;
  findTransferBatchByIdempotency(input: {
    organizationId: string;
    projectId: string;
    idempotencyKey: string;
  }): Promise<PaymentTransferBatchRow | null>;
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
  /**
   * Atomically settles a terminal chunk transfer: updates its recipient rows
   * to the matching terminal status and recomputes the parent batch status
   * from all recipients, in one transaction. Concurrent settlements of the
   * same batch are serialized on the batch row lock so the recompute never
   * reads a sibling's uncommitted recipient statuses.
   *
   * @param input.transferId - Chunk transfer that reached a terminal status.
   * @param input.transferStatus - Terminal status the transfer reached.
   * @param input.error - Failure detail applied to failed recipients.
   */
  settleTransferBatch(input: SettlePaymentTransferBatchInput): Promise<void>;
  /**
   * Recomputes and writes a batch's status from its recipient rows under the
   * batch row lock. The only sanctioned way to write a batch status after
   * creation — every writer (chunk submission, reconciliation) goes through
   * this protocol so none can overwrite a terminal status from a stale read.
   *
   * @param input.batchId - Batch to recompute.
   * @returns The batch row after the recompute.
   */
  recomputeTransferBatchStatus(
    input: RecomputeTransferBatchStatusInput
  ): Promise<PaymentTransferBatchRow>;
}
