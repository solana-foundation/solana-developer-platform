import { describe, expect, it } from "vitest";
import { earnMovementsProxyQuery } from "./provider-query";

describe("earnMovementsProxyQuery", () => {
  it.each([
    ["unknown parameter", "?unknown=value"],
    ["duplicate parameter", "?limit=1&limit=2"],
    ["invalid limit", "?limit=0"],
    ["invalid cursor", "?before=*"],
    ["invalid direction", "?direction=sideways"],
    ["invalid filter", "?provider=*"],
  ])("uses the customer-facing product name for an %s error", (_name, query) => {
    const result = earnMovementsProxyQuery(new Request(`https://dashboard.example.com/${query}`));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Embedded Yield movements");
    expect(result.message).not.toMatch(/\bEarn\b/i);
  });
});
