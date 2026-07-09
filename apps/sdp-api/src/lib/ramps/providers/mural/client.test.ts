import { SdpPaymentsError } from "@sdp/payments";
import type { SdpEnvironment } from "@sdp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RampRuntimeContext } from "../../types";
import { MuralRampClient } from "./client";

const client = new MuralRampClient();

const RUNTIME: RampRuntimeContext = {
  env: { MURAL_PAY_SANDBOX_API_KEY: "mural_sandbox_key" },
  mode: "sandbox" as SdpEnvironment,
};

describe("MuralRampClient.parseMuralWebhookEvent", () => {
  it("maps verification_status_changed to a kyc_status event", () => {
    expect(
      client.parseMuralWebhookEvent({
        eventCategory: "BUSINESS_VERIFICATION_STATUS",
        payload: {
          type: "verification_status_changed",
          organizationId: "org_1",
          currentStatus: { type: "approved", approvedAt: "2026-06-26T00:00:00Z" },
        },
      })
    ).toEqual({ kind: "kyc_status", organizationId: "org_1", kycStatus: "approved" });
  });

  it("maps tos_accepted", () => {
    expect(
      client.parseMuralWebhookEvent({
        payload: { type: "tos_accepted", organizationId: "org_2", source: "ui" },
      })
    ).toEqual({ kind: "tos_accepted", organizationId: "org_2" });
  });

  it("maps account_credited", () => {
    expect(
      client.parseMuralWebhookEvent({
        payload: {
          type: "account_credited",
          organizationId: "org_3",
          accountId: "acct_1",
          tokenAmount: { tokenAmount: 42.5, tokenSymbol: "USDC" },
        },
      })
    ).toEqual({
      kind: "account_credited",
      organizationId: "org_3",
      accountId: "acct_1",
      tokenAmount: 42.5,
    });
  });

  it("maps executed payout status changes", () => {
    expect(
      client.parseMuralWebhookEvent({
        payload: {
          type: "payout_request_status_changed",
          organizationId: "org_4",
          payoutRequestId: "payout_1",
          statusChangeDetails: { currentStatus: { type: "executed" } },
        },
      })
    ).toEqual({ kind: "payout_settled", organizationId: "org_4", payoutRequestId: "payout_1" });
  });

  it("ignores unhandled event types", () => {
    expect(
      client.parseMuralWebhookEvent({
        payload: { type: "payout_status_changed", organizationId: "org_5" },
      }).kind
    ).toBe("ignore");
  });

  it("ignores an unknown kyc status", () => {
    expect(
      client.parseMuralWebhookEvent({
        payload: {
          type: "verification_status_changed",
          organizationId: "org_6",
          currentStatus: { type: "weird" },
        },
      }).kind
    ).toBe("ignore");
  });

  it("ignores an event with no organizationId", () => {
    expect(client.parseMuralWebhookEvent({ payload: { type: "tos_accepted" } }).kind).toBe(
      "ignore"
    );
  });
});

describe("MuralRampClient.listAccounts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scopes to the managed org and maps payin methods", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "acct_1",
            isApiEnabled: true,
            status: "ACTIVE",
            destinationToken: { symbol: "USDC", blockchain: "POLYGON" },
            accountDetails: {
              payinMethods: [
                {
                  status: "ACTIVATED",
                  supportedDestinationTokens: [
                    { token: { symbol: "USDC", blockchain: "POLYGON" } },
                  ],
                  payinRailDetails: {
                    type: "usd",
                    currency: "USD",
                    payinRails: ["ACH", "WIRE"],
                    bankAccountNumber: "123456789",
                    bankRoutingNumber: "021000021",
                  },
                },
              ],
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const accounts = await client.listAccounts(RUNTIME, "org_42");

    const request = fetchSpy.mock.calls[0];
    expect(String(request?.[0])).toBe("https://api-staging.muralpay.com/api/accounts");
    expect(new Headers(request?.[1]?.headers).get("on-behalf-of")).toBe("org_42");

    expect(accounts).toHaveLength(1);
    const account = accounts[0];
    if (account === undefined) {
      throw new Error("Expected one Mural account");
    }
    expect(account.isApiEnabled).toBe(true);
    expect(account.payinMethods[0]).toEqual({
      status: "ACTIVATED",
      currency: "USD",
      payinRailDetails: {
        type: "usd",
        currency: "USD",
        payinRails: ["ACH", "WIRE"],
        bankAccountNumber: "123456789",
        bankRoutingNumber: "021000021",
      },
    });
  });
});

