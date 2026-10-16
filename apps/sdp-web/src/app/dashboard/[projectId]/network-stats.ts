import type { NetworkMetricId, NetworkPoint } from "@sdp/types/network-metrics";

export const NETWORK_RANGES = ["30d", "90d", "1y"] as const;
export type NetworkRange = (typeof NETWORK_RANGES)[number];

const RANGE_DAYS = { "30d": 30, "90d": 90, "1y": 365 } as const satisfies Record<
  NetworkRange,
  number
>;

export function isNetworkRange(value: string): value is NetworkRange {
  return NETWORK_RANGES.some((range) => range === value);
}

/** How a metric's figures read: dollars in billions, a count in millions, a share, or cents. */
export type NetworkMetricFormat = "usdCompact" | "countCompact" | "percent" | "usdPrecise";

export interface NetworkMetricDisplay {
  format: NetworkMetricFormat;
  unit: "usd" | "count" | "percent";
  /** A rising supply is good news; a rising cost per transaction is not. */
  higherIsBetter: boolean;
  /**
   * Drawn as a 7-day average. Daily transfers swing 30% or more with the weekday, so a daily
   * change would hinge on which day a range starts; supply moves slowly and reads daily.
   */
  averaged: boolean;
}

export const NETWORK_METRIC_DISPLAY = {
  stablecoinSupply: { format: "usdCompact", unit: "usd", higherIsBetter: true, averaged: false },
  stablecoinTransfers: {
    format: "countCompact",
    unit: "count",
    higherIsBetter: true,
    averaged: true,
  },
  stablecoinShare: { format: "percent", unit: "percent", higherIsBetter: true, averaged: true },
  costPerTransaction: {
    format: "usdPrecise",
    unit: "usd",
    higherIsBetter: false,
    averaged: true,
  },
} as const satisfies Record<NetworkMetricId, NetworkMetricDisplay>;

const DAY_MS = 86_400_000;
const AVERAGE_DAYS = 7;

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOfDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * The days a range covers, ending on the latest point. Cut by date, not by count, so a missing
 * day never stretches a range past its days or moves its change onto a longer period.
 */
export function sliceNetworkRange(
  points: readonly NetworkPoint[],
  range: NetworkRange
): readonly NetworkPoint[] {
  const last = points.at(-1);
  if (last === undefined) return [];
  const from = dayNumber(last.date) - (RANGE_DAYS[range] - 1);
  return points.filter(({ date }) => dayNumber(date) >= from);
}

/**
 * Each day's 7-day average: the mean of that day and the six before it, for every day with a
 * full week behind it. A missing day inside the week is left out of the mean, never counted as
 * zero.
 */
export function sevenDayAverages(points: readonly NetworkPoint[]): NetworkPoint[] {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return [];
  const valueOn = new Map(points.map(({ date, value }) => [dayNumber(date), value]));
  const averages: NetworkPoint[] = [];
  for (let day = dayNumber(first.date) + AVERAGE_DAYS - 1; day <= dayNumber(last.date); day++) {
    let sum = 0;
    let count = 0;
    for (let back = 0; back < AVERAGE_DAYS; back++) {
      const value = valueOn.get(day - back);
      if (value !== undefined) {
        sum += value;
        count++;
      }
    }
    if (count > 0) averages.push({ date: dateOfDay(day), value: sum / count });
  }
  return averages;
}

/** Whole weeks, stepping back from the latest day: each one's 7-day average on its last day. */
export function weeklyAverages(points: readonly NetworkPoint[]): NetworkPoint[] {
  const averages = sevenDayAverages(points);
  const last = averages.at(-1);
  if (last === undefined) return [];
  const lastDay = dayNumber(last.date);
  return averages.filter(({ date }) => (lastDay - dayNumber(date)) % AVERAGE_DAYS === 0);
}

/**
 * What a figure draws over a range. A daily metric shows its days; an averaged one shows each
 * day's 7-day average on 30D and 90D, and one point a week on 1Y. The headline and the change
 * read these same points, so the number, the end of the line and the % always agree.
 */
export function networkRangePoints(
  points: readonly NetworkPoint[],
  range: NetworkRange,
  averaged: boolean
): readonly NetworkPoint[] {
  if (!averaged) return sliceNetworkRange(points, range);
  return range === "1y"
    ? weeklyAverages(points)
    : sliceNetworkRange(sevenDayAverages(points), range);
}

/** The change from the first point to the last as a ratio (0.297 for +29.7%), or null. */
export function networkChange(points: readonly NetworkPoint[]): number | null {
  const first = points[0]?.value;
  const last = points.at(-1)?.value;
  if (first === undefined || last === undefined || first === 0) return null;
  return (last - first) / first;
}

const TICK_STEPS = [1, 2, 2.5, 5] as const;

/**
 * Axis ticks that bracket the data on round numbers: the smallest step from 1, 2, 2.5 and 5 per
 * power of ten that covers min to max in at most `maxTicks` ticks. The first and last ticks
 * are the plot's floor and ceiling, so the line always sits inside the gridlines.
 */
