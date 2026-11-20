import { describe, expect, it } from "vitest";
import { strategyOutputFloor, strategySharesForTokenAmount } from "./strategy-terms";

describe("strategy execution amounts", () => {
  it("rounds output protection down at the actual mint scale", () => {
    expect(strategyOutputFloor("1.000001", 6, 50)).toBe("0.995");
    expect(strategyOutputFloor("1.000001", 6, 0)).toBe("1.000001");
  });

  it("rejects floors with no positive atomic unit", () => {
    expect(() => strategyOutputFloor("0.000001", 6, 1)).toThrow("too small");
    expect(() => strategyOutputFloor("1", 6, 501)).toThrow("slippageBps");
  });

  it("sizes token withdrawals with exact integer division", () => {
    expect(
      strategySharesForTokenAmount({
        shares: "10",
        tokenValue: "30",
        tokenAmount: "1",
        shareDecimals: 6,
      })
    ).toBe("0.333333");
  });

  it("preserves large balances without floating point rounding", () => {
    expect(
      strategySharesForTokenAmount({
        shares: "9007199254.740993",
        tokenValue: "18014398509.481986",
        tokenAmount: "9007199254.740993",
        shareDecimals: 6,
      })
    ).toBe("4503599627.370496");
  });

  it("refuses an amount above the live holding instead of capping silently", () => {
    expect(() =>
      strategySharesForTokenAmount({
        shares: "1",
        tokenValue: "2",
        tokenAmount: "2.000001",
        shareDecimals: 6,
      })
    ).toThrow("exceeds");
  });

  it("does not round a sub-unit token withdrawal up", () => {
    expect(() =>
      strategySharesForTokenAmount({
        shares: "0.000001",
        tokenValue: "10",
        tokenAmount: "1",
        shareDecimals: 6,
      })
    ).toThrow("one strategy share unit");
  });
});
