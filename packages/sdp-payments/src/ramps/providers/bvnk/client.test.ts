import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "../../../errors";
import type { RampRuntimeContext } from "../../types";
import { BvnkRampClient, type CreateBvnkCustomerV2Input } from "./client";

const runtimeContext = {
  env: {
    BVNK_SANDBOX_WALLET_ID: "wallet_id",
    BVNK_SANDBOX_HAWK_AUTH_ID: "auth_id",
    BVNK_SANDBOX_HAWK_SECRET_KEY: "secret_key",
  },
  mode: "sandbox",
} satisfies RampRuntimeContext;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respond(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function queueFetch(...responses: Response[]): { requests: { url: string; init: RequestInit }[] } {
  const requests: { url: string; init: RequestInit }[] = [];
  let index = 0;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    const response = responses[index];
    index += 1;
    if (response === undefined) {
      throw new Error("unexpected fetch call");
    }
    return response;
  };
  return { requests };
}

const individual = {
  address: {
    addressLine1: "1 Main Street",
    city: "Austin",
    postalCode: "78701",
    stateCode: "TX",
    countryCode: "US",
  },
  dateOfBirth: "1984-06-30",
  firstName: "Jane",
  lastName: "Doe",
  birthCountryCode: "US",
  nationality: "US",
  taxIdentification: { number: "123-45-6789", taxResidenceCountryCode: "US" },
  cdd: {
    employmentStatus: "SALARIED",
    sourceOfFunds: "SALARY",
    pepStatus: "NOT_PEP",
    intendedUseOfAccount: "TRANSFERS_OWN_WALLET",
    expectedMonthlyVolume: { amount: "1000", currency: "USD" },
    estimatedYearlyIncome: "INCOME_0_TO_50K",
    employmentIndustrySector: "INVESTMENT",
  },
} satisfies CreateBvnkCustomerV2Input["individual"];

const customerSummary = {
  id: "customer-id",
  reference: "customer-reference",
  status: "PENDING",
  type: "INDIVIDUAL",
  model: "EMBEDDED_BVNK_MANAGED",
  useCase: "STABLECOIN_PAYOUTS",
};

describe("BvnkRampClient v2 customer surfaces", () => {
  it("creates a v2 customer and sends the required idempotency key", async () => {
    const { requests } = queueFetch(respond(customerSummary, 201));

    const result = await new BvnkRampClient().createCustomerV2(runtimeContext, {
      idempotencyKey: "customer-key",
      useCase: "STABLECOIN_PAYOUTS",
      reference: "customer-reference",
      individual,
    });

    assert.deepEqual(result, customerSummary);
    assert.equal(new URL(requests[0].url).pathname, "/platform/v2/customers");
    assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "customer-key");
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      useCase: "STABLECOIN_PAYOUTS",
      reference: "customer-reference",
      individual,
    });
  });

  it("preserves dotted validation errors from v2 customer creation", async () => {
    queueFetch(
      respond(
        {
          message: "Validation failed",
          details: { errors: { "individual.birthCountryCode": "Required" } },
        },
        400
      )
    );

    await assert.rejects(
      () =>
        new BvnkRampClient().createCustomerV2(runtimeContext, {
          idempotencyKey: "customer-key",
          useCase: "STABLECOIN_PAYOUTS",
          individual,
        }),
      (error: unknown) => {
        assert.equal(error instanceof SdpPaymentsError, true);
        if (!(error instanceof SdpPaymentsError)) return false;
        assert.equal(error.message, "BVNK request failed with status 400");
        assert.deepEqual(error.details, {
          errors: { "individual.birthCountryCode": "Required" },
        });
        return true;
      }
    );
  });

  it("returns the full typed v2 customer detail including its fresh link", async () => {
    const response = {
      ...customerSummary,
      status: "ACTIONS_REQUIRED",
      authenticatedLink: {
        link: "https://onboarding.example/customer",
        expiresAt: "2030-01-01T00:00:00Z",
      },
      requiredActions: [{ type: "DATA", code: "TAX_ID", status: "REQUIRED" }],
      individual,
    };
    queueFetch(respond(response));

    const result = await new BvnkRampClient().getCustomerV2(runtimeContext, {
      id: customerSummary.id,
    });

    assert.deepEqual(result, response);
  });

  it("does not put a v2 customer response body in an error message", async () => {
    const pii = "123-45-6789";
    queueFetch(respond({ individual: { taxIdentification: { number: pii } } }, 500));

    await assert.rejects(
      () => new BvnkRampClient().getCustomerV2(runtimeContext, { id: customerSummary.id }),
      (error: unknown) => {
        assert.equal(error instanceof SdpPaymentsError, true);
        if (!(error instanceof SdpPaymentsError)) return false;
        assert.equal(error.message.includes(pii), false);
        return true;
      }
    );
  });
});

