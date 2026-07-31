import { describe, expect, it } from "vitest";
import { getAmountError } from "./amount-validation";

describe("getAmountError", () => {
  it.each([
    "1",
    "1.25",
    ".5",
    "1.",
    "0.000001",
    " 2.5 ",
  ])("accepts backend-compatible positive USDC amount %s", (amount) => {
    expect(getAmountError(amount)).toBeNull();
  });

  it("requires an amount", () => {
    expect(getAmountError("")).toBe("DashboardPrivateChannels.common.amountRequired");
    expect(getAmountError("   ")).toBe("DashboardPrivateChannels.common.amountRequired");
  });

  it.each([
    "0",
    "0.000000",
    "-1",
    "1.0000001",
    "1e2",
    "0x10",
    "1..2",
    "USDC 1",
  ])("rejects backend-incompatible amount %s", (amount) => {
    expect(getAmountError(amount)).toBe("DashboardPrivateChannels.common.amountInvalid");
  });
});
