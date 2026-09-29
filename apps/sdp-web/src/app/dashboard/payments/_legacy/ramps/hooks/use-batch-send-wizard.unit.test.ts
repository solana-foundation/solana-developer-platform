import { describe, expect, it } from "vitest";
import { sumBatchAmounts } from "./use-batch-send-wizard";

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