describe("BvnkRampClient v2 agreement surfaces", () => {
  it("creates agreements", async () => {
    const response = {
      id: "working-set-id",
      reference: "customer-reference",
      agreements: [{ id: "agreement-id", status: "PENDING", declinable: false, name: "Terms" }],
      signingUrl: "https://onboarding.example/sign",
    };
    const { requests } = queueFetch(respond(response));

    const result = await new BvnkRampClient().createAgreementsV2(runtimeContext, {
      idempotencyKey: "agreement-key",
      reference: "customer-reference",
      useCase: "STABLECOIN_PAYOUTS",
      customerType: "INDIVIDUAL",
      countryCode: "US",
    });

    assert.deepEqual(result, response);
    assert.equal(new URL(requests[0].url).pathname, "/platform/v2/agreements");
    assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "agreement-key");
  });

  it("gets agreement content", async () => {
    const response = {
      downloadUrl: "https://files.example/agreement.pdf",
      filename: "agreement.pdf",
      expiresAt: null,
    };
    queueFetch(respond(response));

    const result = await new BvnkRampClient().getAgreementContentV2(runtimeContext, {
      id: "agreement-id",
    });

    assert.deepEqual(result, response);
  });

  it("responds to agreements and parses per-agreement results", async () => {
    const response = {
      content: [{ agreementId: "agreement-id", status: "ACCEPTED" }],
      totalElements: 1,
      totalPages: 1,
      hasNext: false,
    };
    const { requests } = queueFetch(respond(response));

    const result = await new BvnkRampClient().respondAgreementsV2(runtimeContext, {
      idempotencyKey: "response-key",
      reference: "customer-reference",
      actions: [{ agreementId: "agreement-id", type: "ACCEPT" }],
    });

    assert.deepEqual(result, response);
    assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "response-key");
  });

  it("lists customer agreements", async () => {
    const response = {
      totalElements: 1,
      totalPages: 1,
      content: [
        {
          id: "assigned-agreement-id",
          agreement: { version: null, title: "Terms", locale: null },
          status: "ACCEPTED",
          respondedAt: null,
          respondedToDocumentChecksum: null,
        },
      ],
      hasNext: false,
    };
    queueFetch(respond(response));

    const result = await new BvnkRampClient().listCustomerAgreementsV2(runtimeContext, {
      customerId: customerSummary.id,
    });

    assert.deepEqual(result, response);
  });
});

describe("BvnkRampClient v2 ledger surfaces", () => {
  const wallet = {
    id: "wallet-id",
    name: "USD Wallet",
    status: "ACTIVE",
    paymentInstruments: [
      {
        type: "FIAT",
        accountHolderName: "Jane Doe",
        accountNumber: "123456789",
        bankDetails: {
          name: "Example Bank",
          bic: "EXAMPLEUS",
          nid: { value: "021000021", type: "ROUTING_NUMBER" },
        },
        remittanceInformationPrefix: "REF-123",
      },
    ],
  };

  it("creates a ledger wallet", async () => {
    const { requests } = queueFetch(respond(wallet, 201));

    const result = await new BvnkRampClient().createLedgerWalletV2(runtimeContext, {
      idempotencyKey: "wallet-key",
      currency: "USD",
      name: "USD Wallet",
      customerId: customerSummary.id,
      profileId: "fiat:usd:profile",
    });

    assert.deepEqual(result, wallet);
    assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "wallet-key");
  });

  it("gets a ledger wallet with typed payment instruments", async () => {
    queueFetch(respond(wallet));

    const result = await new BvnkRampClient().getLedgerWalletV2(runtimeContext, {
      walletId: wallet.id,
    });

    assert.deepEqual(result.paymentInstruments?.[0].bankDetails.nid, {
      value: "021000021",
      type: "ROUTING_NUMBER",
    });
  });

  it("lists ledger wallet profiles and rails", async () => {
    const response = {
      totalElements: 1,
      totalPages: 1,
      content: [{ id: "fiat:usd:profile", currencies: ["USD"], methods: ["ACH", "FEDWIRE"] }],
      hasNext: false,
    };
    queueFetch(respond(response));

    const result = await new BvnkRampClient().listLedgerWalletProfilesV2(runtimeContext);

    assert.deepEqual(result, response);
  });
});
