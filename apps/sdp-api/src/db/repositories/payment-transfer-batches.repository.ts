import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  ONCHAIN_TRANSFER_IN_FLIGHT_STATUSES,
  ONCHAIN_TRANSFER_SETTLED_STATUSES,
  type PaymentTransferBatchRecipientStatus,
  type PaymentTransferBatchStatus,
  type PaymentTransferStatus,
  type TransferChainVerdictStatus,
} from "@sdp/types/payments";

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
  if (
    statuses.some((status) =>
      ONCHAIN_TRANSFER_IN_FLIGHT_STATUSES.some((inFlight) => inFlight === status)
    )
  ) {
    return "processing";
  }
  const settled = statuses.filter((status) =>
    ONCHAIN_TRANSFER_SETTLED_STATUSES.some((settledStatus) => settledStatus === status)
  ).length;
  if (settled === statuses.length) {
    return "confirmed";
  }
  return settled === 0 ? "failed" : "partially_failed";
}

export function generatePaymentTransferBatchId(): string {
  return `xbatch_${crypto.randomUUID()}`;
}

/**
 * How long a request that wrote an unsent batch recipient (a create, or a
 * retry's claim) can still be running: past any request's lifetime (renewal
 * cap plus lease), with room to spare. An unsent recipient last written before
 * this is stranded and may be failed; a younger one may belong to a live
 * request (HOO-2343).
 */
export const TRANSFER_BATCH_ATTEMPT_LIFETIME_MS = 60 * 60 * 1000;

export function generatePaymentTransferBatchRetryId(): string {
  return `xbretry_${crypto.randomUUID()}`;
}

export function generatePaymentTransferRecipientId(): string {
  return `xrec_${crypto.randomUUID()}`;
}

export interface PaymentTransferBatchRow {
  id: string;
  organization_id: string;
  project_id: string;
  external_id: string | null;
  source_custody_wallet_id: string | null;
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
  sourceCustodyWalletId: string;
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
  sourceCustodyWalletId?: string;
  walletId?: string;
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
  /** The writing attempt's lastValidBlockHeight, for a pending recipient (HOO-2343). */
  attemptLastValidBlockHeight?: bigint | null;
}

export interface UpsertPaymentTransferRecipientInput extends CreatePaymentTransferRecipientInput {
  recipientId?: string;
}

export interface CreatePaymentTransferBatchWithRecipientsInput {
  batch: CreatePaymentTransferBatchInput;
  recipients: Omit<CreatePaymentTransferRecipientInput, "batchId">[];
}

interface CreatePaymentTransferBatchWithRecipientsResult {
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
  /**
   * Link CAS: update only recipients still pending with no chunk transfer, so
   * a chunk never claims a recipient another writer failed or linked first.
   */
  requireUnsent?: true;
}

export interface ClaimFailedTransferRecipientsInput extends RecomputeTransferBatchStatusInput {
  recipientIds: string[];
  /** Chunks the resend adds to the batch's transaction count. */
  addedTransactionCount: number;
  /** The resend's lastValidBlockHeight, stored on the claimed recipients. */
  attemptLastValidBlockHeight: bigint;
  /** The retry's recovery row, written in the claim's transaction (HOO-2343). */
  retry: {
    idempotencyKey: string;
    idempotencyFingerprint: string;
    initiatedByKeyId: string | null;
  };
}

/**
 * When an unsent recipient is stranded (HOO-2343): written before an instant,
 * or written by an attempt whose lastValidBlockHeight the chain has passed.
 */
export type StrandedRecipientCutoff =
  | { attemptedBefore: string; expiredBelowBlockHeight?: bigint }
  | { attemptedBefore?: string; expiredBelowBlockHeight: bigint };

/** A retry of a batch's failed recipients, recorded under its key (HOO-2343). */
export interface PaymentTransferBatchRetryRow {
  id: string;
  batch_id: string;
  idempotency_fingerprint: string;
  initiated_by_key_id: string | null;
  recipient_ids: string[];
  /** The failed chunk transfers the claim unlinked these recipients from. */
  superseded_transfer_ids: string[];
  created_at: string;
}

