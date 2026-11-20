import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { CustodyProvider } from "@sdp/types/custody";
import type {
  CustodyProposalEffect,
  CustodyProposalEvent,
  CustodyProposalState,
} from "@sdp/types/custody-proposals";
import type { MoneyPrincipal } from "@/lib/money-principal";
import type { PaymentTransferRow } from "./payments.repository";

/** A provider proposal bound permanently to one payment and custody account. */
export interface CustodyProposalRow {
  kind: "transfer";
  id: string;
  organization_id: string;
  project_id: string;
  custody_wallet_id: string | null;
  payment_transfer_id: string;
  provider: CustodyProvider;
  binding: Record<string, unknown>;
  state: CustodyProposalState;
  version: number;
  recheck_requested_at: string | null;
  next_check_at: string;
  last_checked_at: string | null;
  last_polled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A sign-only request shares proposal state without manufacturing a payment. */
export interface SigningProposalRow
  extends Omit<CustodyProposalRow, "kind" | "payment_transfer_id" | "custody_wallet_id"> {
  kind: "signing";
  payment_transfer_id: null;
  custody_wallet_id: string;
  operation: string;
  request_id: string | null;
  finished_at: string | null;
}

/** The canonical queue dispatches by recorded operation kind. */
export type ProposedTransactionRow = CustodyProposalRow | SigningProposalRow;

/** Every signing request names its immutable tenant and proposal identity. */
export interface SigningProposalIdentity {
  organizationId: string;
  projectId: string;
  proposalId: string;
}

/** Every access names both the payment parent and its tenant. */
export interface CustodyProposalIdentity {
  transferId: string;
  organizationId: string;
  projectId: string | null;
}

/** Optional narrowing never changes the proposal's stored authority. */
export interface CustodyProposalRecoveryScope {
  organizationId?: string;
  projectId?: string;
  principal?: MoneyPrincipal;
}

/** A bounded, environment-specific worker page. */
export interface ClaimCustodyProposalsInput extends CustodyProposalRecoveryScope {
  environment: SdpEnvironment;
  now: string;
  limit: number;
}

/** A successful versioned transition and its transactional/external effects. */
export interface CustodyProposalTransition {
  proposal: CustodyProposalRow;
  effects: readonly CustodyProposalEffect[];
}

/** Proposal lifecycle storage; providers never run within these operations. */
export interface CustodyProposalsRepository {
  /** Persist the immutable provider binding before an external proposal is created. */
  createSigning(input: {
    organizationId: string;
    projectId: string;
    provider: CustodyProvider;
    connectionId: string;
    walletId: string;
    binding: Record<string, unknown>;
    operation: string;
    requestId?: string;
  }): Promise<string>;
  getSigning(input: SigningProposalIdentity): Promise<SigningProposalRow | null>;
  requireSigning(input: SigningProposalIdentity): Promise<SigningProposalRow>;
  listSigning(input: {
    organizationId: string;
    projectId: string;
    walletId: string;
    offset: number;
  }): Promise<SigningProposalRow[]>;
  /** All signing observations and cancellation facts use the shared reducer. */
  transitionSigning(
    input: SigningProposalIdentity & {
      event: CustodyProposalEvent;
      expectedVersion?: number;
      expectedCancelAttempt?: number;
    }
  ): Promise<SigningProposalRow | null>;
  /** Atomically observe provider progress and test whether signature delivery is authorized. */
  observeSigning(
    input: SigningProposalIdentity & {
      event: Extract<CustodyProposalEvent, { type: "observed" }>;
    }
  ): Promise<boolean>;
  failUnacceptedSigning(input: SigningProposalIdentity): Promise<boolean>;
  /** Durable refusal wins before provider cancellation I/O or signature delivery. */
  requestSigningCancellation(input: SigningProposalIdentity): Promise<boolean>;
  /** Viewer reads never advance the shared recovery schedule. */
  claimSigningPoll(input: SigningProposalIdentity): Promise<boolean>;
  /** Metrics count the same active kinds and environment the shared queue can recover. */
  stats(
    input: CustodyProposalRecoveryScope & { environment: SdpEnvironment; now: string }
  ): Promise<{
    pending: number;
    transfers: number;
    signing: number;
    oldestUnpolledAgeMs: number;
  }>;
  /** First write wins; tenant, payment, wallet, provider and binding never change. */
  ensureForTransfer(input: {
    transfer: PaymentTransferRow;
    provider: CustodyProvider;
    binding: Record<string, unknown>;
    state: CustodyProposalState;
    now: string;
  }): Promise<CustodyProposalRow>;
  getForTransfer(input: CustodyProposalIdentity): Promise<CustodyProposalRow | null>;
  /** Use the caller's payment/audit transaction; stale or illegal events return null. */
  transition(
    input: CustodyProposalIdentity & {
      expectedVersion: number;
      event: CustodyProposalEvent;
    }
  ): Promise<CustodyProposalTransition | null>;
  /** System only; clear the old wake before I/O and reserve ordinary sweep capacity. */
  claimDue(input: ClaimCustodyProposalsInput): Promise<ProposedTransactionRow[]>;
  /** System only; preserve priority when concurrent writes exhaust a recovery pass. */
  requestRecheck(input: CustodyProposalIdentity & { now: string }): Promise<void>;
  /** Viewer-only throttle, independent of worker scheduling and authority wakes. */
  claimForPoll(
    input: CustodyProposalIdentity & { now: string; polledBefore: string }
  ): Promise<CustodyProposalRow | null>;
  /** System only; completed proposals remain in the critical-alert outbox. */
  listUnalerted(
    input: CustodyProposalRecoveryScope & { environment: SdpEnvironment; limit: number }
  ): Promise<ProposedTransactionRow[]>;
  /** System only; also discovers payments written by older live revisions. */
  adoptLegacyTransfers(input: {
    environment: SdpEnvironment;
    now: string;
    limit: number;
  }): Promise<number>;
}
