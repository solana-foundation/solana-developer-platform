import { distillCoinbaseRailSupport } from "@sdp/payments/ramps/providers/coinbase/client";
import { distillLightsparkRailSupport } from "@sdp/payments/ramps/providers/lightspark/currencies";
import { distillMuralRailSupport } from "@sdp/payments/ramps/providers/mural/client";
import { isActiveIso4217CurrencyCode } from "@sdp/payments/ramps/shared";
import { describe, expect, it } from "vitest";

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

  it("distills Lightspark exchange-rate corridors into both directions", () => {
    const usdc = { code: "USDC", decimals: 6 };
    const lightspark = distillLightsparkRailSupport(
      {
        data: [
          {
            sourceCurrency: usdc,
            destinationCurrency: { code: "USD", decimals: 2 },
            minSendingAmount: 1000000,
            maxSendingAmount: 5000000000,
          },
          {
            sourceCurrency: usdc,
            destinationCurrency: { code: "USD", decimals: 2 },
            minSendingAmount: 40455477,
            maxSendingAmount: 6000000000,
          },
          {
            sourceCurrency: usdc,
            destinationCurrency: { code: "EUR", decimals: 2 },
            minSendingAmount: 23341214,
            maxSendingAmount: 5000000000,
          },
          {
            sourceCurrency: usdc,
            destinationCurrency: { code: "USDT", decimals: 6 },
            minSendingAmount: 1000000,
            maxSendingAmount: 5000000000,
          },
          {
            sourceCurrency: usdc,
            destinationCurrency: { code: "SLL", decimals: 2 },
            minSendingAmount: 1000000,
            maxSendingAmount: 5000000000,
          },
        ],
      },
      {
        data: [
          {
            sourceCurrency: { code: "USD", decimals: 2 },
            destinationCurrency: usdc,
            minSendingAmount: 100,
            maxSendingAmount: 500000,
          },
          {
            sourceCurrency: { code: "USDB", decimals: 6 },
            destinationCurrency: usdc,
            minSendingAmount: 1000000,
            maxSendingAmount: 0,
          },
        ],
      }
    );
    expect(lightspark.snapshot.offramp.currencies.USD).toEqual({ min: "1", max: "6000" });
    expect(lightspark.snapshot.offramp.currencies.EUR).toEqual({
      min: "23.341214",
      max: "5000",
    });
    expect(lightspark.snapshot.offramp.currencies.USDT).toBeUndefined();
    expect(lightspark.snapshot.offramp.currencies.SLL).toBeUndefined();
    expect(lightspark.snapshot.offramp.cryptos).toEqual(["usdc.solana"]);
    expect(lightspark.snapshot.onramp.currencies).toEqual({
      USD: { min: "1", max: "5000" },
    });
    expect(lightspark.snapshot.onramp.cryptos).toEqual(["usdc.solana"]);
    expect(lightspark.droppedCurrencyCodes).toEqual(["SLL", "USDB"]);
  });

  it("throws when a Lightspark off-ramp corridor is not sourced from a crypto asset", () => {
    expect(() =>
      distillLightsparkRailSupport(
        {
          data: [
            {
              sourceCurrency: { code: "USD", decimals: 2 },
              destinationCurrency: { code: "EUR", decimals: 2 },
              minSendingAmount: 100,
              maxSendingAmount: 500000,
            },
          ],
        },
        { data: [] }
      )
    ).toThrow("must be a crypto asset");
  });
});
