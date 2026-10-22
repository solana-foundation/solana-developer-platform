import { AmountError } from "@sdp/solana/amount";
import { parseTokenAmount, type TokenAmount, toBaseUnits } from "@sdp/solana/token-amount";
import { SdpWisdomTreeError } from "./errors";

/**
 * Amount validation at the MINT's own scale — the `@sdp/kamino amounts.ts`
 * rule restated for this package: refuse sub-atomic precision rather than
 * floor it silently, and return the canonical form the instructions actually
 * encode, because a movement row is a claim about what moved on chain. The
 * conversion itself is `@sdp/solana/token-amount`'s, at the mint's decimals.
 */

function isPlainPositiveDecimal(value: string): boolean {
  if (value.length === 0) return false;
  let decimalPoint = -1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 48 && code <= 57) continue;
    if (value[index] !== "." || decimalPoint !== -1 || index === 0 || index === value.length - 1) {
      return false;
    }
    decimalPoint = index;
  }
  return true;
}

export interface AcceptedAmount {
  /** Canonical decimal string (no trailing fractional zeroes, no leading zeroes). */
  canonical: string;
  /** The exact integer the instruction encodes. */
  baseUnits: bigint;
}

/**
 * Parse `amount` against a mint of `decimals`, refusing anything the mint
 * cannot represent exactly or the u64 instruction field cannot hold. Zero is
 * refused too: a zero-quantity transfer is never a subscription or redemption,
 * only a caller bug.
 */
export function acceptAtMintScale(amount: string, decimals: number, what: string): AcceptedAmount {
  const trimmed = amount.trim();
  if (!isPlainPositiveDecimal(trimmed)) {
    throw new SdpWisdomTreeError(
      "INVALID_AMOUNT",
      `${what} must be a plain positive decimal string; received "${amount}".`
    );
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const keptFraction = fraction.slice(0, decimals);
  const discarded = fraction.slice(decimals);
  if ([...discarded].some((digit) => digit !== "0")) {
    throw new SdpWisdomTreeError(
      "INVALID_AMOUNT",
      `${what} of ${amount} is finer than the mint's ${decimals} decimals; ` +
        "refusing rather than silently moving a different amount."
    );
  }

  // Zeros past the mint's scale carry no value; the rest is exact at its decimals.
  let accepted: TokenAmount;
  try {
    accepted = parseTokenAmount(keptFraction ? `${whole}.${keptFraction}` : whole, decimals);
  } catch (error) {
    if (!(error instanceof AmountError)) throw error;
    // The syntax and scale checks above passed, so the parse refuses only a value above u64.
    throw new SdpWisdomTreeError(
      "INVALID_AMOUNT",
      `${what} of ${amount} is above the largest amount a token account holds.`
    );
  }
  const baseUnits = toBaseUnits(accepted);
  if (baseUnits === 0n) {
    throw new SdpWisdomTreeError("INVALID_AMOUNT", `${what} must be greater than zero.`);
  }
  return { canonical: accepted.value, baseUnits };
}
