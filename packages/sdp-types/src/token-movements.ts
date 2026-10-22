/**
 * Token movement vocabulary (ADR 0012): what an amount fixes, and whether SDP
 * has checked what a movement moved. The API, the dashboard and the
 * `token_movement_legs` ledger share these sets.
 *
 * Amounts here are token units: base units ÷ 10^decimals, never the display
 * value a scaled or interest-bearing mint shows.
 */

import type {
  PaymentTransferStatus,
  RampTransferTransitionId,
  TransferChainVerdictStatus,
} from "./payments";

/**
 * Which side of a transfer an amount fixes: `debit` is what leaves the
 * source, `credit` is what the destination receives. Request amounts default
 * to `debit`; an amount that is a receipt by definition (a provider's deposit
 * amount) is a `credit`.
 */
export const TOKEN_MOVEMENT_BASES = ["debit", "credit"] as const;

export type TokenMovementBasis = (typeof TOKEN_MOVEMENT_BASES)[number];

/**
 * A leg's lifecycle (soft delete only): archived with the row that owns it,
 * never deleted. Separate from its verification state.
 */
export const TOKEN_MOVEMENT_LEG_STATUSES = ["active", "archived"] as const;

export type TokenMovementLegStatus = (typeof TOKEN_MOVEMENT_LEG_STATUSES)[number];

/** The basis a request amount has when the request does not name one. */
export const DEFAULT_TOKEN_MOVEMENT_BASIS = "debit" satisfies TokenMovementBasis;

/**
 * Why SDP will not make a movement now (`@sdp/solana/token-movement`). A
 * builder path refuses it with a 400; a recurring pull is held with it, and
 * the collection attempt reports it.
 */
export const TOKEN_MOVEMENT_REFUSAL_REASONS = [
  "non_transferable",
  "paused",
  "default_frozen",
  "hook_unresolved",
  "memo_required",
  "nothing_credited",
  /** A recurring pull's transfer fee is above the fee tolerance its mandate recorded. */
  "fee_above_tolerance",
] as const;

export type TokenMovementRefusalReason = (typeof TOKEN_MOVEMENT_REFUSAL_REASONS)[number];

/**
 * Whether SDP has checked what a movement moved against its quote. It is
 * separate from the transfer status, which never changes for it.
 */
export const AMOUNT_VERIFICATION_STATES = [
  "pending",
  "verified",
  "mismatch",
  "not_required",
] as const;

export type AmountVerificationState = (typeof AMOUNT_VERIFICATION_STATES)[number];

export const AMOUNT_VERIFICATION_REASONS = [
  /**
   * SDP built and signed a top-level `TransferChecked` (or `TransferCheckedWithFee`)
   * and it landed: it moved exactly the quoted debit, fee and credit.
   */
  "sdp_built_transfer_landed",
  /** The movement failed, or was released, before it moved anything. */
  "movement_not_executed",
  /**
   * A movement SDP did not build itself (a program's CPI pull) landed, and the
   * chain shows it moved exactly the quote: the instruction's debit, and the
   * destination's raw token-balance delta as the credit.
   */
  "chain_delta_matched",
  /** The chain shows the movement moved other amounts than the quote, or none SDP can read. */
  "chain_delta_mismatch",
] as const;

export type AmountVerificationReason = (typeof AMOUNT_VERIFICATION_REASONS)[number];

/**
 * The order a movement of several legs reports their states in: the first any
 * leg is in. One mismatch outranks everything, an unchecked leg outranks the
 * checked ones, and `not_required` reports only when no leg needed a check.
 */
export const AMOUNT_VERIFICATION_SUMMARY_ORDER = [
  "mismatch",
  "pending",
  "verified",
  "not_required",
] as const satisfies readonly AmountVerificationState[];

/**
 * The state a movement of several legs reports: the first in
 * {@link AMOUNT_VERIFICATION_SUMMARY_ORDER} any leg is in.
 *
 * @throws Error when `states` is empty, which no movement is.
 */
