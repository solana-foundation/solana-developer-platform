import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "../../../errors";
import type { RampRuntimeContext } from "../../types";
import { BvnkRampClient } from "./client";
import { bvnkRuleEntityFromCustomer } from "./provider-data";
import {
  bvnkAgreementSession,
  bvnkCustomer,
  bvnkCustomerCreated,
  bvnkIndividualCustomer,
  bvnkLedgerWallet,
  bvnkWalletProfilesResponse,
} from "./test-fixtures";

const runtimeContext: RampRuntimeContext = {
  env: {
    BVNK_SANDBOX_WALLET_ID: "wallet_id",
    BVNK_SANDBOX_HAWK_AUTH_ID: "auth_id",
    BVNK_SANDBOX_HAWK_SECRET_KEY: "secret_key",
  },
  mode: "sandbox",
};

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

const individual = bvnkIndividualCustomer();

const session = bvnkAgreementSession();

describe("BvnkRampClient v1 customer surfaces", () => {
  it("creates an agreement session for the residence country with the row-uuid idempotency header", async () => {
    const { requests } = queueFetch(respond(session, 201));

    const result = await new BvnkRampClient().createAgreementSession(runtimeContext, {
      countryCode: "US",
      idempotencyKey: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
    });

    assert.deepEqual(result, session);
    assert.equal(new URL(requests[0].url).pathname, "/platform/v1/customers/agreement/sessions");
    assert.equal(
      new Headers(requests[0].init.headers).get("X-Idempotency-Key"),
      "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3"
    );
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      customerType: "INDIVIDUAL",
      countryCode: "US",
      useCase: "EMBEDDED_FIAT_ACCOUNTS",
    });
  });

  it("signs an agreement session with the consenting IP and accepts the empty 204", async () => {
    const { requests } = queueFetch(new Response(null, { status: 204 }));

    const result = await new BvnkRampClient().signAgreementSession(runtimeContext, {
      reference: session.reference,
      ipAddress: "203.0.113.10",
    });

    assert.equal(result, undefined);
    assert.equal(
      new URL(requests[0].url).pathname,
      `/platform/v1/customers/agreement/sessions/${session.reference}`
    );
    assert.equal(requests[0].init.method, "PUT");
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      status: "SIGNED",
      ipAddress: "203.0.113.10",
    });
  });

  it("creates a v1 customer with the idempotency header and no useCase", async () => {
    const response = bvnkCustomerCreated();
    const { requests } = queueFetch(respond(response, 201));

    const result = await new BvnkRampClient().createCustomer(runtimeContext, {
      idempotencyKey: "customer-key",
      externalReference: "probe_v1_1789564047204",
      signedAgreementSessionReference: session.reference,
      individual,
    });

    assert.deepEqual(result, response);
    assert.equal(new URL(requests[0].url).pathname, "/platform/v1/customers");
    assert.equal(new Headers(requests[0].init.headers).get("X-Idempotency-Key"), "customer-key");
    const body = JSON.parse(String(requests[0].init.body)) as Record<string, unknown>;
    assert.equal(body.useCase, undefined);
    assert.equal(body.description, undefined);
    assert.deepEqual(body, {
      type: "individual",
      externalReference: "probe_v1_1789564047204",
      signedAgreementSessionReference: session.reference,
      individual,
    });
  });

  it("returns the typed v1 customer including its verification link", async () => {
    const response = bvnkCustomer();
    const { requests } = queueFetch(respond(response));

    const result = await new BvnkRampClient().getCustomer(runtimeContext, {
      reference: response.reference,
    });

    assert.deepEqual(result, response);
    assert.equal(new URL(requests[0].url).pathname, `/platform/v1/customers/${response.reference}`);
  });

  it("parses the v1 customer's individual person block for the rule entity", async () => {
    const response = bvnkCustomer({
      status: "VERIFIED",
      individual: {
        person: {
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1984-06-30",
          address: {
            addressLine1: "1 Main Street",
            addressLine2: "Apt 4",
            city: "Austin",
            postalCode: "78701",
            stateCode: "TX",
            countryCode: "US",
          },
        },
      },
    });
    queueFetch(respond(response));

    const result = await new BvnkRampClient().getCustomer(runtimeContext, {
      reference: response.reference,
    });

    assert.deepEqual(result.individual?.person, {
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1984-06-30",
      address: {
        addressLine1: "1 Main Street",
        addressLine2: "Apt 4",
        city: "Austin",
        postalCode: "78701",
        stateCode: "TX",
        countryCode: "US",
      },
    });
  });

  it("resolves a PENDING v1 customer whose verification block has no Sumsub link", async () => {
    queueFetch(
      respond({
        reference: session.reference,
        status: "PENDING",
        verification: { status: "pending" },
      })
    );

    const result = await new BvnkRampClient().getCustomer(runtimeContext, {
      reference: session.reference,
    });

    const verification = result.verification;
    assert.equal(verification === undefined ? undefined : verification.url, undefined);
    assert.equal(verification === undefined ? undefined : verification.status, "pending");
  });
});

describe("BvnkRampClient v2 ledger surfaces", () => {
  const wallet = bvnkLedgerWallet();

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
    const response = bvnkWalletProfilesResponse();
    queueFetch(respond(response));

    const result = await new BvnkRampClient().listLedgerWalletProfilesV2(runtimeContext);

    assert.deepEqual(result, response);
  });
});

