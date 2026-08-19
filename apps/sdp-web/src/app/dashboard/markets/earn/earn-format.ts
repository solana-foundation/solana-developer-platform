import { isDecimalString } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";

/**
 * Pure display formatters shared by every Earn surface.
 *
 * All money on the live wire is a decimal STRING and never passes through a
 * JavaScript `number`. `Intl.NumberFormat.prototype.format` accepts one
 * directly (ES2023) and formats it exactly, so a balance past 2^53 still
 * renders every digit it was given — which is why there is no `Number()` cast
 * and no hand-rolled digit grouping here.
 *
 * `roundingMode: "trunc"` is deliberate: these figures are balances and
 * ceilings, so rounding the last visible digit UP would display an amount the
 * provider will then refuse.
 *
 * Every formatter takes the caller's `locale`, matching `formatProviderApy` —
 * digit grouping and the decimal separator are locale facts, not en-US
 * constants.
 */
/**
 * `isDecimalString` restated as a type predicate: an unsigned decimal string is
 * exactly what `Intl`'s string overload takes, so this reaches the exact
 * formatter without an `as` cast.
 */
function isIntlDecimalLiteral(value: string): value is Intl.StringNumericLiteral {
  return isDecimalString(value);
}

function formatDecimalString(
  value: string,
  locale: string,
  maximumFractionDigits: number,
  minimumFractionDigits: number
): string | undefined {
  if (!isIntlDecimalLiteral(value)) return undefined;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    minimumFractionDigits,
    roundingMode: "trunc",
  }).format(value);
}

/** Display a provider amount without losing precision or inventing zero. */
export function formatProviderAmount(
  value: string | undefined,
  locale: string,
  symbol?: string,
  maximumFractionDigits = 6,
  minimumFractionDigits = 0
): string {
  if (value === undefined) return "—";
  const amount = formatDecimalString(value, locale, maximumFractionDigits, minimumFractionDigits);
  if (amount === undefined) return "—";
  return symbol ? `${amount} ${symbol}` : amount;
}

export function formatUsd(value: string | undefined, locale: string): string {
  const amount = formatProviderAmount(value, locale, undefined, 6, 2);
  return amount === "—" ? amount : `$${amount}`;
}

export function tokenSymbol(mint: string): string {
  return WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function formatTokenQuantity(
  value: string | undefined,
  locale: string,
  symbol: string
): string {
  return formatProviderAmount(value, locale, symbol, 6);
}

/**
 * Compact human range from two ISO-8601 durations (Ground reports processing
 * estimates as e.g. "PT21M" / "P2D"). Unparseable inputs render verbatim so a
 * provider format change degrades to raw text instead of hiding the estimate.
 */
export function formatDurationRange(minimum: string, maximum: string): string {
  const min = formatIsoDuration(minimum);
  const max = formatIsoDuration(maximum);
  return min === max ? min : `${min}–${max}`;
}

/** Whole-day count from an ISO-8601 duration ("P2D" → 2), else undefined. */
export function isoDurationDays(duration: string): number | undefined {
  const match = /^P(\d+)D$/.exec(duration.trim());
  return match ? Number(match[1]) : undefined;
}

function formatIsoDuration(duration: string): string {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration.trim());
  if (!match) return duration;
  const [, days, hours, minutes, seconds] = match.map((part) => (part ? Number(part) : 0));
  const totalSeconds = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  if (totalSeconds === 0) return duration;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3_600) return `${Math.round(totalSeconds / 60)}m`;
  if (totalSeconds < 86_400) return `${Math.round(totalSeconds / 3_600)}h`;
  return `${Math.round(totalSeconds / 86_400)}d`;
}
