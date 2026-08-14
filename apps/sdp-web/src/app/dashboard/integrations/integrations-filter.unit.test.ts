import { describe, expect, it } from "vitest";
import { type FilterableIntegration, matchesFilters, NO_FILTERS } from "./integrations-filter";

const ROWS: FilterableIntegration[] = [
  { family: "custody", provider: "privy", label: "Privy", status: "active" },
  { family: "custody", provider: "fireblocks", label: "Fireblocks", status: "request_access" },
  { family: "rpc", provider: "helius", label: "Helius", status: "active" },
  { family: "ramps", provider: "moonpay", label: "MoonPay", status: "enabled" },
];

describe("integration filters", () => {
  it("passes everything through with no filters", () => {
    expect(ROWS.filter((row) => matchesFilters(row, NO_FILTERS))).toHaveLength(4);
  });

  it("narrows by family and by status independently", () => {
    const custody = ROWS.filter((row) => matchesFilters(row, { ...NO_FILTERS, family: "custody" }));
    expect(custody.map((row) => row.provider)).toEqual(["privy", "fireblocks"]);

    const active = ROWS.filter((row) => matchesFilters(row, { ...NO_FILTERS, status: "active" }));
    expect(active.map((row) => row.provider)).toEqual(["privy", "helius"]);
  });

  it("searches label and provider id case-insensitively", () => {
    expect(
      ROWS.filter((row) => matchesFilters(row, { ...NO_FILTERS, query: "MOON" }))
    ).toHaveLength(1);
    expect(
      ROWS.filter((row) => matchesFilters(row, { ...NO_FILTERS, query: "fireb" }))
    ).toHaveLength(1);
    expect(ROWS.filter((row) => matchesFilters(row, { ...NO_FILTERS, query: "  " }))).toHaveLength(
      4
    );
  });

  it("combines all three filter dimensions", () => {
    const filtered = ROWS.filter((row) =>
      matchesFilters(row, { family: "custody", status: "active", query: "priv" })
    );
    expect(filtered.map((row) => row.provider)).toEqual(["privy"]);
  });
});
