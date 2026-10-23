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
import type { SdpModule } from "./release-channels";

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
 * The paths a movement takes, each with its own capability row (ADR 0012,
 * "one capability decision"). `builder` is the instructions
 * `@sdp/solana/token-movement` builds; the others are registered adapters:
 * each moves tokens through its own engine (an SDK or an on-chain program),
 * so its row holds that engine's rules.
 */
export const TOKEN_MOVEMENT_PATHS = [
  /** Instructions built by the builder: Payments transfers, batches, off-ramp funding, /pay and DvP funding. */
  "builder",
  // ── Registered adapters ────────────────────────────────────────────────
  /**
   * A recurring pull: the subscriptions program moves the mandate's debit with
   * a plain `TransferChecked` through CPI, so no fee guard is on chain and the
   * destination cannot get a memo first.
   */
  "recurring",
  /** Issuance mint and burn through Mosaic. Neither is a transfer, so no fee or hook applies. */
  "issuance",
  /** Issuance seize: the permanent delegate's `TransferChecked`, which Mosaic builds. */
  "issuance_seize",
  /** DvP trades: the DvP program settles, cancels and reclaims each escrow. */
  "dvp",
  /** Private Channels deposits, transfers and withdrawals, through SPC's escrow and encoding. */
  "private_channels",
  /**
   * Earn deposit mints, moved by each provider's own builder or program. Exits
   * never inherit a money-in gate; the deposit-mint guard reports this row.
   */
  "earn",
] as const;

export type TokenMovementPath = (typeof TOKEN_MOVEMENT_PATHS)[number];

/**
 * The module each movement path belongs to. A deployment reports, and its
 * public documents name, only the paths of modules its release channel runs.
 * The builder serves Payments, which every channel runs.
 */
export const TOKEN_MOVEMENT_PATH_MODULES = {
  builder: "payments",
  recurring: "recurring_payments",
  issuance: "issuance",
  issuance_seize: "issuance",
  dvp: "dvp",
  private_channels: "private_channels",
  earn: "earn",
} as const satisfies Record<TokenMovementPath, SdpModule>;

/**
 * What a path does with a movement it will not make now. A `hold` may pass
 * later without anything SDP stores changing (a paused mint can be unpaused),
 * so a path that can wait, a recurring pull, waits instead of failing; a
 * `refuse` cannot.
 */
export const TOKEN_MOVEMENT_DISPOSITIONS = ["refuse", "hold"] as const;

export type TokenMovementDisposition = (typeof TOKEN_MOVEMENT_DISPOSITIONS)[number];

/** The Token-2022 mint extensions, as the client names them, whose state a capability row refuses. */
export const CAPABILITY_EXTENSIONS = [
  "NonTransferable",
  "PausableConfig",
  "DefaultAccountState",
  "TransferFeeConfig",
  // biome-ignore lint/security/noSecrets: an extension name, not a secret.
  "ScaledUiAmountConfig",
  "InterestBearingConfig",
  "TransferHook",
] as const;

export type CapabilityExtension = (typeof CAPABILITY_EXTENSIONS)[number];

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

/**
 * How a mint's wallets show an amount: as token units (`plain`), scaled by a
 * multiplier (Token-2022 scaled UI amount), or with interest accrued
 * (Token-2022 interest-bearing). Base units never change with it.
 */
export const TOKEN_DISPLAY_RULES = ["plain", "scaled", "interest"] as const;

export type TokenDisplayRule = (typeof TOKEN_DISPLAY_RULES)[number];

/**
 * Whether a display rule gives an approximate value: an interest-bearing
 * mint accrues every second, so its display is true only at its `asOf`. A
 * scaled mint's display is exact; screens mark only approximate ones ("≈").
 */
export const APPROXIMATE_TOKEN_DISPLAY_RULES = {
  plain: false,
  scaled: false,
  interest: true,
} as const satisfies Record<TokenDisplayRule, boolean>;

