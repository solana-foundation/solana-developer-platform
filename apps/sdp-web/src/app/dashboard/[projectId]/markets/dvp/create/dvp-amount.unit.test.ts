import { describe, expect, it } from "vitest";
import { amountToBaseUnits } from "./dvp-amount";

describe("amountToBaseUnits", () => {
  it("scales a whole amount by the mint's decimals", () => {
    expect(amountToBaseUnits("10", 6)).toEqual({ ok: true, baseUnits: "10000000" });
    expect(amountToBaseUnits("1", 9)).toEqual({ ok: true, baseUnits: "1000000000" });
  });

  it("scales a fractional amount", () => {
    expect(amountToBaseUnits("10.5", 6)).toEqual({ ok: true, baseUnits: "10500000" });
    expect(amountToBaseUnits("0.000001", 6)).toEqual({ ok: true, baseUnits: "1" });
  });

  it("passes a zero-decimal mint through unchanged", () => {
    expect(amountToBaseUnits("1000", 0)).toEqual({ ok: true, baseUnits: "1000" });
  });

  it("handles zero", () => {
    expect(amountToBaseUnits("0", 6)).toEqual({ ok: true, baseUnits: "0" });
  });

  // Truncating would move a different amount than the one on screen, which is
  // the one thing a money form must never do quietly.
  it("refuses more precision than the mint supports", () => {
    expect(amountToBaseUnits("1.9999999", 6)).toEqual({ ok: false, reason: "too-precise" });
    expect(amountToBaseUnits("0.1", 0)).toEqual({ ok: false, reason: "too-precise" });
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const input of ["", ".", "abc", "1e9", "-1", "1.2.3", "1,000"]) {
      expect(amountToBaseUnits(input, 6).ok).toBe(false);
    }
  });

  // All string arithmetic. Going through Number would round this to
  // 18446744073709552000 and silently move a different amount.
  it("keeps precision far above 2^53", () => {
    const result = amountToBaseUnits("18446744073709.551615", 6);

    expect(result).toEqual({ ok: true, baseUnits: "18446744073709551615" });
  });

  // No token account holds more than u64 base units, so no leg can move it.
  it("refuses an amount above u64", () => {
    expect(amountToBaseUnits("18446744073709.551616", 6)).toEqual({
      ok: false,
      reason: "out-of-range",
    });
  });
});
