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

    // "Connected" selects everything the catalog paints as connected, which is
    // both ways a provider can be on: `active` per organization and `enabled`
    // deployment-wide. Matching `active` alone hid MoonPay behind a chip whose
    // colour it already carried.
    const connected = ROWS.filter((row) =>
      matchesFilters(row, { ...NO_FILTERS, status: "connected" })
    );
    expect(connected.map((row) => row.provider)).toEqual(["privy", "helius", "moonpay"]);
  });

  it("folds the two off states into one chip", () => {
    // `available` and `not_configured` both mean "not running"; the difference
    // is whether it could be switched on, which is the detail page's business.
    const rows: FilterableIntegration[] = [
      { family: "rpc", provider: "alchemy", label: "Alchemy", status: "not_configured" },
      { family: "custody", provider: "turnkey", label: "Turnkey", status: "available" },
    ];

    expect(
      rows.filter((row) => matchesFilters(row, { ...NO_FILTERS, status: "not_connected" }))
    ).toHaveLength(2);
  });

  it("keeps a request-only provider out of both on and off", () => {
    const gated: FilterableIntegration = {
      family: "custody",
      provider: "fireblocks",
      label: "Fireblocks",
      status: "request_access",
    };

    expect(matchesFilters(gated, { ...NO_FILTERS, status: "connected" })).toBe(false);
    expect(matchesFilters(gated, { ...NO_FILTERS, status: "not_connected" })).toBe(false);
    expect(matchesFilters(gated, { ...NO_FILTERS, status: "on_request" })).toBe(true);
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
      matchesFilters(row, { family: "custody", status: "connected", query: "priv" })
    );
    expect(filtered.map((row) => row.provider)).toEqual(["privy"]);
  });
});
