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
const parseDecimalFixedPoint = (value: string, decimals: number, totalBits: number) => {
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
    return decimalFixedPoint("unsigned", totalBits, decimals)(normalized, "strict");
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
  parseDecimalFixedPoint(value, decimals, TOTAL_BITS).raw;

/** Parses an exact token or lamport amount, rejecting precision loss and u64 overflow. */
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
  const decimals = Math.max(decimalScale(left), decimalScale(right));
  const leftAmount = parseDecimalFixedPoint(left, decimals, TOTAL_BITS);
  const rightAmount = parseDecimalFixedPoint(right, decimals, TOTAL_BITS);
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
  const decimals = Math.max(decimalScale(left), decimalScale(right));
  const sum = parseDecimalAmount(left, decimals) + parseDecimalAmount(right, decimals);
  return formatDecimalAmount(sum, decimals);
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
  const decimals = decimalScale(value);
  const scaled = (parseDecimalAmount(value, decimals) * BigInt(bps)) / 10_000n;
  return formatDecimalAmount(scaled, decimals);
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

/** Every token amount a Solana instruction encodes is an unsigned 64-bit integer. */
export const MAX_TOKEN_BASE_UNITS = (1n << 64n) - 1n;

/** Why `acceptTokenAmount` refused a value. */
export type TokenAmountRefusal = "invalid" | "too_precise" | "out_of_range" | "not_positive";

/** A caller amount `acceptTokenAmount` refused, with a reason each provider maps to its own error. */
export class TokenAmountError extends AmountError {
  constructor(
    readonly reason: TokenAmountRefusal,
    message: string
  ) {
    super(message);
    this.name = "TokenAmountError";
  }
}

/** An amount `acceptTokenAmount` accepted. */
export interface AcceptedTokenAmount {
  /** The exact integer the instruction encodes. */
  baseUnits: bigint;
  /** The same value as a decimal string, canonical to the mint's scale ("1.500" is "1.5"). */
  canonical: string;
}

/**
 * Zeros after the last non-zero fractional digit, removed with one scan from the end rather than
 * an end-anchored repetition, which could retry from every zero of a long caller-controlled run.
 */
function trimInsignificantFractionalZeroes(value: string): string {
  const dot = value.indexOf(".");
  if (dot === -1) return value;
  let fractionEnd = value.length;
  while (fractionEnd > dot + 1 && value[fractionEnd - 1] === "0") fractionEnd -= 1;
  return fractionEnd === dot + 1 ? value.slice(0, dot) : value.slice(0, fractionEnd);
}

/**
 * Accept a caller amount at a mint's scale for an instruction that encodes a u64: the one amount
 * grammar every Earn provider package uses.
 *
 * - Syntax: digits and at most one dot once trimmed (`isDecimalString`), so a sign, an exponent or
 *   `Infinity` is refused.
 * - Scale is a property of the VALUE, not its spelling: zeros after the last non-zero fractional
 *   digit need no mint atoms, so `1.5000000` fits a six-decimal mint while `1.0000001` is refused.
 *   Never floored or clamped: the number asked for is the number that moves.
 * - The base units must fit a u64 and, with `positive`, be at least one atom.
 *
 * @param value - The caller's decimal amount.
 * @param decimals - The mint's decimals.
 * @param options - `positive` refuses zero.
 * @returns The base units and their canonical decimal string.
 * @throws {TokenAmountError} With the reason the value was refused.
 * @throws {AmountError} When `decimals` is not a non-negative integer.
 */
export function acceptTokenAmount(
  value: string,
  decimals: number,
  options: { positive?: boolean } = {}
): AcceptedTokenAmount {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AmountError("Invalid decimals configuration");
  }
  const normalized = value.trim();
  if (!isDecimalString(normalized)) throw new TokenAmountError("invalid", "Invalid decimal amount");
  const significant = trimInsignificantFractionalZeroes(normalized);
  if (decimalScale(significant) > decimals) {
    throw new TokenAmountError("too_precise", "Amount has too many decimal places");
  }
  let baseUnits: bigint;
  try {
    baseUnits = parseDecimalAmount(significant, decimals);
  } catch (error) {
    // Syntax, scale and decimals are proven above, so only the 256-bit range remains.
    if (!(error instanceof AmountError)) throw error;
    throw new TokenAmountError("out_of_range", "Amount is out of range");
  }
  if (baseUnits > MAX_TOKEN_BASE_UNITS) {
    throw new TokenAmountError("out_of_range", "Amount is out of range");
  }
  if (options.positive === true && baseUnits === 0n) {
    throw new TokenAmountError("not_positive", "Amount must be positive");
  }
  return { baseUnits, canonical: formatDecimalAmount(baseUnits, decimals) };
}
