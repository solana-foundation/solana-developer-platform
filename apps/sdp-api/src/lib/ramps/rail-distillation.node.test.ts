import { distillBvnkRailSupport } from "@sdp/payments/ramps/providers/bvnk/currencies";
import { isActiveIso4217CurrencyCode } from "@sdp/payments/ramps/shared";
import { describe, expect, it } from "vitest";

describe("ramp rail distillation", () => {
  it("validates ISO 4217 currency codes", () => {
    expect(isActiveIso4217CurrencyCode("ADP")).toBe(false);
    expect(isActiveIso4217CurrencyCode("MXN")).toBe(true);
  });

  it("distills BVNK rail support into the sandbox fiat set", () => {
    const bvnk = distillBvnkRailSupport(
      [
        { code: "EUR", fiat: true, supportsDeposits: true },
        { code: "USD", fiat: true, supportsDeposits: true },
      ],
      [
        { code: "EUR", fiat: true, supportsWithdrawals: true },
        { code: "USD", fiat: true, supportsWithdrawals: true },
        { code: "GBP", fiat: true, supportsWithdrawals: true },
      ],
      [
        {
          code: "USDC",
          protocols: [{ networkCode: "SOLANA" }],
          supportsDeposits: true,
          supportsWithdrawals: true,
        },
      ]
    );
    expect(Object.keys(bvnk.snapshot.onramp.currencies)).toEqual(["EUR", "USD"]);
    expect(Object.keys(bvnk.snapshot.offramp.currencies)).toEqual(["EUR", "USD"]);
    expect(bvnk.snapshot.onramp.cryptos).toEqual(["usdc.solana"]);
    expect(bvnk.droppedCurrencyCodes).toEqual([]);
  });
});
