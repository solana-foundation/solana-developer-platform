import { describe, expect, it } from "vitest";
import {
  formatAllocationApy,
  formatAllocationWeight,
  formatKaminoAsOf,
  hasKaminoAllocationContent,
  kaminoAllocationsByWeight,
  kaminoDeployedWeightPct,
} from "./kamino-allocations-format";
import type { KaminoVaultAllocations } from "./kamino-allocations-schema";

function payload(actualPcts: string[]): KaminoVaultAllocations {
  return {
    allocations: actualPcts.map((actualPct, index) => ({
      reserve: `reserve-${index}`,
      marketName: `Market ${index}`,
      symbol: `T${index}`,
      actualPct,
    })),
  };
}

describe("formatAllocationWeight", () => {
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

describe("formatAllocationApy", () => {
  it("reads decimal-fraction wire values as percents", () => {
    expect(formatAllocationApy("0.044979844106186606", "en")).toBe("4.5%");
    expect(formatAllocationApy("0", "en")).toBe("0.0%");
  });

  it("keeps an unusable rate a placeholder", () => {
    expect(formatAllocationApy(undefined, "en")).toBe("—");
    expect(formatAllocationApy("n/a", "en")).toBe("—");
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
    expect(rows.map((row) => row.symbol)).toEqual(["T1", "T2", "T0"]);
  });

  it("sorts unreadable weights last, preserving provider order among them", () => {
    const rows = kaminoAllocationsByWeight(payload(["n/a", "60", "also-n/a", "10"]).allocations);
    expect(rows.map((row) => row.symbol)).toEqual(["T1", "T3", "T0", "T2"]);
  });

  it("keeps equal weights in provider order", () => {
    const rows = kaminoAllocationsByWeight(payload(["50", "50", "50"]).allocations);
    expect(rows.map((row) => row.symbol)).toEqual(["T0", "T1", "T2"]);
  });
});

describe("hasKaminoAllocationContent", () => {
  it("is true with reserve rows or an unallocated share", () => {
    expect(hasKaminoAllocationContent(payload(["50"]))).toBe(true);
    expect(hasKaminoAllocationContent({ allocations: [], unallocated: { pct: "100" } })).toBe(true);
  });

  it("is false for an empty read, so the cell stays a placeholder", () => {
    expect(hasKaminoAllocationContent({ allocations: [] })).toBe(false);
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
