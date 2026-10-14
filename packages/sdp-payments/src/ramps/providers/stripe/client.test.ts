import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "../../../errors";
import { replayExchanges } from "../../test-kit";
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
