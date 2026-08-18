import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { SdpKaminoError } from "./errors";
import { requireNonNegativeFiniteDecimal } from "./sdk";

describe("requireNonNegativeFiniteDecimal", () => {
  it.each([
    [new Decimal("1.25"), "1.25"],
    ["9007199254740993.000001", "9007199254740993.000001"],
    [0, "0"],
  ])("accepts observed non-negative values exactly", (value, expected) => {
    expect(requireNonNegativeFiniteDecimal("test value", value).toFixed()).toBe(expected);
  });

  it.each([undefined, null, "NaN", Number.POSITIVE_INFINITY, "-0.1"])(
    "rejects malformed or negative observed value %s",
    (value) => {
      expect(() => requireNonNegativeFiniteDecimal("test value", value)).toThrow(SdpKaminoError);
      expect(() => requireNonNegativeFiniteDecimal("test value", value)).toThrow(
        /finite non-negative decimal/
      );
    }
  );
});
