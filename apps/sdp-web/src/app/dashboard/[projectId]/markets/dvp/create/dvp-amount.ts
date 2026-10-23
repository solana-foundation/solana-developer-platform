/**
 * Turning what someone types into the base units the chain takes.
 *
 * The API takes u64 base units as strings, which is correct for a machine and
 * hostile to a person: "10 USDC" is 10000000, and asking for the second is how
 * you get a trade off by three orders of magnitude. So the form takes the human
 * amount wherever the mint's decimals are known, and converts here.
 *
 * The conversion is `@sdp/solana/token-amount`'s, at the decimals the API
 * already returns (the token list, or the pasted mint's inspection), so this
 * file stays about the contract the form holds (the `AmountResult` tagged
 * union), not about string decimal arithmetic.
 *
 * TODO(ADR 0012): this conversion belongs on the server, at the mint's live
 * decimals (Token Terms), as every other movement path does. Moving it needs a
 * DvP contract change: `POST /v1/dvp/trades` takes `amountA`/`amountB` in
 * token units and the API converts them at each mint's terms, instead of the
 * u64 base-unit strings it takes now.
 */

import { AmountError, decimalScale, isDecimalString } from "@sdp/solana/amount";
import { parseTokenAmount, type TokenAmount, toBaseUnits } from "@sdp/solana/token-amount";

export type AmountResult =
  | { ok: true; baseUnits: string }
  | { ok: false; reason: "malformed" | "too-precise" | "out-of-range" };

/**
 * Converts a token amount to base units at the mint's decimals.
 *
 * @param input - What the user typed, e.g. "10.5".
 * @param decimals - The mint's decimals.
 * @returns The base-unit string, or why it could not be converted.
 */
export function amountToBaseUnits(input: string, decimals: number): AmountResult {
  const trimmed = input.trim();
  if (!isDecimalString(trimmed)) {
    return { ok: false, reason: "malformed" };
  }

  if (decimalScale(trimmed) > decimals) {
    // Silently truncating would move a different amount than the one on screen.
    return { ok: false, reason: "too-precise" };
  }

  let amount: TokenAmount;
  try {
    amount = parseTokenAmount(trimmed, decimals);
  } catch (error) {
    // The checks above passed, so the parse refuses only an amount above u64.
    if (error instanceof AmountError) return { ok: false, reason: "out-of-range" };
    throw error;
  }
  return { ok: true, baseUnits: toBaseUnits(amount).toString() };
}
