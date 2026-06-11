import { afterEach, describe, expect, it, vi } from "vitest";
import { LightsparkRampClient } from "./lightspark";

const LIGHTSPARK_GRID_API_BASE_URL = "https://api.lightspark.com/grid/2025-10-13";
const LIGHTSPARK_CONTEXT = {
  env: {
    LIGHTSPARK_GRID_SANDBOX_CLIENT_ID: "lightspark_client_id",
    LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET: "lightspark_client_secret",
  },
  mode: "sandbox",
} as const;

function gridExchangeRateResponse(params: {
  sourceCurrency: string;
  sourceDecimals: number;
  sendingAmount: number;
  receivingAmount: number;
}): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          sourceCurrency: { code: params.sourceCurrency, decimals: params.sourceDecimals },
          destinationCurrency: { code: "USD", decimals: 2 },
          sendingAmount: params.sendingAmount,
          receivingAmount: params.receivingAmount,
          exchangeRate: 0.998333,
          fees: { fixed: 10 },
          minSendingAmount: 1,
          maxSendingAmount: 100000000000,
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

describe("LightsparkRampClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Grid currency decimals when sending USDC off-ramp estimate amounts", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        gridExchangeRateResponse({
          sourceCurrency: "USDC",
          sourceDecimals: 6,
          sendingAmount: 100000000,
          receivingAmount: 6400,
        })
      )
      .mockResolvedValueOnce(
        gridExchangeRateResponse({
          sourceCurrency: "USDC",
          sourceDecimals: 6,
          sendingAmount: 30000000,
          receivingAmount: 2995,
        })
      );

    await new LightsparkRampClient().estimateOfframp(LIGHTSPARK_CONTEXT, {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      cryptoAmount: "30",
    });

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe(`${LIGHTSPARK_GRID_API_BASE_URL}/exchange-rates`);
    expect(url.searchParams.get("sourceCurrency")).toBe("USDC");
    expect(url.searchParams.get("destinationCurrency")).toBe("USD");
    expect(url.searchParams.has("sendingAmount")).toBe(false);

    const amountSpecificUrl = new URL(String(fetchSpy.mock.calls[1]?.[0]));
    expect(amountSpecificUrl.searchParams.get("sourceCurrency")).toBe("USDC");
    expect(amountSpecificUrl.searchParams.get("destinationCurrency")).toBe("USD");
    expect(amountSpecificUrl.searchParams.get("sendingAmount")).toBe("3000");
  });

  it("uses each Grid source currency's decimals for estimate amounts", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        gridExchangeRateResponse({
          sourceCurrency: "SOL",
          sourceDecimals: 9,
          sendingAmount: 100000000,
          receivingAmount: 99833300,
        })
      )
      .mockResolvedValueOnce(
        gridExchangeRateResponse({
          sourceCurrency: "SOL",
          sourceDecimals: 9,
          sendingAmount: 1250000000,
          receivingAmount: 1247916250,
        })
      );

    await new LightsparkRampClient().estimateOfframp(LIGHTSPARK_CONTEXT, {
      assetRail: "sol.solana",
      fiatCurrency: "USD",
      cryptoAmount: "1.25",
    });

    const url = new URL(String(fetchSpy.mock.calls[1]?.[0]));
    expect(url.searchParams.get("sourceCurrency")).toBe("SOL");
    expect(url.searchParams.get("sendingAmount")).toBe("125000");
  });

  it("returns Grid currency metadata on on-ramp quotes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "Quote:ls_onramp_123",
          quoteStatus: "PENDING",
          exchangeRate: 1,
          totalSendingAmount: 2500,
          sendingCurrency: { code: "USD", decimals: 2, name: "US Dollar", symbol: "$" },
          totalReceivingAmount: 2500,
          receivingCurrency: { code: "USDC", decimals: 2, name: "USD Coin", symbol: "$" },
          feesIncluded: 25,
          expiresAt: "2026-06-05T09:45:00.000Z",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const quote = await new LightsparkRampClient().createOnrampQuote(LIGHTSPARK_CONTEXT, {
      customerId: "Customer:cus_123",
      externalCustomerId: "counterparty_123",
      destinationWalletAddress: "ExternalAccount:acc_destination_123",
      cryptoToken: "USDC",
      fiatCurrency: "USD",
      fiatAmount: "25",
    });

    expect(quote.provider).toBe("lightspark");
    if (quote.provider !== "lightspark") {
      throw new Error("Expected Lightspark quote");
    }
    expect(quote.sendingCurrency).toEqual({
      code: "USD",
      decimals: 2,
      name: "US Dollar",
      symbol: "$",
    });
    expect(quote.receivingCurrency).toEqual({
      code: "USDC",
      decimals: 2,
      name: "USD Coin",
      symbol: "$",
    });
    expect(quote.feeCurrency).toEqual({
      code: "USD",
      decimals: 2,
      name: "US Dollar",
      symbol: "$",
    });
  });

  it("creates realtime-funded off-ramp quotes against the payout account", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "Quote:ls_offramp_123",
          quoteStatus: "PENDING",
          paymentInstructions: [
            {
              accountOrWalletInfo: {
                infoType: "CRYPTO_WALLET_INFO",
                accountType: "SOLANA_WALLET",
                address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
              },
            },
          ],
          exchangeRate: 1,
          totalSendingAmount: 25000000,
          sendingCurrency: { code: "USDC", decimals: 6, name: "USD Coin", symbol: "$" },
          totalReceivingAmount: 2490,
          receivingCurrency: { code: "USD", decimals: 2, name: "US Dollar", symbol: "$" },
          feesIncluded: 10,
          expiresAt: "2026-06-11T09:45:00.000Z",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const quote = await new LightsparkRampClient().createOfframpQuote(LIGHTSPARK_CONTEXT, {
      customerId: "Customer:cus_123",
      externalCustomerId: "counterparty_123",
      payoutAccountId: "ExternalAccount:acc_payout_123",
      sourceWalletAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      cryptoToken: "USDC",
      fiatCurrency: "USD",
      cryptoAmount: "25",
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`${LIGHTSPARK_GRID_API_BASE_URL}/quotes`);
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      source: {
        sourceType: "REALTIME_FUNDING",
        customerId: "Customer:cus_123",
        currency: "USDC",
        cryptoNetwork: "SOLANA",
      },
      destination: {
        destinationType: "ACCOUNT",
        accountId: "ExternalAccount:acc_payout_123",
        currency: "USD",
      },
      lockedCurrencySide: "SENDING",
      lockedCurrencyAmount: 25000000,
      description: "SDP offramp",
    });

    expect(quote.provider).toBe("lightspark");
    if (quote.provider !== "lightspark") {
      throw new Error("Expected Lightspark quote");
    }
    expect(quote.id).toBe("Quote:ls_offramp_123");
    expect(quote.status).toBe("pending");
    expect(quote.deliveryMode).toBe("manual_instructions");
    expect(quote.paymentInstructions).toHaveLength(1);
    expect(quote.totalReceivingAmount).toBe(2490);
  });

  it("creates fiat external payout accounts and parses id + status", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "ExternalAccount:acc_payout_123", status: "ACTIVE" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const account = await new LightsparkRampClient().createFiatExternalAccount(LIGHTSPARK_CONTEXT, {
      customerId: "Customer:cus_123",
      currency: "USD",
      accountInfo: {
        accountType: "USD_ACCOUNT",
        paymentRails: ["ACH"],
        routingNumber: "021000021",
        accountNumber: "12345678901",
        beneficiary: { beneficiaryType: "INDIVIDUAL", fullName: "Ada Lovelace" },
      },
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      `${LIGHTSPARK_GRID_API_BASE_URL}/customers/external-accounts`
    );
    expect(account).toEqual({ id: "ExternalAccount:acc_payout_123", status: "ACTIVE" });
  });

  it("deletes external accounts and accepts the empty 204 body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await new LightsparkRampClient().deleteExternalAccount(LIGHTSPARK_CONTEXT, {
      accountId: "ExternalAccount:acc_payout_123",
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      `${LIGHTSPARK_GRID_API_BASE_URL}/customers/external-accounts/ExternalAccount%3Aacc_payout_123`
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });
});