export function summarizeAmountVerificationStates(
  states: readonly AmountVerificationState[]
): AmountVerificationState {
  const state = AMOUNT_VERIFICATION_SUMMARY_ORDER.find((candidate) => states.includes(candidate));
  if (state === undefined) {
    throw new Error("A movement has at least one leg to summarize");
  }
  return state;
}

/** A movement's verification, as the API reports it. */
export interface AmountVerification {
  state: AmountVerificationState;
  reason?: AmountVerificationReason;
}

/** A verification a chain verdict writes: every written state has its reason. */
export type AmountVerificationVerdict = Readonly<{
  state: Exclude<AmountVerificationState, "pending">;
  reason: AmountVerificationReason;
}>;

const BUILT_TRANSFER_LANDED = {
  state: "verified",
  reason: "sdp_built_transfer_landed",
} as const satisfies AmountVerificationVerdict;

const MOVEMENT_NOT_EXECUTED = {
  state: "not_required",
  reason: "movement_not_executed",
} as const satisfies AmountVerificationVerdict;

/**
 * What a chain verdict on a transfer SDP built means for its legs. A landed
 * transfer is verified by construction, with no extra `getTransaction`: its
 * debit and fee are what SDP signed, and the program moved exactly those.
 */
export const BUILT_MOVEMENT_VERDICTS = {
  confirmed: BUILT_TRANSFER_LANDED,
  finalized: BUILT_TRANSFER_LANDED,
  failed: MOVEMENT_NOT_EXECUTED,
} as const satisfies Record<TransferChainVerdictStatus, AmountVerificationVerdict>;

/**
 * The verdict a transfer status writes on the legs of a movement SDP built,
 * or null when the status is no chain verdict.
 */
export function builtMovementVerdict(
  status: PaymentTransferStatus
): AmountVerificationVerdict | null {
  const verdicts: Partial<Record<PaymentTransferStatus, AmountVerificationVerdict>> =
    BUILT_MOVEMENT_VERDICTS;
  return verdicts[status] ?? null;
}

/** The same for the ramp transitions that end an off-ramp deposit SDP built. */
export const BUILT_OFFRAMP_DEPOSIT_VERDICTS = {
  offramp_deposit_confirmed: BUILT_TRANSFER_LANDED,
  offramp_deposit_failed: MOVEMENT_NOT_EXECUTED,
  offramp_deposit_released: MOVEMENT_NOT_EXECUTED,
} as const satisfies Partial<Record<RampTransferTransitionId, AmountVerificationVerdict>>;

/**
 * The verdict a ramp transition writes on its legs, or null when it ends no
 * deposit SDP built.
 */
export function builtOfframpDepositVerdict(
  transition: RampTransferTransitionId
): AmountVerificationVerdict | null {
  const verdicts: Partial<Record<RampTransferTransitionId, AmountVerificationVerdict>> =
    BUILT_OFFRAMP_DEPOSIT_VERDICTS;
  return verdicts[transition] ?? null;
}

/** The three amounts as a scaled or interest-bearing mint's wallets show them. */
export interface TokenMovementDisplay {
  debit: string;
  fee: string;
  credit: string;
  /** The chain time the display values were computed at (ISO 8601). */
  asOf: string;
}

/**
 * What an expectation or a mandate fixes before any movement exists, in token
 * units. A payment request fixes the credit its payment must deliver; the
 * payer's debit and the fee are quoted when the payment is built. A recurring
 * mandate fixes the debit of each pull; the fee, and so the credit, depend on
 * the epoch the pull runs in, up to `maxFeePerPull`.
 */
export type TokenMovementExpectation =
  | {
      basis: "credit";
      credit: string;
      decimals: number;
    }
  | {
      basis: "debit";
      debit: string;
      decimals: number;
      /** The largest transfer fee one pull may pay; a pull that would pay more is held. */
      maxFeePerPull: string;
    };

/**
 * What a movement moves, in token units. `debit = credit + fee`; the fee is
 * the mint's transfer fee, withheld in the destination, never the network fee.
 */
export interface TokenMovementAmounts {
  basis: TokenMovementBasis;
  debit: string;
  fee: string;
  credit: string;
  decimals: number;
  /** Present only for a scaled or interest-bearing mint. */
  display?: TokenMovementDisplay;
}
