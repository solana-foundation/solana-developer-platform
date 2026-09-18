import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "../../../errors";
import type { RampRuntimeContext } from "../../types";
import { BvnkPayRequestError, BvnkRampClient } from "./client";
import type { BvnkOnrampPayoutInput } from "./schemas";
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

describe("BvnkRampClient pay family", () => {
  const payoutUuid = "01a0b3f2-ad2d-7a55-95dc-98d85d4def2f";

  const payoutInput: BvnkOnrampPayoutInput = {
    walletId: "a:26091832492051:YVPgmfq:1",
    amount: 1.2,
    currency: "USD",
    reference: "xfr_7acd66cc-7364-4423-86e4-cfd3552fe8f3",
    customerId: "2acdd3e5-7166-4b04-8115-6ad3ccd66477",
    payOutDetails: {
      code: "crypto",
      currency: "USDC",
      network: "SOLANA",
      address: "93Xd7X9vDv3dJzP5nJ7qQ6hQ8tQ9Q2Q3Q4Q5Q6Q7Q8Q9",
    },
    complianceDetails: {
      requesterIpAddress: "0.0.0.0",
      partyDetails: [
        {
          type: "BENEFICIARY",
          entityType: "INDIVIDUAL",
          firstName: "Zach",
          lastName: "Khong",
          dateOfBirth: "2001-04-01",
          relationshipType: "THIRD_PARTY",
          countryCode: "US",
        },
      ],
    },
  };

  const payoutSummary = {
    uuid: payoutUuid,
    type: "OUT",
    walletId: payoutInput.walletId,
    status: "PROCESSING",
    quoteStatus: "ACCEPTED",
    reference: payoutInput.reference,
    walletCurrency: { currency: "USD", amount: 1.2, actual: 1.2 },
    paidCurrency: { currency: "USDC", amount: 1.1976, actual: 0 },
    feeCurrency: { currency: "USD", amount: 0.01, actual: 0 },
    networkFeeCurrency: { currency: "USD", amount: 0, actual: 0 },
    exchangeRate: { base: "USD", counter: "USDC", rate: 0.998 },
    transactions: [],
    address: { address: payoutInput.payOutDetails.address, network: "SOLANA" },
  };

  it("dry_run_schema_accepts_probe_nulls and posts the dry-run path with the SOL network", async () => {
    const { requests } = queueFetch(
      respond({
        walletCurrency: { currency: "USD", amount: 1.2, actual: null },
        paidCurrency: { currency: "USDC", amount: 1.1976, actual: null },
        feeCurrency: { currency: "USD", amount: 0.01, actual: null },
        networkFeeCurrency: { currency: "USD", amount: 0, actual: null },
        exchangeRate: { base: "USD", counter: "USDC", rate: 0.998 },
      })
    );

    const result = await new BvnkRampClient().dryRunOnrampPayout(runtimeContext, payoutInput);

    const url = new URL(requests[0].url);
    assert.equal(url.pathname, "/api/v1/pay/summary/dry-run");
    assert.equal(requests[0].init.method, "POST");
    const body = JSON.parse(String(requests[0].init.body)) as {
      payOutDetails: { network: string };
    };
    assert.equal(body.payOutDetails.network, "SOL");
    assert.equal(result.walletCurrency.amount, 1.2);
    assert.equal(result.feeCurrency.amount, 0.01);
    assert.equal(result.feeCurrency.actual, null);
    assert.equal(result.networkFeeCurrency.actual, null);
    assert.equal(result.exchangeRate.rate, 0.998);
  });

  it("createOnrampPayout posts the full body with the SOLANA network and the transfer-id reference", async () => {
    const { requests } = queueFetch(respond(payoutSummary));

    const result = await new BvnkRampClient().createOnrampPayout(runtimeContext, payoutInput);

    assert.deepEqual(result, payoutSummary);
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, "/api/v1/pay/summary");
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      walletId: payoutInput.walletId,
      type: "OUT",
      amount: 1.2,
      currency: "USD",
      reference: payoutInput.reference,
      customerId: payoutInput.customerId,
      payOutDetails: { ...payoutInput.payOutDetails, network: "SOLANA" },
      complianceDetails: payoutInput.complianceDetails,
    });
  });

  it("bvnk_errors_accept_both_probe_envelopes", async () => {
    queueFetch(
      respond(
        {
          errorList: [
            {
              requestId: null,
              code: "MER-PAY-2010",
              parameter: "reference",
              message:
                "A payment with reference xfr_7acd66cc-7364-4423-86e4-cfd3552fe8f3 already exists. Please enter a unique reference.",
            },
          ],
        },
        400
      )
    );

    await assert.rejects(
      () => new BvnkRampClient().createOnrampPayout(runtimeContext, payoutInput),
      (error: unknown) => {
        assert.equal(error instanceof BvnkPayRequestError, true);
        if (!(error instanceof BvnkPayRequestError)) return false;
        assert.equal(error.bvnkCode, "MER-PAY-2010");
        assert.equal(error instanceof SdpPaymentsError, true);
        return true;
      }
    );

    queueFetch(
      respond(
        {
          code: "MER-PAY-2009",
          status: "Bad Request",
          message: "Party details can not be empty",
        },
        400
      )
    );

    await assert.rejects(
      () => new BvnkRampClient().createOnrampPayout(runtimeContext, payoutInput),
      (error: unknown) => {
        assert.equal(error instanceof BvnkPayRequestError, true);
        if (!(error instanceof BvnkPayRequestError)) return false;
        assert.equal(error.bvnkCode, "MER-PAY-2009");
        return true;
      }
    );
  });

  it("MER-PAY-2012 maps to the insufficient funds error", async () => {
    queueFetch(
      respond(
        {
          errorList: [
            {
              requestId: null,
              code: "MER-PAY-2012",
              parameter: "amount",
              message: "insufficient funds",
            },
          ],
        },
        400
      )
    );

    await assert.rejects(
      () => new BvnkRampClient().createOnrampPayout(runtimeContext, payoutInput),
      (error: unknown) => {
        assert.equal(error instanceof BvnkPayRequestError, true);
        if (!(error instanceof BvnkPayRequestError)) return false;
        assert.equal(error.bvnkCode, "MER-PAY-2012");
        return true;
      }
    );
  });

  it("a 404 with a MER-PAY body is a business error, not a path error", async () => {
    queueFetch(
      respond(
        {
          code: "MER-PAY-2001",
          status: "Not Found",
          message: "less than minimum limit of 1.15 USD",
        },
        404
      )
    );

    await assert.rejects(
      () => new BvnkRampClient().createOnrampPayout(runtimeContext, payoutInput),
      (error: unknown) => {
        assert.equal(error instanceof BvnkPayRequestError, true);
        if (!(error instanceof BvnkPayRequestError)) return false;
        assert.equal(error.bvnkCode, "MER-PAY-2001");
        return true;
      }
    );
  });

  it("unknown pay error codes stay generic and never map to a typed class", async () => {
    queueFetch(
      respond(
        {
          errorList: [
            { requestId: null, code: "MER-PAY-9999", parameter: "amount", message: "mystery code" },
          ],
        },
        400
      )
    );

    await assert.rejects(
      () => new BvnkRampClient().createOnrampPayout(runtimeContext, payoutInput),
      (error: unknown) => {
        assert.equal(error instanceof SdpPaymentsError, true);
        if (!(error instanceof SdpPaymentsError)) return false;
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error instanceof BvnkPayRequestError, false);
        return true;
      }
    );
  });

  it("listPayoutsByReference builds the encoded wallet and reference list URL", async () => {
    const { requests } = queueFetch(respond([payoutSummary]));

    const result = await new BvnkRampClient().listPayoutsByReference(runtimeContext, {
      walletId: payoutInput.walletId,
      reference: payoutInput.reference,
    });

    assert.deepEqual(result, [payoutSummary]);
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, "/api/v1/pay/summary");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(url.searchParams.get("walletId"), payoutInput.walletId);
    assert.equal(url.searchParams.get("reference"), payoutInput.reference);
    assert.equal(url.searchParams.get("max"), "200");
  });

  it("getPayoutSummary reads /api/v1/pay/<uuid>/summary and tolerates pre-completion absence of transactions and address", async () => {
    const { requests } = queueFetch(
      respond({
        uuid: payoutUuid,
        type: "OUT",
        walletId: payoutInput.walletId,
        status: "PROCESSING",
        quoteStatus: "ACCEPTED",
        reference: payoutInput.reference,
        walletCurrency: { currency: "USD", amount: 1.2, actual: 1.2 },
        paidCurrency: { currency: "USDC", amount: 1.1976, actual: 0 },
        feeCurrency: { currency: "USD", amount: 0.01, actual: 0 },
        networkFeeCurrency: { currency: "USD", amount: 0, actual: 0 },
        exchangeRate: { base: "USD", counter: "USDC", rate: 0.998 },
      })
    );

    const result = await new BvnkRampClient().getPayoutSummary(runtimeContext, {
      payoutId: payoutUuid,
    });

    assert.equal(new URL(requests[0].url).pathname, `/api/v1/pay/${payoutUuid}/summary`);
    assert.equal(result.status, "PROCESSING");
    assert.equal(result.transactions, undefined);
    assert.equal(result.address, undefined);
  });

  it("passes an AbortSignal.timeout fence on every BVNK request", async () => {
    const { requests } = queueFetch(respond(payoutSummary), respond(payoutSummary));

    await new BvnkRampClient().createOnrampPayout(runtimeContext, payoutInput);
    await new BvnkRampClient().getPayoutSummary(runtimeContext, { payoutId: payoutUuid });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].init.signal instanceof AbortSignal, true);
    assert.equal(requests[1].init.signal instanceof AbortSignal, true);
  });
});

