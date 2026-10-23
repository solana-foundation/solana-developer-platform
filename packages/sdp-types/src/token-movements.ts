/**
 * Token movement vocabulary (ADR 0012): what an amount fixes, and whether SDP
 * has checked what a movement moved. The API, the dashboard and the
 * `token_movement_legs` ledger share these sets.
 *
 * Amounts here are token units: base units ÷ 10^decimals, never the display
 * value a scaled or interest-bearing mint shows.
 */

import { z } from "zod";
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
 * Why SDP will not make a movement now (`@sdp/solana/token-movement`). The
 * builder and each adapter refuse it with a 400; a recurring pull is held
 * with it, and the collection attempt reports it.
 */
export const TOKEN_MOVEMENT_REFUSAL_REASONS = [
  "non_transferable",
  "paused",
  "default_frozen",
  "hook_unresolved",
  "memo_required",
  "nothing_credited",
  /** Wallets show a scaled or interest-bearing amount: Payments refuses the mint until PR 5. */
  "scaled_display",
  /** A recurring pull's transfer fee is above the fee tolerance its mandate recorded. */
  "fee_above_tolerance",
  /** An existing destination token account is frozen. */
  "destination_frozen",
  // An adapter's row (issuance, DvP, Private Channels, Earn) refuses these.
  /** The path cannot state a transfer fee, or cannot carry one. */
  "transfer_fee",
  /** The path's program refuses a scaled or interest-bearing mint. */
  "display_rule",
  /** The path cannot pass a transfer hook's extra accounts. */
  "transfer_hook",
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
   * SDP did not build the movement itself (a program's CPI pull, an observed
   * transfer, a provider's delivery), and the chain shows it moved what it
   * says: the raw balance changes, in base units, agree with the quote (a
   * pull's fee may be any fee within its mandate's tolerance), or with its
   * instruction data and the transfer fee rule.
   */
  "chain_delta_matched",
  /**
   * The chain shows other amounts than the movement says it moved (a pull's
   * fee above its tolerance included), or none SDP can read.
   */
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

/** The verdict on a movement that failed, or was released, before it moved anything. */
export const MOVEMENT_NOT_EXECUTED = {
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

/**
 * The same for the ramp transitions that end an off-ramp deposit SDP built,
 * written on off-ramp rows only. `delivery_verified` is there because a
 * provider settlement can move the row out of `processing` before
 * `offramp_deposit_confirmed` matches it; on-ramps take it too, and get no verdict.
 */
export const BUILT_OFFRAMP_DEPOSIT_VERDICTS = {
  offramp_deposit_confirmed: BUILT_TRANSFER_LANDED,
  /**
   * The chain verifier saw a deposit's signature finalize without error. A
   * deposit whose own confirmation timed out stayed pending until then: it
   * landed as SDP built it. An on-ramp has no built leg, so this writes none.
   */
  delivery_verified: BUILT_TRANSFER_LANDED,
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

/**
 * How a leg is verified: `construction` for a top-level transfer SDP built
 * and signed, verified once it lands; `chain` for a movement a program makes
 * (a CPI pull), verified from the landed transaction.
 */
export const LEG_VERIFIERS = ["construction", "chain"] as const;

export type LegVerifier = (typeof LEG_VERIFIERS)[number];

/**
 * The verdict on a chain-verified leg whose landed transaction moved its
 * quote's debit, its fee within the tolerance.
 */
export const CHAIN_DELTA_MATCHED = {
  state: "verified",
  reason: "chain_delta_matched",
} as const satisfies AmountVerificationVerdict;

/** The verdict on a chain-verified leg whose landed transaction shows other amounts or none. */
export const CHAIN_DELTA_MISMATCH = {
  state: "mismatch",
  reason: "chain_delta_mismatch",
} as const satisfies AmountVerificationVerdict;

/**
 * The verdict the chain gives a leg it verifies: matched when the landed
 * transaction moved the quote's debit with a fee within the tolerance.
 */
export function chainDeltaVerdict(matched: boolean): AmountVerificationVerdict {
  return matched ? CHAIN_DELTA_MATCHED : CHAIN_DELTA_MISMATCH;
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
export const tokenMovementExpectationSchema = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("credit"), credit: z.string(), decimals: z.number().int() }),
  z.object({
    basis: z.literal("debit"),
    debit: z.string(),
    decimals: z.number().int(),
    /** The largest transfer fee one pull may pay; a pull that would pay more is held. */
    maxFeePerPull: z.string(),
  }),
]);

export type TokenMovementExpectation = z.infer<typeof tokenMovementExpectationSchema>;

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
