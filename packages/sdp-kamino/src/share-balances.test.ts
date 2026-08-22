import { describe, expect, it } from "vitest";
import { SdpKaminoError } from "./errors";
import { parseShareTokenAccountBalances, sumRawTokenAccountBaseUnits } from "./share-balances";

function tokenAccount(amount: unknown) {
  return {
    pubkey: "11111111111111111111111111111112",
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

describe("parseShareTokenAccountBalances", () => {
  it("keeps each account address paired with its exact balance", () => {
    expect(parseShareTokenAccountBalances([tokenAccount("9007199254740993")])).toEqual([
      {
        address: "11111111111111111111111111111112",
        amount: 9007199254740993n,
      },
    ]);
  });

  it("fails closed when a matching account has no address", () => {
    expect(() =>
      parseShareTokenAccountBalances([{ ...tokenAccount("1"), pubkey: undefined }])
    ).toThrow(/did not contain an address/);
  });
});
