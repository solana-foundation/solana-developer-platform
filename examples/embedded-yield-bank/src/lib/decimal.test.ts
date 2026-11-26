import { describe, expect, it } from "vitest";
import { addDecimals, formatAtoms, isPositiveDecimal } from "./decimal";

describe("exact decimal arithmetic", () => {
  it("formats token atoms and sums unequal decimal scales", () => {
    expect(formatAtoms(12_345_600n, 6)).toBe("12.3456");
    expect(addDecimals(["12.34", "0.006", "-2"])).toBe("10.346");
  });
  it("retains precision above the JavaScript integer limit", () => {
    expect(
      addDecimals(["9007199254740993.000001", "0.000001", "-9007199254740993"])
    ).toBe("0.000002");
    expect(addDecimals(["0.000001", "-0.000002"])).toBe("-0.000001");
  });
  it("requires a positive ordinary decimal for transfer intent", () => {
    expect(isPositiveDecimal("0.000001")).toBe(true);
    for (const amount of ["0", "-1", "NaN", "1e2", "1."])
      expect(isPositiveDecimal(amount)).toBe(false);
    expect(() => addDecimals(["1e2"])).toThrow("Invalid decimal");
  });
});
