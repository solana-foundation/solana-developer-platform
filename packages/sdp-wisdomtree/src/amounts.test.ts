import { describe, expect, it } from "vitest";
import { acceptAtMintScale } from "./amounts";
import { SdpWisdomTreeError } from "./errors";

describe("acceptAtMintScale", () => {
  it("returns the canonical form the instruction encodes", () => {
    expect(acceptAtMintScale("1.500000", 6, "Deposit amount")).toEqual({
      canonical: "1.5",
      baseUnits: 1_500_000n,
    });
    expect(acceptAtMintScale("25", 6, "Deposit amount")).toEqual({
      canonical: "25",
      baseUnits: 25_000_000n,
    });
  });

  it("refuses sub-atomic precision rather than flooring silently", () => {
    expect(() => acceptAtMintScale("1.0000009", 6, "Deposit amount")).toThrowError(
      SdpWisdomTreeError
    );
    // Trailing zeroes past the mint's scale add no precision and are accepted.
    expect(acceptAtMintScale("1.0000000", 6, "Deposit amount").canonical).toBe("1");
  });

  it("refuses zero and non-decimal input", () => {
    for (const bad of ["0", "0.000", "", "1e6", "-1", "1,5", "USDC"]) {
      expect(() => acceptAtMintScale(bad, 6, "Deposit amount")).toThrowError(SdpWisdomTreeError);
    }
  });

  it("rejects adversarially long invalid input in a single pass", () => {
    const bad = `${"1".repeat(50_000)}.${"1".repeat(50_000)}.`;
    expect(() => acceptAtMintScale(bad, 6, "Deposit amount")).toThrowError(SdpWisdomTreeError);
  });

  it("handles quantities beyond 2^53 exactly, up to u64", () => {
    const { baseUnits, canonical } = acceptAtMintScale("18446744073.709551615", 9, "Shares");
    expect(baseUnits).toBe(18_446_744_073_709_551_615n);
    expect(canonical).toBe("18446744073.709551615");
  });

  it("refuses a quantity above u64, which no instruction can encode", () => {
    expect(() => acceptAtMintScale("18446744073.709551616", 9, "Shares")).toThrowError(
      SdpWisdomTreeError
    );
  });
});
