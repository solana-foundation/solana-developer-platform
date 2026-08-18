import { isDecimalString } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";

/**
 * Pure display formatters shared by every Earn surface. All USD figures on the
 * live wire are decimal strings and never pass through JavaScript `number`.
 */

function groupedDecimal(
  value: string,
  maximumFractionDigits: number,
  minimumFractionDigits: number
): string {
  if (!isDecimalString(value)) return "—";
  const [whole = "0", fraction = ""] = value.split(".");
  const groupedWhole = whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const visibleFraction = fraction
    .slice(0, maximumFractionDigits)
    .replace(/0+$/, "")
    .padEnd(minimumFractionDigits, "0");
  return visibleFraction ? `${groupedWhole}.${visibleFraction}` : groupedWhole;
}

/** Display a provider amount without losing precision or inventing zero. */
export function formatProviderAmount(
  value: string | undefined,
  symbol?: string,
  maximumFractionDigits = 6,
  minimumFractionDigits = 0
): string {
  if (value === undefined) return "—";
  const amount = groupedDecimal(value, maximumFractionDigits, minimumFractionDigits);
  if (amount === "—") return amount;
  return symbol ? `${amount} ${symbol}` : amount;
}

export function formatUsd(value: string | undefined): string {
  const amount = formatProviderAmount(value, undefined, 6, 2);
  return amount === "—" ? amount : `$${amount}`;
}

export function tokenSymbol(mint: string): string {
  return WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function formatTokenQuantity(value: string | undefined, symbol: string): string {
  return formatProviderAmount(value, symbol, 6);
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
