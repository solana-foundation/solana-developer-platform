import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Counterparty } from "@sdp/types/counterparties";
import { SdpPaymentsError } from "#/errors";
import { RAMP_PROVIDER_CLIENTS } from "#/ramps/index";
import { rampTestRuntime, replayExchanges } from "#/ramps/test-kit";
import type {
  RampCustomerLink,
  RampCustomerLinkStore,
  RampProviderRequirements,
} from "#/ramps/types";
import { buildHercleSignature } from "./client";
import { HERCLE_FIELD_KEYS } from "./counterparty";
import { HERCLE_ORDER, HERCLE_TEST_KIT } from "./test-kit";

const hercle = RAMP_PROVIDER_CLIENTS.hercle;
const sandbox = rampTestRuntime("sandbox", HERCLE_TEST_KIT.credentials);
const BASE_URL = "https://publicapi.sandbox.hercle.financial";

function requirementsMember(): RampProviderRequirements {
  assert.ok(hercle.requirements, "Hercle settles its requirements itself");
  return hercle.requirements;
}

const BUSINESS: Counterparty = {
  id: "cpty_hercle_business",
  organizationId: "org_test",
  projectId: "proj_test",
  externalId: null,
  entityType: "business",
  displayName: "Contract Business AG",
  status: "active",
  createdBy: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};

const KYB = {
  [HERCLE_FIELD_KEYS.legalName]: "Contract Business Holding AG",
  [HERCLE_FIELD_KEYS.registrationNumber]: "CHE-123.456.789",
  [HERCLE_FIELD_KEYS.registrationCountry]: "CH",
  [HERCLE_FIELD_KEYS.addressLine1]: "Bahnhofstrasse 1",
  [HERCLE_FIELD_KEYS.addressCity]: "Zurich",
  [HERCLE_FIELD_KEYS.addressPostalCode]: "8001",
  [HERCLE_FIELD_KEYS.termsConsent]: "true",
  [HERCLE_FIELD_KEYS.privacyConsent]: "true",
};

/** The customer-link store the API backs with a row, in memory. */
function memoryLinkStore(initial: RampCustomerLink | null = null) {
  const state: { link: RampCustomerLink | null; recorded: string[] } = {
    link: initial,
    recorded: [],
  };
  const store: RampCustomerLinkStore = {
    read: async () => state.link,
    link: async (providerCustomerReference) => {
      state.link ??= { providerCustomerReference, providerStatus: null };
      return state.link;
    },
    recordStatus: async (providerStatus) => {
      assert.ok(state.link, "a status is recorded on a linked customer");
      state.link = { ...state.link, providerStatus };
      state.recorded.push(providerStatus);
    },
  };
  return { state, store };
}

