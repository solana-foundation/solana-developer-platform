import {
  cmpDecimalFixedPoint,
  decimalFixedPoint,
  decimalFixedPointToString,
  rawDecimalFixedPoint,
} from "@solana/fixed-points";

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
 * Generic fixed-point math on decimal strings: rates, prices, percentages,
 * shares and sums at a chosen scale. A token's base units ↔ token units
 * conversion does not belong here: it goes through `@sdp/solana/token-amount`
 * (`parseTokenAmount`, `toBaseUnits`, `toTokenAmount`) with the mint's decimals.
 */

/**
 * Parses a decimal string into a kit unsigned decimal fixed-point at the
 * given scale, enforcing the SDP input grammar and error contract before
 * delegating to kit.
 *
 * The guards run before the kit call in the exact order callers have always
 * seen; the only kit failure they cannot exclude is a raw value above the
 * unsigned 256-bit range, which is rethrown as
 * `AmountError("Amount is out of range")`.
 *
 * @param value - Decimal string; surrounding whitespace is ignored.
 * @param scale - Non-negative integer count of fractional digits.
 * @returns The parsed value as a frozen kit decimal fixed-point.
 * @throws {AmountError} When the string is not a plain unsigned decimal, the
 * scale is invalid, the string has more fraction digits than the scale, or the
 * scaled value overflows the 256-bit raw range.
 */
const parseDecimalFixedPoint = (value: string, scale: number, totalBits: number) => {
  const normalized = value.trim();

  if (!isDecimalString(normalized)) {
    throw new AmountError("Invalid decimal amount");
  }

  if (!Number.isInteger(scale) || scale < 0) {
    throw new AmountError("Invalid decimals configuration");
  }

  if (decimalScale(normalized) > scale) {
    throw new AmountError("Amount has too many decimal places");
  }

  try {
    return decimalFixedPoint("unsigned", totalBits, scale)(normalized, "strict");
  } catch {
    throw new AmountError("Amount is out of range");
  }
};

/**
 * Parses a decimal string into an integer count of units at the given scale:
 * `parseFixedDecimal("1.25", 4)` is `12500n`. Generic math only; a token
 * amount goes through `parseTokenAmount` in `@sdp/solana/token-amount`.
 *
 * @param value - Decimal string; surrounding whitespace is ignored.
 * @param scale - Non-negative integer count of fractional digits.
 * @returns The value × 10^scale as a bigint.
 * @throws {AmountError} When the string is not a plain unsigned decimal, the
 * scale is invalid, the string has more fraction digits than the scale, or the
 * scaled value overflows the 256-bit raw range.
 */
export const parseFixedDecimal = (value: string, scale: number): bigint =>
  parseDecimalFixedPoint(value, scale, TOTAL_BITS).raw;

/**
 * Parses an exact token or lamport amount, rejecting precision loss and u64
 * overflow. `@sdp/solana/token-amount` builds its `parseTokenAmount` on it;
 * code converting a mint's amount uses that one.
 */
export const parseTokenAmount = (value: string, decimals: number): bigint =>
  parseDecimalFixedPoint(value, decimals, 64).raw;

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
  const scale = Math.max(decimalScale(left), decimalScale(right));
  const leftAmount = parseDecimalFixedPoint(left, scale, TOTAL_BITS);
  const rightAmount = parseDecimalFixedPoint(right, scale, TOTAL_BITS);
  return cmpDecimalFixedPoint(leftAmount, rightAmount);
};

/**
 * Adds two decimal amount strings exactly, at their maximum shared scale.
 *
 * @param left - First decimal amount string; surrounding whitespace is ignored.
 * @param right - Second decimal amount string; surrounding whitespace is ignored.
 * @returns The canonical decimal sum (trailing zeros trimmed).
 * @throws {AmountError} When either string fails the parse guards.
 */
export const addDecimalAmounts = (left: string, right: string): string => {
  const scale = Math.max(decimalScale(left), decimalScale(right));
  const sum = parseFixedDecimal(left, scale) + parseFixedDecimal(right, scale);
  return formatFixedDecimal(sum, scale);
};

/**
 * Scales a decimal amount string by a basis-point share, rounding DOWN to the
 * amount's own scale. `scaleDecimalAmountByBps("50000000", 1000)` is
 * `"5000000"` (10%). Truncation is deliberate: the one caller is a ceiling
 * derived from a share of a total, and rounding a ceiling up would admit more
 * than the share allows.
 *
 * @param value - Decimal amount string; surrounding whitespace is ignored.
 * @param bps - Non-negative integer basis points (10000 = 100%).
 * @returns The canonical scaled decimal string (trailing zeros trimmed).
 * @throws {AmountError} When the string fails the parse guards or `bps` is not
 * a non-negative integer.
 */
export const scaleDecimalAmountByBps = (value: string, bps: number): string => {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new AmountError("Invalid basis points");
  }
  const scale = decimalScale(value);
  const scaled = (parseFixedDecimal(value, scale) * BigInt(bps)) / 10_000n;
  return formatFixedDecimal(scaled, scale);
};

/**
 * Formats an integer count of units at the given scale as a canonical decimal
 * string, trimming trailing zeros and dropping the point for whole numbers:
 * `formatFixedDecimal(12500n, 4)` is `"1.25"`. Signed: a negative count keeps
 * its "-". Generic math only; base units of a mint become a token amount
 * through `toTokenAmount` in `@sdp/solana/token-amount`.
 *
 * @param units - The value × 10^scale.
 * @param scale - Non-negative integer count of fractional digits.
 * @returns The canonical decimal string, prefixed with "-" for negatives.
 * @throws {AmountError} When the scale is invalid or the value overflows the
 * signed 256-bit raw range.
 */
export const formatFixedDecimal = (units: bigint, scale: number): string => {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new AmountError("Invalid decimals configuration");
  }

  try {
    return decimalFixedPointToString(rawDecimalFixedPoint("signed", TOTAL_BITS, scale)(units));
  } catch {
    throw new AmountError("Amount is out of range");
  }
};
