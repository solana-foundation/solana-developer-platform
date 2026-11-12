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
  claimDue(input: ClaimCustodyProposalsInput): Promise<CustodyProposalRow[]>;
  /** Viewer-only throttle, independent of worker scheduling and authority wakes. */
  claimForPoll(
    input: CustodyProposalIdentity & { now: string; polledBefore: string }
  ): Promise<CustodyProposalRow | null>;
  /** System only; completed proposals remain in the critical-alert outbox. */
  listUnalerted(
    input: CustodyProposalRecoveryScope & { environment: SdpEnvironment; limit: number }
  ): Promise<CustodyProposalRow[]>;
  /** System only; also discovers payments written by older live revisions. */
  adoptLegacyTransfers(input: {
    environment: SdpEnvironment;
    now: string;
    limit: number;
  }): Promise<number>;
}
