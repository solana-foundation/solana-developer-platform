import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countActiveIssuanceFilters,
  DEFAULT_ISSUANCE_FILTERS,
  filterAndSortTokens,
  type IssuanceFilterState,
} from "./issuance-filter-popover";
import type { IssuanceTokenView } from "./issuance-token-fields";

function token(overrides: Partial<IssuanceTokenView> = {}): IssuanceTokenView {
  return {
    id: "tok",
    name: "Token",
    symbol: "TKN",
    status: "active",
    template: "stablecoin",
    imageUrl: null,
    mintAddress: null,
    totalSupply: "0",
    createdAt: "2026-07-20",
    deployedAt: null,
    decimals: 6,
    maxSupply: null,
    isMintable: true,
    isFreezable: true,
    requiresAllowlist: false,
    description: null,
    uri: null,
    signingWalletId: null,
    assetProfile: null,
    ...overrides,
  };
}

// draft (no mint/deploy), 2 days old, stablecoin.
const draftRecent = token({ id: "A", name: "Zebra", createdAt: "2026-07-20" });
// active (has mint), ~7 weeks old, custom.
const activeMid = token({
  id: "B",
  name: "Alpha",
  template: "custom",
  mintAddress: "Mint111",
  createdAt: "2026-06-01",
});
// active (deployed), >1 year old, stablecoin.
const activeOld = token({
  id: "C",
  name: "Mango",
  deployedAt: "2025-01-02",
  createdAt: "2025-01-01",
});

const all = [draftRecent, activeMid, activeOld];

function withFilters(changes: Partial<IssuanceFilterState>): IssuanceFilterState {
  return { ...DEFAULT_ISSUANCE_FILTERS, ...changes };
}

function ids(tokens: IssuanceTokenView[]): string[] {
  return tokens.map((tokenView) => tokenView.id);
}

describe("filterAndSortTokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to newest-first, no filtering", () => {
    expect(ids(filterAndSortTokens(all, DEFAULT_ISSUANCE_FILTERS))).toEqual(["A", "B", "C"]);
  });

  it("filters by deployment status", () => {
    expect(ids(filterAndSortTokens(all, withFilters({ status: "draft" })))).toEqual(["A"]);
    expect(ids(filterAndSortTokens(all, withFilters({ status: "active" })))).toEqual(["B", "C"]);
  });

  it("filters by template", () => {
    expect(ids(filterAndSortTokens(all, withFilters({ template: "stablecoin" })))).toEqual([
      "A",
      "C",
    ]);
    expect(ids(filterAndSortTokens(all, withFilters({ template: "custom" })))).toEqual(["B"]);
  });

  it("filters by created-date window", () => {
    expect(ids(filterAndSortTokens(all, withFilters({ date: "7d" })))).toEqual(["A"]);
    expect(ids(filterAndSortTokens(all, withFilters({ date: "30d" })))).toEqual(["A"]);
    expect(ids(filterAndSortTokens(all, withFilters({ date: "12m" })))).toEqual(["A", "B"]);
  });

  it("sorts by each option", () => {
    expect(ids(filterAndSortTokens(all, withFilters({ sort: "oldest" })))).toEqual(["C", "B", "A"]);
    expect(ids(filterAndSortTokens(all, withFilters({ sort: "name-asc" })))).toEqual([
      "B",
      "C",
      "A",
    ]);
    expect(ids(filterAndSortTokens(all, withFilters({ sort: "name-desc" })))).toEqual([
      "A",
      "C",
      "B",
    ]);
  });

  it("combines filters", () => {
    expect(
      ids(filterAndSortTokens(all, withFilters({ status: "active", template: "stablecoin" })))
    ).toEqual(["C"]);
  });

  it("does not mutate the input array", () => {
    const input = [...all];
    filterAndSortTokens(input, withFilters({ sort: "oldest" }));
    expect(ids(input)).toEqual(["A", "B", "C"]);
  });
});

describe("countActiveIssuanceFilters", () => {
  it("counts only narrowing filters, not sort", () => {
    expect(countActiveIssuanceFilters(DEFAULT_ISSUANCE_FILTERS)).toBe(0);
    expect(countActiveIssuanceFilters(withFilters({ sort: "oldest" }))).toBe(0);
    expect(countActiveIssuanceFilters(withFilters({ status: "draft" }))).toBe(1);
    expect(
      countActiveIssuanceFilters(withFilters({ status: "draft", template: "custom", date: "7d" }))
    ).toBe(3);
  });
});