/**
 * A held amount in its three units (ADR 0012). Balance checks and "Max" use
 * `tokenAmount`; screens show `displayAmount`, which is never sent back as an
 * amount.
 */
export interface TokenBalanceAmounts {
  /** Base units, summed over every token account the owner holds for the mint. */
  amount: string;
  /** Exact token units: `amount` ÷ 10^decimals. */
  tokenAmount: string;
  /**
   * What a wallet shows for the summed base units under the mint's display
   * rule. Equal to `tokenAmount` under the `plain` rule. Interest-bearing
   * values are approximate and change every second.
   */
  displayAmount: string;
  /** The chain time `displayAmount` was computed at (ISO 8601); null under the `plain` rule. */
  displayAsOf: string | null;
  displayRule: TokenDisplayRule;
  decimals: number;
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

/** One fee entry of a mint's transfer-fee schedule, as the terms route reports it. */
export interface TokenTransferFeeEntry {
  /** First epoch the entry applies in. */
  epoch: string;
  /** Fee rate in hundredths of a percent, at most 10 000. */
  basisPoints: number;
  /** Cap on the fee of one transfer, in token units. */
  maximumFee: string;
}

/** A mint's display rule, as the terms route reports it. */
export type TokenDisplayTerms =
  | { rule: "plain" }
  | {
      rule: "scaled";
      multiplier: number;
      newMultiplier: number;
      /** When `newMultiplier` replaces `multiplier` (ISO 8601). */
      newMultiplierEffectiveAt: string;
    }
  | {
      rule: "interest";
      /** Rate in basis points from `lastUpdateAt` on; may be negative. */
      currentRate: number;
      /** Average rate in basis points from `initializedAt` to `lastUpdateAt`. */
      preUpdateAverageRate: number;
      initializedAt: string;
      lastUpdateAt: string;
    };

/** One reason a movement path refuses, or holds, a mint. */
export interface TokenMovementRefusalSummary {
  reason: TokenMovementRefusalReason;
  extension: CapabilityExtension;
  disposition: TokenMovementDisposition;
  message: string;
}

/** Whether one movement path can move the mint now, with every reason it cannot. */
export interface TokenMovementPathSupport {
  path: TokenMovementPath;
  supported: boolean;
  /** Empty when `supported`. */
  refusals: TokenMovementRefusalSummary[];
}

/** A mint's Token Terms at one read, as `GET /v1/tokens/{mint}/terms` reports them. */
export interface TokenTermsSummary {
  mint: string;
  program: "spl-token" | "token-2022";
  decimals: number;
  /** The Clock read with the mint. */
  readAt: { slot: string; epoch: string; time: string };
  /** Null when the mint has no transfer-fee config. */
  transferFee: {
    /** The entry in force in `readAt.epoch`. */
    current: TokenTransferFeeEntry;
    /** The entry in force in the next epoch: a fee change shows here first. */
    next: TokenTransferFeeEntry;
  } | null;
  display: TokenDisplayTerms;
  transferHookProgram: string | null;
  paused: boolean;
  nonTransferable: boolean;
  defaultAccountState: "initialized" | "frozen";
  permanentDelegate: string | null;
  confidentialTransfers: boolean;
  /** One entry per movement path this deployment runs. */
  support: TokenMovementPathSupport[];
}

/** A movement priced under one read of a mint's terms, as `POST /v1/tokens/{mint}/quote` reports it. */
export interface TokenAmountQuote {
  mint: string;
  /** The token amount the quote prices, in token units: the input, or a display input converted. */
  amount: string;
  amounts: TokenMovementAmounts;
  /** The epoch whose fee entry priced the fee; null when the mint has no fee config. */
  feeEpoch: string | null;
  /** The chain time of the terms read (ISO 8601). */
  asOf: string;
  /**
   * Submit the token amount before this time (ISO 8601). It is never later
   * than a pending multiplier switch, after which the same display amount is
   * another token amount.
   */
  expiresAt: string;
}
