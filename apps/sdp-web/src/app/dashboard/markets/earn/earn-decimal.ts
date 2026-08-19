import { compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";

export interface ParsedUnsignedDecimal {
  /** Leading-zero and trailing-fraction-zero normalized representation. */
  canonical: string;
  /** Leading-zero normalized integer component. */
  whole: string;
  /** Fraction exactly as supplied, for raw mint/API scale enforcement. */
  fraction: string;
}

interface ParseUnsignedDecimalOptions {
  /** Trim surrounding whitespace before validating. Defaults to true. */
  trim?: boolean;
  /** Maximum length after optional trimming. */
  maxLength?: number;
}

/**
 * Parse one unsigned, non-exponent decimal without touching a JavaScript number.
 *
 * Stricter than `isDecimalString` in `@sdp/solana/amount` on purpose: this is
 * the seam between a typed money field and free text, so it requires digits on
 * BOTH sides of the point (`.5` and `5.` are rejected, not coerced), can refuse
 * untrimmed input, and can cap length. It also returns the canonical form,
 * which the shared helpers do not expose. Scale and ordering are NOT
 * reimplemented here — use `decimalScale` and `compareUnsignedDecimals`.
 */
export function parseUnsignedDecimal(
  value: string,
  { trim = true, maxLength }: ParseUnsignedDecimalOptions = {}
): ParsedUnsignedDecimal | undefined {
  const input = trim ? value.trim() : value;
  if (maxLength !== undefined && input.length > maxLength) return undefined;

  const match = /^(\d+)(?:\.(\d+))?$/.exec(input);
  if (!match) return undefined;

  const whole = (match[1] ?? "0").replace(/^0+(?=\d)/, "") || "0";
  const fraction = match[2] ?? "";
  const canonicalFraction = fraction.replace(/0+$/, "");
  return {
    canonical: canonicalFraction ? `${whole}.${canonicalFraction}` : whole,
    whole,
    fraction,
  };
}

/**
 * `compareDecimalAmounts` with the fail-soft contract the money surfaces need.
 *
 * The shared comparator THROWS `AmountError` on a non-decimal input, and these
 * call sites read provider-supplied strings during render — a lane ceiling the
 * API returned malformed would crash the withdraw modal while a reader is
 * trying to exit a position. ADR 0002 (money out beats money off) forbids that,
 * so an unparseable side answers `undefined` and every caller treats "cannot
 * compare" as "do not offer", never as a pass.
 */
export function compareUnsignedDecimals(left: string, right: string): -1 | 0 | 1 | undefined {
  if (!isDecimalString(left.trim()) || !isDecimalString(right.trim())) return undefined;
  const ordering = compareDecimalAmounts(left, right);
  if (ordering === 0) return 0;
  return ordering < 0 ? -1 : 1;
}