export interface SettlePaymentTransferBatchInput {
  transferId: string;
  /** Timeout CAS: leave a signed or started chunk and its recipients unchanged. */
  requireUnsigned?: true;
  organizationId: string;
  projectId: string;
  transferStatus: TransferChainVerdictStatus;
  error: string | null;
  slot: number | null;
  updatedAt: string;
  /** Expiry CAS: leave a started chunk and its recipients unchanged. */
  requireUnstarted?: true;
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
  /**
   * Fails the batch's recipients that never got a chunk transfer (pending, no
   * transfer_id) and recomputes the batch status, in one transaction under the
   * batch row lock. A chunk's transfer row and recipient links commit before
   * it is broadcast, so an unlinked recipient was never sent: failing it is
   * truthful, and only valid once the request that wrote it is dead. Only
   * recipients last written before `attemptedBefore` are failed, so a live
   * retry's freshly claimed recipients are never taken (HOO-2343).
   *
   * @param input.batchId - Batch whose unsent recipients are failed.
   * @param input.error - Failure detail recorded on each failed recipient.
   * A recipient is failed when it was last written before `attemptedBefore`,
   * or its attempt's lastValidBlockHeight is below `expiredBelowBlockHeight`
   * (that attempt can no longer land anything); at least one is given.
   *
   * @param input.attemptedBefore - Recipients written before this instant.
   * @param input.expiredBelowBlockHeight - The cluster's current block height.
   * @param input.recipientIds - Only these recipients, when the caller knows which ones it wrote.
   * @returns The batch row after the recompute.
   */
  failUnsentTransferRecipients(
    input: RecomputeTransferBatchStatusInput & {
      error: string;
      recipientIds?: string[];
    } & StrandedRecipientCutoff
  ): Promise<PaymentTransferBatchRow>;
  /**
   * Takes failed recipients back to pending with no chunk transfer for a
   * resend (HOO-2343), under the batch lock, and records the retry under its
   * key in the same transaction. All or nothing: null when any of them is no
   * longer failed (another resend claimed it first).
   */
  claimFailedTransferRecipients(input: ClaimFailedTransferRecipientsInput): Promise<{
    batch: PaymentTransferBatchRow;
    recipients: PaymentTransferRecipientRow[];
    retry: PaymentTransferBatchRetryRow;
  } | null>;
  /**
   * Processing batches with a pending recipient, no chunk transfer, last
   * written before `attemptedBefore`: the request that created or retried it
   * died before sending it. Aged by the recipient, not the batch, so a retry
   * that just claimed recipients of an old batch is left alone (HOO-2343).
   * System-only (the reconciliation job), oldest first.
   */
  listStrandedTransferBatches(
    input: {
      /** Only batches whose project is in this environment, so one job run settles one cluster's batches. */
      environment: SdpEnvironment;
      limit: number;
    } & StrandedRecipientCutoff
  ): Promise<RecomputeTransferBatchStatusInput[]>;
  /**
   * The lowest attempt lastValidBlockHeight among the environment's unsent
   * recipients of processing batches, or null when none records one: the job
   * reads the cluster's block height only when this says one may be past it.
   */
  lowestUnsentAttemptBlockHeight(input: { environment: SdpEnvironment }): Promise<bigint | null>;
  /**
   * The failed chunk transfers the batch's retries unlinked their recipients
   * from: still the batch's transactions, so its responses keep showing them.
   */
  listSupersededTransferIds(input: RecomputeTransferBatchStatusInput): Promise<string[]>;
  /** The retry recorded under a credential-bound record key, if any. */
  findTransferBatchRetryByIdempotency(input: {
    organizationId: string;
    projectId: string;
    idempotencyKey: string;
  }): Promise<PaymentTransferBatchRetryRow | null>;
}
