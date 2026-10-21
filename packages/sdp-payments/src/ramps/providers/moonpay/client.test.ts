import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { RAMP_PROVIDER_SUPPORT_DETAILS, type RampFiatCurrency } from "@sdp/types/generated/ramp";
import { type CryptoRailId, SOLANA_CRYPTO_RAILS } from "@sdp/types/payment-rails";
import type { PaymentRampQuote } from "@sdp/types/payments";
import { addDecimalAmounts, subtractDecimalAmounts } from "#/decimal";
import { rampAmountLimitOf, SdpPaymentsError } from "#/errors";
import { RAMP_PROVIDER_CLIENTS, rampClientFor } from "#/ramps/index";
import { rampTestRuntime } from "#/ramps/test-kit";
import type { RampOfframpQuoteInput, RampOnrampQuoteInput } from "#/ramps/types";
import { distillMoonpayRailSupport } from "./client";
import { MOONPAY_TEST_KIT } from "./test-kit";

const WALLET = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";
const SECRET_KEY = "sk_test_moonpay";

const runtimeContext = rampTestRuntime("sandbox", {
  publicKey: "pk_test_moonpay",
  secretKey: SECRET_KEY,
});
const moonpayOnramp = rampClientFor("moonpay", "onramp");
const moonpayOfframp = rampClientFor("moonpay", "offramp");

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
      await moonpayOnramp.estimateOnramp(runtimeContext, {
        assetRail,
        fiatCurrency: "USD",
        fiatAmount: "50",
      });
      await moonpayOfframp.estimateOfframp(runtimeContext, {
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
      const onramp = await moonpayOnramp.createOnrampQuote(runtimeContext, {
        ...onrampInput,
        assetRail,
      });
      const offramp = await moonpayOfframp.createOfframpQuote(runtimeContext, {
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
    const unsupported = isBadRequest(/^MoonPay does not support eurc\.solana$/);

    await assert.rejects(
      moonpayOnramp.estimateOnramp(runtimeContext, {
        assetRail,
        fiatCurrency: "USD",
        fiatAmount: "50",
      }),
      unsupported
    );
    await assert.rejects(
      moonpayOfframp.estimateOfframp(runtimeContext, {
        assetRail,
        fiatCurrency: "USD",
        cryptoAmount: "1",
      }),
      unsupported
    );
    await assert.rejects(
      moonpayOnramp.createOnrampQuote(runtimeContext, { ...onrampInput, assetRail }),
      unsupported
    );
    await assert.rejects(
      moonpayOfframp.createOfframpQuote(runtimeContext, { ...offrampInput, assetRail }),
      unsupported
    );
  });
});

describe("MoonpayRampClient on-ramp total", () => {
  function answerBuyQuote(body: typeof QUOTE_RESPONSE & { totalAmount?: number }): void {
    globalThis.fetch = async () => Response.json(body);
  }

  it("prices the widget's charge: by card, its fees out of the amount", async () => {
    let requested: URL | undefined;
    globalThis.fetch = async (input) => {
      requested = new URL(String(input));
      return Response.json({ ...QUOTE_RESPONSE, baseCurrencyAmount: 48.4 });
    };

    const estimate = await moonpayOnramp.estimateOnramp(runtimeContext, {
      assetRail: "sol.solana",
      fiatCurrency: "USD",
      fiatAmount: "50",
    });

    assert.equal(requested?.searchParams.get("areFeesIncluded"), "true");
    assert.equal(requested?.searchParams.get("paymentMethod"), "credit_debit_card");
    assert.equal(estimate.fiatAmount, "48.4");
    assert.equal(estimate.totalFiatAmount, "50");
  });

  it("takes MoonPay's own total when it sends one", async () => {
    answerBuyQuote({ ...QUOTE_RESPONSE, totalAmount: 51.61 });

    const estimate = await moonpayOnramp.estimateOnramp(runtimeContext, {
      assetRail: "sol.solana",
      fiatCurrency: "USD",
      fiatAmount: "50",
    });

    assert.equal(estimate.totalFiatAmount, "51.61");
  });

  it("opens the buy widget on card, the method its estimate priced", async () => {
    refuseProviderCalls();

    const quote = await moonpayOnramp.createOnrampQuote(runtimeContext, onrampInput);

    assert.equal(signedHostedUrl(quote).searchParams.get("paymentMethod"), "credit_debit_card");
  });
});

