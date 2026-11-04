import { describe, expect, it } from "vitest";
import { type FilterableIntegration, matchesFilters, NO_FILTERS } from "./integrations-filter";

const ROWS: FilterableIntegration[] = [
  { family: "custody", provider: "privy", label: "Privy", status: "active" },
  { family: "custody", provider: "fireblocks", label: "Fireblocks", status: "available" },
  { family: "privacy", provider: "private-channels", label: "Private Channels", status: "active" },
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
    expect(connected.map((row) => row.provider)).toEqual(["privy", "private-channels", "moonpay"]);
  });

  it("selects only the providers that are off for not connected", () => {
    const notConnected = ROWS.filter((row) =>
      matchesFilters(row, { ...NO_FILTERS, status: "not_connected" })
    );
    expect(notConnected.map((row) => row.provider)).toEqual(["fireblocks"]);
  });

  it("keeps a provider of unknown state out of both on and off", () => {
    const unread: FilterableIntegration = {
      family: "privacy",
      provider: "private-channels",
      label: "Private Channels",
      status: "unknown",
    };

    expect(matchesFilters(unread, { ...NO_FILTERS, status: "connected" })).toBe(false);
    expect(matchesFilters(unread, { ...NO_FILTERS, status: "not_connected" })).toBe(false);
    expect(matchesFilters(unread, NO_FILTERS)).toBe(true);
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
