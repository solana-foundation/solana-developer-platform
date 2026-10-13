import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { PaymentRampQuote } from "@sdp/types";
import { RAMP_PROVIDER_SUPPORT_DETAILS, type RampFiatCurrency } from "@sdp/types/generated/ramp";
import { type CryptoRailId, SOLANA_CRYPTO_RAILS } from "@sdp/types/payment-rails";
import { addDecimalAmounts, subtractDecimalAmounts } from "../../../decimal";
import { SdpPaymentsError } from "../../../errors";
import type { RampOfframpQuoteInput, RampOnrampQuoteInput, RampRuntimeContext } from "../../types";
import { distillMoonpayRailSupport, MoonpayRampClient } from "./client";

const WALLET = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";
const SECRET_KEY = "sk_test_moonpay";

const runtimeContext = {
  env: { MOONPAY_SANDBOX_API_KEY: "pk_test_moonpay", MOONPAY_SANDBOX_SECRET_KEY: SECRET_KEY },
  mode: "sandbox",
} satisfies RampRuntimeContext;

const EXPECTED_MOONPAY_CODES = {
  "sol.solana": "sol",
  "usdc.solana": "usdc_sol",
  "usdt.solana": "usdt_sol",
  "usdg.solana": "usdg_sol",
  "pyusd.solana": "pyusd_sol",
} as const satisfies Record<CryptoRailId, string>;

const MOONPAY_ONRAMP_CURRENCIES = RAMP_PROVIDER_SUPPORT_DETAILS.moonpay.onramp.currencies;

const QUOTE_RESPONSE = {
  baseCurrencyAmount: 50,
  quoteCurrencyAmount: 0.3,
  quoteCurrencyPrice: 150,
  baseCurrencyPrice: 150,
  feeAmount: 1.5,
  networkFeeAmount: 0.1,
  extraFeeAmount: 0,
};

const onrampInput: RampOnrampQuoteInput = {
  paymentTransferId: "xfr_0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  externalCustomerId: "cpty_moonpay_onramp_1",
  destinationWalletAddress: WALLET,
  assetRail: "sol.solana",
  fiatCurrency: "USD",
  fiatAmount: "50",
};

const offrampInput: RampOfframpQuoteInput = {
  paymentTransferId: "xfr_0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  externalCustomerId: "cpty_moonpay_offramp_1",
  sourceWalletAddress: WALLET,
  assetRail: "sol.solana",
  fiatCurrency: "USD",
  cryptoAmount: "1",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function refuseProviderCalls(): void {
  globalThis.fetch = async () => assert.fail("MoonPay must not be called");
}

function isBadRequest(message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof SdpPaymentsError);
    assert.equal(error.code, "BAD_REQUEST");
    assert.match(error.message, message);
    return true;
  };
}

function signedHostedUrl(quote: PaymentRampQuote): URL {
  assert.ok(quote.provider === "moonpay");
  const url = new URL(quote.hostedUrl);
  const unsigned = new URL(url);
  unsigned.searchParams.delete("signature");
  const expected = createHmac("sha256", SECRET_KEY).update(unsigned.search).digest("base64");
  assert.equal(url.searchParams.get("signature"), expected);
  return url;
}

describe("MoonpayRampClient currency codes", () => {
  for (const assetRail of SOLANA_CRYPTO_RAILS) {
    const code = EXPECTED_MOONPAY_CODES[assetRail];

    it(`requests ${assetRail} buy and sell estimates as ${code}`, async () => {
      const paths: string[] = [];
      globalThis.fetch = async (input) => {
        paths.push(new URL(String(input)).pathname);
        return Response.json(QUOTE_RESPONSE);
      };

      const client = new MoonpayRampClient();
      await client.estimateOnramp(runtimeContext, {
        assetRail,
        fiatCurrency: "USD",
        fiatAmount: "50",
      });
      await client.estimateOfframp(runtimeContext, {
        assetRail,
        fiatCurrency: "USD",
        cryptoAmount: "1",
      });

      assert.deepEqual(paths, [
        `/v3/currencies/${code}/buy_quote`,
        `/v3/currencies/${code}/sell_quote`,
      ]);
    });

    it(`signs ${code} into both widget URLs for ${assetRail}`, async () => {
      refuseProviderCalls();

      const client = new MoonpayRampClient();
      const onramp = await client.createOnrampQuote(runtimeContext, { ...onrampInput, assetRail });
      const offramp = await client.createOfframpQuote(runtimeContext, {
        ...offrampInput,
        assetRail,
      });

      assert.equal(signedHostedUrl(onramp).searchParams.get("currencyCode"), code);
      assert.equal(signedHostedUrl(offramp).searchParams.get("baseCurrencyCode"), code);
    });
  }

  it("discovers each rail from the same code its requests send", () => {
    const currencies = SOLANA_CRYPTO_RAILS.map((assetRail) => ({
      type: "crypto",
      code: EXPECTED_MOONPAY_CODES[assetRail],
      supportsTestMode: true,
      isSellSupported: true,
      minBuyAmount: 1,
      minSellAmount: 1,
      metadata: { networkCode: "solana" },
    }));

    const { snapshot } = distillMoonpayRailSupport(currencies, []);

    assert.deepEqual(snapshot.onramp.cryptos, [...SOLANA_CRYPTO_RAILS].sort());
    assert.deepEqual(snapshot.offramp.cryptos, [...SOLANA_CRYPTO_RAILS].sort());
  });

  it("refuses a rail with no MoonPay code before calling MoonPay", async () => {
    refuseProviderCalls();
    const assetRail = "eurc.solana" as string as CryptoRailId;
    const client = new MoonpayRampClient();
    const unsupported = isBadRequest(/^MoonPay does not support eurc\.solana$/);

    await assert.rejects(
      client.estimateOnramp(runtimeContext, { assetRail, fiatCurrency: "USD", fiatAmount: "50" }),
      unsupported
    );
    await assert.rejects(
      client.estimateOfframp(runtimeContext, { assetRail, fiatCurrency: "USD", cryptoAmount: "1" }),
      unsupported
    );
    await assert.rejects(
      client.createOnrampQuote(runtimeContext, { ...onrampInput, assetRail }),
      unsupported
    );
    await assert.rejects(
      client.createOfframpQuote(runtimeContext, { ...offrampInput, assetRail }),
      unsupported
    );
  });
});

