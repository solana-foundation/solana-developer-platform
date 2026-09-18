import { describe, expect, it } from "vitest";
import { acceptAtMintScale, formatBaseUnits } from "./amounts";
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

  it("handles quantities beyond 2^53 exactly", () => {
    const { baseUnits, canonical } = acceptAtMintScale("92233720368.547758079", 9, "Shares");
    expect(baseUnits).toBe(92_233_720_368_547_758_079n);
    expect(canonical).toBe("92233720368.547758079");
  });
});

describe("formatBaseUnits", () => {
  it('serializes exactly, zero as "0", no trailing fractional zeroes', () => {
    expect(formatBaseUnits(0n, 9)).toBe("0");
    expect(formatBaseUnits(1n, 9)).toBe("0.000000001");
    expect(formatBaseUnits(37_969_751_026n, 9)).toBe("37.969751026");
    expect(formatBaseUnits(1_500_000n, 6)).toBe("1.5");
  });
});
