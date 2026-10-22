import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "#/errors";
import { rampClientFor } from "#/ramps/index";
import { rampTestRuntime, replayExchanges } from "#/ramps/test-kit";
import type { RampOnrampQuoteInput } from "#/ramps/types";
import { STRIPE_SESSION_TERMS, STRIPE_TEST_KIT, stripeSessionExchange } from "./test-kit";

const stripe = rampClientFor("stripe", "onramp");
const sandbox = rampTestRuntime("sandbox", STRIPE_TEST_KIT.credentials);

function kitQuoteInput(): RampOnrampQuoteInput {
  assert.ok(STRIPE_TEST_KIT.onramp, "the Stripe kit records an onramp");
  return STRIPE_TEST_KIT.onramp.quote.input;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Quotes the kit's onramp against a session that echoes `terms`. */
async function quoteAgainst(terms: typeof STRIPE_SESSION_TERMS) {
  replayExchanges([stripeSessionExchange(terms)]);
  return stripe.createOnrampQuote(sandbox, kitQuoteInput());
}

/** Asserts the quote failed closed, naming exactly `mismatched` in diagnostics. */
function refusedFor(mismatched: string[]) {
  return (cause: unknown) => {
    assert.ok(cause instanceof SdpPaymentsError);
    assert.equal(cause.code, "PROVIDER_UNAVAILABLE");
    assert.equal(cause.message, "Stripe returned a session that does not match the quote.");
    assert.deepEqual(cause.diagnostics, { mismatched });
    return true;
  };
}

describe("StripeRampClient session terms", () => {
  it("accepts a session that echoes the quote's locks", async () => {
    const quote = await quoteAgainst(STRIPE_SESSION_TERMS);
    assert.equal(quote.id, "cos_contract");
  });

  it("ignores the fiat amount, which the buyer can change in Stripe's widget", async () => {
    const quote = await quoteAgainst({ ...STRIPE_SESSION_TERMS, source_amount: "96.50" });
    assert.equal(quote.id, "cos_contract");
  });

  it("refuses a session that still offers other assets", async () => {
    await assert.rejects(
      quoteAgainst({ ...STRIPE_SESSION_TERMS, destination_currencies: ["usdc", "sol"] }),
      refusedFor(["destination_currencies"])
    );
  });

  it("refuses a session bound to another wallet", async () => {
    await assert.rejects(
      quoteAgainst({
        ...STRIPE_SESSION_TERMS,
        wallet_addresses: { ...STRIPE_SESSION_TERMS.wallet_addresses, solana: "other-wallet" },
      }),
      refusedFor(["wallet_addresses.solana"])
    );
  });

  it("refuses a session that unlocks the wallet or the network", async () => {
    await assert.rejects(
      quoteAgainst({
        ...STRIPE_SESSION_TERMS,
        destination_networks: ["solana", "ethereum"],
        lock_wallet_address: false,
      }),
      refusedFor(["destination_networks", "lock_wallet_address"])
    );
  });
});

describe("StripeRampClient session request", () => {
  /** Quotes `input` against a session locked to `currency`, answering with the form it sent. */
  async function sentForm(input: RampOnrampQuoteInput, currency: string) {
    let form: URLSearchParams | undefined;
    const { body } = stripeSessionExchange({
      ...STRIPE_SESSION_TERMS,
      destination_currency: currency,
      destination_currencies: [currency],
    });
    globalThis.fetch = async (_url, init) => {
      form = new URLSearchParams(String(init?.body));
      return Response.json(body);
    };
    await stripe.createOnrampQuote(sandbox, input);
    assert.ok(form, "the quote sent a session request");
    return form;
  }

  it("pre-fills the buyer's identity it was given", async () => {
    const form = await sentForm(
      {
        ...kitQuoteInput(),
        customerDetails: {
          email: "john@doe.com",
          dob: { year: 1990, month: 7, day: 4 },
          address: { state: "CA", country: "US" },
        },
      },
      "usdc"
    );
    assert.equal(form.get("customer_information[email]"), "john@doe.com");
    assert.equal(form.get("customer_information[dob][year]"), "1990");
    assert.equal(form.get("customer_information[address][state]"), "CA");
  });

  it("locks sol.solana to Stripe's sol", async () => {
    const form = await sentForm({ ...kitQuoteInput(), assetRail: "sol.solana" }, "sol");
    assert.equal(form.get("destination_currency"), "sol");
    assert.deepEqual(form.getAll("destination_currencies[]"), ["sol"]);
  });

  it("refuses a quote it can't send before any request", async () => {
    globalThis.fetch = async () => assert.fail("Stripe must not be called");
    for (const [input, message] of [
      [{ ...kitQuoteInput(), fiatCurrency: undefined }, /requires a fiat currency/],
      [{ ...kitQuoteInput(), assetRail: "usdt.solana" }, /usdc\.solana and sol\.solana/],
    ] as const) {
      await assert.rejects(stripe.createOnrampQuote(sandbox, input), (cause: unknown) => {
        assert.ok(cause instanceof SdpPaymentsError);
        assert.equal(cause.code, "BAD_REQUEST");
        assert.match(cause.message, message);
        return true;
      });
    }
  });
});

describe("StripeRampClient credentials", () => {
  it("accepts a restricted secret key in either mode", () => {
    assert.equal(
      stripe.checkCredentials(
        { ...STRIPE_TEST_KIT.credentials, secretKey: "rk_test_restricted" },
        "sandbox"
      ),
      null
    );
    assert.equal(
      stripe.checkCredentials(
        { ...STRIPE_TEST_KIT.liveCredentials, secretKey: "rk_live_restricted" },
        "production"
      ),
      null
    );
  });
});

describe("StripeRampClient estimate total", () => {
  const quote = {
    id: "q_total",
    destination_network: "solana",
    destination_currency: "usdc",
    destination_amount: "19.990000",
    fees: { network_fee_monetary: "0.01", transaction_fee_monetary: "0.80" },
  };

  /** Estimates 20 USD of USDC against a Stripe quote set holding `answers`. */
  async function estimateAgainst(...answers: Record<string, unknown>[]) {
    replayExchanges([
      {
        method: "GET",
        url: /^https:\/\/api\.stripe\.com\/v1\/crypto\/onramp\/quotes\?/,
        query: { source_amount: "20" },
        status: 200,
        body: {
          id: "quote_set_total",
          object: "crypto.onramp.quotes",
          source_amount: "20.00",
          source_currency: "usd",
          rate_fetched_at: 1719947634,
          destination_network_quotes: { solana: answers },
        },
      },
    ]);
    return stripe.estimateOnramp(sandbox, {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "20",
    });
  }

  it("reports what the buyer pays in all, Stripe's fees on top of the amount", async () => {
    const estimate = await estimateAgainst({ ...quote, source_total_amount: "20.81" });
    assert.equal(estimate.fiatAmount, "20");
    assert.equal(estimate.totalFiatAmount, "20.81");
  });

  it("adds the fees itself when Stripe leaves the total out", async () => {
    const estimate = await estimateAgainst(quote);
    assert.equal(estimate.fees.total, "0.81");
    assert.equal(estimate.totalFiatAmount, "20.81");
  });

  it("answers ESTIMATE_NOT_AVAILABLE when Stripe quotes nothing for the asset", async () => {
    await assert.rejects(estimateAgainst(), (cause: unknown) => {
      assert.ok(cause instanceof SdpPaymentsError);
      assert.equal(cause.code, "ESTIMATE_NOT_AVAILABLE");
      return true;
    });
  });
});
