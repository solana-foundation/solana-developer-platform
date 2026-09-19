import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it, mock } from "node:test";
import { z } from "zod";
import { SdpPaymentsError } from "../../../errors";
import type { RampOnrampQuoteInput, RampRuntimeContext } from "../../types";
import { CoinbaseRampClient } from "./client";

// A throwaway Ed25519 key so the client can mint its request JWT; never a real credential.
// The CDP SDK accepts the 64-byte seed+public form as base64.
function throwawayEd25519Secret(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return Buffer.concat([seed, pub]).toString("base64");
}
const env = {
  COINBASE_CDP_API_KEY_ID: "organizations/test/apiKeys/test",
  COINBASE_CDP_API_KEY_SECRET: throwawayEd25519Secret(),
};
const sandbox = { env, mode: "sandbox" } satisfies RampRuntimeContext;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

function respond(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const orderBodySchema = z.record(z.string(), z.unknown());

function captureOrderRequest(response: Response): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = orderBodySchema.parse(JSON.parse(String(init?.body)));
    return response;
  };
  return {
    body: () => {
      if (captured === undefined) {
        throw new Error("Coinbase order request was not sent");
      }
      return captured;
    },
  };
}

const orderResponse = {
  order: {
    orderId: "order_123",
    status: "PENDING",
    paymentCurrency: "USD",
    paymentSubtotal: "100.00",
    paymentTotal: "102.44",
    purchaseCurrency: "USDC",
    purchaseAmount: "100.00",
    exchangeRate: "1",
    fees: [{ amount: "2.44", currency: "USD", type: "COINBASE_FEE" }],
  },
  paymentLink: {
    url: "https://pay.coinbase.com/v3/buy/input?sessionToken=abc",
    paymentLinkType: "PAYMENT_LINK_TYPE_APPLE_PAY_BUTTON",
  },
  userAuthToken: "uat_secret_do_not_store",
};

const quoteInput = {
  assetRail: "usdc.solana",
  fiatCurrency: "USD",
  fiatAmount: "100",
  destinationWalletAddress: "wallet_123",
  externalCustomerId: "cpty_123",
} satisfies RampOnrampQuoteInput;

describe("CoinbaseRampClient.createOnrampQuote (embedded mode)", () => {
  it("creates the order without any buyer contact data or verification timestamps", async () => {
    const request = captureOrderRequest(respond(orderResponse));

    await new CoinbaseRampClient().createOnrampQuote(sandbox, quoteInput);

    const body = request.body();
    assert.deepEqual(body, {
      paymentCurrency: "USD",
      purchaseCurrency: "USDC",
      paymentMethod: "GUEST_CHECKOUT_APPLE_PAY",
      destinationAddress: "wallet_123",
      destinationNetwork: "solana",
      paymentAmount: "100",
      partnerUserRef: "sandbox-cpty_123",
    });
  });

  it("forwards the embedding domain when the caller supplies one", async () => {
    const request = captureOrderRequest(respond(orderResponse));

    await new CoinbaseRampClient().createOnrampQuote(sandbox, {
      ...quoteInput,
      domain: "sdp-web-smoky.vercel.app",
    });

    assert.equal(request.body().domain, "sdp-web-smoky.vercel.app");
  });

  it("omits the domain for local hostnames, which Coinbase never allow-lists", async () => {
    for (const hostname of ["localhost", "127.0.0.1", "LOCALHOST"]) {
      const request = captureOrderRequest(respond(orderResponse));

      await new CoinbaseRampClient().createOnrampQuote(sandbox, {
        ...quoteInput,
        domain: hostname,
      });

      assert.equal(request.body().domain, undefined, hostname);
    }
  });

  it("neither returns nor logs the userAuthToken Coinbase sends back", async () => {
    captureOrderRequest(respond(orderResponse));
    const log = mock.method(console, "log", () => undefined);

    const quote = await new CoinbaseRampClient().createOnrampQuote(sandbox, quoteInput);

    assert.ok(!JSON.stringify(quote).includes("uat_secret_do_not_store"));
    assert.equal(quote.provider, "coinbase");
    assert.equal(quote.id, "order_123");
    assert.equal(quote.status, "pending");
    assert.equal(quote.deliveryMode, "hosted");
    assert.ok("hostedUrl" in quote && quote.hostedUrl.includes("useApplePaySandbox=true"));
    const logged = log.mock.calls.map((call) => call.arguments.map(String).join(" ")).join("\n");
    assert.ok(!logged.includes("uat_secret_do_not_store"));
    assert.ok(!logged.includes("sessionToken=abc"));
  });

  it("refuses production orders until the embedding domain is registered", async () => {
    await assert.rejects(
      new CoinbaseRampClient().createOnrampQuote({ env, mode: "production" }, quoteInput),
      (error: unknown) =>
        error instanceof SdpPaymentsError && /registered embedding domain/.test(error.message)
    );
  });
});
