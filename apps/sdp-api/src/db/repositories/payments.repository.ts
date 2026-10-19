import { PAYMENT_TRANSFER_ID_PREFIX } from "@sdp/payments/ramps/shared";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type {
  PaymentTransferStatus,
  PaymentTransferType,
  RampTransferSettlement,
  RampTransferTransitionId,
} from "@sdp/types/payments";
import type { PersistedRampProviderId, RampProviderId } from "@sdp/types/provider-access";
import type { PaymentTransactionKind } from "@sdp/types/unified-transactions";
import type { DatabaseClient as RepositoryDbClient } from "@/db/client";

export type PaymentTransferDirection = "inbound" | "outbound";
export type PaymentTransferDeliveryMode = "hosted" | "manual_instructions" | "session_widget";

export interface PaymentTransferRow {
  id: string;
  organization_id: string;
  project_id: string;
  custody_wallet_id: string | null;
  wallet_id: string;
  counterparty_id: string | null;
  counterparty_display_name?: string | null;
  source_address: string | null;
  destination_address: string | null;
  token: string;
  amount: string | null;
  memo: string | null;
  type: PaymentTransferType;
  kind: PaymentTransactionKind;
  direction: PaymentTransferDirection;
  status: PaymentTransferStatus;
  /** A retired provider's historical row reads too; writes take a live `RampProviderId`. */
  provider: PersistedRampProviderId | null;
  provider_reference: string | null;
  /** MoonPay's canonical top-level updatedAt for the currently bound transaction. */
  provider_observed_at: string | null;
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
  created_at: string;
  updated_at: string;
}

export function generatePaymentTransferId(): string {
  return `${PAYMENT_TRANSFER_ID_PREFIX}${crypto.randomUUID()}`;
}

export type ConfirmedTransferPollVerdict = {
  transferId: string;
  organizationId: string;
} & ({ finalized: true; slot: number } | { finalized: false; slot: null });

