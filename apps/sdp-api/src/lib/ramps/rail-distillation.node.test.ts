import { distillBvnkRailSupport } from "@sdp/payments/ramps/providers/bvnk/currencies";
import { distillCoinbaseRailSupport } from "@sdp/payments/ramps/providers/coinbase/client";
import { isActiveIso4217CurrencyCode } from "@sdp/payments/ramps/shared";
import { describe, expect, it } from "vitest";

describe("ramp rail distillation", () => {
  it("validates ISO 4217 currency codes", () => {
    expect(isActiveIso4217CurrencyCode("ADP")).toBe(false);
    expect(isActiveIso4217CurrencyCode("MXN")).toBe(true);
  });

  it("distills Coinbase onramp currency limits and crypto support", () => {
    const coinbase = distillCoinbaseRailSupport({
      purchase_currencies: [
        { symbol: "SOL", networks: [{ name: "solana" }] },
        { symbol: "ETH", networks: [{ name: "base" }] },
      ],
      payment_currencies: [
        {
          id: "USD",
          limits: [
            { id: "CARD", min: "3", max: "10" },
            { id: "APPLE_PAY", min: "2", max: "20" },
            { id: "FIAT_WALLET", min: "1", max: "1000000" },
          ],
        },
      ],
    });
    expect(coinbase.snapshot.onramp.currencies.USD).toEqual({ min: "2", max: "20" });
    expect(coinbase.snapshot.onramp.cryptos).toEqual(["sol.solana"]);
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
