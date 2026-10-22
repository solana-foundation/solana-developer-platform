import { NETWORK_METRIC_IDS, networkSnapshotSchema } from "@sdp/types/network-metrics";
import { describe, expect, it } from "vitest";
import {
  formatNetworkAge,
  formatNetworkDay,
  formatNetworkTicks,
  formatNetworkValue,
  NETWORK_METRIC_DISPLAY,
  NETWORK_RANGES,
  networkAxisTicks,
  networkFreshness,
  networkRangePoints,
  niceNetworkTicks,
  sevenDayAverages,
  sliceNetworkRange,
  weeklyAverages,
} from "./network-stats";
import { buildNetworkStatsFixture } from "./network-stats.fixture";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One point a day from `from`, with these values. */
function daily(values: readonly number[], from = "2026-01-01") {
  const start = Date.parse(`${from}T00:00:00Z`);
  return values.map((value, index) => ({
    date: new Date(start + index * DAY_MS).toISOString().slice(0, 10),
    value,
  }));
}

describe("niceNetworkTicks", () => {
  it("brackets the data on round steps, as the prototype's axes do", () => {
    expect(niceNetworkTicks(12.54e9, 16.27e9)).toEqual([12e9, 14e9, 16e9, 18e9]);
    expect(niceNetworkTicks(7.25e6, 18.9e6)).toEqual([5e6, 10e6, 15e6, 20e6]);
    expect(niceNetworkTicks(0.0063, 0.0173)).toEqual([0.005, 0.01, 0.015, 0.02]);
  });

  it("never returns more ticks than asked and keeps float noise out", () => {
    const ticks = niceNetworkTicks(0.1, 0.7, 4);
    expect(ticks.length).toBeLessThanOrEqual(4);
    expect(ticks.every((tick) => String(tick).length < 8)).toBe(true);
  });

  it("widens a flat series so it still has a floor and a ceiling", () => {
    const ticks = niceNetworkTicks(5, 5);
    expect(ticks[0]).toBeLessThan(5);
    expect(ticks.at(-1)).toBeGreaterThan(5);
  });
});

describe("networkAxisTicks", () => {
  it("keeps all four of the prototype's axes", () => {
    expect(networkAxisTicks([12.54e9, 16.27e9])).toEqual([12e9, 14e9, 16e9, 18e9]);
    expect(networkAxisTicks([7.25e6, 18.9e6])).toEqual([5e6, 10e6, 15e6, 20e6]);
    expect(networkAxisTicks([11.9, 18.3])).toEqual([10, 12.5, 15, 17.5, 20]);
    expect(networkAxisTicks([0.0063, 0.0173])).toEqual([0.005, 0.01, 0.015, 0.02]);
  });

  it("lifts a line that would run along the frame off it", () => {
    // Bare ticks put 12.0 on the floor; the headroom drops the floor a step.
    expect(niceNetworkTicks(12, 18.3)[0]).toBe(12);
    expect(networkAxisTicks([12, 18.3])[0]).toBe(10);
  });

  it("never takes a positive series below zero", () => {
    expect(networkAxisTicks([0.0001, 0.02])[0]).toBe(0);
  });

  it("has no axis without data", () => {
    expect(networkAxisTicks([])).toEqual([]);
  });
});

describe("formatNetworkValue", () => {
  it("prints the headline figures the prototype shows", () => {
    expect(formatNetworkValue(16.27e9, "usdCompact", "en", "headline")).toBe("$16.27B");
    expect(formatNetworkValue(18.9e6, "countCompact", "en", "headline")).toBe("18.90M");
    expect(formatNetworkValue(18.3, "percent", "en", "headline")).toBe("18.3%");
    expect(formatNetworkValue(0.0063, "usdPrecise", "en", "headline")).toBe("$0.0063");
  });

  it("drops what the gridline implies on the axis", () => {
    expect(formatNetworkValue(18e9, "usdCompact", "en", "axis")).toBe("$18B");
    expect(formatNetworkValue(20e6, "countCompact", "en", "axis")).toBe("20M");
    expect(formatNetworkValue(17.5, "percent", "en", "axis")).toBe("17.5%");
    expect(formatNetworkValue(0.015, "usdPrecise", "en", "axis")).toBe("$0.015");
  });

  it("adds decimals until no two ticks share a label", () => {
    // A month of cost per transaction: ticks 0.0002 apart, all "$0.006"/"$0.007" at the
    // axis's usual precision.
    const ticks = networkAxisTicks([0.0063, 0.00696]);
    expect(formatNetworkTicks(ticks, "usdPrecise", "en")).toEqual([
      "$0.0062",
      "$0.0064",
      "$0.0066",
      "$0.0068",
      "$0.007",
    ]);
    expect(formatNetworkTicks([12e9, 14e9, 16e9, 18e9], "usdCompact", "en")).toEqual([
      "$12B",
      "$14B",
      "$16B",
      "$18B",
    ]);
    expect(formatNetworkTicks([18.1, 18.15, 18.2], "percent", "en")).toEqual([
      "18.1%",
      "18.15%",
      "18.2%",
    ]);
  });

  it("formats in the viewer's locale", () => {
    expect(formatNetworkValue(16.27e9, "usdCompact", "fr", "headline")).toMatch(/16,27/);
  });
});

