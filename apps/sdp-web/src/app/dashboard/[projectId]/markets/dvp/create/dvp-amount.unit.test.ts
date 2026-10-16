import { describe, expect, it } from "vitest";
import { toBaseUnits } from "./dvp-amount";

describe("toBaseUnits", () => {
  it("scales a whole amount by the mint's decimals", () => {
    expect(toBaseUnits("10", 6)).toEqual({ ok: true, baseUnits: "10000000" });
    expect(toBaseUnits("1", 9)).toEqual({ ok: true, baseUnits: "1000000000" });
  });

  it("scales a fractional amount", () => {
    expect(toBaseUnits("10.5", 6)).toEqual({ ok: true, baseUnits: "10500000" });
    expect(toBaseUnits("0.000001", 6)).toEqual({ ok: true, baseUnits: "1" });
  });

  it("passes a zero-decimal mint through unchanged", () => {
    expect(toBaseUnits("1000", 0)).toEqual({ ok: true, baseUnits: "1000" });
  });

  it("handles zero", () => {
    expect(toBaseUnits("0", 6)).toEqual({ ok: true, baseUnits: "0" });
  });

  // Truncating would move a different amount than the one on screen, which is
  // the one thing a money form must never do quietly.
  it("refuses more precision than the mint supports", () => {
    expect(toBaseUnits("1.9999999", 6)).toEqual({ ok: false, reason: "too-precise" });
    expect(toBaseUnits("0.1", 0)).toEqual({ ok: false, reason: "too-precise" });
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const input of ["", ".", "abc", "1e9", "-1", "1.2.3", "1,000"]) {
      expect(toBaseUnits(input, 6).ok).toBe(false);
    }
  });

  // All string arithmetic. Going through Number would round this to
  // 18446744073709552000 and silently move a different amount.
  it("keeps precision far above 2^53", () => {
    const result = toBaseUnits("18446744073709.551615", 6);

    expect(result).toEqual({ ok: true, baseUnits: "18446744073709551615" });
  });
});
