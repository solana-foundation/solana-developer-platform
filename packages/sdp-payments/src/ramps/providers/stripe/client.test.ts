import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "#/errors";
import { RAMP_PROVIDER_CLIENTS } from "#/ramps/index";
import { replayExchanges } from "#/ramps/test-kit";
import { StripeRampClient } from "./client";
import { STRIPE_SESSION_TERMS, STRIPE_TEST_KIT, stripeSessionExchange } from "./test-kit";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Quotes the kit's onramp against a session that echoes `terms`. */
async function quoteAgainst(terms: typeof STRIPE_SESSION_TERMS) {
  assert.ok(STRIPE_TEST_KIT.onramp, "the Stripe kit records an onramp");
  replayExchanges([stripeSessionExchange(terms)]);
  return new StripeRampClient().createOnrampQuote(
    { env: STRIPE_TEST_KIT.env, mode: "sandbox" },
    STRIPE_TEST_KIT.onramp.quote.input
  );
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

describe("StripeRampClient credentials", () => {
  /** Estimates the kit's onramp with `env` in `mode`, recording every request. */
  async function estimateWith(env: Record<string, string>, mode: "sandbox" | "production") {
    assert.ok(STRIPE_TEST_KIT.onramp, "the Stripe kit records an onramp");
    const replay = replayExchanges(STRIPE_TEST_KIT.onramp.estimate.exchanges);
    const settled = await RAMP_PROVIDER_CLIENTS.stripe
      .estimateOnramp({ env, mode }, STRIPE_TEST_KIT.onramp.estimate.input)
      .then(
        () => ({ ok: true as const }),
        (cause: unknown) => ({ ok: false as const, cause })
      );
    return { settled, requests: replay.requests.length + replay.unrecorded.length };
  }

  function refusedBeforeAnyRequest(
    result: Awaited<ReturnType<typeof estimateWith>>,
    message: string
  ): void {
    assert.equal(result.requests, 0, "no request reaches Stripe");
    assert.ok(!result.settled.ok, "the estimate is refused");
    assert.ok(result.settled.cause instanceof SdpPaymentsError);
    assert.equal(result.settled.cause.code, "PROVIDER_NOT_CONFIGURED");
    assert.equal(result.settled.cause.message, message);
  }

  it("refuses production projects, which bring their own keys", async () => {
    refusedBeforeAnyRequest(
      await estimateWith(STRIPE_TEST_KIT.env, "production"),
      "Stripe is not configured for production projects."
    );
  });

  it("refuses a live secret key mounted under the sandbox names", async () => {
    refusedBeforeAnyRequest(
      await estimateWith(
        { ...STRIPE_TEST_KIT.env, STRIPE_SANDBOX_SECRET_KEY: "sk_live_mounted_by_mistake" },
        "sandbox"
      ),
      "Stripe sandbox keys must be test-mode keys."
    );
  });

  it("refuses a live publishable key mounted under the sandbox names", async () => {
    refusedBeforeAnyRequest(
      await estimateWith(
        { ...STRIPE_TEST_KIT.env, STRIPE_SANDBOX_PUBLISHABLE_KEY: "pk_live_mounted_by_mistake" },
        "sandbox"
      ),
      "Stripe sandbox keys must be test-mode keys."
    );
  });

  it("refuses when the sandbox keys are missing", async () => {
    refusedBeforeAnyRequest(
      await estimateWith({ STRIPE_SANDBOX_PUBLISHABLE_KEY: "pk_test_contract" }, "sandbox"),
      "Stripe sandbox is not configured. Set STRIPE_SANDBOX_SECRET_KEY and STRIPE_SANDBOX_PUBLISHABLE_KEY."
    );
  });

  it("accepts a restricted test-mode secret key", async () => {
    const result = await estimateWith(
      { ...STRIPE_TEST_KIT.env, STRIPE_SANDBOX_SECRET_KEY: "rk_test_restricted" },
      "sandbox"
    );
    assert.ok(result.settled.ok, "the estimate succeeds");
    assert.equal(result.requests, 1);
  });
});
