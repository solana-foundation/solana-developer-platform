import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Counterparty } from "@sdp/types/counterparties";
import { SdpPaymentsError } from "#/errors";
import { rampClientFor } from "#/ramps/index";
import { rampTestRuntime, replayExchanges } from "#/ramps/test-kit";
import type {
  RampCustomerLink,
  RampCustomerLinkStore,
  RampCustomerStatusObservation,
  RampProviderRequirements,
  RampRuntimeContext,
} from "#/ramps/types";
import { buildHercleSignature } from "./client";
import { HERCLE_FIELD_KEYS } from "./counterparty";
import { HERCLE_ORDER, HERCLE_ORDER_LOOKUP_REFUSALS, HERCLE_TEST_KIT } from "./test-kit";

const hercle = rampClientFor("hercle", "onramp");
const sandbox = rampTestRuntime("sandbox", HERCLE_TEST_KIT.credentials);
const BASE_URL = "https://publicapi.sandbox.hercle.financial";

function requirementsMember(): RampProviderRequirements {
  assert.ok(hercle.requirements, "Hercle settles its requirements itself");
  return hercle.requirements;
}

function simulateSettlement(ctx: RampRuntimeContext, providerReference: string): Promise<void> {
  assert.ok(hercle.simulateSandboxSettlement, "Hercle settles a sandbox order on request");
  return hercle.simulateSandboxSettlement(ctx, providerReference);
}

function kitOnramp() {
  assert.ok(HERCLE_TEST_KIT.onramp, "the Hercle kit records an onramp");
  return HERCLE_TEST_KIT.onramp;
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

/**
 * The customer-link store the API backs with a row, in memory.
 * It takes every observation; the API's repository tests pin which ones the row keeps.
 * With `newer`, it holds a newer report with that status instead, as the row does when a report loses to one.
 */
function memoryLinkStore(
  initial: RampCustomerLink | null = null,
  newer?: { providerStatus: string | null }
) {
  const state: {
    link: RampCustomerLink | null;
    recorded: (string | null)[];
    observations: RampCustomerStatusObservation[];
  } = { link: initial, recorded: [], observations: [] };
  const store: RampCustomerLinkStore = {
    read: async () => state.link,
    link: async (providerCustomerReference) => {
      state.link ??= { providerCustomerReference, providerStatus: null };
      return state.link;
    },
    recordStatus: async (observation) => {
      assert.ok(state.link, "a status is recorded on a linked customer");
      state.observations.push(observation);
      if (newer !== undefined) {
        state.link = { ...state.link, providerStatus: newer.providerStatus };
        return newer.providerStatus;
      }
      state.link = { ...state.link, providerStatus: observation.providerStatus };
      state.recorded.push(observation.providerStatus);
      return observation.providerStatus;
    },
  };
  return { state, store };
}

/** The instants around `run`, the window an observation SDP stamps while it runs must fall in. */
async function stampedWindow<T>(
  run: () => Promise<T>
): Promise<{ result: T; from: Date; to: Date }> {
  const from = new Date();
  const result = await run();
  return { result, from, to: new Date() };
}

function assertObservedWithin(observedAt: string, window: { from: Date; to: Date }) {
  const instant = new Date(observedAt);
  assert.ok(instant >= window.from && instant <= window.to, observedAt);
}

interface CapturedCall {
  method: string;
  url: string;
  headers: Headers;
  body: string;
  sentAt: Date;
}

/**
 * Answers each call with the next reply, recording what was sent and when.
 * A reply with `delayMs` arrives that much later, so a time SDP takes after it differs from the call's.
 */
function scriptedFetch(
  replies: readonly { status: number; body: unknown; delayMs?: number }[]
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? "" : String(init.body),
      sentAt: new Date(),
    });
    const reply = replies[calls.length - 1];
    assert.ok(reply, `no scripted reply for call ${calls.length}`);
    if (reply.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    }
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
    await hercle.estimateOnramp(sandbox, {
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
    replayExchanges(kitOnramp().estimate.exchanges);
    const estimate = await hercle.estimateOnramp(sandbox, {
      assetRail: "usdc.solana",
      fiatCurrency: "EUR",
      fiatAmount: "100",
    });
    assert.equal(estimate.totalFiatAmount, "100.00");
    assert.equal(estimate.fiatAmount, "99");
    assert.equal(estimate.fees.total, "1.00");
  });

  it("drops the price feed's expiry, since the order is priced again", async () => {
    replayExchanges(kitOnramp().estimate.exchanges);
    const estimate = await hercle.estimateOnramp(sandbox, {
      assetRail: "usdc.solana",
      fiatCurrency: "EUR",
      fiatAmount: "100",
    });
    assert.equal(estimate.expiresAt, undefined);
  });
});