interface CapturedCall {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

/** Answers each call with the next reply, recording what was sent. */
function scriptedFetch(replies: readonly { status: number; body: unknown }[]): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? "" : String(init.body),
    });
    const reply = replies[calls.length - 1];
    assert.ok(reply, `no scripted reply for call ${calls.length}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Hercle request signing", () => {
  it("matches the test vectors of Hercle's Partner API specification, section 2.1", async () => {
    const secret = "cvVdfH8pVpI3rWx1Gt4duZAxRq0Y2eaB7kNQ5mM1sT2";
    const timestamp = 1_756_200_000;
    const vectors = [
      ["GET", "/partner/v1/ping", "", "iMXClpe2o7fK3tmryuWZYDrMArC9EeWU8K+lqqc06uQ="],
      [
        "POST",
        "/partner/v1/accounts",
        '{"companyName":"Acme Ltd","accountType":"BUSINESS","jurisdiction":"EU","fundingMode":"Funded","accountLabel":"Acme Ltd","externalReference":"org-42"}',
        "VZxKIMTb+Amddm5GwqMHU3fNUrTvTBB4J0BMac/AvuU=",
      ],
      [
        "GET",
        "/partner/v1/accounts?externalReference=org-42",
        "",
        "IBDStsSzHkbVKPHrZWEKHtx8xFpQugzBtZ4HwqCMc8A=",
      ],
    ] as const;
    for (const [method, pathWithQuery, rawBody, expected] of vectors) {
      assert.equal(
        await buildHercleSignature(secret, timestamp, method, pathWithQuery, rawBody),
        expected,
        `${method} ${pathWithQuery}`
      );
    }
  });

  it("signs the timestamp, method, path and body with no separators", async () => {
    const signature = await buildHercleSignature(
      "secret",
      1_700_000_000,
      "post",
      "/partner/v1/orders/onramp",
      '{"a":1}'
    );
    const expected = await buildHercleSignature(
      "secret",
      1_700_000_000,
      "POST",
      "/partner/v1/orders/onramp",
      '{"a":1}'
    );
    assert.equal(signature, expected);
    assert.match(signature, /^[A-Za-z0-9+/]+=*$/);
  });

  it("sends exactly the bytes it signed", async () => {
    const calls = scriptedFetch([
      {
        status: 200,
        body: {
          fiatAmount: "100.00",
          cryptoAmount: "98.765432",
          exchangeRate: "1.002375",
          fees: { total: "1.00" },
        },
      },
    ]);
    await hercle.estimateOnramp?.(sandbox, {
      assetRail: "usdc.solana",
      fiatCurrency: "EUR",
      fiatAmount: "100",
    });
    const [call] = calls;
    assert.ok(call);
    const expected = await buildHercleSignature(
      HERCLE_TEST_KIT.credentials.secretKey,
      Number(call.headers.get("X-Hercle-Ts")),
      "POST",
      "/partner/v1/quotes/estimate",
      call.body
    );
    assert.equal(call.headers.get("X-Hercle-Signature"), expected);
  });
});

describe("Hercle estimate", () => {
  it("takes the fee out of the fiat paid in", async () => {
    replayExchanges(HERCLE_TEST_KIT.onramp?.estimate.exchanges ?? []);
    const estimate = await hercle.estimateOnramp?.(sandbox, {
      assetRail: "usdc.solana",
      fiatCurrency: "EUR",
      fiatAmount: "100",
    });
    assert.equal(estimate?.totalFiatAmount, "100.00");
    assert.equal(estimate?.fiatAmount, "99");
    assert.equal(estimate?.fees.total, "1.00");
  });

  it("drops the price feed's expiry, since the order is priced again", async () => {
    replayExchanges(HERCLE_TEST_KIT.onramp?.estimate.exchanges ?? []);
    const estimate = await hercle.estimateOnramp?.(sandbox, {
      assetRail: "usdc.solana",
      fiatCurrency: "EUR",
      fiatAmount: "100",
    });
    assert.ok(estimate);
    assert.equal(estimate.expiresAt, undefined);
  });
});

describe("Hercle order", () => {
  it("acts for the business and keys the order on SDP's transfer id", async () => {
    const input = HERCLE_TEST_KIT.onramp?.quote.input;
    assert.ok(input);
    const replay = replayExchanges(HERCLE_TEST_KIT.onramp?.quote.exchanges ?? []);
    const quote = await hercle.createOnrampQuote?.(sandbox, input);
    const [request] = replay.requests;
    assert.equal(request?.headers.get("on-behalf-of"), input.externalCustomerId);
    assert.equal(request?.headers.get("Idempotency-Key"), `sdp-onramp-${input.paymentTransferId}`);
    assert.equal(quote?.deliveryMode, "manual_instructions");
  });

  it("refuses to open an order with no reserved transfer id", async () => {
    const input = HERCLE_TEST_KIT.onramp?.quote.input;
    assert.ok(input);
    replayExchanges([]);
    await assert.rejects(
      hercle.createOnrampQuote?.(sandbox, { ...input, paymentTransferId: undefined }) ??
        Promise.resolve(),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "INTERNAL_ERROR"
    );
  });

  it("names Hercle's refusals of the business instead of blaming SDP's keys", async () => {
    const input = HERCLE_TEST_KIT.onramp?.quote.input;
    assert.ok(input);
    const cases = [
      { status: 403, code: "ACCOUNT_NOT_VERIFIED", expected: "CONFLICT" },
      { status: 403, code: "ACCOUNT_SUSPENDED", expected: "CONFLICT" },
      { status: 409, code: "BANK_ACCOUNT_NOT_PROVISIONED", expected: "CONFLICT" },
      { status: 400, code: "CORRIDOR_NOT_SUPPORTED", expected: "BAD_REQUEST" },
      { status: 403, code: "PERMISSION_DENIED", expected: "PROVIDER_NOT_CONFIGURED" },
    ] as const;
    for (const { status, code, expected } of cases) {
      scriptedFetch([{ status, body: { code, message: "refused" } }]);
      await assert.rejects(
        hercle.createOnrampQuote?.(sandbox, input) ?? Promise.resolve(),
        (cause: unknown) =>
          cause instanceof SdpPaymentsError &&
          cause.code === expected &&
          cause.details?.outcome === "rejected",
        code
      );
    }
  });

  it("refuses an order without the payer the bank enforces", async () => {
    const input = HERCLE_TEST_KIT.onramp?.quote.input;
    const [exchange] = HERCLE_TEST_KIT.onramp?.quote.exchanges ?? [];
    assert.ok(input && exchange);
    replayExchanges([
      {
        ...exchange,
        body: {
          ...HERCLE_ORDER,
          bankAccount: { ...HERCLE_ORDER.bankAccount, payerAccountHolder: "" },
        },
      },
    ]);
    await assert.rejects(
      hercle.createOnrampQuote?.(sandbox, input) ?? Promise.resolve(),
      (cause: unknown) =>
        cause instanceof SdpPaymentsError && cause.code === "PROVIDER_RESPONSE_INVALID"
    );
  });
});

describe("Hercle sandbox settlement", () => {
  it("asks Hercle to settle the order as its rail would", async () => {
    const calls = scriptedFetch([
      { status: 200, body: { orderId: "ord_1", status: "settled", webhookDelivered: true } },
    ]);
    await hercle.simulateSandboxSettlement?.(sandbox, "ord_1");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url, `${BASE_URL}/partner/v1/orders/ord_1/simulate-settlement`);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), { status: "settled" });
  });

  it("refuses to simulate in production, before any request", async () => {
    const calls = scriptedFetch([]);
    await assert.rejects(
      hercle.simulateSandboxSettlement?.(
        rampTestRuntime("production", HERCLE_TEST_KIT.liveCredentials),
        "ord_1"
      ) ?? Promise.resolve(),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "BAD_REQUEST"
    );
    assert.equal(calls.length, 0);
  });
});

describe("Hercle status lookup", () => {
  it("treats a bare 404 as a failure to ask, not as an order it does not hold", async () => {
    scriptedFetch([{ status: 404, body: {} }]);
    await assert.rejects(
      hercle.fetchTransferStatus(sandbox, {
        transferId: "xfr_7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
        rampType: "onramp",
        providerReference: "ord_contract_onramp",
      }),
      SdpPaymentsError
    );
  });

  it("maps an unknown order status to a held ignore", async () => {
    scriptedFetch([{ status: 200, body: { orderId: "ord_1", status: "refunding", error: null } }]);
    const events = await hercle.fetchTransferStatus(sandbox, {
      transferId: "xfr_7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      rampType: "onramp",
      providerReference: "ord_1",
    });
    assert.deepEqual(events, [
      {
        provider: "hercle",
        kind: "ignore",
        reason: "unsupported_status:refunding",
        unmappedStatus: "refunding",
      },
    ]);
  });
});

describe("Hercle requirements", () => {
  it("collects the KYB fields from a business with no Hercle account, asking Hercle nothing", async () => {
    const calls = scriptedFetch([]);
    const { store } = memoryLinkStore();
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.equal(answer.status, "collect");
    assert.equal(calls.length, 0);
  });

  it("refuses individuals and the off-ramp", async () => {
    const { store } = memoryLinkStore();
    const individual = await requirementsMember().describe(sandbox, {
      counterparty: { ...BUSINESS, entityType: "individual" },
      direction: "onramp",
      customerLink: store,
    });
    assert.equal(individual.status, "unsupported");
    const offramp = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "offramp",
      customerLink: store,
    });
    assert.equal(offramp.status, "unsupported");
  });

  it("opens the account, links it and starts the verification on submit", async () => {
    const calls = scriptedFetch([
      { status: 201, body: { accountId: "acct_1", externalReference: BUSINESS.id } },
      {
        status: 200,
        body: { status: "action_required", verificationUrl: "https://verify.hercle.test/acct_1" },
      },
    ]);
    const { state, store } = memoryLinkStore();
    const answer = await requirementsMember().submit(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
      collectedData: KYB,
    });
    assert.deepEqual(answer, {
      provider: "hercle",
      direction: "onramp",
      status: "customer_verification_required",
      verificationUrl: "https://verify.hercle.test/acct_1",
    });
    assert.deepEqual(state.link, {
      providerCustomerReference: "acct_1",
      providerStatus: "action_required",
    });
    const [account, verification] = calls;
    assert.equal(account?.url, `${BASE_URL}/partner/v1/accounts`);
    assert.equal(account?.headers.get("Idempotency-Key"), `sdp-account-${BUSINESS.id}`);
    const sent = JSON.parse(account?.body ?? "{}");
    assert.equal(sent.jurisdiction, "SWISS");
    assert.equal(sent.externalReference, BUSINESS.id);
    // The registered name the business typed, never the counterparty's display name.
    assert.equal(sent.companyName, "Contract Business Holding AG");
    assert.equal(sent.accountType, "BUSINESS");
    assert.equal("accountLabel" in sent, false);
    assert.deepEqual(
      { terms: sent.consents.termsAndConditions, privacy: sent.consents.privacyPolicy },
      { terms: true, privacy: true }
    );
    assert.equal(verification?.url, `${BASE_URL}/partner/v1/accounts/acct_1/verifications`);
    assert.equal(verification?.headers.get("Idempotency-Key"), `sdp-kyb-${BUSINESS.id}`);
  });

  it("links the account Hercle already holds when a re-sent submission conflicts", async () => {
    const calls = scriptedFetch([
      { status: 409, body: { code: "IDEMPOTENCY_KEY_REUSED", message: "different body" } },
      { status: 200, body: { accountId: "acct_1", externalReference: BUSINESS.id } },
      { status: 200, body: { status: "pending" } },
    ]);
    const { state, store } = memoryLinkStore();
    const answer = await requirementsMember().submit(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
      collectedData: KYB,
    });
    assert.equal(answer.status, "customer_verifying");
    assert.deepEqual(state.link, {
      providerCustomerReference: "acct_1",
      providerStatus: "pending",
    });
    const lookup = calls[1];
    assert.equal(lookup?.method, "GET");
    assert.equal(lookup?.url, `${BASE_URL}/partner/v1/accounts?externalReference=${BUSINESS.id}`);
    assert.equal(calls[2]?.url, `${BASE_URL}/partner/v1/accounts/acct_1/verifications`);
  });

  it("refuses to link an account Hercle holds under another reference", async () => {
    scriptedFetch([
      { status: 409, body: { code: "REF_CONFLICT", message: "reference in use" } },
      { status: 200, body: { accountId: "acct_9", externalReference: "cpty_other" } },
    ]);
    const { state, store } = memoryLinkStore();
    await assert.rejects(
      requirementsMember().submit(sandbox, {
        counterparty: BUSINESS,
        direction: "onramp",
        customerLink: store,
        collectedData: KYB,
      }),
      (cause: unknown) =>
        cause instanceof SdpPaymentsError && cause.code === "PROVIDER_RESPONSE_INVALID"
    );
    assert.equal(state.link, null);
  });

  it("keeps any other conflict on the account a failure, without looking it up", async () => {
    const calls = scriptedFetch([{ status: 409, body: { code: "FUNDING_MODE_NOT_ALLOWED" } }]);
    const { state, store } = memoryLinkStore();
    await assert.rejects(
      requirementsMember().submit(sandbox, {
        counterparty: BUSINESS,
        direction: "onramp",
        customerLink: store,
        collectedData: KYB,
      }),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "CONFLICT"
    );
    assert.equal(calls.length, 1);
    assert.equal(state.link, null);
  });

  it("refuses a submission that does not accept Hercle's terms, before any request", async () => {
    const calls = scriptedFetch([]);
    const { store } = memoryLinkStore();
    await assert.rejects(
      requirementsMember().submit(sandbox, {
        counterparty: BUSINESS,
        direction: "onramp",
        customerLink: store,
        collectedData: { ...KYB, [HERCLE_FIELD_KEYS.termsConsent]: "false" },
      }),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "BAD_REQUEST"
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a country outside Hercle's perimeter, before any request", async () => {
    const calls = scriptedFetch([]);
    const { store } = memoryLinkStore();
    await assert.rejects(
      requirementsMember().submit(sandbox, {
        counterparty: BUSINESS,
        direction: "onramp",
        customerLink: store,
        collectedData: { ...KYB, [HERCLE_FIELD_KEYS.registrationCountry]: "US" },
      }),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "BAD_REQUEST"
    );
    assert.equal(calls.length, 0);
  });

  it("reads the verdict on a linked business and records a change", async () => {
    const calls = scriptedFetch([{ status: 200, body: { status: "pending" } }]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "action_required",
    });
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.equal(answer.status, "customer_verifying");
    assert.deepEqual(state.recorded, ["pending"]);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.url, `${BASE_URL}/partner/v1/accounts/acct_1/verification`);
  });

  it("only reads a linked business with no recorded verdict, never starting its verification", async () => {
    const calls = scriptedFetch([
      {
        status: 200,
        body: { status: "action_required", verificationUrl: "https://verify.hercle.test/acct_1" },
      },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: null,
    });
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.equal(answer.status, "customer_verification_required");
    assert.deepEqual(state.recorded, ["action_required"]);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["GET"]
    );
  });

  it("asks for the fields again when the account's verification never started", async () => {
    const calls = scriptedFetch([
      { status: 404, body: { code: "VERIFICATION_NOT_STARTED", message: "not started" } },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: null,
    });
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.equal(answer.status, "collect");
    assert.deepEqual(state.recorded, []);
    assert.equal(calls.length, 1);
  });

  it("starts the verification on a resubmission when Hercle holds none for the account", async () => {
    const calls = scriptedFetch([
      { status: 404, body: { code: "VERIFICATION_NOT_STARTED", message: "not started" } },
      {
        status: 200,
        body: { status: "action_required", verificationUrl: "https://verify.hercle.test/acct_1" },
      },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "pending",
    });
    const answer = await requirementsMember().submit(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
      collectedData: KYB,
    });
    assert.equal(answer.status, "customer_verification_required");
    assert.deepEqual(state.recorded, ["action_required"]);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        `GET ${BASE_URL}/partner/v1/accounts/acct_1/verification`,
        `POST ${BASE_URL}/partner/v1/accounts/acct_1/verifications`,
      ]
    );
  });

  it("answers an approved business without asking Hercle again", async () => {
    const calls = scriptedFetch([]);
    const { store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "approved",
    });
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.equal(answer.status, "ready");
    assert.equal(calls.length, 0);
  });

  it("fails closed when Hercle asks for verification without a link", async () => {
    scriptedFetch([{ status: 200, body: { status: "action_required" } }]);
    const { store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "pending",
    });
    await assert.rejects(
      requirementsMember().describe(sandbox, {
        counterparty: BUSINESS,
        direction: "onramp",
        customerLink: store,
      }),
      (cause: unknown) =>
        cause instanceof SdpPaymentsError && cause.code === "PROVIDER_RESPONSE_INVALID"
    );
  });

  it("refuses a verification link that is not plain HTTPS", async () => {
    scriptedFetch([
      { status: 200, body: { status: "action_required", verificationUrl: "javascript:alert(1)" } },
    ]);
    const { store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "pending",
    });
    await assert.rejects(
      requirementsMember().describe(sandbox, {
        counterparty: BUSINESS,
        direction: "onramp",
        customerLink: store,
      }),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "PROVIDER_UNAVAILABLE"
    );
  });

  it("lets a quote run only for an approved business", () => {
    const member = requirementsMember();
    assert.equal(
      member.isCustomerReady({ providerCustomerReference: "acct_1", providerStatus: "approved" }),
      true
    );
    for (const providerStatus of [null, "pending", "action_required", "rejected"]) {
      assert.equal(
        member.isCustomerReady({ providerCustomerReference: "acct_1", providerStatus }),
        false,
        String(providerStatus)
      );
    }
  });
});
