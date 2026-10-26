/**
 * The Overview's Solana network readings, derived from data.solana.com's metrics. Each reading
 * is a recipe over metrics read on the same UTC day; adding one is an entry in
 * `NETWORK_READINGS` and its id in `@sdp/types/network-metrics`.
 */
import {
  NETWORK_METRIC_IDS,
  type NetworkMetricId,
  type NetworkPoint,
  type NetworkSnapshot,
  networkMetricsSchema,
} from "@sdp/types/network-metrics";
import type { DataApiMetricTable } from "@/lib/data-api/metrics";

interface NetworkReading {
  /** data.solana.com metric names, read for the same day. */
  inputs: readonly string[];
  /** The reading from its inputs' figures, in `inputs` order; null when it is undefined. */
  derive: (figures: readonly number[]) => number | null;
}

const NON_VOTE_TRANSACTIONS = "Non Vote Transaction Count (Success)";

/** A day with no transactions has no share or cost, rather than an infinite one. */
function quotient(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

const NETWORK_READINGS = {
  stablecoinSupply: {
    inputs: ["Circulating Supply"],
    derive: ([supply]) => supply,
  },
  stablecoinTransfers: {
    inputs: ["Transfer Count"],
    derive: ([transfers]) => transfers,
  },
  // Transfers over every successful non-vote transaction that day, in percent.
  stablecoinShare: {
    inputs: ["Transfer Count", NON_VOTE_TRANSACTIONS],
    derive: ([transfers, transactions]) => {
      const share = quotient(transfers, transactions);
      return share === null ? null : share * 100;
    },
  },
  // The day's fees (in SOL) at the day's SOL price, over its non-vote transactions.
  costPerTransaction: {
    inputs: ["Fees", "SOL Price", NON_VOTE_TRANSACTIONS],
    derive: ([fees, solPrice, transactions]) => quotient(fees * solPrice, transactions),
  },
} as const satisfies Record<NetworkMetricId, NetworkReading>;

/** The days a snapshot covers, ending on its `asOf`: the 1Y range. */
const SNAPSHOT_DAYS = 365;
const DAY_MS = 86_400_000;

function dayBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** Past the four the Overview prints, extra digits only weigh down the response and the cache. */
const SIGNIFICANT_DIGITS = 6;

/**
 * Every closed UTC day a reading can be made on, oldest first: the days all its inputs reported,
 * and none when one of them is missing from the read, so the reading shows as unavailable.
 */
function readingPoints(table: DataApiMetricTable, reading: NetworkReading): NetworkPoint[] {
  const byInput = reading.inputs.map((input) => table.values.get(input));
  const [first] = byInput;
  if (first === undefined) return [];
  const points: NetworkPoint[] = [];
  for (const date of [...first.keys()].sort()) {
    const figures = byInput.map((byDay) => byDay?.get(date));
    if (!figures.every((figure): figure is number => figure !== undefined)) continue;
    const value = reading.derive(figures);
    if (value !== null && Number.isFinite(value)) {
      points.push({ date, value: Number(value.toPrecision(SIGNIFICANT_DIGITS)) });
    }
  }
  return points;
}

/** Metrics report a day or two apart, so the shared day is looked for this far behind the
 * freshest one; a reading with no point that far back is stale and shows as unavailable. */
const MAX_LAG_DAYS = 2;

/** The snapshot's figures; its health is read apart, on a much shorter clock. */
export type NetworkReadings = Omit<NetworkSnapshot, "health">;

/**
 * The readings the Overview draws, or null when none has a day to show. `asOf` is the newest day,
 * within MAX_LAG_DAYS of the freshest point, that the most readings have a point on; each series
 * ends there, and a reading with no point on it shows as unavailable. So every headline is the
 * same day's figure, and a day some inputs have not reported yet never sits beside complete ones.
 */
export function buildNetworkReadings(table: DataApiMetricTable): NetworkReadings | null {
  const series = NETWORK_METRIC_IDS.map((id) => {
    const points = readingPoints(table, NETWORK_READINGS[id]);
    return { id, points, days: new Set(points.map(({ date }) => date)) };
  });
  const freshest = series.reduce<string | undefined>((max, { points }) => {
    const latest = points.at(-1)?.date;
    return latest !== undefined && (max === undefined || latest > max) ? latest : max;
  }, undefined);
  if (freshest === undefined) return null;

  const covering = (day: string) => series.filter(({ days }) => days.has(day)).length;
  let asOf = freshest;
  for (let back = 1; back <= MAX_LAG_DAYS; back++) {
    const day = dayBefore(freshest, back);
    if (covering(day) > covering(asOf)) asOf = day;
  }
  const from = dayBefore(asOf, SNAPSHOT_DAYS - 1);
  // The contract's record holds each reading exactly once; parsing into it proves this one does.
  const metrics = networkMetricsSchema.parse(
    Object.fromEntries(
      series.map(({ id, points, days }) => [
        id,
        days.has(asOf) ? points.filter(({ date }) => date >= from && date <= asOf) : [],
      ])
    )
  );
  return { asOf, metrics };
}
