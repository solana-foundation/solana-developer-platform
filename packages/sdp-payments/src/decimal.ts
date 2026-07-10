import { decimalScale, isDecimalString } from "@sdp/solana/amount";
import {
  addDecimalFixedPoint,
  cmpDecimalFixedPoint,
  decimalFixedPoint,
  decimalFixedPointToString,
  divideDecimalFixedPoint,
} from "@solana/fixed-points";
import { badRequest } from "./errors";

/**
 * Bit width for provider-amount fixed points. u64 (the on-chain bound)
 * overflows for large fiat amounts scaled to 9 decimals (~$18.4B), so
 * these helpers use the next power-of-two width; kit range-checks every
 * value against it and throws on overflow.
 */
const DECIMAL_BITS = 128;
const DIVISION_DECIMALS = 9;

function parseAmount(value: string, decimals: number) {
  const normalized = value.trim();
  if (!isDecimalString(normalized)) {
    throw badRequest("Invalid amount format");
  }
  return decimalFixedPoint("unsigned", DECIMAL_BITS, decimals)(normalized);
}

export function compareDecimalAmounts(left: string, right: string): number {
  const scale = Math.max(decimalScale(left), decimalScale(right));
  return cmpDecimalFixedPoint(parseAmount(left, scale), parseAmount(right, scale));
}

export function sumDecimalAmounts(amounts: string[]): string {
  if (amounts.length === 0) {
    return "0";
  }
  const scale = amounts.reduce((max, amount) => Math.max(max, decimalScale(amount)), 0);
  const total = amounts.map((amount) => parseAmount(amount, scale)).reduce(addDecimalFixedPoint);
  return decimalFixedPointToString(total);
}

/**
 * Divides two decimal amount strings exactly, rounding half away from zero
 * to 9 fractional digits. Intended for derived figures like exchange rates,
 * where float division would leak artifacts.
 */
export function divideDecimalAmounts(numerator: string, denominator: string): string {
  const num = parseAmount(numerator, Math.max(decimalScale(numerator), DIVISION_DECIMALS));
  const den = parseAmount(denominator, decimalScale(denominator));
  if (den.raw === 0n) {
    throw badRequest("Cannot divide by a zero amount");
  }
  const quotient = divideDecimalFixedPoint(num, den, "round");
  if (quotient.decimals > DIVISION_DECIMALS) {
    return decimalFixedPointToString(quotient, { decimals: DIVISION_DECIMALS, rounding: "round" });
  }
  return decimalFixedPointToString(quotient);
}

export function addDecimalAmounts(left: string, right: string): string {
  return sumDecimalAmounts([left, right]);
}

/**
 * Converts a finite JS number to a plain decimal string, expanding the
 * scientific notation String() emits for magnitudes below 1e-6 or at
 * 1e21 and above. Preserves the number's shortest round-trip digits.
 */
export function decimalStringFromNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw badRequest("Amount must be a finite number");
  }
  const text = String(value);
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i);
  if (!match) {
    return text;
  }
  const [, sign, whole, fraction = "", exponentText] = match;
  const digits = `${whole}${fraction}`;
  const pointIndex = whole.length + Number(exponentText);
  if (pointIndex <= 0) {
    return `${sign}0.${"0".repeat(-pointIndex)}${digits}`;
  }
  if (pointIndex >= digits.length) {
    return `${sign}${digits}${"0".repeat(pointIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}

export function getUtcDayWindow(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}
