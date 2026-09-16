import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "../../../errors";
import type { RampRuntimeContext } from "../../types";
import { BvnkRampClient } from "./client";
import { bvnkRuleEntityFromCustomer } from "./provider-data";
import {
  bvnkCustomerSchema,
  type CreateBvnkAgreementSessionInput,
  type CreateBvnkCustomerInput,
} from "./schemas";

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

const sessionResponse = {
  reference: "c1d91c8b-f4a6-469e-953d-7344fdb6858c",
  accountReference: "07f1fe9b-c14e-4a1d-a3fa-0768bac98033",
  status: "PENDING",
  customerType: "INDIVIDUAL",
  useCase: "EMBEDDED_FIAT_ACCOUNTS",
  countryCode: "US",
  expiresOn: "2027-09-16T13:07:34.439862563Z",
  agreements: [
    {
      status: "PENDING",
      name: "EMBEDDED_PARTNER_PLATFORM_CUSTOMERS_US",
      displayName: "Embedded US Partner Platform Customers Agreement",
      description: "Embedded US Partner Platform Customers Agreement",
      url: "https://help.bvnk.com/hc/en-us/sections/27816998470930-BVNK-US-Partner-Platform-Customers",
      privacyPolicyName: "End customer Privacy Policy",
      privacyPolicyDescription:
        "Privacy Policy describes our data handling practices when you access content we own or operate on the website located at www.bvnk.com or any other associated websites we own or operate",
      privacyPolicyUrl: "https://help.bvnk.com/hc/en-us/articles/7662076884882-Privacy-Policy",
    },
  ],
};

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
  emailAddress: "probe+178****5742@example.com",
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
} satisfies CreateBvnkCustomerInput["individual"];

const createdCustomerResponse = {
  reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
  status: "PENDING",
};

const customerDetailResponse = {
  reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
  externalReference: "probe_v1_1789564047204",
  status: "INFO_REQUIRED",
  type: "INDIVIDUAL",
  flowType: "API",
  individual: {
    person: {
      reference: "6273b651-74c1-47c2-84d4-0052238a6232",
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1984-06-30",
      address: {
        addressLine1: "1 Main Street",
        city: "Austin",
        postalCode: "78701",
        stateCode: "TX",
        state: "Texas",
        countryCode: "US",
        country: "United States",
      },
    },
    details: {
      nationality: "US",
      birthCountryCode: "US",
      contactInfo: { emailAddress: "probe+178****5742@example.com" },
      taxIdentification: { number: "123-45-6789", taxResidenceCountryCode: "US" },
    },
    cdd: {
      intendedUseOfAccount: "TRANSFERS_OWN_WALLET",
      pepStatus: "NOT_PEP",
      expectedMonthlyVolume: { amount: 1000, currency: "USD" },
      employmentStatus: "SALARIED",
      sourceOfFunds: "SALARY",
      estimatedYearlyIncome: "INCOME_0_TO_50K",
      employmentIndustrySector: "INVESTMENT",
    },
  },
  verification: {
    status: "init",
    url: "https://in.sumsub.com/websdk/p/sbx_EDHeJPPmWnBSU2Es",
    expiresAt: "2026-10-16T13:07:54.354482408Z",
  },
};

const searchResponse = {
  totalElements: 1,
  totalPages: 1,
  content: [
    {
      id: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      reference: "probe_v1_1789564047204",
      status: "ACTIONS_REQUIRED",
      type: "INDIVIDUAL",
      model: "EMBEDDED",
      name: "Jane Doe",
      createdAt: "2026-09-16T13:07:50.438748Z",
    },
  ],
  pageable: { pageNumber: 0, pageSize: 64 },
  hasNext: false,
};

const duplicateExternalReferenceError = {
  code: "ACCOUNTS-2000",
  traceId: "6aaa94d1184d65e454d08a790495961b",
  status: "Bad Request",
  message: "Invalid request",
  details: {
    errors: {
      externalReference: [
        "Customer with external reference: probe_v1_1789564047204 already exists",
      ],
      signedAgreementSessionReference: [
        "Agreement session with reference: c1d91c8b-f4a6-469e-953d-7344fdb6858c is already assigned to the customer",
      ],
    },
  },
};

