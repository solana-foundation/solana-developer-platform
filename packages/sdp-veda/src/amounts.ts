import { type AcceptedTokenAmount, acceptTokenAmount, TokenAmountError } from "@sdp/solana/amount";
import { amountOutOfRange, amountTooPrecise, invalidAmount } from "./errors";

/**
 * Amount conversion at the MINT's precision.
 *
 * A separate module from `./sdk.ts` for one reason: none of this needs
 * `@vedatech/svm-sdk`, so keeping it outside the firewall module makes it
 * unit-testable without loading the SDK or its nested `@solana/kit` 7.
 * `@sdp/solana/amount` is the repo's fixed-point arithmetic and is exact —
 * `bigint` base units throughout, never a float.
 */

/** What the instruction will encode, and its canonical decimal string at the mint's scale. */
export type AcceptedAmount = AcceptedTokenAmount;

/**
 * Convert a decimal string to mint atoms, refusing anything that would not
 * survive the trip.
 *
 * Veda's SDK takes atomic `bigint`s, so SDP owns this conversion and the only
 * two options are REFUSE or ROUND. Rounding is the dangerous one, and two
 * distinct bugs hide under it:
 *
 * - A deposit of `1.0000009` against a six-decimal mint would be RECORDED as
 *   1.0000009 while 1.000000 moved. The ledger and the chain disagree, and the
 *   ledger is what a customer is later shown.
 * - A `minSharesOut` below one atom would become `0` — a slippage floor that
 *   reads as protection in the request, the ledger and the UI, and imposes none
 *   on chain. Strictly worse than sending no floor, because it also suppresses
 *   anyone's suspicion that protection is missing.
 *
 * Validating the SCALE rather than clamping the value is deliberate: clamping
 * would make SDP quietly move a different amount than it was asked for, which
 * is the same class of bug wearing a friendlier costume.
 */
export function acceptAtMintScale(field: string, value: string, decimals: number): AcceptedAmount {
  return acceptVedaAmount(field, value, decimals, false);
}

/**
 * `acceptAtMintScale`, additionally refusing zero.
 *
 * Both amounts SDP sends Veda are positive by contract: a zero deposit moves
 * nothing, and a zero share floor is the absent-protection case above. The
 * scale check already refuses sub-atom values, so reaching zero here means the
 * caller literally passed a zero.
 */
export function acceptPositiveAtMintScale(
  field: string,
  value: string,
  decimals: number
): AcceptedAmount {
  return acceptVedaAmount(field, value, decimals, true);
}

function acceptVedaAmount(
  field: string,
  value: string,
  decimals: number,
  positive: boolean
): AcceptedAmount {
  try {
    return acceptTokenAmount(value, decimals, { positive });
  } catch (error) {
    if (!(error instanceof TokenAmountError)) throw error;
    if (error.reason === "too_precise") throw amountTooPrecise(field, value, decimals);
    if (error.reason === "out_of_range") throw amountOutOfRange(field, value);
    throw invalidAmount(field, value);
  }
}

/**
 * A mint's decimal count, validated.
 *
 * Read from chain or from the SDK, so it arrives as `unknown`. Matched as
 * DIGITS rather than parsed with `Number`, because `Number("")` is 0 — a
 * missing field would otherwise arrive as a perfectly plausible "zero-decimal
 * mint" and disable every scale check downstream. Solana mints cap at 9
 * decimals; anything larger means the read is wrong, not that Veda invented a
 * new scale.
 */
export function mintDecimals(value: unknown, label: string): number {
  const raw = String(value ?? "").trim();
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed > 9) {
    throw new Error(`Veda ${label} was not a usable mint decimal count (${String(value)})`);
  }
  return parsed;
}
