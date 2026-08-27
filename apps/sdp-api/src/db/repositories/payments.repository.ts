import type { PaymentTransferStatus } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { RepositoryDbClient } from "./base";

export type PaymentTransferDirection = "inbound" | "outbound";
export type PaymentTransferType =
  | "transfer"
  | "transfer_confidential"
  | "transfer_batch"
  | "onramp"
  | "offramp";
export const WALLET_TRANSFER_TYPES = [
  "transfer",
  "transfer_confidential",
  "transfer_batch",
] as const satisfies readonly PaymentTransferType[];
export const RAMP_TRANSFER_TYPES = [
  "onramp",
  "offramp",
] as const satisfies readonly PaymentTransferType[];
export type RampTransferType = (typeof RAMP_TRANSFER_TYPES)[number];
export function isRampTransferType(type: PaymentTransferType): type is RampTransferType {
  return type === "onramp" || type === "offramp";
}
export type PaymentTransferDeliveryMode = "hosted" | "manual_instructions" | "session_widget";
export type { PaymentTransferStatus };

export interface PaymentTransferRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  wallet_id: string;
  counterparty_id: string | null;
  counterparty_display_name?: string | null;
  source_address: string | null;
  destination_address: string | null;
  token: string;
  amount: string | null;
  memo: string | null;
  type: PaymentTransferType;
  direction: PaymentTransferDirection;
  status: PaymentTransferStatus;
  provider: RampProviderId | null;
  provider_reference: string | null;
  delivery_mode: PaymentTransferDeliveryMode | null;
  fiat_currency: string | null;
  fiat_amount: string | null;
  ramps_memo: Record<string, string>;
  provider_data: Record<string, unknown>;
  signature: string | null;
  serialized_tx: string | null;
  signed_transaction: string | null;
  /** NUMERIC in Postgres, read as a string so uint64 round-trips exactly. */
  last_valid_block_height: string | null;
  submission_started_at: string | null;
  slot: number | null;
  block_time: string | null;
  fee: number | null;
  error: string | null;
  initiated_by_key_id: string | null;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  confirmed_at: string | null;
  finalization_last_polled_at: string | null;
  settlement_signature: string | null;
  settlement_verified_slot: number | null;
  settlement_verified_at: string | null;
  settlement_verification_method: string | null;
  verification_claim_token: string | null;
  verification_claimed_until: string | null;
  verification_last_polled_at: string | null;
  verification_attempts: number;
  created_at: string;
  updated_at: string;
}

export function generatePaymentTransferId(): string {
  return `xfr_${crypto.randomUUID()}`;
}

export type ConfirmedTransferPollVerdict = {
  transferId: string;
  organizationId: string;
} & ({ finalized: true; slot: number } | { finalized: false; slot: null });

export interface CreatePaymentTransferInput {
  organizationId: string;
  projectId: string | null;
  walletId: string;
  counterpartyId: string | null;
  sourceAddress: string | null;
  destinationAddress: string | null;
  token: string;
  amount: string | null;
  memo: string | null;
  type: PaymentTransferType;
  direction: PaymentTransferDirection;
  status: PaymentTransferStatus;
  provider: RampProviderId | null;
  providerReference: string | null;
  deliveryMode: PaymentTransferDeliveryMode | null;
  fiatCurrency: string | null;
  fiatAmount: string | null;
  rampsMemo?: Record<string, string>;
  providerData: Record<string, unknown>;
  serializedTx: string | null;
  signature: string | null;
  slot: number | null;
  initiatedByKeyId: string | null;
  idempotencyKey?: string | null;
  idempotencyFingerprint?: string | null;
}

export interface UpdatePaymentTransferInput {
  transferId: string;
  organizationId?: string;
  projectId?: string | null;
  expectedStatus?: PaymentTransferStatus;
  status?: PaymentTransferStatus;
  signature?: string | null;
  serializedTx?: string | null;
  slot?: number | null;
  blockTime?: string | null;
  fee?: number | null;
  amount?: string | null;
  fiatAmount?: string | null;
  providerReference?: string | null;
  deliveryMode?: PaymentTransferDeliveryMode | null;
  providerData?: Record<string, unknown>;
  error?: string | null;
  updatedAt: string;
}

export interface ListTransfersInput {
  organizationId: string;
  projectId: string | null;
  walletId?: string;
  walletIds?: string[];
  walletAddress?: string;
  counterpartyId?: string;
  search?: string;
  token?: string;
  direction?: PaymentTransferDirection;
  statuses?: PaymentTransferStatus[];
  types?: readonly PaymentTransferType[];
  provider?: RampProviderId;
  providerReference?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
  sortBy?: "amount" | "createdAt" | "status" | "updatedAt";
  sortDirection?: "asc" | "desc";
  limit: number;
  offset: number;
}

export interface ListTransfersByStatusInput {
  statuses: PaymentTransferStatus[];
  types?: readonly PaymentTransferType[];
  hasSignature?: boolean;
  createdBefore?: string;
  updatedBefore?: string;
  limit: number;
  offset?: number;
}

export interface ListTransfersResult {
  rows: PaymentTransferRow[];
  total: number;
}

export type GetTransferByProviderReferenceInput = {
  provider: RampProviderId;
  providerReference: string;
} & (
  | {
      organizationId: string;
      projectId: string | null;
    }
  | {
      organizationId?: never;
      projectId?: never;
    }
);

export interface PaymentsRepositoryContext {
  db: RepositoryDbClient;
}

