import { StripeRampClient } from "@sdp/payments/ramps/providers/stripe/client";
import type { RampOnrampQuoteInput } from "@sdp/payments/ramps/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const STRIPE_CONTEXT = {
  env: {
    STRIPE_SECRET_KEY: "sk_test_secret",
    STRIPE_PUBLISHABLE_KEY: "pk_test_pub",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  },
  mode: "sandbox",
} as const;

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sessionResponse(overrides?: Record<string, unknown>): Response {
  const body = {
    id: "cos_123",
    client_secret: "cos_123_secret_abc",
    status: "initialized",
    redirect_url: "https://crypto.link.com?session_hash=xyz",
  };
  return jsonResponse(overrides ? { ...body, ...overrides } : body);
}

function quotesResponse(overrides?: Record<string, unknown>): Response {
  const body = {
    id: "quote_set_1",
    object: "crypto.onramp.quotes",
    source_amount: "96.50",
    source_currency: "usd",
    rate_fetched_at: 1719947634,
    destination_network_quotes: {
      solana: [
        {
          id: "q_usdc",
          destination_network: "solana",
          destination_currency: "usdc",
          destination_amount: "96.500000",
          fees: { network_fee_monetary: "0.01", transaction_fee_monetary: "3.49" },
          source_total_amount: "100.00",
        },
      ],
    },
  };
  return jsonResponse(overrides ? { ...body, ...overrides } : body);
}

function onrampInput(overrides?: Partial<RampOnrampQuoteInput>): RampOnrampQuoteInput {
  const input: RampOnrampQuoteInput = {
    cryptoToken: "usdc.solana",
    fiatCurrency: "USD",
    fiatAmount: "100",
    destinationWalletAddress: "WALLET123",
    externalCustomerId: "cp_1",
    customerIpAddress: "8.8.8.8",
    stripeCustomerInfo: {
      email: "john@doe.com",
      firstName: "John",
      lastName: "Doe",
      dob: { year: 1990, month: 7, day: 4 },
      address: {
        line1: "1 Market St",
        city: "SF",
        state: "CA",
        postalCode: "94080",
        country: "US",
      },
    },
  };
  return overrides ? { ...input, ...overrides } : input;
}

function requireFetchInit(fetchSpy: ReturnType<typeof vi.spyOn>): RequestInit {
  const firstCall = fetchSpy.mock.calls[0];
  if (!firstCall) {
    throw new Error("Expected fetch to be called");
  }
  const init = firstCall[1];
  if (!init) {
    throw new Error("Expected fetch init");
  }
  return init;
}

function readStripeBody(init: RequestInit): URLSearchParams {
  if (init.body instanceof URLSearchParams) {
    return init.body;
  }
  if (typeof init.body === "string") {
    return new URLSearchParams(init.body);
  }
  throw new Error("Expected Stripe form body");
}

