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

/** Parse one unsigned, non-exponent decimal without touching a JavaScript number. */
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

/** Fractional scale, optionally ignoring harmless trailing zeroes. */
export function unsignedDecimalScale(
  decimal: Pick<ParsedUnsignedDecimal, "fraction">,
  { ignoreTrailingZeros = false }: { ignoreTrailingZeros?: boolean } = {}
): number {
  return (ignoreTrailingZeros ? decimal.fraction.replace(/0+$/, "") : decimal.fraction).length;
}

/** Exact ordering for unsigned decimal strings of arbitrary magnitude. */
export function compareUnsignedDecimals(left: string, right: string): -1 | 0 | 1 | undefined {
  const leftParts = parseUnsignedDecimal(left);
  const rightParts = parseUnsignedDecimal(right);
  if (!leftParts || !rightParts) return undefined;

  if (leftParts.whole.length !== rightParts.whole.length) {
    return leftParts.whole.length < rightParts.whole.length ? -1 : 1;
  }
  if (leftParts.whole !== rightParts.whole) {
    return leftParts.whole < rightParts.whole ? -1 : 1;
  }

  const fractionLength = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(fractionLength, "0");
  const rightFraction = rightParts.fraction.padEnd(fractionLength, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}