describe("BvnkRampClient payment rule surfaces", () => {
  it("lists the wallet's on-ramp rules with ACTIVE and INACTIVE entries", async () => {
    const walletId = "a:24122329329347:HsdJVhW:1";
    const { requests } = queueFetch(
      respond([
        {
          id: "rule_act_1",
          reference: "xfr_1",
          status: "ACTIVE",
          trigger: "payment:payin:fiat",
          walletId,
        },
        {
          id: "rule_inact_1",
          reference: "xfr_old",
          status: "INACTIVE",
          trigger: "payment:payin:fiat",
          walletId,
        },
      ])
    );

    const result = await new BvnkRampClient().listOnrampRules(runtimeContext, {
      walletId,
    });

    assert.deepEqual(result, [
      { id: "rule_act_1", reference: "xfr_1", status: "ACTIVE" },
      { id: "rule_inact_1", reference: "xfr_old", status: "INACTIVE" },
    ]);
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, "/payment/v1/rules");
    assert.equal(url.searchParams.get("walletId"), walletId);
    assert.equal(requests[0].init.method, "GET");
  });

  it("creates a payment rule carrying the mapped beneficiary entity", async () => {
    const customer = bvnkCustomer({
      status: "VERIFIED",
      individual: {
        person: {
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1984-06-30",
          address: {
            addressLine1: "1 Main Street",
            addressLine2: "Apt 4",
            city: "Austin",
            postalCode: "78701",
            stateCode: "TX",
            countryCode: "US",
          },
        },
      },
    });
    const rule = { id: "rule_create_1", reference: "xfr_1", status: "ACTIVE" };
    const { requests } = queueFetch(respond(rule, 201));

    const result = await new BvnkRampClient().createOnrampRule(runtimeContext, {
      reference: rule.reference,
      walletId: "a:24122329329347:HsdJVhW:1",
      currency: "USDC",
      network: "SOLANA",
      beneficiaryAddress: "dest",
      entity: bvnkRuleEntityFromCustomer(customer),
    });

    assert.deepEqual(result, rule);
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, "/payment/v1/rules");
    assert.equal(requests[0].init.method, "POST");
    const body = JSON.parse(String(requests[0].init.body)) as {
      beneficiary: { entity: Record<string, unknown> };
    };
    assert.deepEqual(body.beneficiary.entity, {
      type: "INDIVIDUAL",
      relationshipType: "SELF_OWNED",
      customerIdentifier: customer.reference,
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1984-06-30",
      address: {
        addressLine1: "1 Main Street",
        addressLine2: "Apt 4",
        city: "Austin",
        region: "TX",
        postCode: "78701",
        country: "US",
      },
    });
  });

  it("deactivates a rule through the plural actions endpoint and accepts the empty 204", async () => {
    const { requests } = queueFetch(new Response(null, { status: 204 }));

    const result = await new BvnkRampClient().deactivateOnrampRule(runtimeContext, {
      ruleId: "rule_deact_1",
    });

    assert.equal(result, undefined);
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, "/payment/v1/rules/rule_deact_1/actions");
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      type: "DEACTIVATE",
    });
  });
});

describe("BvnkRampClient response parsing", () => {
  it("treats a malformed v1 customer response as provider-unavailable", async () => {
    queueFetch(respond({ unexpected: "shape" }));

    await assert.rejects(
      () =>
        new BvnkRampClient().getCustomer(runtimeContext, {
          reference: session.reference,
        }),
      (error: unknown) => {
        assert.equal(error instanceof SdpPaymentsError, true);
        if (!(error instanceof SdpPaymentsError)) return false;
        assert.equal(error.code, "PROVIDER_UNAVAILABLE");
        assert.equal(error.message, "BVNK response is malformed.");
        return true;
      }
    );
  });
});

describe("BvnkRampClient estimate and simulation surfaces", () => {
  it("computes off-ramp net fiat and total fees with exact decimal math", async () => {
    queueFetch(
      respond({
        walletCurrency: "USD",
        walletRequiredAmount: 100.5,
        paidCurrency: "USDC",
        paidRequiredAmount: 1,
        feeCurrency: "USD",
        feePredictedAmount: 0.25,
        networkFeeCurrency: "USD",
        networkFeePredictedAmount: 0.05,
        totalWalletAmount: 100.8,
        exchangeRate: 100.8,
      })
    );

    const result = await new BvnkRampClient().estimateOfframp(runtimeContext, {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      cryptoAmount: "1",
    });

    assert.equal(result.fiatAmount, "100.2");
    assert.equal(result.fees.total, "0.3");
    assert.equal(result.fees.provider, "0.25");
    assert.equal(result.fees.network, "0.05");
    assert.equal(result.exchangeRate, "100.2");
  });

  it("forwards the SDP transfer id as the remittance reference and idempotency key", async () => {
    const { requests } = queueFetch(new Response(null, { status: 201 }));

    await new BvnkRampClient().simulatePayin(runtimeContext, {
      walletId: "wallet_id",
      amount: 100,
      currency: "USD",
      originatorName: "Jane Doe",
      remittanceInformation: "xfr_9f3b1c2d4e5f",
      idempotencyKey: "xfr_9f3b1c2d4e5f",
    });

    const body = JSON.parse(String(requests[0].init.body));
    assert.equal(body.remittanceInformation, "xfr_9f3b1c2d4e5f");
    assert.equal(body.method, "ACH");
    assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "xfr_9f3b1c2d4e5f");
  });
});