describe("Hercle order", () => {
  it("acts for the business and keys the order on SDP's transfer id", async () => {
    const input = kitOnramp().quote.input;
    const replay = replayExchanges(kitOnramp().quote.exchanges);
    const quote = await hercle.createOnrampQuote(sandbox, input);
    const [request] = replay.requests;
    assert.ok(request);
    assert.equal(request.headers.get("on-behalf-of"), input.externalCustomerId);
    assert.equal(request.headers.get("Idempotency-Key"), `sdp-onramp-${input.paymentTransferId}`);
    assert.equal(quote.deliveryMode, "manual_instructions");
  });

  it("refuses to open an order with no reserved transfer id", async () => {
    const input = kitOnramp().quote.input;
    replayExchanges([]);
    await assert.rejects(
      hercle.createOnrampQuote(sandbox, { ...input, paymentTransferId: undefined }),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "INTERNAL_ERROR"
    );
  });

  it("names Hercle's refusals of the business instead of blaming SDP's keys", async () => {
    const input = kitOnramp().quote.input;
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
        hercle.createOnrampQuote(sandbox, input),
        (cause: unknown) =>
          cause instanceof SdpPaymentsError &&
          cause.code === expected &&
          cause.details?.outcome === "rejected",
        code
      );
    }
  });

  it("records a suspension Hercle refuses the order for, at the order's time, with no further request", async () => {
    const input = kitOnramp().quote.input;
    const calls = scriptedFetch([
      { status: 403, body: { code: "ACCOUNT_SUSPENDED", message: "suspended" } },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: input.externalCustomerId,
      providerStatus: "approved",
    });

    const window = await stampedWindow(() =>
      assert.rejects(
        hercle.createOnrampQuote(sandbox, { ...input, customerLink: store }),
        (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "CONFLICT"
      )
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(state.recorded, ["suspended"]);
    const [observation] = state.observations;
    assert.ok(observation);
    assert.deepEqual(
      { winsTie: observation.winsTie, preserves: observation.preserves },
      { winsTie: true, preserves: [] }
    );
    assertObservedWithin(observation.observedAt, window);
  });

  it("reads the verdict again when Hercle refuses the order for want of verification", async () => {
    const input = kitOnramp().quote.input;
    const calls = scriptedFetch([
      { status: 403, body: { code: "ACCOUNT_NOT_VERIFIED", message: "not verified" } },
      { status: 200, body: { status: "pending" } },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: input.externalCustomerId,
      providerStatus: "approved",
    });

    await assert.rejects(
      hercle.createOnrampQuote(sandbox, { ...input, customerLink: store }),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "CONFLICT"
    );

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        `POST ${BASE_URL}/partner/v1/orders/onramp`,
        `GET ${BASE_URL}/partner/v1/accounts/${input.externalCustomerId}/verification`,
      ]
    );
    assert.deepEqual(state.recorded, ["pending"]);
    // The refusal shows the account is not suspended, so the verdict may replace a recorded suspension.
    assert.deepEqual(state.observations[0]?.preserves, []);
  });

  it("stamps the verdict read after a refusal for want of verification with the order's time", async () => {
    const input = kitOnramp().quote.input;
    const calls = scriptedFetch([
      { status: 403, body: { code: "ACCOUNT_NOT_VERIFIED", message: "not verified" }, delayMs: 20 },
      { status: 200, body: { status: "approved" } },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: input.externalCustomerId,
      providerStatus: "pending",
    });

    await assert.rejects(
      hercle.createOnrampQuote(sandbox, { ...input, customerLink: store }),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "CONFLICT"
    );

    // Only the refusal showed the account not suspended, so a suspension recorded after the order still wins.
    const [order] = calls;
    const [observation] = state.observations;
    assert.ok(order && observation);
    assert.ok(new Date(observation.observedAt) <= order.sentAt, observation.observedAt);
  });

  it("still answers the refusal when the verdict cannot be read again", async () => {
    const input = kitOnramp().quote.input;
    scriptedFetch([
      { status: 403, body: { code: "ACCOUNT_NOT_VERIFIED", message: "not verified" } },
      { status: 503, body: { code: "VERIFICATION_UNAVAILABLE", message: "retry later" } },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: input.externalCustomerId,
      providerStatus: "approved",
    });

    await assert.rejects(
      hercle.createOnrampQuote(sandbox, { ...input, customerLink: store }),
      (cause: unknown) =>
        cause instanceof SdpPaymentsError &&
        cause.code === "CONFLICT" &&
        typeof cause.diagnostics?.customerLinkRecheckFailed === "string"
    );
    assert.deepEqual(state.recorded, []);
  });

  it("records nothing on the link for an order Hercle opens or refuses for another reason", async () => {
    const input = kitOnramp().quote.input;
    const { state, store } = memoryLinkStore({
      providerCustomerReference: input.externalCustomerId,
      providerStatus: "approved",
    });
    const opened = scriptedFetch([{ status: 200, body: HERCLE_ORDER }]);
    await hercle.createOnrampQuote(sandbox, { ...input, customerLink: store });
    const refused = scriptedFetch([
      { status: 409, body: { code: "BANK_ACCOUNT_NOT_PROVISIONED", message: "opening" } },
    ]);
    await assert.rejects(
      hercle.createOnrampQuote(sandbox, { ...input, customerLink: store }),
      SdpPaymentsError
    );

    assert.equal(opened.length, 1);
    assert.equal(refused.length, 1);
    assert.deepEqual(state.recorded, []);
  });

  it("refuses an order without the payer the bank enforces", async () => {
    const input = kitOnramp().quote.input;
    const [exchange] = kitOnramp().quote.exchanges;
    assert.ok(exchange);
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
      hercle.createOnrampQuote(sandbox, input),
      (cause: unknown) =>
        cause instanceof SdpPaymentsError && cause.code === "PROVIDER_RESPONSE_INVALID"
    );
  });
});

