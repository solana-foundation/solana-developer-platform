import { describe, expect, it } from "vitest";
import {
  formatNetworkChange,
  formatNetworkValue,
  networkChange,
  networkChangeTone,
  niceNetworkTicks,
  sliceNetworkRange,
} from "./network-stats";
import { NETWORK_STATS_FIXTURE } from "./network-stats.fixture";

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
});

describe("changes", () => {
  it("signs a change with a true minus", () => {
    expect(formatNetworkChange(0.297, "en")).toBe("+29.7%");
    expect(formatNetworkChange(-0.636, "en")).toBe("−63.6%");
  });

  it("reads a falling cost as good news and a falling supply as bad", () => {
    expect(networkChangeTone(-0.636, false)).toBe("positive");
    expect(networkChangeTone(-0.1, true)).toBe("critical");
    expect(networkChangeTone(0, true)).toBe("neutral");
  });

  it("measures a change from the first point to the last", () => {
    expect(
      networkChange([
        { date: "2026-01-01", value: 10 },
        { date: "2026-01-02", value: 15 },
      ])
    ).toBe(0.5);
    expect(networkChange([])).toBeNull();
  });
});

describe("the design-review fixture", () => {
  it("lands on the prototype's year figures", () => {
    const figures = NETWORK_STATS_FIXTURE.metrics.map((metric) => {
      const points = sliceNetworkRange(metric.points, "1y");
      return [
        metric.id,
        formatNetworkValue(points.at(-1)?.value ?? 0, metric.format, "en", "headline"),
        formatNetworkChange(networkChange(points) ?? 0, "en"),
        points[0]?.date,
        points.at(-1)?.date,
      ];
    });
    expect(figures).toEqual([
      ["stablecoinSupply", "$16.27B", "+29.7%", "2025-09-26", "2026-09-25"],
      ["stablecoinTransfers", "18.90M", "+160.6%", "2025-09-26", "2026-09-25"],
      ["stablecoinShare", "18.3%", "+52.3%", "2025-09-26", "2026-09-25"],
      ["costPerTransaction", "$0.0063", "−63.6%", "2025-09-26", "2026-09-25"],
    ]);
  });

  it("slices the shorter ranges from the same series", () => {
    const [supply] = NETWORK_STATS_FIXTURE.metrics;
    expect(sliceNetworkRange(supply?.points ?? [], "30d")).toHaveLength(30);
    expect(sliceNetworkRange(supply?.points ?? [], "90d")).toHaveLength(90);
  });
});
