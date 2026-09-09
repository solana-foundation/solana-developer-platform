/**
 * Turning what someone types into the base units the chain takes.
 *
 * The API takes u64 base units as strings, which is correct for a machine and
 * hostile to a person: "10 USDC" is 10000000, and asking for the second is how
 * you get a trade off by three orders of magnitude. So the form takes the human
 * amount wherever the mint's decimals are known, and converts here.
 *
 * Thin adapters over `@sdp/solana/amount`: the conversion, malformed check and
 * precision check are all delegated, so this file stays about the contract the
 * form holds (the `AmountResult` tagged union), not about string decimal
 * arithmetic.
 */

import {
  decimalScale,
  formatDecimalAmount,
  isDecimalString,
  parseDecimalAmount,
} from "@sdp/solana/amount";

export type AmountResult =
  | { ok: true; baseUnits: string }
  | { ok: false; reason: "malformed" | "too-precise" };

/**
 * Converts a decimal amount to base units.
 *
 * @param input - What the user typed, e.g. "10.5".
 * @param decimals - The mint's decimals.
 * @returns The base-unit string, or why it could not be converted.
 */
export function toBaseUnits(input: string, decimals: number): AmountResult {
  const trimmed = input.trim();
  if (!isDecimalString(trimmed)) {
    return { ok: false, reason: "malformed" };
  }

  if (decimalScale(trimmed) > decimals) {
    // Silently truncating would move a different amount than the one on screen.
    return { ok: false, reason: "too-precise" };
  }

  return { ok: true, baseUnits: parseDecimalAmount(trimmed, decimals).toString() };
}

/**
 * Renders base units back as a decimal amount, for showing a stored value.
 *
 * @param baseUnits - A u64 as a decimal string.
 * @param decimals - The mint's decimals.
 */
export function fromBaseUnits(baseUnits: string, decimals: number): string {
  return formatDecimalAmount(baseUnits, decimals);
}
