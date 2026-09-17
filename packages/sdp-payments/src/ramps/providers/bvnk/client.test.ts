import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "../../../errors";
import type { RampRuntimeContext } from "../../types";
import { BvnkRampClient } from "./client";
import { bvnkContactV3, bvnkLedgerWallet, bvnkWalletProfilesResponse } from "./test-fixtures";

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

describe("BvnkRampClient v3 contact surfaces", () => {
  const contact = bvnkContactV3();

  it("creates a contact from the counterparty id and entity, without an idempotency header", async () => {
    const { requests } = queueFetch(respond(contact, 201));

    const result = await new BvnkRampClient().createContactV3(runtimeContext, {
      description: "cpty_123e4567-e89b-12d3-a456-426614174000",
      entity: {
        type: "INDIVIDUAL",
        relationshipType: "THIRD_PARTY",
        firstName: "Jane",
        lastName: "Doe",
      },
    });

    assert.deepEqual(result, contact);
    assert.equal(new URL(requests[0].url).pathname, "/platform/v3/contacts");
    assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), null);
    assert.equal(new Headers(requests[0].init.headers).get("X-Idempotency-Key"), null);
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      description: "cpty_123e4567-e89b-12d3-a456-426614174000",
      entity: {
        type: "INDIVIDUAL",
        relationshipType: "THIRD_PARTY",
        firstName: "Jane",
        lastName: "Doe",
      },
    });
  });

  it("creates a company contact", async () => {
    const company = bvnkContactV3({
      entity: {
        type: "COMPANY",
        relationshipType: "THIRD_PARTY",
        legalName: "Acme Corporation",
        registrationNumber: "12345678",
      },
    });
    const { requests } = queueFetch(respond(company, 201));

    const result = await new BvnkRampClient().createContactV3(runtimeContext, {
      description: "cpty_123e4567-e89b-12d3-a456-426614174000",
      entity: {
        type: "COMPANY",
        relationshipType: "THIRD_PARTY",
        legalName: "Acme Corporation",
        registrationNumber: "12345678",
      },
    });

    assert.deepEqual(result, company);
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      description: "cpty_123e4567-e89b-12d3-a456-426614174000",
      entity: {
        type: "COMPANY",
        relationshipType: "THIRD_PARTY",
        legalName: "Acme Corporation",
        registrationNumber: "12345678",
      },
    });
  });

  it("gets a contact by id", async () => {
    const { requests } = queueFetch(respond(contact));

    const result = await new BvnkRampClient().getContactV3(runtimeContext, {
      contactId: contact.id,
    });

    assert.deepEqual(result, contact);
    assert.equal(new URL(requests[0].url).pathname, `/platform/v3/contacts/${contact.id}`);
  });

  it("normalizes address lanes BVNK reports as null, keeping zip lanes it does not model", async () => {
    // Run-2 live shape: BVNK answers absent address lanes with explicit nulls,
    // and a `postCode` lane the schema does not model at all.
    queueFetch(
      respond({
        id: "a3700c37-3f46-4766-b0db-3250b073fd9c",
        description: "cpty_123e4567-e89b-12d3-a456-426614174000",
        entity: {
          type: "INDIVIDUAL",
          relationshipType: "THIRD_PARTY",
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          address: {
            addressLine1: "10 Downing Street",
            city: "London",
            region: null,
            stateCode: null,
            postalCode: null,
            postCode: null,
            country: "GB",
          },
        },
        createdAt: "2026-06-10T10:30:00Z",
        updatedAt: "2026-06-10T10:30:00Z",
      })
    );

    const result = await new BvnkRampClient().getContactV3(runtimeContext, {
      contactId: "a3700c37-3f46-4766-b0db-3250b073fd9c",
    });

    assert.equal(result.entity.type, "INDIVIDUAL");
    assert.equal(result.entity.dateOfBirth, "1990-01-01");
    assert.deepEqual(result.entity.address, {
      addressLine1: "10 Downing Street",
      city: "London",
      region: undefined,
      stateCode: undefined,
      postalCode: undefined,
      country: "GB",
    });
  });

  it("lists contacts by the description query and returns the page with its pagination metadata", async () => {
    const { requests } = queueFetch(
      respond({ content: [contact], pageable: { pageNumber: 0, pageSize: 5 }, hasNext: false })
    );

    const result = await new BvnkRampClient().listContactsV3(runtimeContext, {
      q: "cpty_123e4567-e89b-12d3-a456-426614174000",
      pageSize: 5,
      pageNumber: 0,
    });

    assert.deepEqual(result, {
      content: [contact],
      pageable: { pageNumber: 0, pageSize: 5 },
      hasNext: false,
    });
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, "/platform/v3/contacts");
    assert.equal(url.searchParams.get("q"), "cpty_123e4567-e89b-12d3-a456-426614174000");
    assert.equal(url.searchParams.get("pageSize"), "5");
    assert.equal(url.searchParams.get("pageNumber"), "0");
  });
});

describe("BvnkRampClient v2 ledger surfaces", () => {
  const wallet = bvnkLedgerWallet();

  it("creates a merchant-owned ledger wallet without a customerId", async () => {
    const { requests } = queueFetch(respond(wallet, 201));

    const result = await new BvnkRampClient().createLedgerWalletV2(runtimeContext, {
      idempotencyKey: "wallet-key",
      currency: "USD",
      name: "USD Wallet",
      profileId: "fiat:usd:profile",
    });

    assert.deepEqual(result, wallet);
    assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "wallet-key");
    const body = JSON.parse(String(requests[0].init.body)) as Record<string, unknown>;
    assert.equal(body.customerId, undefined);
    assert.deepEqual(body, {
      currency: "USD",
      name: "USD Wallet",
      profileId: "fiat:usd:profile",
    });
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

  it("lists ledger wallet profiles without a customerId filter", async () => {
    const response = bvnkWalletProfilesResponse();
    const { requests } = queueFetch(respond(response));

    const result = await new BvnkRampClient().listLedgerWalletProfilesV2(runtimeContext, {
      currency: "USD",
    });

    assert.deepEqual(result, response);
    assert.equal(new URL(requests[0].url).searchParams.get("q"), "currency:USD");
    assert.equal(new URL(requests[0].url).searchParams.get("q")?.includes("customerId"), false);
  });
});

describe("BvnkRampClient response parsing", () => {
  it("treats a malformed contact list response as provider-unavailable", async () => {
    queueFetch(respond({ unexpected: "shape" }));

    await assert.rejects(
      () =>
        new BvnkRampClient().listContactsV3(runtimeContext, {
          q: "cpty_123e4567-e89b-12d3-a456-426614174000",
          pageSize: 5,
          pageNumber: 0,
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
