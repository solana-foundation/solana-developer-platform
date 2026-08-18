import { describe, expect, it } from "vitest";
import {
  compareUnsignedDecimals,
  parseUnsignedDecimal,
  unsignedDecimalScale,
} from "./earn-decimal";

describe("Earn unsigned decimal utilities", () => {
  it("validates syntax and canonicalizes without converting through a number", () => {
    expect(parseUnsignedDecimal(" 0009007199254740993.230000 ")).toEqual({
      canonical: "9007199254740993.23",
      whole: "9007199254740993",
      fraction: "230000",
    });
    expect(parseUnsignedDecimal(" 1 ", { trim: false })).toBeUndefined();
    expect(parseUnsignedDecimal("123", { maxLength: 2 })).toBeUndefined();
    for (const value of ["", "-1", "+1", ".5", "1.", "1e3", "NaN"]) {
      expect(parseUnsignedDecimal(value)).toBeUndefined();
    }
  });

  it("reports raw or significant fractional scale", () => {
    const decimal = parseUnsignedDecimal("1.230000");
    expect(decimal).toBeDefined();
    if (!decimal) return;

    expect(unsignedDecimalScale(decimal)).toBe(6);
    expect(unsignedDecimalScale(decimal, { ignoreTrailingZeros: true })).toBe(2);
  });

  it("compares equivalent and arbitrary-magnitude decimals exactly", () => {
    expect(compareUnsignedDecimals("9007199254740993.000001", "9007199254740993")).toBe(1);
    expect(compareUnsignedDecimals("9007199254740993", "9007199254740993.000001")).toBe(-1);
    expect(compareUnsignedDecimals("00012.3400", "12.34")).toBe(0);
    expect(compareUnsignedDecimals("0", "0.000000")).toBe(0);
    expect(compareUnsignedDecimals("1", "not-a-decimal")).toBeUndefined();
  });
});
