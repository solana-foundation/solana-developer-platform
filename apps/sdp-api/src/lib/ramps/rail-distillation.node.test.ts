import { describe, expect, it } from "vitest";
import { distillCoinbaseRailSupport } from "./providers/coinbase/client";
import { distillLightsparkRailSupport } from "./providers/lightspark/client";
import { distillMuralRailSupport } from "./providers/mural/client";
import { isActiveIso4217CurrencyCode } from "./shared";

describe("ramp rail distillation", () => {
  it("validates ISO 4217 currency codes", () => {
    expect(isActiveIso4217CurrencyCode("ADP")).toBe(false);
    expect(isActiveIso4217CurrencyCode("MXN")).toBe(true);
  });

  it("distills Mural country/currency support from its countries dump", () => {
    const mural = distillMuralRailSupport({
      "usd-peru": {
        status: 200,
        body: {
          count: 1,
          countries: [{ alpha2Code: "PE", name: "Peru", subdivisions: [] }],
        },
      },
      mxn: {
        status: 200,
        body: {
          count: 1,
          countries: [{ alpha2Code: "MX", name: "Mexico", subdivisions: [] }],
        },
      },
    });
    expect(mural.snapshot.onramp.currencies).toEqual({
      MXN: { min: null, max: null },
      USD: { min: null, max: null },
    });
    expect(mural.snapshot.onramp.countrySupport).toEqual({
      coverage: "by-country",
      countries: { MX: ["MXN"], PE: ["USD"] },
    });
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

  it("distills Lightspark USD minor-unit limits and crypto support", () => {
    const lightspark = distillLightsparkRailSupport({
      supportedCurrencies: [
        {
          currencyCode: "USD",
          enabledTransactionTypes: ["INCOMING", "OUTGOING"],
          minAmount: 100,
          maxAmount: 1000000,
        },
        { currencyCode: "USDC", enabledTransactionTypes: ["INCOMING", "OUTGOING"] },
      ],
    });
    expect(lightspark.snapshot.onramp.currencies.USD).toEqual({
      min: "1",
      max: "10000",
    });
    expect(lightspark.snapshot.onramp.cryptos).toEqual(["usdc.solana"]);
  });

  it("throws for non-USD Lightspark currency limits", () => {
    expect(() =>
      distillLightsparkRailSupport({
        supportedCurrencies: [
          {
            currencyCode: "EUR",
            enabledTransactionTypes: ["INCOMING"],
            minAmount: 100,
            maxAmount: 1000000,
          },
        ],
      })
    ).toThrow("only USD minor-unit scaling is verified");
  });
});
