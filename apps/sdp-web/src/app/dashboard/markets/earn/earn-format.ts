import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";

/**
 * Pure display formatters shared by every Earn surface. All USD figures on the
 * live wire are decimal strings; these helpers accept both strings and numbers
 * so callers never juggle conversions at render time.
 */

export function formatApy(apy: string | undefined): string {
  if (!apy) return "—";
  const value = Number(apy);
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export function formatUsd(value: number | string): string {
  const amount = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(amount)) return "—";
  return usdFormatter.format(amount);
}

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatUsdCompact(value: number | string): string {
  const amount = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(amount)) return "—";
  return compactUsdFormatter.format(amount);
}

export function tokenSymbol(mint: string): string {
  return WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

const amountFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatTokenAmount(value: number, mint: string): string {
  return `${amountFormatter.format(value)} ${tokenSymbol(mint)}`;
}

/** Simple-interest projection for preview panels (display only). */
export function projectYearlyYield(amount: number, apy: string | undefined): number {
  const rate = Number(apy ?? 0);
  if (!Number.isFinite(rate) || !Number.isFinite(amount)) return 0;
  return amount * rate;
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
