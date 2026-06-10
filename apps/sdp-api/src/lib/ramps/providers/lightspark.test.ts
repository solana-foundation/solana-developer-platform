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
});
