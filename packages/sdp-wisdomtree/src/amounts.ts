import {
  type AcceptedTokenAmount,
  acceptTokenAmount,
  TokenAmountError,
  type TokenAmountRefusal,
} from "@sdp/solana/amount";
import { SdpWisdomTreeError } from "./errors";

/**
 * Amount validation at the MINT's own scale — the `@sdp/kamino amounts.ts`
 * rule restated for this package: refuse sub-atomic precision rather than
 * floor it silently, and return the canonical form the instructions actually
 * encode, because a movement row is a claim about what moved on chain.
 */

/** The canonical decimal string (no trailing fractional or leading zeroes) and its exact base units. */
export type AcceptedAmount = AcceptedTokenAmount;

/**
 * Parse `amount` against a mint of `decimals`, refusing anything the mint
 * cannot represent exactly. Zero is refused too: a zero-quantity transfer is
 * never a subscription or redemption, only a caller bug.
 */
export function acceptAtMintScale(amount: string, decimals: number, what: string): AcceptedAmount {
  try {
    return acceptTokenAmount(amount, decimals, { positive: true });
  } catch (error) {
    if (!(error instanceof TokenAmountError)) throw error;
    throw new SdpWisdomTreeError("INVALID_AMOUNT", refusal(error.reason, amount, decimals, what));
  }
}

function refusal(reason: TokenAmountRefusal, amount: string, decimals: number, what: string) {
  switch (reason) {
    case "invalid":
      return `${what} must be a plain positive decimal string; received "${amount}".`;
    case "too_precise":
      return (
        `${what} of ${amount} is finer than the mint's ${decimals} decimals; ` +
        "refusing rather than silently moving a different amount."
      );
    case "not_positive":
      return `${what} must be greater than zero.`;
    case "out_of_range":
      return `${what} of ${amount} does not fit an SPL token amount.`;
  }
}

/** Exact base-units → canonical decimal string. Serializes zero as "0". */
export function formatBaseUnits(baseUnits: bigint, decimals: number): string {
  const digits = baseUnits.toString().padStart(decimals + 1, "0");
  const cut = digits.length - decimals;
  const whole = digits.slice(0, cut);
  let fraction = digits.slice(cut);
  while (fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return fraction === "" ? whole : `${whole}.${fraction}`;
}
