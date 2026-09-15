import { describe, expect, it } from "vitest";
import {
  formatAllocationWeight,
  formatKaminoAsOf,
  hasKaminoAllocationContent,
  kaminoAllocationsByWeight,
  kaminoDeployedWeightPct,
  kaminoDisclosureRows,
  kaminoMarketLabel,
} from "./kamino-allocations-format";
import type { KaminoVaultAllocations } from "./kamino-allocations-schema";

function payload(actualPcts: string[], unallocatedPct?: string): KaminoVaultAllocations {
  return {
    allocations: actualPcts.map((actualPct, index) => ({
      reserve: `reserve-${index}`,
      marketName: `Market ${index}`,
      actualPct,
    })),
    ...(unallocatedPct === undefined ? {} : { unallocated: { pct: unallocatedPct } }),
  };
}

describe("formatAllocationWeight", () => {
  it("shows a live sliver as <0.1% instead of a misleading 0.0%", () => {
    expect(formatAllocationWeight("0.02", "en")).toBe("<0.1%");
    expect(formatAllocationWeight("0.049", "en")).toBe("<0.1%");
    expect(formatAllocationWeight("0.05", "en")).toBe("0.1%");
    expect(formatAllocationWeight("0", "en")).toBe("0.0%");
  });

  it("reads percent-unit wire values as percents", () => {
    expect(formatAllocationWeight("23.94", "en")).toBe("23.9%");
    expect(formatAllocationWeight("0.0613", "en")).toBe("0.1%");
    expect(formatAllocationWeight("100", "en")).toBe("100.0%");
  });

  it("keeps an unusable weight a placeholder", () => {
    expect(formatAllocationWeight(undefined, "en")).toBe("—");
    expect(formatAllocationWeight("abc", "en")).toBe("—");
  });

  it("formats in the caller's locale", () => {
    // `Intl` separates the number and % sign with a non-breaking space.
    expect(formatAllocationWeight("23.94", "de")).toBe("23,9\u00A0%");
  });
});

describe("kaminoDeployedWeightPct", () => {
  it("complements the unallocated share as a percent-unit decimal string", () => {
    expect(kaminoDeployedWeightPct("0.061363718634853357161")).toBe("99.938636281365146642839");
    expect(kaminoDeployedWeightPct("0")).toBe("100");
    expect(kaminoDeployedWeightPct("100")).toBe("0");
  });

  it("cannot certify a complement from a missing or malformed share", () => {
    expect(kaminoDeployedWeightPct(undefined)).toBeUndefined();
    expect(kaminoDeployedWeightPct("soon")).toBeUndefined();
  });

  it("refuses a share outside 0-100 rather than projecting it", () => {
    expect(kaminoDeployedWeightPct("-1")).toBeUndefined();
    expect(kaminoDeployedWeightPct("100.5")).toBeUndefined();
  });
});

describe("kaminoAllocationsByWeight", () => {
  it("orders reserves heaviest first", () => {
    const rows = kaminoAllocationsByWeight(payload(["10", "60", "30"]).allocations);
    expect(rows.map((row) => row.marketName)).toEqual(["Market 1", "Market 2", "Market 0"]);
  });

  it("sorts unreadable weights last, preserving provider order among them", () => {
    const rows = kaminoAllocationsByWeight(payload(["n/a", "60", "also-n/a", "10"]).allocations);
    expect(rows.map((row) => row.marketName)).toEqual([
      "Market 1",
      "Market 3",
      "Market 0",
      "Market 2",
    ]);
  });

  it("keeps equal weights in provider order", () => {
    const rows = kaminoAllocationsByWeight(payload(["50", "50", "50"]).allocations);
    expect(rows.map((row) => row.marketName)).toEqual(["Market 0", "Market 1", "Market 2"]);
  });
});

describe("kaminoDisclosureRows", () => {
  it("lists markets heaviest first and the idle share last", () => {
    expect(kaminoDisclosureRows(payload(["10", "60"], "30"))).toEqual([
      { kind: "market", reserve: "reserve-1", marketName: "Market 1", pct: "60" },
      { kind: "market", reserve: "reserve-0", marketName: "Market 0", pct: "10" },
      { kind: "idle", pct: "30" },
    ]);
  });

  it("leaves out a market holding exactly nothing", () => {
    const rows = kaminoDisclosureRows(payload(["0", "99.5", "0.00", "0.5"]));
    expect(rows.map((row) => (row.kind === "market" ? row.marketName : row.kind))).toEqual([
      "Market 1",
      "Market 3",
    ]);
  });

  it("leaves out the idle row when nothing is unallocated, keeps a sliver", () => {
    expect(kaminoDisclosureRows(payload(["100"], "0"))).toHaveLength(1);
    expect(kaminoDisclosureRows(payload(["100"], "0.000"))).toHaveLength(1);
    expect(kaminoDisclosureRows(payload(["99.98"], "0.02")).at(-1)).toEqual({
      kind: "idle",
      pct: "0.02",
    });
  });

  it("keeps an unreadable weight rather than guessing it is nothing", () => {
    expect(kaminoDisclosureRows(payload(["n/a"]))).toHaveLength(1);
  });
});

describe("kaminoMarketLabel", () => {
  it("shortens an unnamed market's address the way SDP shows any address", () => {
    expect(kaminoMarketLabel("Dwg1aeZFYtsyMEkoyJn2ak8oPqaXMWd1uui6FBkM1872")).toBe("Dwg1ae…1872");
  });

  it("leaves a real market name alone", () => {
    expect(kaminoMarketLabel("SOL/BTC Market")).toBe("SOL/BTC Market");
    expect(kaminoMarketLabel("Maple Market")).toBe("Maple Market");
  });
});

describe("hasKaminoAllocationContent", () => {
  it("is true with a market holding capital or an unallocated share", () => {
    expect(hasKaminoAllocationContent(payload(["50"]))).toBe(true);
    expect(hasKaminoAllocationContent({ allocations: [], unallocated: { pct: "100" } })).toBe(true);
  });

  it("is false when there is nothing to list, so the cell stays a placeholder", () => {
    expect(hasKaminoAllocationContent({ allocations: [] })).toBe(false);
    expect(hasKaminoAllocationContent(payload(["0", "0"], "0"))).toBe(false);
    expect(hasKaminoAllocationContent({ allocations: [], unallocated: {} })).toBe(false);
  });
});

describe("formatKaminoAsOf", () => {
  it("renders the provider timestamp in the caller's locale", () => {
    expect(formatKaminoAsOf("2026-09-14T17:53:52.895Z", "en-US")).toMatch(/2026/);
  });

  it("stays silent for a missing or unusable timestamp", () => {
    expect(formatKaminoAsOf(undefined, "en")).toBeUndefined();
    expect(formatKaminoAsOf("yesterday", "en")).toBeUndefined();
  });
});
