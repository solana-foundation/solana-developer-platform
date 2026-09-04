import BN from "bn.js";
import { SdpJupiterLendError } from "./errors";

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;
const U64_MAX = (1n << 64n) - 1n;

export function toAtoms(field: string, value: string, decimals = 6): BN {
  const match = DECIMAL.exec(value);
  if (!match) {
    throw new SdpJupiterLendError(
      "INVALID_AMOUNT",
      `Jupiter Lend ${field} must be a positive decimal string; received ${JSON.stringify(value)}`
    );
  }
  const fraction = match[1] ?? "";
  if (fraction.length > decimals) {
    throw new SdpJupiterLendError(
      "INVALID_AMOUNT",
      `Jupiter Lend ${field} has more than ${decimals} decimal places`
    );
  }
  const [whole = "0"] = value.split(".");
  const atoms = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  if (atoms === 0n || atoms > U64_MAX) {
    throw new SdpJupiterLendError(
      "INVALID_AMOUNT",
      `Jupiter Lend ${field} must encode a positive unsigned 64-bit amount`
    );
  }
  return new BN(atoms.toString());
}

export function fromAtoms(value: BN, decimals = 6): string {
  const digits = value.toString(10).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
