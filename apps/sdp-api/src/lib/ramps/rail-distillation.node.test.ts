import { distillCoinbaseRailSupport } from "@sdp/payments/ramps/providers/coinbase/client";
import { distillLightsparkRailSupport } from "@sdp/payments/ramps/providers/lightspark/currencies";
import { distillMuralRailSupport } from "@sdp/payments/ramps/providers/mural/client";
import { isActiveIso4217CurrencyCode } from "@sdp/payments/ramps/shared";
import { resolveOfframpDestination } from "@sdp/types/ramp-resolution";
import { describe, expect, it } from "vitest";

const LIGHTSPARK_OPENAPI_FIXTURE = `
components:
  schemas:
    UsdAccountInfoBase:
      type: object
      required:
        - accountType
        - accountNumber
        - routingNumber
      properties:
        accountType:
          type: string
          enum:
            - USD_ACCOUNT
        accountNumber:
          type: string
          minLength: 1
          maxLength: 34
        routingNumber:
          type: string
          pattern: ^[0-9]{9}$
    UsdAccountInfo:
      allOf:
        - $ref: '#/components/schemas/UsdAccountInfoBase'
        - type: object
          properties:
            paymentRails:
              type: array
              items:
                type: string
                enum:
                  - ACH
                  - WIRE
    EurAccountInfoBase:
      type: object
      required:
        - accountType
        - iban
      properties:
        accountType:
          type: string
          enum:
            - EUR_ACCOUNT
        iban:
          type: string
          pattern: ^[A-Z]{2}[0-9]{2}[A-Za-z0-9]{11,30}$
        swiftCode:
          type: string
          minLength: 8
          maxLength: 11
    EurAccountInfo:
      allOf:
        - $ref: '#/components/schemas/EurAccountInfoBase'
        - type: object
          properties:
            paymentRails:
              type: array
              items:
                type: string
                enum:
                  - SEPA
                  - SEPA_INSTANT
    SwiftAccountInfoBase:
      type: object
      required:
        - accountType
        - swiftCode
        - bankName
        - country
      properties:
        accountType:
          type: string
          enum:
            - SWIFT_ACCOUNT
        country:
          type: string
          pattern: ^[A-Z]{2}$
        swiftCode:
          type: string
          minLength: 8
          maxLength: 11
        bankName:
          type: string
          minLength: 1
          maxLength: 255
        accountNumber:
          type: string
          minLength: 1
          maxLength: 34
        iban:
          type: string
          minLength: 15
          maxLength: 34
    SwiftAccountInfo:
      allOf:
        - $ref: '#/components/schemas/SwiftAccountInfoBase'
        - type: object
          properties:
            paymentRails:
              type: array
              items:
                type: string
                enum:
                  - SWIFT
`;

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
      },
      LIGHTSPARK_OPENAPI_FIXTURE
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
    expect(lightspark.snapshot.offramp.swiftAccount).toEqual({
      accountType: "SWIFT_ACCOUNT",
      rails: {
        SWIFT: {
          country: { required: true, pattern: "^[A-Z]{2}$" },
          swiftCode: { required: true, minLength: 8, maxLength: 11 },
          bankName: { required: true, minLength: 1, maxLength: 255 },
          accountNumber: { required: false, minLength: 1, maxLength: 34 },
          iban: { required: false, minLength: 15, maxLength: 34 },
        },
      },
    });
    expect(lightspark.snapshot.offramp.accounts).toEqual({
      USD: {
        accountType: "USD_ACCOUNT",
        rails: {
          ACH: {
            accountNumber: { required: true, minLength: 1, maxLength: 34 },
            routingNumber: { required: true, pattern: "^[0-9]{9}$" },
          },
          WIRE: {
            accountNumber: { required: true, minLength: 1, maxLength: 34 },
            routingNumber: { required: true, pattern: "^[0-9]{9}$" },
          },
        },
      },
      EUR: {
        accountType: "EUR_ACCOUNT",
        rails: {
          SEPA: {
            iban: { required: true, pattern: "^[A-Z]{2}[0-9]{2}[A-Za-z0-9]{11,30}$" },
            swiftCode: { required: false, minLength: 8, maxLength: 11 },
          },
          SEPA_INSTANT: {
            iban: { required: true, pattern: "^[A-Z]{2}[0-9]{2}[A-Za-z0-9]{11,30}$" },
            swiftCode: { required: false, minLength: 8, maxLength: 11 },
          },
        },
      },
    });
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
        { data: [] },
        LIGHTSPARK_OPENAPI_FIXTURE
      )
    ).toThrow("must be a crypto asset");
  });

  it("resolves off-ramp destinations: corridor, country, rail, fields", () => {
    const malaysia = resolveOfframpDestination({
      provider: "lightspark",
      cryptoRail: "usdc.solana",
      fiatCurrency: "MYR",
      countryCode: "MY",
    });
    if (malaysia === null) {
      throw new Error("expected a MYR/MY resolution");
    }
    expect(Object.keys(malaysia.rails).sort()).toEqual(["BANK_TRANSFER", "SWIFT"]);
    expect(malaysia.rails.BANK_TRANSFER.accountType).toBe("MYR_ACCOUNT");
    expect(malaysia.rails.BANK_TRANSFER.fields.swiftCode.required).toBe(true);
    expect(malaysia.rails.SWIFT.accountType).toBe("SWIFT_ACCOUNT");

    const usdIntoMalaysia = resolveOfframpDestination({
      provider: "lightspark",
      cryptoRail: "usdc.solana",
      fiatCurrency: "USD",
      countryCode: "MY",
    });
    if (usdIntoMalaysia === null) {
      throw new Error("expected USD/MY to resolve over SWIFT");
    }
    expect(Object.keys(usdIntoMalaysia.rails)).toEqual(["SWIFT"]);
    expect(usdIntoMalaysia.rails.SWIFT.accountType).toBe("SWIFT_ACCOUNT");
    expect(usdIntoMalaysia.rails.SWIFT.fields.country.required).toBe(true);

    const croatia = resolveOfframpDestination({
      provider: "lightspark",
      cryptoRail: "usdc.solana",
      fiatCurrency: "USD",
      countryCode: "HR",
    });
    expect(croatia).toBeNull();

    const germany = resolveOfframpDestination({
      provider: "lightspark",
      cryptoRail: "usdc.solana",
      fiatCurrency: "EUR",
      countryCode: "DE",
    });
    if (germany === null) {
      throw new Error("expected an EUR/DE resolution");
    }
    expect(Object.keys(germany.rails).sort()).toEqual(["SEPA", "SEPA_INSTANT", "SWIFT"]);
    expect(germany.rails.SEPA.fields.iban.required).toBe(true);
  });
});