describe("MuralRampClient account and payout helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an API-enabled account on behalf of the org", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "acct_new" }), { status: 200 }));

    await client.createAccount(RUNTIME, "org_42", "SDP onramp");

    const request = fetchSpy.mock.calls[0];
    expect(String(request?.[0])).toBe("https://api-staging.muralpay.com/api/accounts");
    expect(request?.[1]?.method).toBe("POST");
    expect(new Headers(request?.[1]?.headers).get("on-behalf-of")).toBe("org_42");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ name: "SDP onramp" });
  });

  it("simulates a payin with the rail-specific amount on behalf of the org", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 201 }));

    await client.simulatePayin(RUNTIME, {
      organizationId: "org_42",
      destinationAccountId: "acct_1",
      rail: "wire",
      amountValue: "2500",
      currencySymbol: "USD",
    });

    const request = fetchSpy.mock.calls[0];
    expect(String(request?.[0])).toBe(
      "https://api-staging.muralpay.com/api/sandbox/simulate/payin"
    );
    expect(new Headers(request?.[1]?.headers).get("on-behalf-of")).toBe("org_42");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      destinationAccountId: "acct_1",
      rail: { type: "wire", amount: { value: "2500", currencySymbol: "USD" } },
    });
  });

  it("creates a USD to Solana payout and executes it with the transfer key", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "payout_1", status: "AWAITING_EXECUTION" }), {
          status: 201,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "payout_1", status: "EXECUTED", transactionHash: "0xabc" }),
          { status: 200 }
        )
      );

    const payout = await client.createPayout(RUNTIME, {
      organizationId: "org_42",
      sourceAccountId: "acct_1",
      tokenAmount: 25,
      walletAddress: "SoLwallet111",
      recipientInfo: {
        type: "individual",
        firstName: "Ada",
        lastName: "Lovelace",
        physicalAddress: {
          address1: "1 St",
          country: "US",
          state: "NY",
          city: "NYC",
          zip: "10001",
        },
      },
      idempotencyKey: "transfer_1",
    });
    expect(payout.payoutRequestId).toBe("payout_1");

    const createRequest = fetchSpy.mock.calls[0];
    expect(String(createRequest?.[0])).toBe("https://api-staging.muralpay.com/api/payouts/payout");
    const createBody = JSON.parse(String(createRequest?.[1]?.body));
    expect(createBody.payouts[0].amount).toEqual({ tokenAmount: 25, tokenSymbol: "USD" });
    expect(createBody.payouts[0].payoutDetails).toEqual({
      type: "blockchain",
      walletDetails: { walletAddress: "SoLwallet111", blockchain: "SOLANA" },
    });

    const executed = await client.executePayout(
      {
        env: { ...RUNTIME.env, MURAL_PAY_SANDBOX_TRANSFER_API_KEY: "transfer_key" },
        mode: "sandbox",
      },
      { organizationId: "org_42", payoutRequestId: "payout_1" }
    );
    expect(executed.transactionHash).toBe("0xabc");
    const executeRequest = fetchSpy.mock.calls[1];
    expect(String(executeRequest?.[0])).toBe(
      "https://api-staging.muralpay.com/api/payouts/payout/payout_1/execute"
    );
    expect(new Headers(executeRequest?.[1]?.headers).get("transfer-api-key")).toBe("transfer_key");
  });

  it("requires the transfer key when executing payouts", async () => {
    await expect(
      client.executePayout(RUNTIME, { organizationId: "org_42", payoutRequestId: "payout_1" })
    ).rejects.toThrow(SdpPaymentsError);
  });
});

describe("MuralRampClient estimates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts fiat-to-token estimate requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            type: "success",
            exchangeRate: 1,
            estimatedTokenAmountRequired: { tokenAmount: 100, tokenSymbol: "USDC" },
            fiatAmount: { fiatAmount: 100, fiatCurrencyCode: "USD" },
            feeTotal: { tokenAmount: 1.25, tokenSymbol: "USDC" },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const estimate = await client.estimateOnramp(RUNTIME, {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "100",
    });

    const request = fetchSpy.mock.calls[0];
    expect(String(request?.[0])).toBe(
      "https://api-staging.muralpay.com/api/payouts/fees/fiat-to-token"
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      fiatFeeRequests: [{ fiatAmount: 100, tokenSymbol: "USDC", fiatAndRailCode: "usd" }],
    });
    expect(estimate).toMatchObject({
      provider: "mural",
      direction: "onramp",
      fiatCurrency: "USD",
      assetRail: "usdc.solana",
      fiatAmount: "100",
      cryptoAmount: "100",
      exchangeRate: "1",
      fees: { currency: "USDC", total: "1.25", provider: "1.25" },
    });
  });

  it("posts token-to-fiat estimate requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            type: "success",
            exchangeRate: 0.99,
            estimatedFiatAmount: { fiatAmount: 99, fiatCurrencyCode: "USD" },
            tokenAmount: { tokenAmount: 100, tokenSymbol: "USDC" },
            feeTotal: { tokenAmount: 1, tokenSymbol: "USDC" },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const estimate = await client.estimateOfframp(RUNTIME, {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      cryptoAmount: "100",
    });

    const request = fetchSpy.mock.calls[0];
    expect(String(request?.[0])).toBe(
      "https://api-staging.muralpay.com/api/payouts/fees/token-to-fiat"
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      tokenFeeRequests: [
        { amount: { tokenAmount: 100, tokenSymbol: "USDC" }, fiatAndRailCode: "usd" },
      ],
    });
    expect(estimate).toMatchObject({
      provider: "mural",
      direction: "offramp",
      fiatCurrency: "USD",
      assetRail: "usdc.solana",
      fiatAmount: "99",
      cryptoAmount: "100",
      exchangeRate: "0.99",
      fees: { currency: "USDC", total: "1", provider: "1" },
    });
  });
});