describe("BvnkRampClient v1 customer surfaces", () => {
  it("creates an agreement session for the residence country", async () => {
    const { requests } = queueFetch(respond(sessionResponse, 201));

    const result = await new BvnkRampClient().createAgreementSession(runtimeContext, {
      countryCode: "US" as CreateBvnkAgreementSessionInput["countryCode"],
    });

    assert.deepEqual(result, {
      reference: sessionResponse.reference,
      status: "PENDING",
      agreements: sessionResponse.agreements.map((agreement) => ({
        status: agreement.status,
        name: agreement.name,
        displayName: agreement.displayName,
        description: agreement.description,
        url: agreement.url,
        privacyPolicyUrl: agreement.privacyPolicyUrl,
      })),
    });
    assert.equal(new URL(requests[0].url).pathname, "/platform/v1/customers/agreement/sessions");
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      customerType: "INDIVIDUAL",
      countryCode: "US",
      useCase: "EMBEDDED_FIAT_ACCOUNTS",
    });
  });

  it("signs an agreement session with the consenting IP and accepts the empty 204", async () => {
    const { requests } = queueFetch(new Response(null, { status: 204 }));

    const result = await new BvnkRampClient().signAgreementSession(runtimeContext, {
      reference: sessionResponse.reference,
      ipAddress: "203.0.113.10",
    });

    assert.equal(result, undefined);
    assert.equal(
      new URL(requests[0].url).pathname,
      `/platform/v1/customers/agreement/sessions/${sessionResponse.reference}`
    );
    assert.equal(requests[0].init.method, "PUT");
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      status: "SIGNED",
      ipAddress: "203.0.113.10",
    });
  });

  it("creates a v1 customer with the idempotency header and no useCase", async () => {
    const { requests } = queueFetch(respond(createdCustomerResponse, 201));

    const result = await new BvnkRampClient().createCustomer(runtimeContext, {
      idempotencyKey: "customer-key",
      externalReference: "probe_v1_1789564047204",
      signedAgreementSessionReference: sessionResponse.reference,
      individual,
    });

    assert.deepEqual(result, createdCustomerResponse);
    assert.equal(new URL(requests[0].url).pathname, "/platform/v1/customers");
    assert.equal(new Headers(requests[0].init.headers).get("X-Idempotency-Key"), "customer-key");
    const body = JSON.parse(String(requests[0].init.body)) as Record<string, unknown>;
    assert.equal(body.useCase, undefined);
    assert.equal(body.description, undefined);
    assert.deepEqual(body, {
      type: "individual",
      externalReference: "probe_v1_1789564047204",
      signedAgreementSessionReference: sessionResponse.reference,
      individual,
    });
  });

  it("returns the typed v1 customer detail including its verification link", async () => {
    queueFetch(respond(customerDetailResponse));

    const result = await new BvnkRampClient().getCustomer(runtimeContext, {
      reference: createdCustomerResponse.reference,
    });

    assert.deepEqual(result, {
      reference: customerDetailResponse.reference,
      status: "INFO_REQUIRED",
      verification: {
        status: "init",
        url: customerDetailResponse.verification.url,
      },
      individual: {
        person: {
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1984-06-30",
          address: {
            addressLine1: "1 Main Street",
            city: "Austin",
            postalCode: "78701",
            stateCode: "TX",
            countryCode: "US",
          },
        },
      },
    });
  });

  it("resolves a PENDING v1 customer whose verification block has no Sumsub link", async () => {
    queueFetch(
      respond({
        ...customerDetailResponse,
        status: "PENDING",
        verification: { status: "pending" },
      })
    );

    const result = await new BvnkRampClient().getCustomer(runtimeContext, {
      reference: createdCustomerResponse.reference,
    });

    assert.deepEqual(result, {
      reference: customerDetailResponse.reference,
      status: "PENDING",
      verification: { status: "pending" },
      individual: {
        person: {
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1984-06-30",
          address: {
            addressLine1: "1 Main Street",
            city: "Austin",
            postalCode: "78701",
            stateCode: "TX",
            countryCode: "US",
          },
        },
      },
    });
    const verification = result.verification;
    assert.equal(verification === undefined ? undefined : verification.url, undefined);
  });

  it("searches v2 customers by external reference for crash recovery", async () => {
    const { requests } = queueFetch(respond(searchResponse));

    const result = await new BvnkRampClient().searchCustomersV2ByReference(runtimeContext, {
      reference: "probe_v1_1789564047204",
    });

    assert.deepEqual(result, {
      content: [{ id: searchResponse.content[0].id, status: searchResponse.content[0].status }],
    });
    assert.equal(new URL(requests[0].url).pathname, "/platform/v2/customers");
    assert.equal(new URL(requests[0].url).searchParams.get("reference"), "probe_v1_1789564047204");
  });

  it("surfaces the typed conflict envelope when the external reference is already taken", async () => {
    queueFetch(respond(duplicateExternalReferenceError, 400));

    await assert.rejects(
      () =>
        new BvnkRampClient().createCustomer(runtimeContext, {
          idempotencyKey: "customer-key",
          externalReference: "probe_v1_1789564047204",
          signedAgreementSessionReference: sessionResponse.reference,
          individual,
        }),
      (error: unknown) => {
        assert.equal(error instanceof SdpPaymentsError, true);
        if (!(error instanceof SdpPaymentsError)) return false;
        assert.equal(
          error.message,
          "BVNK request failed with status 400: ACCOUNTS-2000 Invalid request"
        );
        assert.deepEqual(error.details, {
          code: "ACCOUNTS-2000",
          errors: duplicateExternalReferenceError.details.errors,
        });
        return true;
      }
    );
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
      customerId: "customer-id",
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

describe("BvnkRampClient on-ramp payment rules", () => {
  it("sends the individual entity mapped from the v1 customer person", async () => {
    const ruleResponse = {
      id: "98c0bb03-567f-11f0-b26e-6b1848874a27",
      reference: "sdp_rule_1",
      status: "ACTIVE",
    };
    const { requests } = queueFetch(respond(ruleResponse, 201));

    const customer = bvnkCustomerSchema.parse(customerDetailResponse);
    const result = await new BvnkRampClient().createOnrampRule(runtimeContext, {
      reference: "sdp_rule_1",
      walletId: "a:24122329329347:HsdJVhW:1",
      currency: "USDC",
      network: "SOLANA",
      beneficiaryAddress: "dest",
      entity: bvnkRuleEntityFromCustomer(customer),
    });

    assert.equal(result.id, ruleResponse.id);
    assert.equal(new URL(requests[0].url).pathname, "/payment/v1/rules");
    const body = JSON.parse(String(requests[0].init.body)) as {
      beneficiary: { entity: unknown };
    };
    assert.deepEqual(body.beneficiary.entity, {
      type: "INDIVIDUAL",
      relationshipType: "SELF_OWNED",
      customerIdentifier: customerDetailResponse.reference,
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1984-06-30",
      address: {
        addressLine1: "1 Main Street",
        city: "Austin",
        region: "TX",
        postCode: "78701",
        country: "US",
      },
    });
  });
});