export interface CreatePaymentTransferInput {
  /** Server-generated transfer id reserved before an external provider call. */
  id: string;
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
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
  projectId?: string;
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

/** Row fields a guarded status change may write alongside the status. */
export interface TransferStatusChangeFields {
  sourceAddress?: string | null;
  destinationAddress?: string | null;
  signature?: string | null;
  serializedTx?: string | null;
  slot?: number | null;
  blockTime?: string | null;
  fee?: number | null;
  amount?: string | null;
  fiatAmount?: string | null;
  deliveryMode?: PaymentTransferDeliveryMode | null;
  providerData?: Record<string, unknown>;
  error?: string | null;
}

export interface RampTransferTransitionInput extends TransferStatusChangeFields {
  transferId: string;
  organizationId: string;
  projectId: string;
  transition: RampTransferTransitionId;
  /** MoonPay observations compare this timestamp only for the bound reference. */
  providerObservation?: { reference: string; observedAt: string };
  updatedAt: string;
}

export interface ListTransfersInput {
  organizationId: string;
  projectId: string;
  walletAuthorization?: {
    custodyWalletIds: string[];
    providerWalletIds: string[];
  };
  custodyWalletId?: string;
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
  /** Only transfers whose project is in this environment, so one job run reads one cluster. */
  environment: SdpEnvironment;
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
      projectId: string;
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
  /**
   * Claims an awaiting off-ramp row for its crypto deposit transaction through
   * the `offramp_deposit_claimed` transition. The update succeeds only while
   * the row still matches its deposit instruction and every on-chain
   * submission field is unoccupied.
   */
  updateOnchainTransferForRamp(input: {
    transferId: string;
    organizationId: string;
    projectId: string;
    custodyWalletId: string;
    walletId: string;
    sourceAddress: string;
    destinationAddress: string;
    token: string;
    amount: string;
    initiatedByKeyId: string;
    /**
     * The funding request's record key and fingerprint (HOO-1918), recorded on
     * the deposit row so a retry after the key's record expires is compared
     * like any keyed transfer; null for an unkeyed request.
     */
    idempotency: { key: string; fingerprint: string } | null;
    updatedAt: string;
  }): Promise<PaymentTransferRow | null>;
  findTransferByIdempotency(params: {
    organizationId: string;
    projectId: string;
    idempotencyKey: string;
  }): Promise<PaymentTransferRow | null>;
  /**
   * Updates a transfer's fields. An update carrying a `status` matches no ramp
   * row: ramp statuses move only through `transitionRampTransfer`.
   */
  updateTransfer(input: UpdatePaymentTransferInput): Promise<PaymentTransferRow | null>;
  persistSignedTransfer(input: {
    transferId: string;
    organizationId: string;
    projectId: string;
    signature: string;
    signedTransaction: string;
    lastValidBlockHeight: string;
    updatedAt: string;
  }): Promise<PaymentTransferRow | null>;
  markTransferSubmissionStarted(input: {
    transferId: string;
    organizationId: string;
    projectId: string;
    startedAt: string;
  }): Promise<PaymentTransferRow | null>;
  /**
   * Applies one `RAMP_TRANSFER_TRANSITIONS` entry as a compare-and-swap: the
   * row must be a ramp transfer of one of the transition's types, in one of its
   * source statuses, scoped to org/project. Returns the updated row, or null
   * when no row matched (illegal source, lost race, missing, wrong owner, or
   * not a ramp transfer of those types).
   */
  transitionRampTransfer(input: RampTransferTransitionInput): Promise<PaymentTransferRow | null>;
  listTransfersByStatus(params: ListTransfersByStatusInput): Promise<PaymentTransferRow[]>;
  /**
   * Lists the page of confirmed transfers whose finalization should be polled
   * next: least-recently-polled first (never-polled rows first), bounded to
   * rows confirmed after the given floor. System-only.
   *
   * @param params - The project environment, the confirmed_at eligibility floor and the page size.
   * @returns The next page of the finalization poll queue.
   */
  listConfirmedTransfersToPoll(params: {
    environment: SdpEnvironment;
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
    projectId: string;
  }): Promise<PaymentTransferRow | null>;
  getTransferBySignature(params: {
    signature: string;
    organizationId: string;
    projectId: string;
  }): Promise<PaymentTransferRow | null>;
  listTransfersByIds(params: {
    transferIds: string[];
    organizationId: string;
    projectId: string;
  }): Promise<PaymentTransferRow[]>;
  getTransferByProviderReference(
    params: GetTransferByProviderReferenceInput
  ): Promise<PaymentTransferRow | null>;
  getTransferProjectEnvironment(input: {
    transferId: string;
    provider: RampProviderId;
  }): Promise<SdpEnvironment | null>;
  /** Locks the transfer while a MoonPay claim or failed-attempt release is decided. Transaction only. */
  lockTransferForProvider(input: {
    transferId: string;
    provider: RampProviderId;
  }): Promise<{ transfer: PaymentTransferRow; environment: SdpEnvironment } | null>;
  /**
   * Serializes MoonPay claims and failures for one transaction id, then reads
   * its bound owner. Transaction only.
   */
  lockMoonpayTransactionOwner(transactionId: string): Promise<string | null>;
  getFailedMoonpayTransaction(transactionId: string): Promise<{
    transferId: string;
    providerObservedAt: string;
  } | null>;
  recordFailedMoonpayTransaction(input: {
    transactionId: string;
    transferId: string;
    providerObservedAt: string;
    failureReason?: string;
    settlement?: RampTransferSettlement;
  }): Promise<void>;
  /**
   * Claims a provider reference after the caller locks and checks its transfer.
   * MoonPay callers also lock the transaction id before checking its owner.
   * Failed MoonPay transaction ids cannot claim even after the reference clears.
   */
  claimProviderReference(input: {
    transferId: string;
    provider: RampProviderId;
    providerReference: string;
    environment: SdpEnvironment;
    updatedAt: string;
  }): Promise<PaymentTransferRow | null>;
  /** Clears a failed MoonPay attempt after its guarded status transition. Transaction only. */
  releaseMoonpayProviderReference(input: {
    transferId: string;
    providerReference: string | null;
    providerObservedAt: string | null;
  }): Promise<void>;
  listTransfersBySignatures(params: {
    signatures: string[];
    organizationId: string;
    projectId: string;
  }): Promise<PaymentTransferRow[]>;
  listTransfers(params: ListTransfersInput): Promise<ListTransfersResult>;
}
