import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { SdpEarnError } from "#/errors";
import type { EarnRuntimeContext } from "#/types";
import { getWisdomTreeOrderByHash, resetWisdomTreeTokenCache } from "./connect";
import type { WisdomTreeOrderDetails } from "./order-schemas";

const credential = JSON.stringify({
  clientId: "client-id",
  clientSecret: "client-secret",
  username: "api-user",
  password: "api-pass",
});
const production: EarnRuntimeContext = {
  environment: "production",
  env: { WISDOMTREE_API_KEY: credential },
};
const sandbox: EarnRuntimeContext = {
  environment: "sandbox",
  env: { WISDOMTREE_SANDBOX_API_KEY: credential },
};
const token = { access_token: "bearer-token", expires_in: 600 };
const order = {
  blockchain: "Solana",
  exchange_code: "WTGXX",
  token_contract_address: "Em46fxxwgY2RRoUbBMSbEjJwY62x3ESMNdhnsGpEKewm",
  settlement_wallet_address: "owner",
  trade_type: "Purchase",
  settlement_currency: "2",
  settlement_currency_name: "USDC",
  status: "Settled",
  order_type: "primary",
  conversion_order_hash: null,
  deposit_hash: "source-signature",
  issuer_order_hash: "destination-signature",
  token_amount: "1.000000001",
  net_value: "1.00000000",
} satisfies WisdomTreeOrderDetails;

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
function replies(...responses: Reply[]) {
  let index = 0;
  return mock.method(globalThis, "fetch", async () => {
    const response = responses[index++];
    assert.ok(response, "Unexpected provider request");
    return Response.json(response.body, { status: response.status });
  });
}

beforeEach(resetWisdomTreeTokenCache);
afterEach(() => mock.restoreAll());