describe("7-day averages", () => {
  it("averages each day with the six before it, from the first full week", () => {
    expect(sevenDayAverages(daily([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toEqual([
      { date: "2026-01-07", value: 4 },
      { date: "2026-01-08", value: 5 },
      { date: "2026-01-09", value: 6 },
    ]);
  });

  it("leaves a missing day out of the mean rather than counting it as zero", () => {
    const points = daily([7, 7, 7, 7, 7, 7, 7, 7]).filter(({ date }) => date !== "2026-01-04");
    expect(sevenDayAverages(points)).toEqual([
      { date: "2026-01-07", value: 7 },
      { date: "2026-01-08", value: 7 },
    ]);
  });

  it("steps a year back from its latest day a whole week at a time", () => {
    const year = daily(Array.from({ length: 365 }, (_, day) => day));
    const weeks = weeklyAverages(year);
    expect(weeks).toHaveLength(52);
    // The last week is days 358 to 364; the first whole one is days 1 to 7.
    expect(weeks.at(-1)).toEqual({ date: year.at(-1)?.date, value: 361 });
    expect(weeks[0]).toEqual({ date: year[7]?.date, value: 4 });
  });

  it("reads a weekday swing as flat, on every range and whatever day it starts", () => {
    // One busy day a week: drawn daily, the line would spike weekly and the headline would
    // hinge on the weekday.
    const swinging = daily(Array.from({ length: 365 }, (_, day) => (day % 7 === 0 ? 70 : 0)));
    for (const range of NETWORK_RANGES) {
      const points = networkRangePoints(swinging, range, true);
      expect(new Set(points.map(({ value }) => value))).toEqual(new Set([10]));
    }
  });

  it("draws an averaged figure daily on 30D and 90D and weekly on 1Y; a daily one as it is", () => {
    const year = daily(Array.from({ length: 365 }, (_, day) => day));
    expect(networkRangePoints(year, "30d", true)).toHaveLength(30);
    expect(networkRangePoints(year, "90d", true)).toHaveLength(90);
    expect(networkRangePoints(year, "1y", true)).toHaveLength(52);
    expect(networkRangePoints(year, "30d", false)).toEqual(year.slice(-30));
    // The headline is the latest 7-day average whichever range is picked.
    const latest = NETWORK_RANGES.map((range) => networkRangePoints(year, range, true).at(-1));
    expect(new Set(latest.map((point) => point?.value))).toEqual(new Set([361]));
  });

  it("cuts a range by its days, so a missing day never stretches it", () => {
    // Day 350 is missing: 30 readings would reach back to day 334, 31 days before the last.
    const supply = daily(Array.from({ length: 365 }, (_, day) => day)).filter(
      ({ value }) => value !== 350
    );
    const month = networkRangePoints(supply, "30d", false);
    expect(month).toHaveLength(29);
    expect(month[0]?.value).toBe(335);
    expect(month.at(-1)?.value).toBe(364);
    expect(networkRangePoints(supply, "90d", false)[0]?.value).toBe(275);
  });

  it("averages transfers, share and cost, and keeps supply daily", () => {
    const averaged = Object.entries(NETWORK_METRIC_DISPLAY)
      .filter(([, display]) => display.averaged)
      .map(([id]) => id);
    expect(averaged).toEqual(["stablecoinTransfers", "stablecoinShare", "costPerTransaction"]);
  });
});

describe("freshness", () => {
  const closeOfOct12 = Date.parse("2026-10-13T00:00:00Z");

  it("counts the age from the end of the latest day, not from the read", () => {
    const freshness = networkFreshness("2026-10-12", closeOfOct12 + 21 * HOUR_MS);
    expect(freshness).toEqual({ kind: "recent", elapsedMs: 21 * HOUR_MS });
    expect(formatNetworkAge(21 * HOUR_MS, "en")).toBe("21h ago");
    // A complete day often sits a day further back: 40 hours is not two days.
    expect(formatNetworkAge(40 * HOUR_MS, "en")).toBe("40h ago");
    expect(formatNetworkAge(50 * HOUR_MS, "en")).toBe("2d ago");
  });

  it("names the date once the figures are more than three days old", () => {
    expect(networkFreshness("2026-10-12", closeOfOct12 + 72 * HOUR_MS).kind).toBe("recent");
    expect(networkFreshness("2026-10-12", closeOfOct12 + 73 * HOUR_MS)).toEqual({ kind: "dated" });
  });

  it("reads a day as its UTC calendar day", () => {
    expect(formatNetworkDay("2026-10-12", "en")).toBe("Oct 12, 2026");
  });
});

describe("the design-review fixture", () => {
  const fixture = buildNetworkStatsFixture("2026-10-12");

  it("is a snapshot the network API could return", () => {
    expect(networkSnapshotSchema.parse(fixture)).toEqual(fixture);
    expect(fixture.health).toBeNull();
  });

  it("lands on the prototype's year figures, ending on its day", () => {
    const figures = NETWORK_METRIC_IDS.map((id) => {
      const points = sliceNetworkRange(fixture.metrics[id], "1y");
      const { format } = NETWORK_METRIC_DISPLAY[id];
      const last = points[points.length - 1];
      return [
        id,
        formatNetworkValue(last.value, format, "en", "headline"),
        points[0].date,
        last.date,
      ];
    });
    expect(figures).toEqual([
      ["stablecoinSupply", "$16.27B", "2025-10-13", "2026-10-12"],
      ["stablecoinTransfers", "18.90M", "2025-10-13", "2026-10-12"],
      ["stablecoinShare", "18.3%", "2025-10-13", "2026-10-12"],
      ["costPerTransaction", "$0.0063", "2025-10-13", "2026-10-12"],
    ]);
  });

  it("slices the shorter ranges from the same series", () => {
    const supply = fixture.metrics.stablecoinSupply;
    expect(sliceNetworkRange(supply, "30d")).toHaveLength(30);
    expect(sliceNetworkRange(supply, "90d")).toHaveLength(90);
  });
});
