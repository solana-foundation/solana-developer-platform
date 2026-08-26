import {
  buildHercleSignature,
  HercleRampClient,
} from "@sdp/payments/ramps/providers/hercle/client";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const RUNTIME: RampRuntimeContext = {
  env: {
    HERCLE_SANDBOX_CLIENT_ID: "hpk_test_client",
    HERCLE_SANDBOX_CLIENT_SECRET: "hercle-test-secret",
    HERCLE_SANDBOX_API_BASE_URL: "https://partner.sandbox.example",
  },
  mode: "sandbox",
};

// System program address — a structurally valid Solana address for instruction assertions.
const DEPOSIT_ADDRESS = "11111111111111111111111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildHercleSignature", () => {
  it("implements Signed Key v1: HMAC-SHA256 over ts + METHOD + pathWithQuery + rawBody", async () => {
    // Vector pinned against the Hercle partner spec (documentation-only secret).
    const signature = await buildHercleSignature(
      // biome-ignore lint/security/noSecrets: published documentation-only test vector secret
      "cvVdfH8pVpI3rWx1Gt4duZAxRq0Y2eaB7kNQ5mM1sT2",
      1756200000,
      "get",
      "/partner/v1/ping",
      ""
    );
    // biome-ignore lint/security/noSecrets: published documentation-only test vector signature
    expect(signature).toBe("iMXClpe2o7fK3tmryuWZYDrMArC9EeWU8K+lqqc06uQ=");
  });
});

describe("HercleRampClient request signing", () => {
  it("sends the three Signed Key headers and signs the exact wire body", async () => {
    const client = new HercleRampClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        fiatCurrency: "EUR",
        fiatAmount: "100",
        cryptoAmount: "108.5",
        exchangeRate: "0.9217",
        fees: { currency: "EUR", total: "1.5" },
      })
    );

    await client.estimateOfframp(RUNTIME, {
      assetRail: "usdc.solana",
      fiatCurrency: "EUR",
      cryptoAmount: "108.5",
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://partner.sandbox.example/partner/v1/quotes/estimate");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Hercle-Client")).toBe("hpk_test_client");
    const ts = headers.get("X-Hercle-Ts");
    expect(ts).toMatch(/^\d+$/);
    expect(typeof init.body).toBe("string");
    const expected = await buildHercleSignature(
      "hercle-test-secret",
      Number(ts),
      "POST",
      "/partner/v1/quotes/estimate",
      init.body as string
    );
    expect(headers.get("X-Hercle-Signature")).toBe(expected);
  });

  it("throws providerNotConfigured when the sandbox credentials are absent", async () => {
    const client = new HercleRampClient();

    await expect(
      client.estimateOfframp(
        { env: {}, mode: "sandbox" },
        { assetRail: "usdc.solana", fiatCurrency: "EUR", cryptoAmount: "10" }
      )
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("maps 401 responses to providerNotConfigured instead of a generic failure", async () => {
    const client = new HercleRampClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ code: "AUTH_INVALID_SIGNATURE", message: "Signature mismatch" }, 401)
    );

    await expect(
      client.estimateOfframp(RUNTIME, {
        assetRail: "usdc.solana",
        fiatCurrency: "EUR",
        cryptoAmount: "10",
      })
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });
});

describe("HercleRampClient off-ramp quote", () => {
  it("builds a crypto-deposit instruction from the order response", async () => {
    const client = new HercleRampClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        orderId: "ord_123",
        depositAddress: DEPOSIT_ADDRESS,
        reference: "HRC-REF-9",
        expiresAt: "2026-08-27T10:00:00Z",
      })
    );

    const quote = await client.createOfframpQuote(RUNTIME, {
      cryptoToken: "usdc.solana",
      fiatCurrency: "EUR",
      cryptoAmount: "250",
      sourceWalletAddress: DEPOSIT_ADDRESS,
      externalCustomerId: "hercle-account-1",
    });

    expect(quote).toMatchObject({
      id: "ord_123",
      provider: "hercle",
      status: "pending",
      deliveryMode: "manual_instructions",
      expiresAt: "2026-08-27T10:00:00Z",
    });
    if (!("paymentInstructions" in quote) || quote.paymentInstructions === undefined) {
      throw new Error("expected payment instructions");
    }
    expect(quote.paymentInstructions[0]).toMatchObject({
      provider: "hercle",
      kind: "crypto_deposit",
      destinationAddress: DEPOSIT_ADDRESS,
      cryptoCurrency: "USDC",
      network: "solana",
      reference: "HRC-REF-9",
      fiatCurrency: "EUR",
    });
  });

  it("scopes the order to the sub-account via on-behalf-of", async () => {
    const client = new HercleRampClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ orderId: "ord_124", depositAddress: DEPOSIT_ADDRESS }));

    await client.createOfframpQuote(RUNTIME, {
      cryptoToken: "usdc.solana",
      fiatCurrency: "EUR",
      cryptoAmount: "250",
      sourceWalletAddress: DEPOSIT_ADDRESS,
      externalCustomerId: "hercle-account-1",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("on-behalf-of")).toBe("hercle-account-1");
    expect(headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("rejects unsupported crypto tokens before any network call", async () => {
    const client = new HercleRampClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      client.createOfframpQuote(RUNTIME, {
        cryptoToken: "doge.solana",
        fiatCurrency: "EUR",
        cryptoAmount: "250",
        sourceWalletAddress: DEPOSIT_ADDRESS,
        externalCustomerId: "hercle-account-1",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("HercleRampClient on-ramp quote", () => {
  it("builds a fiat-funding instruction with the issued bank account", async () => {
    const client = new HercleRampClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        orderId: "ord_125",
        fiatCurrency: "EUR",
        fiatAmount: "1000",
        bankAccount: {
          iban: "CH9300762011623852957",
          bic: "HERCCHZZ",
          bankName: "Hercle SA",
          paymentReference: "HRC-PAY-1",
        },
      })
    );

    const quote = await client.createOnrampQuote(RUNTIME, {
      cryptoToken: "usdc.solana",
      fiatCurrency: "EUR",
      fiatAmount: "1000",
      destinationWalletAddress: DEPOSIT_ADDRESS,
      externalCustomerId: "hercle-account-1",
    });

    expect(quote).toMatchObject({ id: "ord_125", provider: "hercle", status: "pending" });
    if (!("paymentInstructions" in quote) || quote.paymentInstructions === undefined) {
      throw new Error("expected payment instructions");
    }
    expect(quote.paymentInstructions[0]).toMatchObject({
      provider: "hercle",
      kind: "fiat_funding",
      fiatCurrency: "EUR",
      bankAccount: { iban: "CH9300762011623852957", paymentReference: "HRC-PAY-1" },
    });
  });
});
