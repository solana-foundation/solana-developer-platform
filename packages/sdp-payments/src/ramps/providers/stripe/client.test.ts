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
  it("accepts a session that echoes the quote, amount normalized", async () => {
    const quote = await quoteAgainst(STRIPE_SESSION_TERMS);
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

  it("refuses a session that unlocks the wallet or changes the amount", async () => {
    await assert.rejects(
      quoteAgainst({
        ...STRIPE_SESSION_TERMS,
        lock_wallet_address: false,
        source_amount: "250.00",
      }),
      refusedFor(["lock_wallet_address", "source_amount"])
    );
  });
});
