import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LightsparkRampClient } from "./client";

const runtimeContext = {
  env: {
    LIGHTSPARK_GRID_SANDBOX_CLIENT_ID: "client_id",
    LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET: "client_secret",
  },
  mode: "sandbox",
} as const;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LightsparkRampClient.listExternalAccountDetails", () => {
  it("maps Grid accounts and exposes only the account-number last four digits", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "ExternalAccount:grid_123",
              customerId: "Customer:customer_123",
              platformAccountId: "counterparty_provider_account_123",
              currency: "USD",
              status: "ACTIVE",
              accountInfo: {
                accountType: "USD_ACCOUNT",
                paymentRails: ["ACH", "SWIFT"],
                bankName: "Example Bank",
                accountNumber: "123456789",
                swiftCode: "EXAMPLEUS",
                country: "US",
                beneficiary: { name: "Example" },
              },
            },
          ],
          hasMore: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const details = await new LightsparkRampClient().listExternalAccountDetails(runtimeContext, {
      providerCustomerReference: "Customer:customer_123",
      fiatCurrency: "USD",
    });

    assert.deepEqual(details, [
      {
        platformAccountId: "counterparty_provider_account_123",
        providerStatus: "ACTIVE",
        bankName: "Example Bank",
        accountNumberLast4: "6789",
        paymentRails: ["ACH", "SWIFT"],
      },
    ]);
  });
});

describe("LightsparkRampClient.findExternalAccountByPlatformId", () => {
  it("resolves a listed match that omitted its status through the single-account fetch", async () => {
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/customers/external-accounts")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "ExternalAccount:match",
                platformAccountId: "counterparty_provider_account_123",
                accountInfo: { accountType: "USD_ACCOUNT" },
              },
            ],
            hasMore: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (path.endsWith("/customers/external-accounts/ExternalAccount%3Amatch")) {
        return new Response(JSON.stringify({ id: "ExternalAccount:match", status: "ACTIVE" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const found = await new LightsparkRampClient().findExternalAccountByPlatformId(runtimeContext, {
      customerId: "Customer:customer_123",
      currency: "USD",
      platformAccountId: "counterparty_provider_account_123",
    });

    assert.deepEqual(found, { id: "ExternalAccount:match", status: "ACTIVE" });
  });

  it("throws when the listing ends before the platform id could be resolved", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [], hasMore: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    await assert.rejects(
      new LightsparkRampClient().findExternalAccountByPlatformId(runtimeContext, {
        customerId: "Customer:customer_123",
        currency: "USD",
        platformAccountId: "counterparty_provider_account_123",
      }),
      /ended before the platform id was resolved/
    );
  });
});
