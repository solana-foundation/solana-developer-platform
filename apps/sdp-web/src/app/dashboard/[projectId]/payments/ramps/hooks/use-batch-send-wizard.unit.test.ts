import { describe, expect, it } from "vitest";
import {
  belowRentMinimumByAccount,
  sourceBelowRentMinimum,
  sumBatchAmounts,
} from "./use-batch-send-wizard";

describe("sumBatchAmounts", () => {
  it("sums without float artifacts", () => {
    expect(sumBatchAmounts(["0.05", "0.05", "0.05"])).toBe("0.15");
    expect(sumBatchAmounts(["0.1", "0.2"])).toBe("0.3");
  });

  it("is exact at the 9-decimal boundary", () => {
    expect(sumBatchAmounts(["123456.123456789", "0.000000001"])).toBe("123456.12345679");
  });

  it("skips entries still being typed", () => {
    expect(sumBatchAmounts(["0.05", "", "0.", "abc"])).toBe("0.05");
  });

  it("returns 0 for an empty batch", () => {
    expect(sumBatchAmounts([])).toBe("0");
  });
});

describe("belowRentMinimumByAccount", () => {
  const requestRecipients = [
    { counterpartyAccountId: "cpa_a" },
    { counterpartyAccountId: "cpa_b" },
    { counterpartyAccountId: "cpa_c" },
  ];
  const warning = (recipientIndex: number) => ({
    code: "AMOUNT_BELOW_RENT_MINIMUM" as const,
    recipientIndex,
    minimumAmount: "0.00089088",
    message: "below minimum",
  });

  it("keys warnings by the account at their index in the canonical request", () => {
    expect(belowRentMinimumByAccount([warning(2), warning(0)], requestRecipients)).toEqual(
      new Map([
        ["cpa_c", "0.00089088"],
        ["cpa_a", "0.00089088"],
      ])
    );
  });

  it("is empty for an estimate without warnings", () => {
    expect(belowRentMinimumByAccount([], requestRecipients).size).toBe(0);
  });

  it("fails loudly on an index the request does not have", () => {
    expect(() => belowRentMinimumByAccount([warning(7)], requestRecipients)).toThrow("recipient 7");
  });
});

describe("sourceBelowRentMinimum", () => {
  it("reads the source warning and ignores recipient warnings", () => {
    expect(
      sourceBelowRentMinimum([
        {
          code: "AMOUNT_BELOW_RENT_MINIMUM",
          recipientIndex: 0,
          minimumAmount: "0.00089088",
          message: "below minimum",
        },
        {
          code: "SOURCE_BELOW_RENT_MINIMUM",
          sourceRemainder: "0.0003",
          minimumAmount: "0.00089088",
          message: "source below minimum",
        },
      ])
    ).toEqual({ sourceRemainder: "0.0003", minimumAmount: "0.00089088" });
  });

  it("is null without a source warning", () => {
    expect(sourceBelowRentMinimum([])).toBeNull();
  });
});
