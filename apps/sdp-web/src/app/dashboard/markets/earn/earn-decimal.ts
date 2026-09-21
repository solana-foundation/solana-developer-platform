import { compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";

/**
 * Longest free-text money input any vault surface accepts before parsing. One
 * cap shared by the deposit and withdrawal validators so neither drifts past
 * the other's idea of what a typed amount can be.
 */
export const MAX_AMOUNT_LENGTH = 128;

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

/**
 * Whether the value parses as an unsigned decimal AND is strictly above zero.
 *
 * Every money surface answers the same question — a balance of "0" offers
 * nothing to deposit or withdraw, and an unparseable one offers even less — so
 * the comparison against "0" is spelled once. An unparseable value is NOT
 * positive, which is the fail-closed answer.
 */
export function isPositiveDecimal(value: string): boolean {
  return compareUnsignedDecimals(value, "0") === 1;
}

/**
 * Order items by an optional decimal string: unknown values always sort last,
 * ties resolve by original position, and comparable values order by the
 * requested direction. Returns a new array; the input is not mutated. The
 * comparison is fail-soft like `compareUnsignedDecimals` itself — a value
 * that cannot be compared at sort time counts as a tie, never a crash. What
 * counts as "unknown" is the caller's decision: pass a `valueFor` that
 * answers `undefined` for every value it does not vouch for.
 */
export function sortByOptionalDecimal<Item>(
  items: readonly Item[],
  valueFor: (item: Item) => string | undefined,
  direction: "ascending" | "descending"
): Item[] {
  return items
    .map((item, index) => ({ index, item, value: valueFor(item) }))
    .sort((left, right) => {
      if (left.value === undefined && right.value === undefined) return left.index - right.index;
      if (left.value === undefined) return 1;
      if (right.value === undefined) return -1;

      const order = compareUnsignedDecimals(left.value, right.value) ?? 0;
      if (order === 0) return left.index - right.index;
      return direction === "ascending" ? order : -order;
    })
    .map(({ item }) => item);
}
