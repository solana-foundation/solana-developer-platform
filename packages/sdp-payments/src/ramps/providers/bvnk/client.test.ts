import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "../../../errors";
import type { RampRuntimeContext } from "../../types";
import { BvnkRampClient } from "./client";
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
  it("creates an agreement session for the residence country", async () => {
    const { requests } = queueFetch(respond(session, 201));

    const result = await new BvnkRampClient().createAgreementSession(runtimeContext, {
      countryCode: "US",
    });

    assert.deepEqual(result, session);
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
    const { requests } = queueFetch(respond({ ok: true }));

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
    assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "xfr_9f3b1c2d4e5f");
  });
});
