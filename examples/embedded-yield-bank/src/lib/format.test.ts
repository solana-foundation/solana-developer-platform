import { describe, expect, it } from "vitest";
import { formatAmount, roundsToZero } from "./format";

describe("Northstar money formatting", () => {
  it("never signs a figure that renders as zero", () => {
    // Veda's share rounding leaves earnings like -0.000002 on a fresh deposit.
    expect(formatAmount("-0.000002", "USDC", { signed: true })).toBe("$0.00");
    expect(formatAmount("0.000002", "USDC", { signed: true })).toBe("$0.00");
    expect(formatAmount("-0", "USDC")).toBe("$0.00");
  });

  it("keeps the sign on figures that render", () => {
    expect(formatAmount("-1.5", "USDC")).toBe("-$1.50");
    expect(formatAmount("0.0003", "USDC", { signed: true })).toBe("+$0.0003");
    expect(formatAmount("-0.0003", "PYUSD")).toBe("-$0.0003");
    expect(formatAmount("2", "SOL", { signed: true })).toBe("+2.00 SOL");
  });

  it("knows which figures render as zero", () => {
    expect(roundsToZero("0")).toBe(true);
    expect(roundsToZero("-0.000002")).toBe(true);
    expect(roundsToZero("0.00005")).toBe(false);
    expect(roundsToZero("-0.01")).toBe(false);
    expect(roundsToZero("not a number")).toBe(false);
  });
});