export interface PaymentsRepository {
  createTransfer(input: CreatePaymentTransferInput): Promise<PaymentTransferRow | null>;
  findTransferByIdempotency(params: {
    organizationId: string;
    projectId: string | null;
    idempotencyKey: string;
  }): Promise<PaymentTransferRow | null>;
  updateTransfer(input: UpdatePaymentTransferInput): Promise<PaymentTransferRow | null>;
  persistSignedTransfer(input: {
    transferId: string;
    organizationId: string;
    projectId: string | null;
    signature: string;
    signedTransaction: string;
    lastValidBlockHeight: string;
    updatedAt: string;
  }): Promise<PaymentTransferRow | null>;
  markTransferSubmissionStarted(input: {
    transferId: string;
    organizationId: string;
    projectId: string | null;
    startedAt: string;
  }): Promise<PaymentTransferRow | null>;
  /**
   * Atomically transitions a transfer's status only if it is currently one of
   * `fromStatuses`, scoped to org/project. Returns the updated row, or null when
   * no row matched (wrong owner, missing, or status changed concurrently).
   */
  updateTransferStatusGuarded(input: {
    transferId: string;
    organizationId: string;
    projectId: string | null;
    fromStatuses: readonly PaymentTransferStatus[];
    toStatus: PaymentTransferStatus;
    updatedAt: string;
    amount?: string | null;
    fiatAmount?: string | null;
    providerData?: Record<string, unknown>;
    error?: string | null;
    settlementSignature?: string | null;
    settlementVerifiedSlot?: number | null;
    settlementVerifiedAt?: string | null;
    settlementVerificationMethod?: string | null;
  }): Promise<PaymentTransferRow | null>;
  listTransfersByStatus(params: ListTransfersByStatusInput): Promise<PaymentTransferRow[]>;
  /**
   * Lists the page of confirmed transfers whose finalization should be polled
   * next: least-recently-polled first (never-polled rows first), bounded to
   * rows confirmed after the given floor. System-only.
   *
   * @param params - The confirmed_at eligibility floor and the page size.
   * @returns The next page of the finalization poll queue.
   */
  /**
   * Ramp rows carrying a provider-reported settlement signature that has not been
   * proven on chain yet, least-recently-polled first. Separate from the wallet
   * finalization queue on purpose; see migration 0069. System-only.
   */
  /**
   * Atomically CLAIMS the next page of the queue. Stamping the polling cursor inside the same
   * statement as the select is what stops two replicas verifying the same row and burning its
   * attempt allowance twice.
   *
   * Deliberately does NOT increment `verification_attempts`: a worker that dies between claim and
   * completion would otherwise burn an attempt having done nothing, and ten of those permanently
   * report a real settlement as unverified. Attempts are consumed by work, not by intent.
   */
  claimRampTransfersToVerify(params: {
    maxAttempts: number;
    limit: number;
    claimedAt: string;
    /** Identifies this worker's claim. Required later to write the outcome. */
    claimToken: string;
    /** Lease expiry. Rows stay excluded until it passes, so a worker in RPC is not re-claimed. */
    claimedUntil: string;
  }): Promise<PaymentTransferRow[]>;
  /**
   * Records the outcome of one verification attempt. `verifiedAt` and `slot` are
   * written only on proof; every other outcome just advances the polling cursor and
   * the attempt count, so a failure can never mark a transfer verified.
   */
  advanceRampVerification(params: {
    transferId: string;
    polledAt: string;
    /** Must match the claim. A worker whose lease expired and was re-claimed writes nothing. */
    claimToken: string;
    verifiedAt?: string | null;
    slot?: number | null;
    method?: string | null;
  }): Promise<void>;
  listConfirmedTransfersToPoll(params: {
    confirmedAfter: string;
    limit: number;
  }): Promise<PaymentTransferRow[]>;
  /**
   * Records one finalization poll over a page of confirmed transfers in one
   * statement: rows the chain reports finalized upgrade to finalized with
   * their slot and a fresh updated_at; every polled row — finalized or not —
   * gets finalization_last_polled_at stamped, rotating it to the back of the
   * poll queue so no row can starve the ones behind it. updated_at moves only
   * on real finalization, never on a poll. Each row is guarded on still being
   * confirmed (a concurrent transition is never overwritten) and on its
   * owning organization (defense in depth). System-only.
   *
   * @param params - Every polled transfer with its owning org and the chain's
   * verdict (finalized rows carry their slot), plus the poll timestamp.
   * @returns Resolves once the batch update has been applied.
   */
  advanceConfirmedTransfers(params: {
    polled: readonly ConfirmedTransferPollVerdict[];
    updatedAt: string;
  }): Promise<void>;
  getTransferById(params: {
    transferId: string;
    organizationId: string;
    projectId: string | null;
  }): Promise<PaymentTransferRow | null>;
  getTransferBySignature(params: {
    signature: string;
    organizationId: string;
    projectId: string | null;
  }): Promise<PaymentTransferRow | null>;
  listTransfersByIds(params: {
    transferIds: string[];
    organizationId: string;
    projectId: string | null;
  }): Promise<PaymentTransferRow[]>;
  getTransferByProviderReference(
    params: GetTransferByProviderReferenceInput
  ): Promise<PaymentTransferRow | null>;
  listTransfersBySignatures(params: {
    signatures: string[];
    organizationId: string;
    projectId: string | null;
  }): Promise<PaymentTransferRow[]>;
  listTransfers(params: ListTransfersInput): Promise<ListTransfersResult>;
}
