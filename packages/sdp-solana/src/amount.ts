import {
  cmpDecimalFixedPoint,
  decimalFixedPoint,
  decimalFixedPointToString,
  rawDecimalFixedPoint,
} from "@solana/fixed-points";

export const MAX_SAFE_BASE_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

const isDigit = (char: string) => char >= "0" && char <= "9";

export const isDecimalString = (value: string): boolean => {
  if (!value) {
    return false;
  }

  let hasDigit = false;
  let seenDot = false;

  for (const char of value) {
    if (char === ".") {
      if (seenDot) {
        return false;
      }
      seenDot = true;
      continue;
    }

    if (!isDigit(char)) {
      return false;
    }

    hasDigit = true;
  }

  return hasDigit;
};

const normalizeDecimalParts = (value: string): { whole: string; fraction: string } => {
  const [wholeRaw = "", fractionRaw = ""] = value.split(".");
  const whole = wholeRaw.length ? wholeRaw : "0";
  const fraction = fractionRaw ?? "";
  return { whole, fraction };
};

export const decimalScale = (value: string): number =>
  normalizeDecimalParts(value.trim()).fraction.length;

const TOTAL_BITS = 256;

/**
 * Parses a decimal amount string into a kit unsigned decimal fixed-point at
 * the given scale, enforcing the SDP input grammar and error contract before
 * delegating to kit.
 *
 * The guards run before the kit call in the exact order callers have always
 * seen; the only kit failure they cannot exclude is a raw value above the
 * unsigned 256-bit range, which is rethrown as
 * `AmountError("Amount is out of range")`.
 *
 * @param value - Decimal amount string; surrounding whitespace is ignored.
 * @param decimals - Non-negative integer count of fractional digits.
 * @returns The parsed amount as a frozen kit decimal fixed-point.
 * @throws {AmountError} When the string is not a plain unsigned decimal, the
 * decimals configuration is invalid, the string exceeds the target scale, or
 * the scaled value overflows the 256-bit raw range.
 */
const parseDecimalFixedPoint = (value: string, decimals: number) => {
  const normalized = value.trim();

  if (!isDecimalString(normalized)) {
    throw new AmountError("Invalid decimal amount");
  }

  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AmountError("Invalid decimals configuration");
  }

  if (decimalScale(normalized) > decimals) {
    throw new AmountError("Amount has too many decimal places");
  }

  try {
    return decimalFixedPoint("unsigned", TOTAL_BITS, decimals)(normalized);
  } catch {
    throw new AmountError("Amount is out of range");
  }
};

/**
 * Parses a decimal amount string into base units at the given scale.
 *
 * @param value - Decimal amount string; surrounding whitespace is ignored.
 * @param decimals - Non-negative integer count of fractional digits.
 * @returns The amount in base units as a bigint.
 * @throws {AmountError} When the string is not a plain unsigned decimal, the
 * decimals configuration is invalid, the string exceeds the target scale, or
 * the scaled value overflows the 256-bit raw range.
 */
export const parseDecimalAmount = (value: string, decimals: number): bigint =>
  parseDecimalFixedPoint(value, decimals).raw;

/**
 * Compares two decimal amount strings at their maximum shared scale.
 *
 * @param left - First decimal amount string; surrounding whitespace is ignored.
 * @param right - Second decimal amount string; surrounding whitespace is ignored.
 * @returns -1 when left is less than right, 0 when they are equal, 1 when left
 * is greater.
 * @throws {AmountError} When either string fails the parse guards.
 */
export const compareDecimalAmounts = (left: string, right: string): number => {
  const decimals = Math.max(decimalScale(left), decimalScale(right));
  const leftAmount = parseDecimalFixedPoint(left, decimals);
  const rightAmount = parseDecimalFixedPoint(right, decimals);
  return cmpDecimalFixedPoint(leftAmount, rightAmount);
};

/**
 * Formats base units at the given scale as a canonical decimal string,
 * trimming trailing zeros and dropping the decimal point for whole numbers.
 *
 * The `BigInt(value || "0")` conversion for string inputs is intentionally
 * outside the kit try/catch so that non-numeric strings keep throwing the
 * same native SyntaxError they always have.
 *
 * @param value - Base units as a bigint, or a base-unit string; an empty
 * string formats as "0".
 * @param decimals - Non-negative integer count of fractional digits.
 * @returns The canonical decimal string, prefixed with "-" for negatives.
 * @throws {AmountError} When the decimals configuration is invalid or the
 * value overflows the signed 256-bit raw range.
 */
export const formatDecimalAmount = (value: string | bigint, decimals: number): string => {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AmountError("Invalid decimals configuration");
  }

  const bigintValue = typeof value === "bigint" ? value : BigInt(value || "0");

  try {
    return decimalFixedPointToString(
      rawDecimalFixedPoint("signed", TOTAL_BITS, decimals)(bigintValue)
    );
  } catch {
    throw new AmountError("Amount is out of range");
  }
};

/**
 * Converts a decimal amount string to a JS number, throwing if the value
 * cannot be represented exactly as a float at its own decimal scale.
 */
export const toNumberAmount = (value: string): number => {
  const decimals = decimalScale(value);
  const baseUnits = parseDecimalAmount(value, decimals);
  const amount = Number(formatDecimalAmount(baseUnits, decimals));

  const roundTrip = parseDecimalAmount(amount.toFixed(decimals), decimals);
  if (roundTrip !== baseUnits) {
    throw new AmountError("Amount loses precision when converted to a number");
  }

  return amount;
};

export const toMosaicAmount = (value: string, decimals: number): number => {
  const baseUnits = parseDecimalAmount(value, decimals);

  if (baseUnits > MAX_SAFE_BASE_UNITS) {
    throw new AmountError("Amount is too large for Mosaic minting");
  }

  return toNumberAmount(formatDecimalAmount(baseUnits, decimals));
};
