import { describe, expect, it } from "vitest";
import { acceptAtMintScale, acceptPositiveAtMintScale, mintDecimals } from "./amounts";

const USDC_DECIMALS = 6;

describe("acceptAtMintScale", () => {
  it("returns both the atoms encoded and the canonical decimal form", () => {
    expect(acceptAtMintScale("amount", "1.5", USDC_DECIMALS)).toEqual({
      baseUnits: 1_500_000n,
      canonical: "1.5",
    });
  });

  /**
   * Scale is a property of the VALUE, not its spelling: trailing fractional
   * zeros need no atoms. Refusing `1.5000000` on a six-decimal mint would be
   * refusing a number the mint represents exactly.
   */
  it("accepts trailing zeros beyond the mint's scale", () => {
    expect(acceptAtMintScale("amount", "1.5000000", USDC_DECIMALS).baseUnits).toBe(1_500_000n);
    expect(acceptAtMintScale("amount", "1.5000000", USDC_DECIMALS).canonical).toBe("1.5");
  });

  /**
   * THE BUG THIS EXISTS TO PREVENT. Rounding `1.0000009` down would record
   * 1.0000009 in the ledger while 1.000000 moved on chain, and the ledger is
   * what a customer is later shown. Refusing keeps the two equal.
   */
  it("refuses a non-zero sub-atom rather than rounding it away", () => {
    expect(() => acceptAtMintScale("amount", "1.0000009", USDC_DECIMALS)).toThrow(
      /more precision than its mint supports/
    );
  });

  it("refuses anything that is not a plain positive decimal", () => {
    for (const value of ["-1", "1e5", "Infinity", "", " ", "abc", "1.2.3"]) {
      expect(() => acceptAtMintScale("amount", value, USDC_DECIMALS), value).toThrow(
        /positive decimal string/
      );
    }
  });

  /**
   * Scale-valid decimals can still overflow the u64 Veda encodes. Caught here
   * rather than inside the SDK's own `assertU64`, which only fires after
   * several RPC round trips — far from the caller that can fix it.
   */
  it("refuses a value beyond the u64 the instruction encodes", () => {
    const maxU64 = (1n << 64n) - 1n;
    const atMax = `${maxU64 / 1_000_000n}.${(maxU64 % 1_000_000n).toString().padStart(6, "0")}`;
    expect(acceptAtMintScale("amount", atMax, USDC_DECIMALS).baseUnits).toBe(maxU64);
    expect(() => acceptAtMintScale("amount", "18446744073710", USDC_DECIMALS)).toThrow(
      /maximum unsigned 64-bit/
    );
  });

  it("accepts zero, which the positive variant is what refuses", () => {
    expect(acceptAtMintScale("amount", "0.000000", USDC_DECIMALS)).toEqual({
      baseUnits: 0n,
      canonical: "0",
    });
  });
});

describe("acceptPositiveAtMintScale", () => {
  /**
   * A `minSharesOut` of zero is worse than no floor at all: it reads as
   * protection in the request, the ledger and the UI while imposing none on
   * chain, which also suppresses anyone's suspicion that protection is missing.
   */
  it("refuses every spelling of zero", () => {
    for (const value of ["0", "0.0", "0.000000"]) {
      expect(() => acceptPositiveAtMintScale("minSharesOut", value, USDC_DECIMALS), value).toThrow(
        /positive decimal string/
      );
    }
  });

  it("passes a positive value through unchanged", () => {
    expect(acceptPositiveAtMintScale("minSharesOut", "0.000001", USDC_DECIMALS)).toEqual({
      baseUnits: 1n,
      canonical: "0.000001",
    });
  });
});

describe("mintDecimals", () => {
  it("accepts a plausible mint scale in whatever shape it arrives", () => {
    expect(mintDecimals(6, "x")).toBe(6);
    expect(mintDecimals("9", "x")).toBe(9);
    expect(mintDecimals(0, "x")).toBe(0);
  });

  /**
   * `Number("")` is 0, so a missing field would otherwise arrive as a perfectly
   * plausible zero-decimal mint and disable every scale check downstream. That
   * is the failure this refuses, and it is why the check is a digit match
   * rather than a numeric parse.
   */
  it("refuses a missing, non-numeric or impossible value", () => {
    for (const value of [undefined, null, "", " ", "six", -1, 1.5, 10, 255]) {
      expect(() => mintDecimals(value, "x"), String(value)).toThrow(/usable mint decimal count/);
    }
  });
});