describe("WisdomTree order lookup", () => {
  it("reads one exact hash using the environment's OAuth identity without money-in reads", async () => {
    const fetchMock = replies(ok(token), ok(order));

    assert.deepEqual(await getWisdomTreeOrderByHash(production, "source-signature"), order);
    assert.equal(fetchMock.mock.callCount(), 2);
    assert.equal(
      String(fetchMock.mock.calls[0].arguments[0]),
      "https://api.wisdomtreeconnect.com/o/token/"
    );
    assert.equal(fetchMock.mock.calls[0].arguments[1]?.method, "POST");
    assert.equal(
      String(fetchMock.mock.calls[1].arguments[0]),
      "https://api.wisdomtreeconnect.com/api/orders/hash/source-signature"
    );
    assert.equal(fetchMock.mock.calls[1].arguments[1]?.method, "GET");
    assert.equal(
      new Headers(fetchMock.mock.calls[1].arguments[1]?.headers).get("authorization"),
      "Bearer bearer-token"
    );
  });

  it("keeps production and sandbox tokens and endpoints separate", async () => {
    const fetchMock = replies(ok(token), ok(order), ok(token), ok(order));
    await getWisdomTreeOrderByHash(production, "source-signature");
    await getWisdomTreeOrderByHash(sandbox, "source-signature");
    assert.equal(fetchMock.mock.callCount(), 4);
    assert.equal(
      String(fetchMock.mock.calls[2].arguments[0]),
      "https://api.sandbox.wisdomtreeconnect.com/o/token/"
    );
    assert.equal(
      String(fetchMock.mock.calls[3].arguments[0]),
      "https://api.sandbox.wisdomtreeconnect.com/api/orders/hash/source-signature"
    );
  });

  it("encodes the supplied hash as one path segment", async () => {
    const fetchMock = replies(ok(token), ok(order));
    await getWisdomTreeOrderByHash(production, "source/other?key=value");
    assert.equal(
      String(fetchMock.mock.calls[1].arguments[0]),
      "https://api.wisdomtreeconnect.com/api/orders/hash/source%2Fother%3Fkey%3Dvalue"
    );
  });

  for (const status of [403, 404]) {
    it(`keeps a ${status} order lookup pending without another provider request`, async () => {
      const fetchMock = replies(ok(token), { status, body: { error: "Order unavailable" } });
      assert.equal(await getWisdomTreeOrderByHash(production, "source-signature"), null);
      assert.equal(fetchMock.mock.callCount(), 2);
    });
  }

  it("preserves pending null hashes, optional fields and unfamiliar statuses", async () => {
    const { order_type: _type, token_amount: _amount, ...pending } = order;
    const reply = {
      ...pending,
      status: "New provider status",
      deposit_hash: null,
      issuer_order_hash: null,
    };
    replies(ok(token), ok(reply));
    assert.deepEqual(await getWisdomTreeOrderByHash(production, "source-signature"), reply);
  });

  it("keeps an in-flight order with unknown amounts readable", async () => {
    const pending = { ...order, status: "FA Approval", token_amount: null, net_value: null };
    replies(ok(token), ok(pending));
    assert.deepEqual(await getWisdomTreeOrderByHash(production, "source-signature"), pending);
  });

  it("refreshes a revoked token once and retries only the GET", async () => {
    const fetchMock = replies(
      ok(token),
      { status: 401, body: { error: "Token revoked" } },
      ok({ ...token, access_token: "replacement-token" }),
      ok(order)
    );
    assert.deepEqual(await getWisdomTreeOrderByHash(production, "source-signature"), order);
    assert.equal(fetchMock.mock.callCount(), 4);
    assert.deepEqual(
      fetchMock.mock.calls.map((call) => call.arguments[1]?.method),
      ["POST", "GET", "POST", "GET"]
    );
  });

  it("does not retry a second authentication refusal", async () => {
    const refusal = { status: 401, body: { error: "Unauthorized" } };
    const fetchMock = replies(ok(token), refusal, ok(token), refusal);
    await assert.rejects(
      getWisdomTreeOrderByHash(production, "source-signature"),
      (cause) => cause instanceof SdpEarnError && cause.details?.providerStatus === 401
    );
    assert.equal(fetchMock.mock.callCount(), 4);
  });

  for (const status of [429, 503]) {
    it(`preserves a ${status} provider failure without retrying the order`, async () => {
      const fetchMock = replies(ok(token), { status, body: { error: "Provider unavailable" } });
      await assert.rejects(
        getWisdomTreeOrderByHash(production, "source-signature"),
        (cause) =>
          cause instanceof SdpEarnError &&
          cause.code === (status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE")
      );
      assert.equal(fetchMock.mock.callCount(), 2);
    });
  }

  it("ignores unused display fields rather than interpreting their numeric values", async () => {
    replies(ok(token), ok({ ...order, quantity: 1.000000001, org: "Private customer" }));
    assert.deepEqual(await getWisdomTreeOrderByHash(production, "source-signature"), order);
  });

  it("refuses missing credentials before any request", async () => {
    const fetchMock = replies();
    await assert.rejects(
      getWisdomTreeOrderByHash({ environment: "production", env: {} }, "source-signature"),
      (cause) => cause instanceof SdpEarnError && cause.code === "PROVIDER_NOT_CONFIGURED"
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  for (const malformed of [
    null,
    [],
    { ...order, token_contract_address: undefined },
    { ...order, settlement_wallet_address: null },
    { ...order, trade_type: "" },
    { ...order, settlement_currency_name: undefined },
    { ...order, token_amount: "not-an-amount" },
    { ...order, net_value: "" },
    { ...order, token_amount: "1".repeat(129) },
    { ...order, issuer_order_hash: "a".repeat(256) },
  ]) {
    it("rejects a malformed 200 response without exposing its contents", async () => {
      replies(ok(token), ok(malformed));
      await assert.rejects(
        getWisdomTreeOrderByHash(production, "source-signature"),
        (cause) =>
          cause instanceof SdpEarnError &&
          cause.code === "PROVIDER_UNAVAILABLE" &&
          cause.message === "WisdomTree returned a malformed order response"
      );
    });
  }
});
