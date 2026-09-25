import type {
  NetworkMetric,
  NetworkMetricId,
  NetworkPoint,
  NetworkSnapshot,
} from "./network-stats";

/**
 * DESIGN-REVIEW FIXTURE — not data. The prototype's Solana network figures, expanded into daily
 * series so the charts and the 30D / 90D / 1Y switch behave. No provider backs the Overview's
 * network section yet (solana.com/data publishes no API); replace `NETWORK_STATS_FIXTURE` with
 * a real source such as Allium, Artemis or Dune before this ships.
 */
export const NETWORK_STATS_FIXTURE_AS_OF = "2026-09-25";

const DAYS = 365;

/** mulberry32: a tiny seeded generator, so every render draws the same wiggle. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function isoDay(offsetFromEnd: number): string {
  const date = new Date(`${NETWORK_STATS_FIXTURE_AS_OF}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offsetFromEnd);
  return date.toISOString().slice(0, 10);
}

/**
 * A daily series from `start` to `end` along `shape` (0→1 over the year), with a smoothed random
 * walk on top that fades out at both ends so the first and last values are exact.
 */
function series({
  start,
  end,
  shape,
  wiggle,
  seed,
}: {
  start: number;
  end: number;
  shape: (t: number) => number;
  wiggle: number;
  seed: number;
}): NetworkPoint[] {
  const random = seededRandom(seed);
  const walk: number[] = [];
  let position = 0;
  for (let day = 0; day < DAYS; day++) {
    position = position * 0.9 + (random() - 0.5);
    walk.push(position);
  }
  const span = Math.abs(end - start);
  return walk.map((step, day) => {
    const t = day / (DAYS - 1);
    const trend = start + (end - start) * shape(t);
    const noise = step * wiggle * span * Math.sin(Math.PI * t);
    return { date: isoDay(DAYS - 1 - day), value: trend + noise };
  });
}

function metric(
  id: NetworkMetricId,
  rest: Omit<NetworkMetric, "id" | "points">,
  points: NetworkPoint[]
): NetworkMetric {
  return { id, ...rest, points };
}

// Year-end figures and year-on-year changes as the prototype prints them.
export const NETWORK_STATS_FIXTURE: NetworkSnapshot = {
  health: "healthy",
  updatedAt: "2026-09-23T12:00:00Z",
  metrics: [
    metric(
      "stablecoinSupply",
      { format: "usdCompact", unit: "usd", higherIsBetter: true },
      series({
        start: 16.27e9 / 1.297,
        end: 16.27e9,
        shape: (t) => t ** 1.08,
        wiggle: 0.02,
        seed: 11,
      })
    ),
    metric(
      "stablecoinTransfers",
      { format: "countCompact", unit: "count", higherIsBetter: true },
      series({
        start: 18.9e6 / 2.606,
        end: 18.9e6,
        shape: (t) => t ** 1.45,
        wiggle: 0.025,
        seed: 23,
      })
    ),
    metric(
      "stablecoinShare",
      { format: "percent", unit: "percent", higherIsBetter: true },
      series({
        start: 18.3 / 1.523,
        end: 18.3,
        shape: (t) => 1 - (1 - t) ** 1.45,
        wiggle: 0.03,
        seed: 37,
      })
    ),
    metric(
      "costPerTransaction",
      { format: "usdPrecise", unit: "usd", higherIsBetter: false },
      series({
        start: 0.0063 / 0.364,
        end: 0.0063,
        shape: (t) => t ** 0.9,
        wiggle: 0.02,
        seed: 41,
      })
    ),
  ],
};
