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