describe("MoonpayRampClient on-ramp limits", () => {
  const aud = MOONPAY_ONRAMP_CURRENCIES.AUD;
  const usd = MOONPAY_ONRAMP_CURRENCIES.USD;

  async function quoteAud(fiatAmount: string) {
    return new MoonpayRampClient().createOnrampQuote(runtimeContext, {
      ...onrampInput,
      fiatCurrency: "AUD",
      fiatAmount,
    });
  }

  it("refuses an amount below the currency's own minimum", async () => {
    refuseProviderCalls();

    await assert.rejects(
      quoteAud(subtractDecimalAmounts(aud.min, "0.01")),
      isBadRequest(
        new RegExp(`^MoonPay on-ramp requires fiatAmount to be at least ${aud.min} AUD$`)
      )
    );
  });

  it("accepts the minimum and the maximum", async () => {
    refuseProviderCalls();

    for (const fiatAmount of [aud.min, aud.max]) {
      const url = signedHostedUrl(await quoteAud(fiatAmount));
      assert.equal(url.searchParams.get("baseCurrencyCode"), "aud");
      assert.equal(url.searchParams.get("baseCurrencyAmount"), fiatAmount);
    }
  });

  it("refuses an amount above the currency's maximum", async () => {
    refuseProviderCalls();

    await assert.rejects(
      quoteAud(addDecimalAmounts(aud.max, "0.01")),
      isBadRequest(new RegExp(`^MoonPay on-ramp requires fiatAmount to be at most ${aud.max} AUD$`))
    );
  });

  it("refuses a fiat currency with no MoonPay on-ramp row", async () => {
    refuseProviderCalls();
    const unlisted: string = "XAF";
    assert.equal(Object.hasOwn(MOONPAY_ONRAMP_CURRENCIES, unlisted), false);

    await assert.rejects(
      new MoonpayRampClient().createOnrampQuote(runtimeContext, {
        ...onrampInput,
        // SAFETY: every RampFiatCurrency has a MoonPay row today, so the guard
        // under test is fed a code from outside the type on purpose.
        fiatCurrency: unlisted as RampFiatCurrency,
      }),
      isBadRequest(new RegExp(`^MoonPay on-ramp does not support ${unlisted}$`))
    );
  });

  it("applies the USD limits when fiatCurrency is omitted, as the widget does", async () => {
    refuseProviderCalls();
    const { paymentTransferId, externalCustomerId, destinationWalletAddress, assetRail } =
      onrampInput;
    const client = new MoonpayRampClient();
    const quote = (fiatAmount: string) =>
      client.createOnrampQuote(runtimeContext, {
        paymentTransferId,
        externalCustomerId,
        destinationWalletAddress,
        assetRail,
        fiatAmount,
      });

    await assert.rejects(
      quote(subtractDecimalAmounts(usd.min, "0.01")),
      isBadRequest(new RegExp(`at least ${usd.min} USD$`))
    );
    const url = signedHostedUrl(await quote(usd.min));
    assert.equal(url.searchParams.get("baseCurrencyCode"), "usd");
  });

  it("refuses malformed and out-of-range amounts as bad requests", async () => {
    refuseProviderCalls();

    await assert.rejects(quoteAud("12abc"), isBadRequest(/^Invalid amount format$/));
    await assert.rejects(
      quoteAud(`1${"0".repeat(40)}`),
      isBadRequest(/^fiatAmount is out of range$/)
    );
  });
});
