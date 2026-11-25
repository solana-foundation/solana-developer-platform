import { acceptTokenAmount, TokenAmountError } from "@sdp/solana/amount";
import BN from "bn.js";
import { SdpJupiterLendError } from "./errors";

export function toAtoms(field: string, value: string, decimals = 6): BN {
  let baseUnits: bigint;
  try {
    ({ baseUnits } = acceptTokenAmount(value, decimals, { positive: true }));
  } catch (error) {
    if (!(error instanceof TokenAmountError)) throw error;
    if (error.reason === "invalid") {
      throw new SdpJupiterLendError(
        "INVALID_AMOUNT",
        `Jupiter Lend ${field} must be a positive decimal string; received ${JSON.stringify(value)}`
      );
    }
    if (error.reason === "too_precise") {
      throw new SdpJupiterLendError(
        "INVALID_AMOUNT",
        `Jupiter Lend ${field} has more than ${decimals} decimal places`
      );
    }
    throw new SdpJupiterLendError(
      "INVALID_AMOUNT",
      `Jupiter Lend ${field} must encode a positive unsigned 64-bit amount`
    );
  }
  return new BN(baseUnits.toString());
}

export function fromAtoms(value: BN, decimals = 6): string {
  const digits = value.toString(10).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const rawFraction = digits.slice(-decimals);
  let fractionEnd = rawFraction.length;
  while (fractionEnd > 0 && rawFraction.charCodeAt(fractionEnd - 1) === 48) {
    fractionEnd -= 1;
  }
  const fraction = rawFraction.slice(0, fractionEnd);
  return fraction ? `${whole}.${fraction}` : whole;
}
