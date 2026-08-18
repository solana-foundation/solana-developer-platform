import { describe, expect, it } from "vitest";
import { SdpKaminoError } from "./errors";
import { sumRawTokenAccountBaseUnits } from "./share-balances";

function tokenAccount(amount: unknown) {
  return {
    account: {
      data: {
        parsed: {
          info: { tokenAmount: { amount } },
        },
      },
    },
  };
}

describe("sumRawTokenAccountBaseUnits", () => {
  it("sums every matching account exactly above 2^53", () => {
    expect(
      sumRawTokenAccountBaseUnits([
        tokenAccount("9007199254740993"),
        tokenAccount("9007199254740995"),
        tokenAccount("12"),
      ])
    ).toBe(18_014_398_509_482_000n);
  });

  it("fails closed when any matching account has a malformed raw amount", () => {
    for (const malformed of [tokenAccount(undefined), tokenAccount(12), tokenAccount("1.5"), {}]) {
      expect(() =>
        sumRawTokenAccountBaseUnits([tokenAccount("9007199254740993"), malformed])
      ).toThrow(SdpKaminoError);
      expect(() =>
        sumRawTokenAccountBaseUnits([tokenAccount("9007199254740993"), malformed])
      ).toThrow(/did not contain an exact raw amount/);
    }
  });

  it("rejects a response with no account list", () => {
    expect(() => sumRawTokenAccountBaseUnits(undefined)).toThrow(/did not contain an account list/);
  });
});
