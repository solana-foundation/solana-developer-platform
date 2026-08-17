import { formatDecimalAmount } from "@sdp/solana/amount";
import { describe, expect, it } from "vitest";
import { acceptAtMintScale, isZeroAmount, mintDecimals } from "./amounts";
import { SdpKaminoError } from "./errors";

describe("acceptAtMintScale", () => {
  it("accepts a value the mint can represent exactly and canonicalises it", () => {
    expect(acceptAtMintScale("amount", "1.5", 6)).toBe("1.5");
    // Trailing zeros are noise, not precision — "1.500" and "1.5" are the same
    // number of atoms, and the ledger should hold one spelling.
    expect(acceptAtMintScale("amount", "1.500000", 6)).toBe("1.5");
    // The spelling may have more places than the mint when every extra place
    // is zero. Precision is determined after insignificant zeros are removed.
    expect(acceptAtMintScale("amount", "1.5000000", 6)).toBe("1.5");
    expect(acceptAtMintScale("amount", "0.0000010", 6)).toBe("0.000001");
    expect(acceptAtMintScale("amount", "1.000000000000", 6)).toBe("1");
    expect(acceptAtMintScale("amount", "  20  ", 6)).toBe("20");
    expect(acceptAtMintScale("amount", "0.000001", 6)).toBe("0.000001");
  });

  /**
   * THE BUG THIS MODULE EXISTS FOR.
   *
   * klend-sdk floors to mint atoms, so `1.0000009` on a six-decimal mint would
   * be recorded as 1.0000009 while 1.000000 actually moves. Refusing keeps the
   * recorded number and the encoded number equal.
   */
  it("refuses a value finer than the mint's atom", () => {
    expect(() => acceptAtMintScale("amount", "1.0000009", 6)).toThrow(SdpKaminoError);
    expect(() => acceptAtMintScale("amount", "1.0000009", 6)).toThrow(/more precision/);
    // One decimal past the boundary is still past it.
    expect(() => acceptAtMintScale("amount", "0.0000001", 6)).toThrow(SdpKaminoError);
    // A trailing zero does not erase the preceding non-zero sub-atom.
    expect(() => acceptAtMintScale("amount", "0.00000010", 6)).toThrow(SdpKaminoError);
  });

  /**
   * The sharper half: a sub-atom `minSharesOut` floors to zero, so a request
   * that LOOKS protected gets no on-chain floor at all.
   */
  it("refuses a sub-atom slippage floor rather than letting it become zero", () => {
    expect(() => acceptAtMintScale("minSharesOut", "0.0000000001", 6)).toThrow(
      /more precision than its mint supports/
    );
  });

  it("carries the error code the API maps to a 400", () => {
    try {
      acceptAtMintScale("amount", "1.0000009", 6);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SdpKaminoError);
      expect((error as SdpKaminoError).code).toBe("INVALID_AMOUNT");
    }
  });

  it("rejects non-decimal, signed and exponential input before scale is considered", () => {
    for (const bad of ["-1", "1e5", "Infinity", "", "abc", "1.2.3"]) {
      expect(() => acceptAtMintScale("amount", bad, 6), bad).toThrow(SdpKaminoError);
    }
  });

  it("handles a zero-decimal mint", () => {
    expect(acceptAtMintScale("amount", "7", 0)).toBe("7");
    expect(acceptAtMintScale("amount", "7.000", 0)).toBe("7");
    expect(() => acceptAtMintScale("amount", "7.5", 0)).toThrow(/more precision/);
  });

  it("enforces the on-chain u64 range for every encoded amount field", () => {
    const maxU64 = "18446744073709551615";
    const overU64 = "18446744073709551616";

    for (const field of ["amount", "minSharesOut", "shares"]) {
      expect(acceptAtMintScale(field, maxU64, 0), field).toBe(maxU64);
      expect(() => acceptAtMintScale(field, overU64, 0), field).toThrow(SdpKaminoError);
      try {
        acceptAtMintScale(field, overU64, 0);
        expect.unreachable("should have rejected an amount above u64");
      } catch (error) {
        expect(error).toBeInstanceOf(SdpKaminoError);
        expect((error as SdpKaminoError).code).toBe("INVALID_AMOUNT");
        expect((error as Error).message).toMatch(/unsigned 64-bit base-unit/);
      }
    }

    // The bound applies after mint scaling, not to the whole-number spelling.
    expect(acceptAtMintScale("amount", "18446744073709.551615", 6)).toBe("18446744073709.551615");
    expect(() => acceptAtMintScale("amount", "18446744073709.551616", 6)).toThrow(
      /unsigned 64-bit base-unit/
    );
  });

  it("handles long zero runs in linear time without changing scale semantics", () => {
    const zeroRun = "0".repeat(50_000);

    expect(acceptAtMintScale("amount", `1.${zeroRun}`, 6)).toBe("1");
    expect(() => acceptAtMintScale("amount", `1.${zeroRun}1`, 6)).toThrow(/more precision/);
  });

  /**
   * The precision floor the reviewer asked to be tested: a share balance above
   * 2^53 base units is exactly where `uiAmount`'s JSON number loses value.
   * These helpers are `bigint` end to end, so the round trip is lossless.
   */
  it("survives a raw balance above 2^53 base units", () => {
    const base = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2
    const asDecimal = formatDecimalAmount(base, 6);
    expect(asDecimal).toBe("9007199254.740993");
    // Round-tripping through the accept path must not perturb the last digit.
    expect(acceptAtMintScale("shares", asDecimal, 6)).toBe("9007199254.740993");

    // For contrast, the cost of the route this replaced. `getUserShares` sums
    // `tokenAmount.uiAmount`, a JSON number; once the raw balance passes 2^53
    // the base units are no longer representable, and the lost digit cannot be
    // recovered by wrapping the result in `Decimal` afterwards.
    expect(Number.isSafeInteger(Number(base))).toBe(false);
    expect(BigInt(Number(base))).toBe(9_007_199_254_740_992n);
  });
});

describe("isZeroAmount", () => {
  it("recognises canonical zero and nothing else", () => {
    expect(isZeroAmount(acceptAtMintScale("amount", "0", 6))).toBe(true);
    expect(isZeroAmount(acceptAtMintScale("amount", "0.000000", 6))).toBe(true);
    expect(isZeroAmount(acceptAtMintScale("amount", "0.000001", 6))).toBe(false);
  });
});

describe("mintDecimals", () => {
  it("normalises the shapes klend-sdk hands back", () => {
    expect(mintDecimals(6, "tokenMintDecimals")).toBe(6);
    expect(mintDecimals("6", "tokenMintDecimals")).toBe(6);
    // A BN-like object stringifies to its digits; `Number(bn)` would be NaN.
    expect(mintDecimals({ toString: () => "9" }, "tokenMintDecimals")).toBe(9);
  });

  /**
   * Fails loudly rather than defaulting. A silent fallback would make every
   * scale comparison above compare against the wrong mint — the check would
   * still run and would still pass, which is the worst of both worlds.
   */
  it("throws on a value it cannot trust", () => {
    for (const bad of [undefined, null, Number.NaN, -1, 1.5, 99, "abc"]) {
      expect(() => mintDecimals(bad, "sharesMintDecimals"), String(bad)).toThrow(/unusable/);
    }
  });
});
