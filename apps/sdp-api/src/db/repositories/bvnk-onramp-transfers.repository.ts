import type { BvnkOnrampTransferData } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { BvnkRampSettlement, SdpEnvironment } from "@sdp/types";
import type { PaymentTransferRow } from "./payments.repository";

/** The immutable pay-in ownership facts persisted by applyPayin, indexed from the provider-data codec. */
export type BvnkOnrampPayin = NonNullable<BvnkOnrampTransferData["payin"]>;

/** The spend intent persisted at claim time, indexed from the provider-data codec (claims always carry one). */
export type BvnkOnrampPayoutIntent = NonNullable<
  NonNullable<BvnkOnrampTransferData["payout"]>["intent"]
>;

/** A candidate row carries the joined active funding-wallet reference and project environment. */
export interface BvnkOnrampTransferCandidateRow extends PaymentTransferRow {
  fundingWalletReference: string;
  environment: SdpEnvironment;
}

export interface GetBvnkOnrampTransferByPayinIdInput {
  payinId: string;
  environment: SdpEnvironment;
}

export interface GetBvnkOnrampTransferByIdInput {
  transferId: string;
  environment: SdpEnvironment;
}

export interface ApplyBvnkOnrampPayinInput {
  transferId: string;
  fundingWalletReference: string;
  payin: BvnkOnrampPayin;
}

export interface ListBvnkPayoutCandidatesInput {
  limit: number;
  /** ISO timestamp a claim/poll must predate to be eligible (recovery and poll branches only). */
  cutoff: string;
}

export interface ClaimBvnkOnrampPayoutInput {
  transferId: string;
  claimedAt: string;
  intent: BvnkOnrampPayoutIntent;
}

export interface LeaseBvnkOnrampPayoutRecoveryInput {
  transferId: string;
  observedClaimedAt: string;
  claimedAt: string;
}

export interface RecordBvnkOnrampPayoutIdInput {
  transferId: string;
  payoutId: string;
  claimedAt: string;
  environment: SdpEnvironment;
  /** The PROCESSING settlement blob, written in the SAME first-write-wins UPDATE as the payout id. */
  settlement: BvnkRampSettlement;
}

export interface BvnkOnrampSettlementUpdate {
  signature: string;
  destinationAddress: string;
  amount: string;
  settlement: Record<string, unknown>;
}

export interface SettleBvnkOnrampPayoutInput {
  transferId: string;
  payoutId: string;
  claimedAt: string;
  update: BvnkOnrampSettlementUpdate;
}

export interface FailBvnkOnrampPayoutInput {
  transferId: string;
  /** The provider payout id, or null for a definitive first-attempt rejection before any payout existed. */
  payoutId: string | null;
  error: string;
  claimedAt: string;
}

export interface FailBvnkOnrampPayoutUnclaimedInput {
  transferId: string;
  error: string;
  claimedAt: string;
}

export interface MarkBvnkOnrampPayoutPolledInput {
  transferId: string;
  polledAt: string;
}

export interface ClaimBvnkOnrampPayinSimulationInput {
  transferId: string;
  requestedAt: string;
}

export interface BvnkOnrampTransfersRepository {
  /** Reads a BVNK on-ramp transfer by its persisted pay-in id, scoped to the owning project's environment. */
  getByPayinId(input: GetBvnkOnrampTransferByPayinIdInput): Promise<PaymentTransferRow | null>;

  /** Reads a BVNK on-ramp transfer by id, scoped to the owning project's environment. */
  getById(input: GetBvnkOnrampTransferByIdInput): Promise<PaymentTransferRow | null>;

  /**
   * Applies a completed pay-in in ONE statement: the status CAS, the
   * first-write-wins pay-in guard, the received-currency guard, and the
   * active funding-wallet binding all land atomically. The received amount
   * must be a positive decimal.
   */
  applyPayin(input: ApplyBvnkOnrampPayinInput): Promise<PaymentTransferRow | null>;

  /** Lists settling transfers with no payout claim; eligibility is decided in SQL before LIMIT, oldest first. */
  listUnclaimedPayoutCandidates(
    input: ListBvnkPayoutCandidatesInput
  ): Promise<BvnkOnrampTransferCandidateRow[]>;

  /** Lists claimed-without-payoutId transfers whose claim predates the cutoff; decided in SQL before LIMIT, oldest first. */
  listRecoverablePayoutCandidates(
    input: ListBvnkPayoutCandidatesInput
  ): Promise<BvnkOnrampTransferCandidateRow[]>;

  /** Lists settling transfers with a payoutId whose last poll (or claim) predates the cutoff; decided in SQL before LIMIT, oldest first. */
  listPollablePayoutCandidates(
    input: ListBvnkPayoutCandidatesInput
  ): Promise<BvnkOnrampTransferCandidateRow[]>;

  /** Claims the payout slot first-write-wins, persisting the spend intent BEFORE any provider call (R4). */
  claimPayout(input: ClaimBvnkOnrampPayoutInput): Promise<PaymentTransferRow | null>;

  /** Leases a claim for recovery: bumps claimedAt and attempts, fenced on the observed claim and on no payoutId existing. */
  leasePayoutRecovery(
    input: LeaseBvnkOnrampPayoutRecoveryInput
  ): Promise<PaymentTransferRow | null>;

  /**
   * Records the provider payout id and the PROCESSING settlement blob in ONE
   * first-write-wins UPDATE, fenced on the held claim and on the settlement
   * key being absent. A lost CAS re-reads the transfer: the same payout id
   * replays, an absent or different id throws, and a vanished transfer
   * throws.
   */
  recordPayoutId(input: RecordBvnkOnrampPayoutIdInput): Promise<PaymentTransferRow>;

  /** Settles a completed payout: `settling` → `completed` with delivery and economics, fenced on payoutId and claim. */
  settlePayout(input: SettleBvnkOnrampPayoutInput): Promise<PaymentTransferRow | null>;

  /** Fails a claimed payout (`payoutId` set) fenced on id and claim; fails a first-attempt claim (null id) only while attempts = 1. */
  failPayout(input: FailBvnkOnrampPayoutInput): Promise<PaymentTransferRow | null>;

  /**
   * Fails a settling transfer that never received a payout claim — the
   * definitive pre-create rejection (dry-run refusal or unknown asset). One
   * UPDATE writes status/error/lastError guarded on the payout key being
   * absent, so no recoverable or fabricated intent is ever persisted (P1-5).
   */
  failPayoutUnclaimed(
    input: FailBvnkOnrampPayoutUnclaimedInput
  ): Promise<PaymentTransferRow | null>;

  /** Stamps `payout.lastPolledAt` after a poll so the row rotates; fenced on the payoutId existing and the row settling. */
  markPayoutPolled(input: MarkBvnkOnrampPayoutPolledInput): Promise<PaymentTransferRow | null>;

  /** Claims the sandbox simulation slot first-write-wins while the transfer is still awaiting payment (R15). */
  claimPayinSimulation(
    input: ClaimBvnkOnrampPayinSimulationInput
  ): Promise<PaymentTransferRow | null>;
}