describe("Hercle sandbox settlement", () => {
  it("asks Hercle to settle the order as its rail would", async () => {
    const calls = scriptedFetch([
      {
        status: 200,
        body: {
          orderId: "ord_1",
          status: "settling",
          error: null,
          reference: "HRC-ORD1",
          txHash: null,
        },
      },
    ]);
    await simulateSettlement(sandbox, "ord_1");
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, "POST");
    assert.equal(call.url, `${BASE_URL}/partner/v1/orders/ord_1/simulate-settlement`);
    assert.deepEqual(JSON.parse(call.body), { status: "settled" });
  });

  it("refuses to simulate in production, before any request", async () => {
    const calls = scriptedFetch([]);
    await assert.rejects(
      simulateSettlement(rampTestRuntime("production", HERCLE_TEST_KIT.liveCredentials), "ord_1"),
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

  const KIT_LOOKUP = {
    transferId: "xfr_7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    rampType: "onramp",
    providerReference: "ord_contract_onramp",
  } as const;

  it("asks for the order by its id in one signed GET with no body, acting for no business", async () => {
    const calls = scriptedFetch([
      { status: 200, body: { orderId: "ord 1/x", status: "settling", error: null } },
    ]);
    const events = await hercle.fetchTransferStatus(sandbox, {
      ...KIT_LOOKUP,
      providerReference: "ord 1/x",
    });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, "GET");
    assert.equal(call.url, `${BASE_URL}/partner/v1/orders/ord%201%2Fx`);
    assert.equal(call.body, "");
    assert.equal(call.headers.get("X-Hercle-Client"), HERCLE_TEST_KIT.credentials.publicKey);
    assert.equal(
      call.headers.get("X-Hercle-Signature"),
      await buildHercleSignature(
        HERCLE_TEST_KIT.credentials.secretKey,
        Number(call.headers.get("X-Hercle-Ts")),
        "GET",
        "/partner/v1/orders/ord%201%2Fx",
        ""
      )
    );
    // A status lookup carries no customer reference, so it reads on SDP's partner keys alone.
    assert.equal(call.headers.get("on-behalf-of"), null);
    assert.deepEqual(events, [{ provider: "hercle", kind: "settling", reference: "ord 1/x" }]);
  });

  for (const [name, exchange] of Object.entries(HERCLE_ORDER_LOOKUP_REFUSALS)) {
    it(`fails on Hercle's refusal of ${name} after one request, never reading it as none`, async () => {
      const replay = replayExchanges([exchange]);
      await assert.rejects(
        hercle.fetchTransferStatus(sandbox, KIT_LOOKUP),
        (cause: unknown) =>
          cause instanceof SdpPaymentsError &&
          cause.code === "PROVIDER_NOT_CONFIGURED" &&
          cause.details?.outcome === "rejected"
      );
      assert.equal(replay.requests.length, 1);
    });
  }

  it("fails after one request on the sandbox's empty 404, an outage and a lost connection", async () => {
    const cases = [
      { name: "empty 404", reply: () => new Response(null, { status: 404 }), code: "BAD_REQUEST" },
      {
        name: "503",
        reply: () => new Response(null, { status: 503 }),
        code: "PROVIDER_UNAVAILABLE",
        outcome: "unknown",
      },
      {
        name: "lost connection",
        reply: () => {
          throw new TypeError("fetch failed");
        },
        code: "PROVIDER_UNAVAILABLE",
        outcome: "unknown",
      },
    ];
    for (const { name, reply, code, outcome = "rejected" } of cases) {
      let requests = 0;
      globalThis.fetch = async () => {
        requests += 1;
        return reply();
      };
      await assert.rejects(
        hercle.fetchTransferStatus(sandbox, KIT_LOOKUP),
        (cause: unknown) =>
          cause instanceof SdpPaymentsError &&
          cause.code === code &&
          cause.details?.outcome === outcome,
        name
      );
      assert.equal(requests, 1, name);
    }
  });

  it("refuses an answer about another order", async () => {
    scriptedFetch([
      { status: 200, body: { orderId: "ord_other", status: "settled", error: null } },
    ]);
    await assert.rejects(
      hercle.fetchTransferStatus(sandbox, KIT_LOOKUP),
      (cause: unknown) =>
        cause instanceof SdpPaymentsError &&
        cause.code === "PROVIDER_RESPONSE_INVALID" &&
        cause.details?.outcome === "unknown"
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
    assert.ok(account && verification);
    assert.equal(account.url, `${BASE_URL}/partner/v1/accounts`);
    assert.equal(account.headers.get("Idempotency-Key"), `sdp-account-${BUSINESS.id}`);
    const sent = JSON.parse(account.body);
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
    assert.equal(verification.url, `${BASE_URL}/partner/v1/accounts/acct_1/verifications`);
    assert.equal(verification.headers.get("Idempotency-Key"), `sdp-kyb-${BUSINESS.id}`);
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

  it("reads the verdict on a linked business and records it with the time SDP asked", async () => {
    const calls = scriptedFetch([{ status: 200, body: { status: "pending" } }]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "action_required",
    });
    const window = await stampedWindow(() =>
      requirementsMember().describe(sandbox, {
        counterparty: BUSINESS,
        direction: "onramp",
        customerLink: store,
      })
    );
    assert.equal(window.result.status, "customer_verifying");
    assert.deepEqual(state.recorded, ["pending"]);
    const [observation] = state.observations;
    assert.ok(observation);
    // A verdict read cannot see a suspension, so it never replaces one.
    assert.deepEqual(
      { winsTie: observation.winsTie, preserves: observation.preserves },
      { winsTie: true, preserves: ["suspended"] }
    );
    assertObservedWithin(observation.observedAt, window);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.url, `${BASE_URL}/partner/v1/accounts/acct_1/verification`);
  });

  it("records an approval that loses a tie, so a same-second revocation is never undone", async () => {
    scriptedFetch([{ status: 200, body: { status: "approved" } }]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "pending",
    });
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.equal(answer.status, "ready");
    assert.equal(state.observations[0]?.winsTie, false);
  });

  it("keeps a suspended business unready, reading only its account", async () => {
    const calls = scriptedFetch([
      { status: 200, body: { accountId: "acct_1", financialStatus: "Suspended" } },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "suspended",
    });
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.deepEqual(answer, {
      provider: "hercle",
      direction: "onramp",
      status: "unsupported",
      reason: "Hercle has suspended the business's account.",
    });
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [`GET ${BASE_URL}/partner/v1/accounts/acct_1`]
    );
    assert.deepEqual(state.recorded, ["suspended"]);
  });

  it("shows a business ready again once Hercle lifts its suspension", async () => {
    const calls = scriptedFetch([
      { status: 200, body: { accountId: "acct_1", financialStatus: "Active" } },
      { status: 200, body: { status: "approved" } },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "suspended",
    });
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.equal(answer.status, "ready");
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        `GET ${BASE_URL}/partner/v1/accounts/acct_1`,
        `GET ${BASE_URL}/partner/v1/accounts/acct_1/verification`,
      ]
    );
    assert.deepEqual(state.recorded, ["approved"]);
    // The account read showed no suspension, so this verdict replaces the recorded one.
    assert.deepEqual(state.observations[0]?.preserves, []);
  });

  it("stamps the verdict that lifts a suspension with the account read's time", async () => {
    const calls = scriptedFetch([
      { status: 200, body: { accountId: "acct_1", financialStatus: "Active" }, delayMs: 20 },
      { status: 200, body: { status: "approved" } },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "suspended",
    });
    await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });

    // Only the account read showed no suspension, so a suspension recorded after it still wins.
    const [account] = calls;
    const [observation] = state.observations;
    assert.ok(account && observation);
    assert.ok(new Date(observation.observedAt) <= account.sentAt, observation.observedAt);
  });

  it("answers with the newer status the link kept instead of the verdict it read", async () => {
    const cases = [
      { read: "approved", kept: "rejected", expected: "customer_verification_failed" },
      { read: "approved", kept: "suspended", expected: "unsupported" },
      { read: "pending", kept: "approved", expected: "ready" },
    ] as const;
    for (const { read, kept, expected } of cases) {
      scriptedFetch([{ status: 200, body: { status: read } }]);
      const { state, store } = memoryLinkStore(
        { providerCustomerReference: "acct_1", providerStatus: "pending" },
        { providerStatus: kept }
      );
      const answer = await requirementsMember().describe(sandbox, {
        counterparty: BUSINESS,
        direction: "onramp",
        customerLink: store,
      });
      assert.equal(answer.status, expected, `${read} over ${kept}`);
      assert.deepEqual(state.recorded, [], `${read} over ${kept}`);
    }
  });

  it("asks to read again when a newer report wants the business to act and SDP holds no link", async () => {
    scriptedFetch([{ status: 200, body: { status: "approved" } }]);
    const { store } = memoryLinkStore(
      { providerCustomerReference: "acct_1", providerStatus: "pending" },
      { providerStatus: "action_required" }
    );
    await assert.rejects(
      requirementsMember().describe(sandbox, {
        counterparty: BUSINESS,
        direction: "onramp",
        customerLink: store,
      }),
      (cause: unknown) => cause instanceof SdpPaymentsError && cause.code === "PROVIDER_UNAVAILABLE"
    );
  });

  it("keeps the link Hercle minted when the newer report the link kept asks the same", async () => {
    scriptedFetch([
      {
        status: 200,
        body: { status: "action_required", verificationUrl: "https://verify.hercle.test/acct_1" },
      },
    ]);
    const { store } = memoryLinkStore(
      { providerCustomerReference: "acct_1", providerStatus: "pending" },
      { providerStatus: "action_required" }
    );
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.deepEqual(answer, {
      provider: "hercle",
      direction: "onramp",
      status: "customer_verification_required",
      verificationUrl: "https://verify.hercle.test/acct_1",
    });
  });

  it("lifts a suspension with no verdict when the reinstated business has no verification", async () => {
    scriptedFetch([
      { status: 200, body: { accountId: "acct_1", financialStatus: "" } },
      { status: 404, body: { code: "VERIFICATION_NOT_STARTED", message: "not started" } },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "suspended",
    });
    const answer = await requirementsMember().describe(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
    });
    assert.equal(answer.status, "collect");
    assert.deepEqual(state.recorded, [null]);
  });

  it("starts the verification of a reinstated business on a submission when Hercle holds none", async () => {
    const calls = scriptedFetch([
      { status: 200, body: { accountId: "acct_1", financialStatus: "Active" } },
      { status: 404, body: { code: "VERIFICATION_NOT_STARTED", message: "not started" } },
      {
        status: 200,
        body: { status: "action_required", verificationUrl: "https://verify.hercle.test/acct_1" },
      },
    ]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "suspended",
    });
    const answer = await requirementsMember().submit(sandbox, {
      counterparty: BUSINESS,
      direction: "onramp",
      customerLink: store,
      collectedData: KYB,
    });
    assert.equal(answer.status, "customer_verification_required");
    assert.equal(calls[2]?.url, `${BASE_URL}/partner/v1/accounts/acct_1/verifications`);
    assert.deepEqual(state.recorded, ["action_required"]);
  });

  it("refuses an account read that answers for another account", async () => {
    scriptedFetch([{ status: 200, body: { accountId: "acct_9", financialStatus: "Active" } }]);
    const { state, store } = memoryLinkStore({
      providerCustomerReference: "acct_1",
      providerStatus: "suspended",
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
    assert.deepEqual(state.recorded, []);
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
    for (const providerStatus of [null, "pending", "action_required", "rejected", "suspended"]) {
      assert.equal(
        member.isCustomerReady({ providerCustomerReference: "acct_1", providerStatus }),
        false,
        String(providerStatus)
      );
    }
  });
});
