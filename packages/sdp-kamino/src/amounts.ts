import {
  decimalScale,
  formatDecimalAmount,
  isDecimalString,
  parseDecimalAmount,
} from "@sdp/solana/amount";
import { amountOutOfRange, amountTooPrecise, invalidAmount } from "./errors";

/** Every amount Kamino serializes into an instruction is an unsigned 64-bit integer. */
const MAX_U64_BASE_UNITS = (1n << 64n) - 1n;

/**
 * Amount validation at the MINT's precision.
 *
 * A separate module from `./sdk.ts` for one reason: none of this needs
 * klend-sdk or `decimal.js`, so keeping it out of the firewall module makes it
 * unit-testable without loading a 13MB chain SDK. `@sdp/solana/amount` is the
 * repo's fixed-point arithmetic and is exact — `bigint` base units throughout,
 * never a float.
 */

/**
 * Read a mint's decimals off vault state.
 *
 * The field arrives as a klend-sdk `BN`, a `Decimal`, or a number depending on
 * the codec, so it is normalised through `String` before `Number`: `Number(BN)`
 * is `NaN`, and a NaN scale would silently DISABLE the check below rather than
 * fail it — the check would compare against NaN and always pass. Failing loudly
 * on an unreadable value is the only safe direction for something whose whole
 * job is to bound a money amount.
 */
export function mintDecimals(value: unknown, label: string): number {
  const raw = String(value ?? "").trim();
  // Matched as DIGITS rather than parsed with `Number`, because `Number("")` is
  // 0 — so a missing field would otherwise arrive as a perfectly plausible
  // "zero-decimal mint" and disable every scale check downstream.
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed > 18) {
    throw new Error(`Kamino vault state carried an unusable ${label} (${String(value)})`);
  }
  return parsed;
}

/**
 * Refuse an amount finer than its mint can represent, and return the canonical
 * form of what will actually be encoded.
 *
 * klend-sdk converts every `Decimal` to mint atoms and FLOORS, silently. Two
 * distinct bugs hide under that floor, neither visible at the call site:
 *
 * - A deposit of `1.0000009` against a six-decimal mint is RECORDED as
 *   1.0000009 while only 1.000000 moves. The ledger and the chain disagree, and
 *   the ledger is the thing a customer is later shown.
 * - A `minSharesOut` below one atom floors to `0`. That is a slippage floor
 *   which reads as protection in the request, in the ledger and in the UI, and
 *   imposes none on chain — strictly worse than sending no floor at all,
 *   because it also suppresses anyone's suspicion that protection is missing.
 *
 * Validating the SCALE rather than clamping the value is deliberate: clamping
 * would make SDP quietly move a different amount than it was asked for, which
 * is the same class of bug wearing a friendlier costume. The caller gets a
 * refusal it can surface, and the number it asked for is the number that moves.
 */
export function acceptAtMintScale(field: string, value: string, decimals: number): string {
  const normalized = value.trim();
  // `isDecimalString` is the syntax gate and also the SIGN gate: it accepts
  // digits and at most one dot, so "-1", "1e5" and "Infinity" are all rejected
  // here rather than needing a separate numeric parse.
  if (!isDecimalString(normalized)) throw invalidAmount(field, value);
  // Scale is a property of the VALUE, not its spelling. Zeros after the last
  // non-zero fractional digit do not require mint atoms: `1.5000000` is exactly
  // representable by a six-decimal mint even though its input text has seven
  // places. Strip only those insignificant zeros; a non-zero sub-atom remains
  // and is still rejected below (`1.0000001` stays seven-place precision).
  const canonicalScaleInput = trimInsignificantFractionalZeroes(normalized);
  if (decimalScale(canonicalScaleInput) > decimals) {
    throw amountTooPrecise(field, value, decimals);
  }
  // Parse once and retain the exact atom count. Scale-valid decimals can still
  // overflow the u64 encoded by Kamino instructions; letting those through
  // defers the failure until Borsh emits an opaque byte-length error after RPC
  // work. This shared gate covers deposit amount, minSharesOut and withdrawal
  // shares before any of them reaches the SDK.
  const baseUnits = parseDecimalAmount(canonicalScaleInput, decimals);
  if (baseUnits > MAX_U64_BASE_UNITS) throw amountOutOfRange(field, value);

  // Re-serialised through the repo's fixed-point helpers so what leaves this
  // package is scaled exactly like every other amount in SDP ("1.500" -> "1.5").
  return formatDecimalAmount(baseUnits, decimals);
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

/**
 * True when a canonical amount is exactly zero.
 *
 * Only sound on the OUTPUT of `acceptAtMintScale`: that function collapses every
 * spelling of nothing ("0", "0.00", "0.000000") to the single string "0", so a
 * string compare is exact here and would not be on a raw caller value.
 */
export function isZeroAmount(canonical: string): boolean {
  return canonical === "0";
}