describe("MoonpayRampClient off-ramp limits", () => {
  // MoonPay's sandbox answers, 2026-10-20: a sale under the minimum is a 400
  // naming it, while one over the maximum still quotes.
  const UNDER_MINIMUM = {
    errors: [
      { property: "minSellFiatAmount", message: "16.18043935029837951066", children: [] },
      { property: "fiatCurrencyCode", message: "usd", children: [] },
      { property: "minSellCryptoAmount", message: "19.92405", children: [] },
      { property: "cryptoCurrencyCode", message: "usdc_sol", children: [] },
    ],
    message: "The minimum order amount is 19.92405 USDC_SOL / $16.18",
    type: "BadRequestError",
  };
  const SELL_QUOTE = {
    baseCurrencyAmount: 25,
    quoteCurrencyAmount: 20.69,
    baseCurrencyPrice: 0.9873727923981503,
    feeAmount: 3.99,
    extraFeeAmount: 0,
    baseCurrency: { code: "usdc_sol", minSellAmount: 19.92405, maxSellAmount: 10000 },
  };

  function answer(status: number, body: Record<string, unknown>): void {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
  }

  function estimateUsdc(cryptoAmount: string) {
    return moonpayOfframp.estimateOfframp(runtimeContext, {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      cryptoAmount,
    });
  }

  it("names MoonPay's minimum when it refuses a sale under it", async () => {
    answer(400, UNDER_MINIMUM);

    await assert.rejects(estimateUsdc("5"), (cause: unknown) => {
      assert.deepEqual(rampAmountLimitOf(cause), {
        reason: "amount_below_minimum",
        limit: { amount: "19.92405", currency: "USDC" },
      });
      assert.ok(cause instanceof SdpPaymentsError);
      assert.doesNotMatch(cause.message, /USDC_SOL/);
      return true;
    });
  });

  it("refuses a sale over the maximum MoonPay would still quote", async () => {
    answer(200, { ...SELL_QUOTE, baseCurrencyAmount: 10001 });

    await assert.rejects(estimateUsdc("10001"), (cause: unknown) => {
      assert.deepEqual(rampAmountLimitOf(cause), {
        reason: "amount_above_maximum",
        limit: { amount: "10000", currency: "USDC" },
      });
      return true;
    });
  });

  it("quotes the payout for a sale inside both bounds", async () => {
    answer(200, SELL_QUOTE);

    const estimate = await estimateUsdc("25");

    assert.equal(estimate.fiatAmount, "20.69");
    assert.equal(estimate.cryptoAmount, "25");
  });

  it("keeps any other refusal a plain provider error", async () => {
    answer(400, { message: "Invalid currency", type: "BadRequestError" });

    await assert.rejects(estimateUsdc("25"), (cause: unknown) => {
      assert.equal(rampAmountLimitOf(cause), null);
      assert.ok(cause instanceof SdpPaymentsError);
      assert.equal(cause.code, "BAD_REQUEST");
      return true;
    });
  });
});

describe("MoonpayRampClient sale cancel", () => {
  const TRANSFER_ID = "xfr_0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

  function cancelSale(transferId: string) {
    const moonpay = RAMP_PROVIDER_CLIENTS.moonpay;
    assert.ok(moonpay.cancelOfframpSale, "MoonPay cancels the sales it holds");
    return moonpay.cancelOfframpSale(runtimeContext, transferId);
  }

  function answerCancel(status: number): Array<{ url: string; init: RequestInit | undefined }> {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(status === 204 ? null : JSON.stringify({ message: "x", type: "y" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };
    return requests;
  }

  it("deletes the sale by SDP's id with the secret key", async () => {
    const requests = answerCancel(204);

    const outcome = await cancelSale(TRANSFER_ID);

    assert.equal(outcome, "canceled");
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.ok(request);
    assert.equal(request.url, `https://api.moonpay.com/v3/sell_transactions/ext/${TRANSFER_ID}`);
    assert.equal(request.init?.method, "DELETE");
    assert.equal(new Headers(request.init?.headers).get("Authorization"), `Api-Key ${SECRET_KEY}`);
  });

  it("reads no sale and a finished sale as answers, not failures", async () => {
    answerCancel(404);
    assert.equal(await cancelSale(TRANSFER_ID), "not_found");
    answerCancel(409);
    assert.equal(await cancelSale(TRANSFER_ID), "not_cancelable");
  });

  it("throws when MoonPay refuses the key", async () => {
    answerCancel(401);

    await assert.rejects(cancelSale(TRANSFER_ID), (cause: unknown) => {
      assert.ok(cause instanceof SdpPaymentsError);
      assert.equal(cause.code, "PROVIDER_NOT_CONFIGURED");
      return true;
    });
  });
});

describe("MoonpayRampClient on-ramp limits", () => {
  const aud = MOONPAY_ONRAMP_CURRENCIES.AUD;
  const usd = MOONPAY_ONRAMP_CURRENCIES.USD;

  async function quoteAud(fiatAmount: string) {
    return moonpayOnramp.createOnrampQuote(runtimeContext, {
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
      moonpayOnramp.createOnrampQuote(runtimeContext, {
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
    const quote = (fiatAmount: string) =>
      moonpayOnramp.createOnrampQuote(runtimeContext, {
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

describe("MoonpayRampClient widget hosts", () => {
  it("opens each mode's widget host", async () => {
    refuseProviderCalls();
    for (const [mode, credentials, onrampHost, offrampHost] of [
      [
        "sandbox",
        MOONPAY_TEST_KIT.credentials,
        "buy-sandbox.moonpay.com",
        "sell-sandbox.moonpay.com",
      ],
      ["production", MOONPAY_TEST_KIT.liveCredentials, "buy.moonpay.com", "sell.moonpay.com"],
    ] as const) {
      const runtime = rampTestRuntime(mode, credentials);
      const onramp = await moonpayOnramp.createOnrampQuote(runtime, onrampInput);
      const offramp = await moonpayOfframp.createOfframpQuote(runtime, offrampInput);
      assert.ok(onramp.deliveryMode === "hosted" && offramp.deliveryMode === "hosted");
      assert.equal(new URL(onramp.hostedUrl).host, onrampHost);
      assert.equal(new URL(offramp.hostedUrl).host, offrampHost);
    }
  });
});