export function niceNetworkTicks(min: number, max: number, maxTicks = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    return niceNetworkTicks(min - pad, max + pad, maxTicks);
  }
  const span = max - min;
  let magnitude = 10 ** Math.floor(Math.log10(span / maxTicks));
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const step of TICK_STEPS) {
      const size = step * magnitude;
      const floor = Math.floor(min / size) * size;
      const ceiling = Math.ceil(max / size) * size;
      const count = Math.round((ceiling - floor) / size) + 1;
      if (count <= maxTicks) {
        // Rebuilt from integers so 0.1 + 0.2 never prints as 0.30000000000000004.
        return Array.from({ length: count }, (_, index) =>
          Number((floor + index * size).toPrecision(12))
        );
      }
    }
    magnitude *= 10;
  }
  return [min, max];
}

/** Room kept between the data and the plot's floor and ceiling, as a share of the data's span. */
const AXIS_HEADROOM = 0.05;

/**
 * The ticks for a series, with a little headroom so the line never runs along the frame. A
 * series that never goes below zero keeps a floor of zero or more.
 */
export function networkAxisTicks(values: readonly number[]): number[] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min > max) return [];
  const pad = (max - min) * AXIS_HEADROOM;
  return niceNetworkTicks(min >= 0 ? Math.max(0, min - pad) : min - pad, max + pad);
}

/** Past this long since the latest close, the Overview names the date instead of the age. */
const DATED_AFTER_MS = 3 * DAY_MS;

export type NetworkFreshness = { kind: "recent"; elapsedMs: number } | { kind: "dated" };

/** How old the latest reading is, counted from the end of its UTC day: the daily close. */
export function networkFreshness(asOf: string, now: number): NetworkFreshness {
  const elapsedMs = Math.max(0, now - (Date.parse(`${asOf}T00:00:00Z`) + DAY_MS));
  return elapsedMs > DATED_AFTER_MS ? { kind: "dated" } : { kind: "recent", elapsedMs };
}

/** "14h ago", "40h ago" for the usual day or two of lag; "3d ago" past two days. */
export function formatNetworkAge(elapsedMs: number, locale: string): string {
  const hours = Math.round(elapsedMs / 3_600_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { style: "narrow" });
  return hours < 48
    ? formatter.format(-hours, "hour")
    : formatter.format(-Math.floor(hours / 24), "day");
}

/** "Oct 12, 2026": a reading's UTC day, as the date row and the hover card name it. */
export function formatNetworkDay(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

type ValueVariant = "headline" | "axis";

/** `extraDigits` widens an axis label for ticks closer together than its usual precision. */
function valueFormatOptions(
  format: NetworkMetricFormat,
  variant: ValueVariant,
  extraDigits: number
): Intl.NumberFormatOptions {
  const headline = variant === "headline";
  const compact = {
    notation: "compact",
    minimumFractionDigits: headline ? 2 : 0,
    maximumFractionDigits: headline ? 2 : 1 + extraDigits,
  } as const;
  switch (format) {
    case "usdCompact":
      return { style: "currency", currency: "USD", ...compact };
    case "countCompact":
      return compact;
    case "percent":
      return { style: "percent", maximumFractionDigits: 1 + extraDigits };
    case "usdPrecise":
      return {
        style: "currency",
        currency: "USD",
        ...(headline
          ? { maximumSignificantDigits: 2 }
          : { maximumFractionDigits: 3 + extraDigits }),
      };
  }
}

// One formatter per locale, format, variant and precision: the hover card formats on every
// pointer move.
const valueFormatters = new Map<string, Intl.NumberFormat>();

function valueFormatter(
  locale: string,
  format: NetworkMetricFormat,
  variant: ValueVariant,
  extraDigits: number
): Intl.NumberFormat {
  const key = `${locale}|${format}|${variant}|${extraDigits}`;
  const cached = valueFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(locale, valueFormatOptions(format, variant, extraDigits));
  valueFormatters.set(key, formatter);
  return formatter;
}

const scaled = (value: number, format: NetworkMetricFormat) =>
  format === "percent" ? value / 100 : value;

/**
 * A metric figure. The headline keeps two decimals where they carry weight ($16.27B, 18.90M);
 * axis labels drop what the gridline already implies ($18B, 20M, 17.5%, $0.015).
 */
export function formatNetworkValue(
  value: number,
  format: NetworkMetricFormat,
  locale: string,
  variant: ValueVariant
): string {
  return valueFormatter(locale, format, variant, 0).format(scaled(value, format));
}

/** Past this, a label would carry more digits than an axis can usefully show. */
const MAX_EXTRA_AXIS_DIGITS = 4;

/**
 * An axis's tick labels: the axis precision, with as many more decimals as it takes to tell
 * every tick apart, so a narrow range never repeats a label ($0.0064, $0.0066, not $0.006
 * twice).
 */
export function formatNetworkTicks(
  ticks: readonly number[],
  format: NetworkMetricFormat,
  locale: string
): string[] {
  let labels: string[] = [];
  for (let extraDigits = 0; extraDigits <= MAX_EXTRA_AXIS_DIGITS; extraDigits++) {
    const formatter = valueFormatter(locale, format, "axis", extraDigits);
    labels = ticks.map((tick) => formatter.format(scaled(tick, format)));
    if (new Set(labels).size === labels.length) break;
  }
  return labels;
}

/** "+29.7%", "−63.6%": signed, one decimal, with a true minus sign. */
export function formatNetworkChange(ratio: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  })
    .format(ratio)
    .replace("-", "−");
}

/** Whether a change is good news for this metric; a flat change is neither. */
export function networkChangeTone(
  ratio: number,
  higherIsBetter: boolean
): "positive" | "critical" | "neutral" {
  if (ratio === 0) return "neutral";
  return ratio > 0 === higherIsBetter ? "positive" : "critical";
}
