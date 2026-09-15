import { formatDecimalAmount } from "@sdp/solana/amount";
import type { Address, Slot } from "@solana/kit";

/**
 * Quote arithmetic and blocking-issue rules for K-Vault deposit and exit
 * previews.
 *
 * Deliberately OUTSIDE the klend-sdk firewall (`./sdk.ts`). `sdk.ts` performs
 * the SDK calls and converts every `Decimal` it observes into integer base
 * units; this module turns those integers into the decimal strings and issues
 * the Earn contract carries. Keeping the rules here makes them unit-testable
 * without loading the SDK, which is where a wrong number would otherwise hide.
 */

export interface KaminoQuoteIssue {
  code: string;
  message: string;
}

export interface KaminoDepositQuoteInput {
  /** The K-Vault's own account address, its `providerReference` in the catalogue. */
  vault: Address;
  /** Deposit amount in the vault token's own units, as a decimal string. */
  amount: string;
  /** Slot the estimate is priced against; the caller reads it once. */
  slot: Slot;
}

export interface KaminoDepositQuote {
  /** Estimated shares minted, canonical to the share mint's decimals. */
  sharesOut: string;
  shareDecimals: number;
  issues: KaminoQuoteIssue[];
}

export interface KaminoWithdrawQuoteInput {
  vault: Address;
  /** Shares to redeem, as a decimal string. */
  shares: string;
  /** Slot the exit is priced against; the caller reads it once. */
  slot: Slot;
}

export interface KaminoWithdrawQuote {
  /** Estimated tokens returned after penalties, canonical to the token mint's decimals. */
  assetsOut: string;
  assetDecimals: number;
  issues: KaminoQuoteIssue[];
}

/** What `sdk.ts` observed from the SDK's deposit estimate, all in integer base units. */
export interface KaminoDepositEstimate {
  /** Share base units the SDK estimates for the deposit. */
  sharesOutBaseUnits: bigint;
  shareDecimals: number;
  /** Token base units the SDK prices once crank funds are deducted. May be <= 0. */
  tokensForSharesBaseUnits: bigint;
  /** Vault deposit cap in token base units; 0 means uncapped. */
  depositCapBaseUnits: bigint;
  /**
   * Net vault AUM in token base units, rounded up, as the SDK prices the
   * deposit. Ignored when no shares are issued yet.
   */
  netAumBaseUnits: bigint;
  sharesIssuedBaseUnits: bigint;
}

/**
 * Whether the SDK clamped the priced amount to the vault's remaining deposit
 * cap. klend-sdk mirrors the program (`get_max_depositable_in_vault`): the
 * deposit is silently reduced to `depositCap - netAum`, so a preview that
 * repeated the estimate without saying so would quote shares for less money
 * than the caller is about to send.
 *
 * The verdict is cross-checked against the SDK's own output: the clamp is
 * reported only when the estimate equals the clamped prediction AND differs
 * from the uncapped one. `netAumBaseUnits` is this package's replica of the
 * SDK's pricing (it vests pending rewards against wall-clock time), so a
 * replica that drifts by a lamport can withhold the issue, never invent it.
 * A deposit that fills the remaining cap exactly is not a clamp: both
 * predictions agree and nothing is reported.
 */
export function detectDepositCapClamp(estimate: KaminoDepositEstimate): boolean {
  const { depositCapBaseUnits: cap, tokensForSharesBaseUnits: tokens } = estimate;
  if (cap <= 0n || tokens <= 0n) return false;
  if (estimate.sharesIssuedBaseUnits === 0n) {
    // First deposit: shares mint 1:1 with token base units, clamped to the whole cap.
    return tokens > cap && estimate.sharesOutBaseUnits === cap;
  }
  if (estimate.netAumBaseUnits <= 0n) return false;
  const remaining = cap > estimate.netAumBaseUnits ? cap - estimate.netAumBaseUnits : 0n;
  if (tokens <= remaining) return false;
  const uncapped = (estimate.sharesIssuedBaseUnits * tokens) / estimate.netAumBaseUnits;
  const clamped = (estimate.sharesIssuedBaseUnits * remaining) / estimate.netAumBaseUnits;
  return estimate.sharesOutBaseUnits === clamped && clamped !== uncapped;
}