describe("StripeRampClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an onramp session with a locked wallet and identity prefill", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sessionResponse());

    const quote = await new StripeRampClient().createOnrampQuote(STRIPE_CONTEXT, onrampInput());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/crypto/onramp_sessions");

    const init = requireFetchInit(fetchSpy);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");

    const body = readStripeBody(init);
    expect(body.get("wallet_addresses[solana]")).toBe("WALLET123");
    expect(body.get("lock_wallet_address")).toBe("true");
    expect(body.get("source_currency")).toBe("usd");
    expect(body.get("source_amount")).toBe("100");
    expect(body.get("destination_currency")).toBe("usdc");
    expect(body.get("destination_network")).toBe("solana");
    expect(body.getAll("destination_currencies[]")).toEqual(["usdc", "sol"]);
    expect(body.get("customer_ip_address")).toBe("8.8.8.8");
    expect(body.get("customer_information[email]")).toBe("john@doe.com");
    expect(body.get("customer_information[dob][year]")).toBe("1990");
    expect(body.get("customer_information[address][state]")).toBe("CA");

    expect(quote).toMatchObject({
      provider: "stripe",
      deliveryMode: "session_widget",
      id: "cos_123",
      sessionId: "cos_123",
      clientSecret: "cos_123_secret_abc",
      publishableKey: "pk_test_pub",
      redirectUrl: "https://crypto.link.com?session_hash=xyz",
    });
  });

  it("maps sol.solana to Stripe's sol destination", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sessionResponse());

    await new StripeRampClient().createOnrampQuote(
      STRIPE_CONTEXT,
      onrampInput({ cryptoToken: "sol.solana", stripeCustomerInfo: undefined })
    );

    expect(readStripeBody(requireFetchInit(fetchSpy)).get("destination_currency")).toBe("sol");
  });

  it("requires a fiat currency", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      new StripeRampClient().createOnrampQuote(
        STRIPE_CONTEXT,
        onrampInput({ fiatCurrency: undefined })
      )
    ).rejects.toThrow(/requires a fiat currency/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsupported destination assets", async () => {
    await expect(
      new StripeRampClient().createOnrampQuote(
        STRIPE_CONTEXT,
        onrampInput({ cryptoToken: "usdt.solana" })
      )
    ).rejects.toThrow(/usdc\.solana and sol\.solana/);
  });

  it("throws when the secret key is not configured", async () => {
    await expect(
      new StripeRampClient().createOnrampQuote({ env: {}, mode: "sandbox" }, onrampInput())
    ).rejects.toThrow(/Stripe is not configured/);
  });

  it("returns an onramp estimate from Stripe quotes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(quotesResponse());

    const estimate = await new StripeRampClient().estimateOnramp(STRIPE_CONTEXT, {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "100",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/v1/crypto/onramp/quotes");
    expect(String(url)).toContain("source_amount=100");
    expect(String(url)).toContain("source_currency=usd");
    expect(init?.method).toBe("GET");
    expect(estimate).toMatchObject({
      provider: "stripe",
      direction: "onramp",
      fiatCurrency: "USD",
      assetRail: "usdc.solana",
      fiatAmount: "100",
      cryptoAmount: "96.500000",
      fees: { currency: "USD", total: "3.5", network: "0.01", provider: "3.49" },
    });
  });

  it("throws ESTIMATE_NOT_AVAILABLE when Stripe returns no matching quote", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      quotesResponse({ destination_network_quotes: { solana: [] } })
    );

    await expect(
      new StripeRampClient().estimateOnramp(STRIPE_CONTEXT, {
        assetRail: "usdc.solana",
        fiatCurrency: "USD",
        fiatAmount: "100",
      })
    ).rejects.toThrow(/did not return an on-ramp quote/);
  });

  it("marks onramp counterparties ready and offramp unsupported", () => {
    const client = new StripeRampClient();
    const counterparty = {} as Parameters<StripeRampClient["validateCounterparty"]>[0];

    expect(
      client.validateCounterparty(counterparty, { direction: "onramp", providerData: {} })
    ).toEqual({
      provider: "stripe",
      direction: "onramp",
      status: "ready",
    });
    expect(
      client.validateCounterparty(counterparty, { direction: "offramp", providerData: {} })
    ).toMatchObject({ provider: "stripe", direction: "offramp", status: "unsupported" });
  });

  it("sums network and transaction fees without float drift", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      quotesResponse({
        destination_network_quotes: {
          solana: [
            {
              id: "q_usdc",
              destination_network: "solana",
              destination_currency: "usdc",
              destination_amount: "96.500000",
              fees: { network_fee_monetary: "0.1", transaction_fee_monetary: "3.49" },
              source_total_amount: "100.00",
            },
          ],
        },
      })
    );

    const estimate = await new StripeRampClient().estimateOnramp(STRIPE_CONTEXT, {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "100",
    });

    expect(estimate.fees).toMatchObject({ network: "0.1", provider: "3.49", total: "3.59" });
  });
});
