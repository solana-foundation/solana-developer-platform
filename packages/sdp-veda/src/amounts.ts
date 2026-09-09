import {
  decimalScale,
  formatDecimalAmount,
  isDecimalString,
  parseDecimalAmount,
} from "@sdp/solana/amount";
import { amountOutOfRange, amountTooPrecise, invalidAmount } from "./errors";

/** Every amount Veda serializes into an instruction is an unsigned 64-bit integer. */
const MAX_U64_BASE_UNITS = (1n << 64n) - 1n;

/**
 * Amount conversion at the MINT's precision.
 *
 * A separate module from `./sdk.ts` for one reason: none of this needs
 * `@vedatech/svm-sdk`, so keeping it outside the firewall module makes it
 * unit-testable without loading the SDK or its nested `@solana/kit` 7.
 * `@sdp/solana/amount` is the repo's fixed-point arithmetic and is exact —
 * `bigint` base units throughout, never a float.
 */

export interface AcceptedAmount {
  /** What the instruction will encode. */
  baseUnits: bigint;
  /** The same value as a decimal string, canonical to the mint's scale. */
  canonical: string;
}

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
  const normalized = value.trim();
  // `isDecimalString` is the syntax gate and also the SIGN gate: it accepts
  // digits and at most one dot, so "-1", "1e5" and "Infinity" are all rejected
  // here rather than needing a separate numeric parse.
  if (!isDecimalString(normalized)) throw invalidAmount(field, value);

  // Scale is a property of the VALUE, not its spelling. Zeros after the last
  // non-zero fractional digit need no mint atoms: `1.5000000` is exactly
  // representable by a six-decimal mint even though its text has seven places.
  // Strip only those; a non-zero sub-atom remains and is still refused.
  const canonicalScaleInput = trimInsignificantFractionalZeroes(normalized);
  if (decimalScale(canonicalScaleInput) > decimals) {
    throw amountTooPrecise(field, value, decimals);
  }

  const baseUnits = parseDecimalAmount(canonicalScaleInput, decimals);
  // Scale-valid decimals can still overflow the u64 Veda encodes. Letting those
  // through defers the failure into the SDK's own `assertU64` after several RPC
  // round trips, far from the caller that can fix it.
  if (baseUnits > MAX_U64_BASE_UNITS) throw amountOutOfRange(field, value);

  // Re-serialised through the repo's fixed-point helpers so what leaves this
  // package is scaled exactly like every other amount in SDP ("1.500" -> "1.5").
  return { baseUnits, canonical: formatDecimalAmount(baseUnits, decimals) };
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
  const accepted = acceptAtMintScale(field, value, decimals);
  if (accepted.baseUnits === 0n) throw invalidAmount(field, value);
  return accepted;
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

function trimInsignificantFractionalZeroes(value: string): string {
  const dot = value.indexOf(".");
  if (dot === -1) return value;

  const whole = value.slice(0, dot);
  let fractionEnd = value.length;
  // Scan once from the end instead of applying an end-anchored repetition to
  // caller-controlled input. The latter can retry from every zero when a long
  // run ends in a non-zero digit, turning validation into quadratic work.
  while (fractionEnd > dot + 1 && value[fractionEnd - 1] === "0") {
    fractionEnd -= 1;
  }

  return fractionEnd === dot + 1 ? whole : value.slice(0, fractionEnd);
}
