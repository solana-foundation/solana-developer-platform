import { describe, expect, it } from "vitest";
import { addDecimals, floorForTolerance, formatAtoms } from "./decimal.ts";

describe("Embedded Yield decimal helpers", () => {
  it("derives a quote floor without a number round-trip", () => {
    expect(floorForTolerance("25.123456", 6, 50)).toBe("24.997838");
  });

  it("keeps a non-zero floor for the smallest quote", () => {
    expect(floorForTolerance("0.000001", 6, 1_000)).toBe("0.000001");
  });

  it("formats token atoms and sums unequal decimal scales", () => {
    expect(formatAtoms(12_345_600n, 6)).toBe("12.3456");
    expect(addDecimals(["12.34", "0.006", "-2"])).toBe("10.346");
  });

  it("rejects a quote that exceeds the provider scale", () => {
    expect(() => floorForTolerance("1.0000001", 6, 50)).toThrow(
      "reported decimal scale"
    );
  });
});
