import { describe, expect, it } from "vitest";
import {
  addDecimals,
  compareDecimals,
  floorForTolerance,
  formatAtoms,
  multiplyDivideDecimals,
} from "./decimal";

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

  it("compares and scales decimals without floating point", () => {
    expect(compareDecimals("1.10", "1.1")).toBe(0);
    expect(compareDecimals("0.000001", "0.0000009")).toBe(1);
    expect(multiplyDivideDecimals("11", "100", "110", 6)).toBe("10");
    expect(multiplyDivideDecimals("1", "3", "7", 6)).toBe("0.428571");
  });

  it("rejects a quote that exceeds the provider scale", () => {
    expect(() => floorForTolerance("1.0000001", 6, 50)).toThrow(
      "reported decimal scale"
    );
  });
});