describe("BvnkRampClient ledger wallet list", () => {
  it("listLedgerWalletsV2 paginates to exhaustion and returns every matching row", async () => {
    const { requests } = queueFetch(
      respond({
        content: [
          {
            id: "a:26091832510099:3uD7Mrf:1",
            name: "sdp:onramp:row-a",
            customer: { id: "c1", name: "Zach Khong" },
            status: "ACTIVE",
            balance: { amount: 0, currency: "USD" },
          },
          {
            id: "a:26091832510281:ZDy86a7:1",
            name: "sdp:onramp:row-b",
            customer: { id: "c1" },
            status: "INACTIVE",
          },
        ],
        pageable: { pageNumber: 0, pageSize: 100 },
        hasNext: true,
      }),
      respond({
        content: [
          {
            id: "a:26091832619757:YNYItty:1",
            name: "sdp:onramp:row-c",
            customer: { id: "c1" },
            status: "ACTIVE",
          },
        ],
        pageable: { pageNumber: 1, pageSize: 100 },
        hasNext: false,
      })
    );

    const result = await new BvnkRampClient().listLedgerWalletsV2(runtimeContext, {
      customerId: "c1",
      currency: "USD",
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(
      result.content.map((row) => row.id),
      ["a:26091832510099:3uD7Mrf:1", "a:26091832510281:ZDy86a7:1", "a:26091832619757:YNYItty:1"]
    );
    assert.equal(result.hasNext, false);
    const firstUrl = new URL(requests[0].url);
    assert.equal(firstUrl.pathname, "/ledger/v2/wallets");
    assert.equal(firstUrl.searchParams.get("q"), "customerId:c1 AND currency:USD");
    assert.equal(firstUrl.searchParams.get("pageSize"), "100");
    assert.equal(firstUrl.searchParams.get("pageNumber"), "0");
    assert.equal(new URL(requests[1].url).searchParams.get("pageNumber"), "1");
  });

  it("never sends a colon-bearing wallet name into the list query", async () => {
    const { requests } = queueFetch(
      respond({
        content: [
          {
            id: "a:26091832510099:3uD7Mrf:1",
            name: "sdp:onramp:cpa_x",
            customer: { id: "c1", name: "Zach Khong" },
            status: "ACTIVE",
            balance: { amount: 0, currency: "USD" },
          },
        ],
        pageable: { pageNumber: 0, pageSize: 100 },
        hasNext: false,
      })
    );

    const result = await new BvnkRampClient().listLedgerWalletsV2(runtimeContext, {
      customerId: "c1",
      currency: "USD",
    });

    assert.equal(requests.length, 1);
    assert.equal(result.content[0]?.name, "sdp:onramp:cpa_x");
    const url = new URL(requests[0].url);
    const q = url.searchParams.get("q") ?? "";
    assert.equal(q, "customerId:c1 AND currency:USD");
    assert.equal(q.includes("sdp:onramp:cpa_x"), false);
    assert.equal(q.includes("name:"), false);
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