export function deriveKaminoDepositQuote(estimate: KaminoDepositEstimate): KaminoDepositQuote {
  const issues: KaminoQuoteIssue[] = [];
  if (detectDepositCapClamp(estimate)) {
    issues.push({
      code: "DEPOSIT_CAP_EXCEEDED",
      message:
        "This deposit exceeds the vault's remaining deposit cap. Kamino's program clamps a " +
        "deposit to the remaining capacity, so less than the requested amount would be accepted.",
    });
  }
  if (estimate.sharesOutBaseUnits <= 0n) {
    issues.push({
      code: "ZERO_SHARES_OUT",
      message: "Kamino would mint no shares for this amount at the vault's current state.",
    });
  }
  return {
    sharesOut: formatDecimalAmount(estimate.sharesOutBaseUnits, estimate.shareDecimals),
    shareDecimals: estimate.shareDecimals,
    issues,
  };
}

/** What `sdk.ts` observed from the SDK's exit plan, all in integer token base units. */
export interface KaminoExitPlanObservation {
  /** Net tokens after the SDK's aggregate penalty (`netTokenLamportsToWithdraw`). */
  netBaseUnits: bigint;
  /** Effective flat penalty per withdraw instruction, `max(vault, global config)`. */
  flatPenaltyBaseUnits: bigint;
  /** Reserves the exit draws on (`reserveTokenLamportsToWithdraw.size`), one withdraw instruction each. */
  reserveCount: number;
  /** Net tokens the vault and its reserves cannot cover right now (`remainingNetTokenLamportsToWithdraw`). */
  remainingBaseUnits: bigint;
  /** The vault's `minWithdrawAmount`; the program refuses a net amount at or below it. */
  minimumWithdrawalBaseUnits: bigint;
  assetDecimals: number;
}

/**
 * Withdraw instructions the SDK's exit builder emits for a plan: one per
 * reserve it draws on, or a single `withdraw_from_available` when the vault's
 * idle liquidity covers everything.
 */
export function exitInstructionCount(reserveCount: number): number {
  return Math.max(1, reserveCount);
}

/**
 * The plan's net amount, lowered to what a split exit can be relied on to
 * return.
 *
 * klend-sdk computes the penalty ONCE on the aggregate gross amount, while the
 * program charges `max(ceil(bps x gross_i), flat)` on EACH withdraw
 * instruction (`ShareExitLiquidityPlan` doc). For N instructions the actual
 * penalty exceeds the aggregate by at most (N - 1) x flat, plus one base unit
 * per extra instruction for the per-instruction rounding of the bps share.
 * Subtracting that bound keeps the quote at or below what the exit pays out,
 * so a floor derived from it is never higher than what lands.
 */
export function conservativeExitNetBaseUnits(
  observation: Pick<
    KaminoExitPlanObservation,
    "netBaseUnits" | "flatPenaltyBaseUnits" | "reserveCount"
  >
): bigint {
  const extraInstructions = BigInt(exitInstructionCount(observation.reserveCount) - 1);
  const overstatement = extraInstructions * (observation.flatPenaltyBaseUnits + 1n);
  return observation.netBaseUnits > overstatement ? observation.netBaseUnits - overstatement : 0n;
}

export function deriveKaminoWithdrawQuote(
  observation: KaminoExitPlanObservation
): KaminoWithdrawQuote {
  const { assetDecimals } = observation;
  const format = (baseUnits: bigint) => formatDecimalAmount(baseUnits, assetDecimals);
  const issues: KaminoQuoteIssue[] = [];
  const net = conservativeExitNetBaseUnits(observation);

  if (observation.remainingBaseUnits > 0n) {
    const fillable = observation.netBaseUnits - observation.remainingBaseUnits;
    issues.push({
      code: "INSUFFICIENT_WITHDRAWAL_LIQUIDITY",
      message:
        "Kamino cannot fill this exit from the vault's currently available liquidity: the vault " +
        `and its reserves can cover ${format(fillable < 0n ? 0n : fillable)} of the ` +
        `${format(observation.netBaseUnits)} this exit needs right now.`,
    });
  }
  if (net <= 0n) {
    issues.push({
      code: "ZERO_ASSETS_OUT",
      message:
        "Kamino's withdrawal penalties consume this exit at the current share price; no tokens " +
        "would be returned.",
    });
  } else if (observation.netBaseUnits <= observation.minimumWithdrawalBaseUnits) {
    // Checked on the SDK's aggregate net rather than the conservative one: a
    // split exit's per-instruction nets are each below the aggregate, so this
    // is a refusal the program will definitely make, never a guess.
    issues.push({
      code: "BELOW_MINIMUM_WITHDRAWAL",
      message:
        "Kamino refuses an exit whose net amount is at or below the vault's minimum withdrawal " +
        `of ${format(observation.minimumWithdrawalBaseUnits)}.`,
    });
  }

  return { assetsOut: format(net), assetDecimals, issues };
}
