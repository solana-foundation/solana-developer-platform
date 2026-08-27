import { describe, expect, it } from "vitest";
import { formatBaseUnitAmount } from "./helius-rings.utils";

describe("formatBaseUnitAmount", () => {
  it("groups a zero-decimal uint without losing precision", () => {
    expect(formatBaseUnitAmount("18446744073709551615", 0, "en")).toBe(
      "18,446,744,073,709,551,615"
    );
  });

  it("places the decimal point exactly and trims insignificant zeros", () => {
    expect(formatBaseUnitAmount("001234500", 6, "en")).toBe("1.2345");
    expect(formatBaseUnitAmount("1000000", 6, "en")).toBe("1");
  });

  it("keeps leading fractional zeros", () => {
    expect(formatBaseUnitAmount("42", 6, "en")).toBe("0.000042");
  });

  it("formats a very large fractional value without Number conversion", () => {
    expect(formatBaseUnitAmount("18446744073709551615", 9, "en")).toBe("18,446,744,073.709551615");
  });

  it.each(["", " ", "-1", "+1", "1.0", "1e3", "not-a-number"])(
    "fails closed for malformed raw amount %j",
    (amountRaw) => {
      expect(formatBaseUnitAmount(amountRaw, 6, "en")).toBeNull();
    }
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 256])(
    "fails closed for invalid decimals %j",
    (decimals) => {
      expect(formatBaseUnitAmount("1", decimals, "en")).toBeNull();
    }
  );
});
