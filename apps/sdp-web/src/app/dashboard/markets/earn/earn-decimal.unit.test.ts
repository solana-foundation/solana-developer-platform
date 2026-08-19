import { describe, expect, it } from "vitest";
import { compareUnsignedDecimals, parseUnsignedDecimal } from "./earn-decimal";

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

  it("compares equivalent and arbitrary-magnitude decimals exactly", () => {
    expect(compareUnsignedDecimals("9007199254740993.000001", "9007199254740993")).toBe(1);
    expect(compareUnsignedDecimals("9007199254740993", "9007199254740993.000001")).toBe(-1);
    expect(compareUnsignedDecimals("00012.3400", "12.34")).toBe(0);
    expect(compareUnsignedDecimals("0", "0.000000")).toBe(0);
  });

  it("answers undefined instead of throwing when a side is not a decimal", () => {
    // The shared `compareDecimalAmounts` throws here. Money surfaces read these
    // strings during render, so an unparseable provider figure must disable an
    // affordance, never crash the modal (ADR 0002).
    expect(compareUnsignedDecimals("1", "not-a-decimal")).toBeUndefined();
    expect(compareUnsignedDecimals("not-a-decimal", "1")).toBeUndefined();
    expect(compareUnsignedDecimals("", "1")).toBeUndefined();
  });
});
