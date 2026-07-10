import { isDecimalString } from "@sdp/solana/amount";
import { badRequest } from "./errors";

// Linear-time trailing-zero strip; /0+$/ backtracks polynomially (js/polynomial-redos).
function trimTrailingZeros(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "0") {
    end -= 1;
  }
  return value.slice(0, end);
}

function parseDecimalParts(value: string): { whole: string; fraction: string } {
  const normalized = value.trim();
  if (!isDecimalString(normalized)) {
    throw badRequest("Invalid amount format");
  }

  const [wholeRaw = "", fractionRaw = ""] = normalized.split(".");
  const whole = (wholeRaw || "0").replace(/^0+(?=\d)/, "");
  const fraction = trimTrailingZeros(fractionRaw ?? "");

  return {
    whole: whole.length > 0 ? whole : "0",
    fraction,
  };
}

export function compareDecimalAmounts(left: string, right: string): number {
  const leftParts = parseDecimalParts(left);
  const rightParts = parseDecimalParts(right);

  if (leftParts.whole.length !== rightParts.whole.length) {
    return leftParts.whole.length < rightParts.whole.length ? -1 : 1;
  }

  if (leftParts.whole !== rightParts.whole) {
    return leftParts.whole < rightParts.whole ? -1 : 1;
  }

  const scale = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(scale, "0");
  const rightFraction = rightParts.fraction.padEnd(scale, "0");

  if (leftFraction === rightFraction) {
    return 0;
  }

  return leftFraction < rightFraction ? -1 : 1;
}

function formatScaledUnits(units: bigint, scale: number): string {
  if (scale === 0) {
    return units.toString();
  }

  const digits = units.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale).replace(/^0+(?=\d)/, "") || "0";
  const fraction = trimTrailingZeros(digits.slice(-scale));

  return fraction ? `${whole}.${fraction}` : whole;
}

export function sumDecimalAmounts(amounts: string[]): string {
  if (amounts.length === 0) {
    return "0";
  }

  const parsed = amounts.map(parseDecimalParts);
  const scale = parsed.reduce((max, entry) => Math.max(max, entry.fraction.length), 0);

  const total = parsed.reduce((acc, entry) => {
    const combined = `${entry.whole}${entry.fraction.padEnd(scale, "0")}`;
    return acc + BigInt(combined);
  }, 0n);

  return formatScaledUnits(total, scale);
}

const DIVISION_DECIMALS = 9;

/**
 * Divides two decimal amount strings via scaled BigInt math, rounding half
 * away from zero to 9 fractional digits. Intended for derived figures like
 * exchange rates, where float division would leak artifacts.
 */
export function divideDecimalAmounts(numerator: string, denominator: string): string {
  const num = parseDecimalParts(numerator);
  const den = parseDecimalParts(denominator);

  const denominatorUnits = BigInt(`${den.whole}${den.fraction}`);
  if (denominatorUnits === 0n) {
    throw badRequest("Cannot divide by a zero amount");
  }

  const numeratorUnits = BigInt(`${num.whole}${num.fraction}`);
  const exponent = DIVISION_DECIMALS + den.fraction.length - num.fraction.length;
  const scaledNumerator = exponent >= 0 ? numeratorUnits * 10n ** BigInt(exponent) : numeratorUnits;
  const scaledDenominator =
    exponent >= 0 ? denominatorUnits : denominatorUnits * 10n ** BigInt(-exponent);

  const quotient = (scaledNumerator * 2n + scaledDenominator) / (scaledDenominator * 2n);
  return formatScaledUnits(quotient, DIVISION_DECIMALS);
}

export function addDecimalAmounts(left: string, right: string): string {
  return sumDecimalAmounts([left, right]);
}

export function getUtcDayWindow(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}
