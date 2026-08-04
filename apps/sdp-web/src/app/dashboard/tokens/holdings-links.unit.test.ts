import { describe, expect, it } from "vitest";
import { tokenActivityHref } from "./holdings-links";

describe("tokenActivityHref", () => {
  it("deep links into the existing transactions filter rather than a new surface", () => {
    // The transactions page already filters by asset; Aaron's per-token history
    // ask was a discoverability gap, not a missing feature.
    expect(tokenActivityHref("USDC")).toBe("/dashboard/payments/transactions?asset=USDC");
  });

  it("encodes symbols that are not URL safe", () => {
    expect(tokenActivityHref("A B&C")).toBe("/dashboard/payments/transactions?asset=A%20B%26C");
  });

  it("stays within the filter's 64 character bound", () => {
    const href = tokenActivityHref("X".repeat(200));
    const asset = new URL(href, "http://x").searchParams.get("asset") ?? "";
    expect(asset.length).toBe(64);
  });

  it("falls back to the unfiltered table when there is no symbol to filter on", () => {
    expect(tokenActivityHref("")).toBe("/dashboard/payments/transactions");
  });
});
