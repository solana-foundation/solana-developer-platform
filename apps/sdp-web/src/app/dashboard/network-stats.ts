export const NETWORK_RANGES = ["30d", "90d", "1y"] as const;
export type NetworkRange = (typeof NETWORK_RANGES)[number];

const RANGE_DAYS: Record<NetworkRange, number> = { "30d": 30, "90d": 90, "1y": 365 };

export type NetworkMetricId =
  | "stablecoinSupply"
  | "stablecoinTransfers"
  | "stablecoinShare"
  | "costPerTransaction";

/** How a metric's figures read: dollars in billions, a count in millions, a share, or cents. */
export type NetworkMetricFormat = "usdCompact" | "countCompact" | "percent" | "usdPrecise";

export interface NetworkPoint {
  /** Calendar day, YYYY-MM-DD. */
  date: string;
  value: number;
}

export interface NetworkMetric {
  id: NetworkMetricId;
  format: NetworkMetricFormat;
  unit: "usd" | "count" | "percent";
  /** A rising supply is good news; a rising cost per transaction is not. */
  higherIsBetter: boolean;
  /** Daily points, oldest first. */
  points: readonly NetworkPoint[];
}

export interface NetworkSnapshot {
  health: "healthy" | "degraded";
  updatedAt: string;
  metrics: readonly NetworkMetric[];
}

/** The trailing days a range covers, ending on the latest point. */
export function sliceNetworkRange(
  points: readonly NetworkPoint[],
  range: NetworkRange
): readonly NetworkPoint[] {
  return points.slice(-RANGE_DAYS[range]);
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

/**
 * A metric figure. The headline keeps two decimals where they carry weight ($16.27B, 18.90M);
 * axis labels drop what the gridline already implies ($18B, 20M, 17.5%, $0.015).
 */
export function formatNetworkValue(
  value: number,
  format: NetworkMetricFormat,
  locale: string,
  variant: "headline" | "axis"
): string {
  const headline = variant === "headline";
  switch (format) {
    case "usdCompact":
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        notation: "compact",
        minimumFractionDigits: headline ? 2 : 0,
        maximumFractionDigits: headline ? 2 : 1,
      }).format(value);
    case "countCompact":
      return new Intl.NumberFormat(locale, {
        notation: "compact",
        minimumFractionDigits: headline ? 2 : 0,
        maximumFractionDigits: headline ? 2 : 1,
      }).format(value);
    case "percent":
      return new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value / 100);
    case "usdPrecise":
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        ...(headline ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 3 }),
      }).format(value);
  }
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
