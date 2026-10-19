import type { NetworkPoint, NetworkSnapshot } from "@sdp/types/network-metrics";

/**
 * TEST FIXTURE, not data: the prototype's year figures (data.solana.com's cross-provider medians
 * on 2026-09-14) as straight daily series ending on `asOf`, in the shape the network API returns.
 */
const DAYS = 365;
const DAY_MS = 86_400_000;

function series(asOf: string, start: number, end: number): NetworkPoint[] {
  const close = Date.parse(`${asOf}T00:00:00Z`);
  return Array.from({ length: DAYS }, (_, day) => ({
    date: new Date(close - (DAYS - 1 - day) * DAY_MS).toISOString().slice(0, 10),
    value: start + ((end - start) * day) / (DAYS - 1),
  }));
}

/** The prototype's year-end figures and year-on-year changes, over the year ending on `asOf`. */
export function buildNetworkStatsFixture(asOf: string): NetworkSnapshot {
  return {
    asOf,
    health: null,
    metrics: {
      stablecoinSupply: series(asOf, 16.27e9 / 1.297, 16.27e9),
      stablecoinTransfers: series(asOf, 18.9e6 / 2.606, 18.9e6),
      stablecoinShare: series(asOf, 18.3 / 1.523, 18.3),
      costPerTransaction: series(asOf, 0.0063 / 0.364, 0.0063),
    },
  };
}
